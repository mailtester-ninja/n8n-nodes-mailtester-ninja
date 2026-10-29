import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MailTesterNinjaApi implements ICredentialType {
	name = 'mailTesterNinjaApi';

	displayName = 'MailTester Ninja API';

	icon: Icon = {
		light: 'file:../icons/mailtesterNinja.svg',
		dark: 'file:../icons/mailtesterNinja.dark.svg',
	};

	documentationUrl = 'https://mailtester.ninja/api/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'A paid key (starts with sub_) or a free API token (starts with mtf_, 50 checks a day) from https://mailtester.ninja/free-email-verification-api/',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			qs: {
				key: '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://happy.mailtester.ninja',
			url: '/ninja',
			method: 'GET',
			qs: {
				email: 'test@example.com',
			},
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'code',
					value: '--',
					message: 'The API key is invalid or disabled',
				},
			},
		],
	};
}
