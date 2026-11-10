import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

export const METHOD_USES = [
	{ id: 'signup', label: 'am.methods.signup' },
	{ id: 'login', label: 'am.methods.login' },
	{ id: 'reauth', label: 'am.methods.reauth' },
	{ id: 'account_link', label: 'am.methods.accountLink' }
] as const satisfies readonly { id: string; label: MessageKey }[];

export const BUILT_IN_METHODS = [
	{ id: 'passkey', label: 'am.methods.passkey' },
	{ id: 'email_otp', label: 'am.methods.emailOtp' },
	{ id: 'totp', label: 'am.methods.totp' }
] as const satisfies readonly { id: string; label: MessageKey }[];

export const methodKey = (method: string, use: string) =>
	`authentication-methods.${method}.${use}_enabled`;

export const guestKey = (name: string) => `authentication-methods.${name}`;
