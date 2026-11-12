/**
 * The parts of a fictional end user beyond the profile: how they sign in, their sessions and
 * their recent activity. Derived from the user, so the same person always has the same ones.
 */
import { FIRST_PARTY_AAGUID_AUTHENTICATORS } from '@authrim/ar-lib-core/webauthn/aaguid-first-party';
import type {
	AdminUser,
	AdminUserActivityEntry,
	AdminUserPasskey,
	AdminUserSession,
	AdminUserTotp
} from '../admin-users';

export interface UserExtras {
	passkeys: AdminUserPasskey[];
	totp: AdminUserTotp[];
	sessions: AdminUserSession[];
	activity: AdminUserActivityEntry[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const AGENTS = [
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
];

const EVENTS: Array<[string, 'success' | 'failure']> = [
	['auth.passkey.succeeded', 'success'],
	['session.user.created', 'success'],
	['token.access.issued', 'success'],
	['auth.totp.failed', 'failure'],
	['auth.login.succeeded', 'success'],
	['consent.granted', 'success'],
	['user.sessions_revoked', 'success'],
	['auth.email_code.failed', 'failure'],
	['token.refresh.rotated', 'success'],
	['session.user.destroyed', 'success'],
	['auth.login.succeeded', 'success'],
	['user.updated', 'success']
];

/** A stand-in logo (a plain shape, not a real brand mark) in the data-URI form the API ships. */
function demoLogo(shape: string, color: string): { light: string; dark: string } {
	const uri = `data:image/svg+xml;utf8,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${shape.replace('COLOR', color)}</svg>`
	)}`;
	return { light: uri, dark: uri };
}

/** The Authrim Keyring entry, shared with the server's first-party AAGUID table (type-only link to the big table). */
const KEYRING = FIRST_PARTY_AAGUID_AUTHENTICATORS['6f1c5e2a-7b4d-4e8f-9a3c-2d5b8e1f0a47']!;
const KEYRING_ICON = { light: KEYRING.icon_light!, dark: KEYRING.icon_dark! };

/** Passkeys as the stories and the dev mock show them: logos of two makers, one without, one unknown. */
export const SAMPLE_AUTHENTICATORS: readonly {
	device: string;
	provider: string | null;
	icon: AdminUserPasskey['providerIcon'];
}[] = [
	{
		device: 'MacBook Pro',
		provider: 'iCloud Keychain',
		icon: demoLogo('<circle cx="128" cy="128" r="96" fill="COLOR"/>', 'steelblue')
	},
	{
		device: 'Pixel 9',
		provider: 'Google Password Manager',
		icon: demoLogo(
			'<rect x="32" y="32" width="192" height="192" rx="48" fill="COLOR"/>',
			'seagreen'
		)
	},
	{ device: 'iPhone 16', provider: 'Authrim Keyring', icon: KEYRING_ICON },
	{ device: 'YubiKey 5C', provider: 'YubiKey', icon: null },
	{ device: 'Work laptop', provider: null, icon: null }
];

/** A number from the user's id, so that what is made up for them does not change. */
function seedOf(user: AdminUser): number {
	return [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

/** `now` is the time the fictional history ends at. */
export function sampleExtras(user: AdminUser, now: number): UserExtras {
	const seed = seedOf(user);
	const restricted = user.lifecycle_state === 'suspended' || user.lifecycle_state === 'locked';
	const hasHistory =
		user.pii_status === 'active' && user.lifecycle_state !== 'deprovisioned'
			? user.last_login_at !== null
			: false;
	if (!hasHistory) return { passkeys: [], totp: [], sessions: [], activity: [] };
	const created = user.created_at ?? now - 30 * DAY;
	const last = user.last_login_at ?? now;
	const first = SAMPLE_AUTHENTICATORS[seed % SAMPLE_AUTHENTICATORS.length]!;
	const passkeys: AdminUserPasskey[] = [
		{
			id: `pk_${user.id}_1`,
			deviceName: seed % 3 === 0 ? null : first.device,
			provider: first.provider,
			providerIcon: first.icon,
			createdAt: created + HOUR,
			lastUsedAt: last
		}
	];
	if (seed % 2 === 0) {
		const second = SAMPLE_AUTHENTICATORS[(seed + 1) % SAMPLE_AUTHENTICATORS.length]!;
		passkeys.push({
			id: `pk_${user.id}_2`,
			deviceName: second.device,
			provider: second.provider,
			providerIcon: second.icon,
			createdAt: created + 3 * DAY,
			lastUsedAt: null
		});
	}
	const totp: AdminUserTotp[] =
		seed % 4 === 0
			? [
					{
						id: `totp_${user.id}_1`,
						label: 'Authenticator app',
						status: 'active',
						createdAt: created + 2 * DAY,
						lastUsedAt: last - 2 * DAY
					}
				]
			: [];
	const sessions: AdminUserSession[] = restricted
		? []
		: Array.from({ length: 1 + (seed % 3) }, (_, index) => ({
				id: `ses_${user.id}_${index}`,
				createdAt: last - index * 9 * HOUR,
				lastActiveAt: last - index * 5 * HOUR + 20 * 60_000,
				expiresAt: now + (24 - index * 5) * HOUR,
				ipAddress: `203.0.113.${(seed + index * 17) % 250}`,
				userAgent: AGENTS[(seed + index) % AGENTS.length]
			}));
	const activity: AdminUserActivityEntry[] = EVENTS.map(([action, result], index) => ({
		id: `act_${user.id}_${index}`,
		action,
		result,
		at: last - index * 7 * HOUR - (seed % 11) * 60_000,
		ipAddress: `203.0.113.${(seed + index) % 250}`
	}));
	return { passkeys, totp, sessions, activity };
}
