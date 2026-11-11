import { ALL_CATEGORY_META } from '@authrim/ar-lib-core/types/settings/catalog';
import type { SettingMeta } from '@authrim/ar-lib-core/utils/settings-manager';

/**
 * What a session profile holds (ar-lib-core `SESSION_PROFILE_KEYS`): the session lengths most
 * profiles change, the per-method lengths under Advanced, and whether a session can be extended
 * and single sign-on is on.
 */
export const SESSION_LENGTH_KEYS = ['session.default_ttl', 'session.max_ttl'] as const;
export const SESSION_METHOD_LENGTH_KEYS = [
	'session.ttl.passkey',
	'session.ttl.email_code',
	'session.ttl.directory_password',
	'session.ttl.direct_auth',
	'session.ttl.did',
	'session.ttl.guest',
	'session.ttl.passkey_registration'
] as const;
export const SESSION_SWITCH_KEYS = ['session.refresh_default', 'oauth.sso_enabled'] as const;
export const SESSION_PROFILE_KEYS = [
	...SESSION_LENGTH_KEYS,
	...SESSION_METHOD_LENGTH_KEYS,
	...SESSION_SWITCH_KEYS
] as const;

/** A profile setting's metadata (its limits and unit), from the Settings API catalog. */
export function sessionSettingMeta(key: string): SettingMeta {
	const category = key.startsWith('oauth.') ? 'oauth' : 'session';
	return (ALL_CATEGORY_META[category].settings as Record<string, SettingMeta>)[key];
}

/** A length in milliseconds as seconds (the duration control's unit). */
export const msToSeconds = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value / 1000 : null;
