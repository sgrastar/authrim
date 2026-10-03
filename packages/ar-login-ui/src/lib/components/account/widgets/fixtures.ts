/** Story fixtures for the account widgets. Factories, so each story gets its own objects. */
import type {
	AccountDevice,
	AccountPasskey,
	AccountSession,
	AccountTotpCredential
} from '$lib/api/account';
import type { AccountTotpEnrollment } from './types';

/** 2026-08-09 10:30 UTC, so every story shows the same dates. */
export const FIXTURE_NOW = Date.UTC(2026, 7, 9, 10, 30);
const DAY = 24 * 60 * 60 * 1000;

function providerIcon(fill: string, letter: string): string {
	return `data:image/svg+xml;utf8,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect width="34" height="34" rx="8" fill="${fill}"/><text x="17" y="23" font-family="sans-serif" font-size="16" font-weight="700" text-anchor="middle" fill="#ffffff">${letter}</text></svg>`
	)}`;
}

export const device = (overrides: Partial<AccountDevice> = {}): AccountDevice => ({
	id: 'device-1',
	display_name: 'Work laptop',
	platform: 'macOS',
	current: false,
	last_seen_at: null,
	last_seen_at_unix: (FIXTURE_NOW - DAY) / 1000,
	...overrides
});

export const session = (overrides: Partial<AccountSession> = {}): AccountSession => ({
	id: 'session-other',
	current: false,
	created_at: FIXTURE_NOW - 3 * DAY,
	expires_at: FIXTURE_NOW + 4 * DAY,
	browser: 'Chrome',
	os: 'Windows',
	device_type: 'desktop',
	country_code: 'US',
	...overrides
});

export const passkey = (overrides: Partial<AccountPasskey> = {}): AccountPasskey => ({
	id: 'passkey-1',
	device_name: 'Direct Auth Passkey',
	aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
	provider: {
		aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
		name: 'iCloud Keychain',
		icon_light: providerIcon('#1f2937', 'K'),
		icon_dark: providerIcon('#4b5563', 'K'),
		known: true
	},
	created_at: FIXTURE_NOW - 30 * DAY,
	last_used_at: FIXTURE_NOW - DAY,
	...overrides
});

export const totpCredential = (
	overrides: Partial<AccountTotpCredential> = {}
): AccountTotpCredential => ({
	id: 'totp-1',
	label: 'Phone',
	algorithm: 'SHA1',
	digits: 6,
	period: 30,
	window: 1,
	status: 'active',
	created_at: FIXTURE_NOW - 60 * DAY,
	activated_at: FIXTURE_NOW - 60 * DAY,
	last_used_at: FIXTURE_NOW - 2 * DAY,
	...overrides
});

export const totpEnrollment = (
	overrides: Partial<AccountTotpEnrollment> = {}
): AccountTotpEnrollment => ({
	credentialId: 'totp-2',
	secret: 'JBSWY3DPEHPK3PXP',
	otpauthUri: 'otpauth://totp/Authrim:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Authrim',
	backupCodes: [],
	...overrides
});

export const backupCodes = (): string[] => [
	'7KQ2M9XHP4TA',
	'R8D3LW6ZC1NE',
	'B5YJ0VQ7GS2U',
	'H9PF4KX1MD8C',
	'W2NT6RB3ZQ5L',
	'E7CG1YH8VJ4S'
];
