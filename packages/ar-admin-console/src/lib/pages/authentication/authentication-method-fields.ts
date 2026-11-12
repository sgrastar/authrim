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

/** The guest uses a method profile can narrow. */
export const GUEST_KEYS = [
	guestKey('guest.login_enabled'),
	guestKey('passkey.guest_upgrade_enabled'),
	guestKey('email_otp.guest_upgrade_enabled')
] as const;

/** Every switch of a method profile: each built-in method's uses, then guest use. */
export const PROFILE_METHOD_KEYS: readonly string[] = [
	...BUILT_IN_METHODS.flatMap((method) => method.supports.map((use) => methodKey(method.id, use))),
	...GUEST_KEYS
];

/**
 * A profile's values as its page shows them. A profile only narrows: a method (or guest use) it
 * leaves unset is allowed at sign-in, so it shows, and saves, as on. Not for the Default, whose
 * values are the tenant's own settings.
 */
export function withUnsetMethodsOn(values: Record<string, unknown>): Record<string, unknown> {
	const shown = structuredClone(values);
	for (const key of PROFILE_METHOD_KEYS) if (shown[key] === undefined) shown[key] = true;
	return shown;
}
