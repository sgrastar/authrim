import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

export const METHOD_USES = [
	{ id: 'signup', label: 'am.methods.signup' },
	{ id: 'login', label: 'am.methods.login' },
	{ id: 'reauth', label: 'am.methods.reauth' },
	{ id: 'account_link', label: 'am.methods.accountLink' }
] as const satisfies readonly { id: string; label: MessageKey }[];

type MethodUse = (typeof METHOD_USES)[number]['id'];
const ALL_USES: readonly MethodUse[] = ['signup', 'login', 'reauth', 'account_link'];

interface BuiltInMethod {
	id: string;
	label: MessageKey;
	description: MessageKey;
	supports: readonly MethodUse[];
}

export const BUILT_IN_METHODS: readonly BuiltInMethod[] = [
	{
		id: 'passkey',
		label: 'am.methods.passkey',
		description: 'am.methods.passkeyHint',
		supports: ALL_USES
	},
	{
		id: 'email_otp',
		label: 'am.methods.emailOtp',
		description: 'am.methods.emailOtpHint',
		supports: ALL_USES
	},
	{
		id: 'totp',
		label: 'am.methods.totp',
		description: 'am.methods.totpHint',
		supports: ALL_USES
	},
	{
		id: 'did',
		label: 'am.methods.did',
		description: 'am.methods.didHint',
		supports: ['login']
	},
	{
		id: 'directory_password',
		label: 'am.methods.directoryPassword',
		description: 'am.methods.directoryPasswordHint',
		supports: ['login']
	}
];

export const methodKey = (method: string, use: string) =>
	method === 'directory_password'
		? 'authentication-methods.directory_password.enabled'
		: `authentication-methods.${method}.${use}_enabled`;

export const guestKey = (name: string) => `authentication-methods.${name}`;
