import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const API_URL = 'https://happy.mailtester.ninja/ninja';
const FIND_BATCH_SIZE = 3;

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
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method: 'GET',
		url: API_URL,
		qs: { email },
		json: true,
		timeout: 60000,
	};
	let response: IDataObject;
	try {
		response = (await context.helpers.httpRequestWithAuthentication.call(
			context,
			'mailTesterNinjaApi',
			options,
		)) as IDataObject;
	} catch (error) {
		throw new NodeApiError(context.getNode(), error as JsonObject, { itemIndex });
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

				if (operation === 'verify') {
					const email = (this.getNodeParameter('email', itemIndex) as string).trim();
					const result = await verifyEmail(this, email, itemIndex);
					returnData.push({ json: result, pairedItem: { item: itemIndex } });
					continue;
				}

				const credentials = await this.getCredentials('mailTesterNinjaApi', itemIndex);
				if (!String(credentials.apiKey ?? '').trim().startsWith('sub_')) {
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
						batch.map(async (email) => await verifyEmail(this, email, itemIndex)),
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
