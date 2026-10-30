import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

const API_URL = 'https://happy.mailtester.ninja/ninja';
const FIND_BATCH_SIZE = 3;

// Rate regulator, shared by every execution of this n8n process that uses the same key.
// The API allows each key daily limit / 8640 requests per 10 seconds (11.57 on Starter and Pro, 23.1 on Ultimate)
// and answers HTTP 429 above that. We stay one request under the limit over an 11 second window, so a normal run
// never gets a 429. Free tokens allow one request every 30 seconds: we wait 31 seconds between their requests.
// If a 429 still comes back (the key is used elsewhere at the same time), we pause the key for one window,
// retry once, then stop with a clear error: never a burst of retries.
const WINDOW_MS = 11000;
const DEFAULT_PER_WINDOW = 10;
const FREE_GAP_MS = 31000;

interface Limiter {
	stamps: number[];
	perWindow: number;
	chain: Promise<void>;
	until: number;
}

const limiters = new Map<string, Limiter>();

function isFreeKey(key: string): boolean {
	return key === 'free' || key.startsWith('mtf_');
}

function limiterFor(key: string): Limiter {
	let limiter = limiters.get(key);
	if (!limiter) {
		limiter = { stamps: [], perWindow: DEFAULT_PER_WINDOW, chain: Promise.resolve(), until: 0 };
		limiters.set(key, limiter);
	}
	return limiter;
}

async function waitForSlot(key: string): Promise<void> {
	const limiter = limiterFor(key);
	const window = isFreeKey(key) ? FREE_GAP_MS : WINDOW_MS;
	const allowed = isFreeKey(key) ? 1 : limiter.perWindow;
	const turn = limiter.chain.then(async () => {
		for (;;) {
			const now = Date.now();
			limiter.stamps = limiter.stamps.filter((stamp) => now - stamp < window);
			let wait = Math.max(0, limiter.until - now);
			if (!wait && limiter.stamps.length >= allowed) wait = limiter.stamps[0] + window - now;
			if (wait <= 0) {
				limiter.stamps.push(now);
				return;
			}
			await sleep(wait);
		}
	});
	limiter.chain = turn.catch(() => undefined);
	await turn;
}

function learnLimit(key: string, dailyLimit: unknown): void {
	const limit = Number(dailyLimit);
	if (limit > 0 && !isFreeKey(key)) {
		limiterFor(key).perWindow = Math.max(1, Math.floor(limit / 8640) - 1);
	}
}

const PATTERNS = [
	'{fn}.{mn}.{ln}',
	'{fn}{mn}{ln}',
	'{fn}.{ln}',
	'{ln}.{fn}',
	'{fn}{ln}',
	'{ln}{fn}',
	'{fi}{ln}',
	'{fn}{li}',
	'{li}{fn}',
	'{ln}{fi}',
	'{fn}',
	'{ln}',
	'{fi}.{ln}',
];

const STOP_REASONS: Record<string, string> = {
	'Catch-All': 'The domain accepts every address (catch-all), so no candidate can be confirmed.',
	'No MX': 'The domain has no mail server.',
	Disposable: 'The domain belongs to a disposable email provider.',
};

