/** Story fixtures for the account widgets. Factories, so each story gets its own objects. */
import type {
	AccountDevice,
	AccountLauncher,
	AccountOAuthClientConsent,
	AccountOperation,
	AccountPasskey,
	AccountProfile,
	AccountSession,
	AccountStatementConsent,
	AccountTotpCredential,
	GuestUpgradeStatus
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

export const launcher = (overrides: Partial<AccountLauncher> = {}): AccountLauncher => ({
	id: 'launcher-calendar',
	name: 'Team calendar',
	description: 'Meetings, rooms and shared schedules.',
	category: 'Productivity',
	launch_type: 'oidc_third_party_initiated',
	open_in_new_tab: false,
	icon_type: 'phosphor',
	icon_value: 'calendar',
	icon_color: '#ffffff',
	background_color: '#2563eb',
	grid_width: 2,
	sort_order: 1,
	enabled: true,
	allow_favorite: true,
	created_at: FIXTURE_NOW - 90 * DAY,
	updated_at: FIXTURE_NOW - 10 * DAY,
	favorite: false,
	launch_href: '#launch-calendar',
	...overrides
});

/** A mixed set: favourites, two categories, an image icon, a legacy SAML app, a fixed tile. */
export const launchers = (): AccountLauncher[] => [
	launcher({ favorite: true }),
	launcher({
		id: 'launcher-expenses',
		name: 'Expenses',
		description: 'Submit receipts and track reimbursements.',
		category: 'Finance',
		icon_value: 'chart-line-up',
		background_color: '#047857',
		open_in_new_tab: true,
		launch_href: '#launch-expenses'
	}),
	launcher({
		id: 'launcher-payroll',
		name: 'Payroll (legacy portal)',
		description: null,
		category: 'Finance',
		launch_type: 'saml_idp_initiated',
		icon_type: 'image',
		icon_value: providerIcon('#7c3aed', 'P'),
		launch_href: '#launch-payroll'
	}),
	launcher({
		id: 'launcher-mail',
		name: 'Mail',
		description: 'Company email.',
		category: null,
		icon_value: 'envelope-simple',
		icon_color: '#1f2937',
		background_color: '#fde68a',
		allow_favorite: false,
		launch_href: '#launch-mail'
	})
];

export const guestUpgradeStatus = (
	overrides: Partial<GuestUpgradeStatus> = {}
): GuestUpgradeStatus => ({
	registration_state: 'guest',
	status: 'active',
	deletion_due_at: (FIXTURE_NOW + 30 * DAY) / 1000,
	upgrade_hold_until: null,
	upgrade_eligible: true,
	allowed_methods: ['email', 'passkey'],
	upgrade_in_progress: false,
	profile_complete: false,
	...overrides
});

export const profile = (overrides: Partial<AccountProfile> = {}): AccountProfile => ({
	user_id: 'user-1',
	registration_state: 'registered',
	email: 'alice@example.com',
	email_verified: true,
	name: 'Alice Example',
	given_name: 'Alice',
	family_name: 'Example',
	locale: 'en',
	picture: null,
	...overrides
});

export const clientConsent = (
	overrides: Partial<AccountOAuthClientConsent> = {}
): AccountOAuthClientConsent => ({
	kind: 'oauth_client',
	id: 'consent-client-1',
	clientId: 'client-docs',
	clientName: 'Docs',
	scopes: ['openid', 'profile', 'email'],
	grantedAt: FIXTURE_NOW - 20 * DAY,
	policyVersions: { privacyPolicyVersion: '2026-04', tosVersion: '3.1' },
	...overrides
});

export const statementConsent = (
	overrides: Partial<AccountStatementConsent> = {}
): AccountStatementConsent => ({
	kind: 'statement',
	id: 'consent-statement-1',
	statementId: 'marketing-email',
	versionId: 'marketing-email-v2',
	version: '2',
	status: 'granted',
	title: 'Product news by email',
	category: 'Marketing',
	grantedAt: FIXTURE_NOW - 5 * DAY,
	updatedAt: FIXTURE_NOW - 5 * DAY,
	selectedValue: 'always',
	...overrides
});

export const operation = (overrides: Partial<AccountOperation> = {}): AccountOperation => ({
	id: 'operation-1',
	action: 'account.passkey.created',
	resource_type: 'passkey',
	resource_id: 'passkey-1',
	created_at: FIXTURE_NOW - 2 * 60 * 60 * 1000,
	...overrides
});