function normalizeName(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/['’\s]+/g, '')
		.replace(/[^a-z0-9._-]/g, '');
}

function normalizeDomain(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/^www\./, '')
		.replace(/[/?#].*$/, '')
		.replace(/^.*@/, '');
}

function buildCandidates(
	firstName: string,
	lastName: string,
	middleName: string,
	domain: string,
): string[] {
	const parts: Record<string, string> = {
		fn: normalizeName(firstName),
		ln: normalizeName(lastName),
		mn: normalizeName(middleName),
	};
	parts.fi = parts.fn.slice(0, 1);
	parts.li = parts.ln.slice(0, 1);
	const candidates: string[] = [];
	for (const pattern of PATTERNS) {
		if (pattern.includes('{mn}') && !parts.mn) continue;
		const local = pattern.replace(/\{(fn|ln|mn|fi|li)\}/g, (_match, key: string) => parts[key]);
		const email = `${local}@${domain}`;
		if (local && !local.startsWith('.') && !local.endsWith('.') && !candidates.includes(email)) {
			candidates.push(email);
		}
	}
	return candidates;
}

async function verifyEmail(
	context: IExecuteFunctions,
	email: string,
	itemIndex: number,
	apiKey: string,
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method: 'GET',
		url: API_URL,
		qs: { email },
		json: true,
		timeout: 60000,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	let response: IDataObject = {};
	for (let attempt = 0; attempt < 2; attempt++) {
		await waitForSlot(apiKey);
		let full: { statusCode: number; body: unknown };
		try {
			full = (await context.helpers.httpRequestWithAuthentication.call(
				context,
				'mailTesterNinjaApi',
				options,
			)) as { statusCode: number; body: unknown };
		} catch (error) {
			throw new NodeApiError(context.getNode(), error as JsonObject, { itemIndex });
		}
		if (full.statusCode === 429) {
			if (attempt === 1) {
				throw new NodeOperationError(context.getNode(), 'MailTester Ninja rate limit reached', {
					itemIndex,
					description:
						'This key is already used at its maximum rate somewhere else at the same time (Starter and Pro: 11 requests per 10 seconds, Ultimate: 23). Try again in a minute, or spread the checks out.',
				});
			}
			limiterFor(apiKey).until = Date.now() + (isFreeKey(apiKey) ? FREE_GAP_MS : WINDOW_MS);
			continue;
		}
		if (full.statusCode >= 400) {
			throw new NodeOperationError(
				context.getNode(),
				`MailTester Ninja answered HTTP ${full.statusCode}: ${String(full.body).slice(0, 200)}`,
				{ itemIndex },
			);
		}
		response = (typeof full.body === 'object' && full.body !== null ? full.body : {}) as IDataObject;
		learnLimit(apiKey, response.limit);
		break;
	}
	if (response.code === '--') {
		throw new NodeOperationError(
			context.getNode(),
			`MailTester Ninja did not run the check: ${String(response.message)}`,
			{
				itemIndex,
				description:
					'Make sure the API key in your credentials is active. Get a free API token at https://mailtester.ninja/free-email-verification-api/ or a paid key at https://mailtester.ninja/verify-emails-unlimited/',
			},
		);
	}
	return {
		email: response.email ?? email,
		code: response.code,
		message: response.message,
		domain: response.domain ?? null,
		mx: response.mx ?? '',
	};
}

export class MailTesterNinja implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MailTester Ninja',
		name: 'mailTesterNinja',
		icon: { light: 'file:mailtesterNinja.svg', dark: 'file:mailtesterNinja.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Verify email addresses in real time and find work emails with MailTester Ninja',
		defaults: {
			name: 'MailTester Ninja',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'mailTesterNinjaApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Find',
						value: 'find',
						action: 'Find a work email address',
						description:
							'Find the work email address of a person from their name and company domain (paid key)',
					},
					{
						name: 'Verify',
						value: 'verify',
						action: 'Verify an email address',
						description:
							'Check in real time whether an email address exists and can receive mail, without sending a message',
					},
				],
				default: 'verify',
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['verify'] } },
				description: 'The email address to verify',
			},
			{
				displayName: 'First Name',
				name: 'firstName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['find'] } },
				description: "The person's first name",
			},
			{
				displayName: 'Last Name',
				name: 'lastName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['find'] } },
				description: "The person's last name",
			},
			{
				displayName: 'Company Domain',
				name: 'domain',
				type: 'string',
				placeholder: 'example.com',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['find'] } },
				description: "The company's email domain",
			},
			{
				displayName: 'Middle Name',
				name: 'middleName',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['find'] } },
				description: "The person's middle name, if any",
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;

				const credentials = await this.getCredentials('mailTesterNinjaApi', itemIndex);
				const apiKey = String(credentials.apiKey ?? '').trim();

				if (operation === 'verify') {
					const email = (this.getNodeParameter('email', itemIndex) as string).trim();
					const result = await verifyEmail(this, email, itemIndex, apiKey);
					returnData.push({ json: result, pairedItem: { item: itemIndex } });
					continue;
				}

				if (isFreeKey(apiKey)) {
					throw new NodeOperationError(
						this.getNode(),
						'Find needs a paid MailTester Ninja key',
						{
							itemIndex,
							description:
								'Find checks several address patterns in a row, which the free API token (one request every 30 seconds) cannot do. Use a paid key starting with sub_: https://mailtester.ninja/verify-emails-unlimited/',
						},
					);
				}

				const domain = normalizeDomain(this.getNodeParameter('domain', itemIndex) as string);
				const candidates = buildCandidates(
					this.getNodeParameter('firstName', itemIndex) as string,
					this.getNodeParameter('lastName', itemIndex) as string,
					this.getNodeParameter('middleName', itemIndex, '') as string,
					domain,
				);
				if (!candidates.length || !domain.includes('.')) {
					throw new NodeOperationError(
						this.getNode(),
						'Provide a first name, a last name and a company domain such as example.com',
						{ itemIndex },
					);
				}

				let outcome: IDataObject | undefined;
				let tried = 0;
				for (let start = 0; start < candidates.length && !outcome; start += FIND_BATCH_SIZE) {
					const batch = candidates.slice(start, start + FIND_BATCH_SIZE);
					const results = await Promise.all(
						batch.map(async (email) => await verifyEmail(this, email, itemIndex, apiKey)),
					);
					for (let j = 0; j < batch.length && !outcome; j++) {
						const result = results[j];
						tried++;
						if (result.message === 'Accepted') {
							outcome = {
								found: true,
								email: batch[j],
								code: result.code,
								message: result.message,
								tried,
								reason: null,
							};
						} else if (result.message !== 'Rejected' && result.message !== 'Limited') {
							outcome = {
								found: false,
								email: null,
								code: result.code,
								message: result.message,
								tried,
								reason:
									STOP_REASONS[String(result.message)] ??
									`The domain could not be checked (${String(result.message)}).`,
							};
						}
					}
				}

				returnData.push({
					json: outcome ?? {
						found: false,
						email: null,
						code: 'ko',
						message: 'Rejected',
						tried,
						reason: 'None of the usual address patterns exists on this domain.',
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
