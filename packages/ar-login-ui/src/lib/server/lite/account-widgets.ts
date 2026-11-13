/**
 * The lite account page's widgets (lite plan PR7b): each one's data as the page draws it, read
 * from ar-management's account APIs as the SPA's widgets read them
 * (lib/components/account/widgets/*). Only what a widget shows is kept: no ID the page does not
 * post back, nothing of another person.
 */
import { accountReleaseRows } from '#lib/consent-release.js';
import { formatTimestamp } from '#lib/utils/date.js';
import type { liteMessages } from './messages';
import { record } from './totp-passkey';

type LL = Awaited<ReturnType<typeof liteMessages>>['LL'];

/**
 * A value the page shows, as the API answers it (no length of the page's own: the API's are its
 * limits), within a bound only against an answer that is not one.
 */
function text(value: unknown, max = 8192): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** An ID a form may post back (the APIs' ID shapes; never one of another shape). */
export function liteAccountItemId(value: unknown): string | null {
	return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(value) ? value : null;
}

export interface LiteAccountProfileView {
	name: string | null;
	email: string | null;
	emailVerified: boolean;
}

export function liteAccountProfile(json: Record<string, unknown>): LiteAccountProfileView {
	const profile = record(json.profile);
	return {
		name: text(profile.name),
		email: text(profile.email),
		emailVerified: profile.email_verified === true
	};
}

export interface LiteAccountSessionItem {
	id: string;
	title: string;
	current: boolean;
	location: string | null;
	signedInAt: string;
}

/** The region's English name (the SPA's `Intl.DisplayNames(['en'])`), else its code. */
function regionName(code: string | null): string | null {
	if (!code || !/^[A-Za-z]{2}$/u.test(code)) return null;
	try {
		return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
	} catch {
		return code;
	}
}

export function liteAccountSessions(
	json: Record<string, unknown>,
	LL: LL,
	locale: string
): LiteAccountSessionItem[] {
	// All of them (the API keeps this browser's session in the list whatever its age).
	const rows = Array.isArray(json.sessions) ? json.sessions : [];
	return rows.flatMap((raw) => {
		const row = record(raw);
		const id = liteAccountItemId(row.id);
		if (!id) return [];
		const title = [text(row.browser), text(row.os)].filter(Boolean).join(' / ');
		return [
			{
				id,
				title: title || LL.account_unknownDevice(),
				current: row.current === true,
				location: regionName(text(row.country_code)),
				signedInAt: formatTimestamp(row.created_at as number | null, locale)
			}
		];
	});
}

export interface LiteAccountDeviceItem {
	title: string;
	current: boolean;
	meta: string;
}

export function liteAccountDevices(
	json: Record<string, unknown>,
	locale: string
): LiteAccountDeviceItem[] {
	const rows = Array.isArray(json.devices) ? json.devices : [];
	return rows.flatMap((raw) => {
		const row = record(raw);
		const id = text(row.id, 256);
		if (!id) return [];
		return [
			{
				title: text(row.display_name) ?? text(row.fallback_display_name) ?? id,
				current: row.current === true,
				meta: `${text(row.platform) ?? ''} / ${formatTimestamp(
					row.last_seen_at_unix as number | null,
					locale
				)}`
			}
		];
	});
}

export type LiteAccountConsentItem =
	| {
			kind: 'oauth_client';
			title: string;
			subtitle: string;
			rows: Array<{ label: string; value: string }>;
	  }
	| {
			kind: 'statement';
			title: string;
			subtitle: string;
			rows: Array<{ label: string; value: string }>;
	  }
	| {
			kind: 'saml_sp';
			title: string;
			subtitle: string;
			rows: Array<{ label: string; value: string }>;
	  };

export function liteAccountConsents(
	json: Record<string, unknown>,
	LL: LL,
	locale: string
): LiteAccountConsentItem[] {
	// All of them (the SPA draws every one the API answers).
	const rows = Array.isArray(json.consents) ? json.consents : [];
	const when = (value: unknown) => formatTimestamp(value as number | null, locale);
	const expires = (value: unknown) =>
		typeof value === 'number' ? when(value) : LL.account_consentNoExpiry();
	return rows.flatMap((raw): LiteAccountConsentItem[] => {
		const row = record(raw);
		if (row.kind === 'saml_sp') {
			const spEntityId = text(row.spEntityId, 2048);
			if (!spEntityId) return [];
			return [
				{
					kind: 'saml_sp',
					title: text(row.spName) ?? spEntityId,
					subtitle: spEntityId,
					rows: [
						...accountReleaseRows(LL, row.informationRelease),
						{ label: LL.account_consentGrantedAt(), value: when(row.decidedAt) }
					]
				}
			];
		}
		if (row.kind === 'oauth_client') {
			const clientId = text(row.clientId, 1024);
			if (!clientId) return [];
			const scopes = (
				Array.isArray(row.selectedScopes) && row.selectedScopes.length > 0
					? row.selectedScopes
					: Array.isArray(row.scopes)
						? row.scopes
						: []
			).filter((scope): scope is string => typeof scope === 'string');
			const versions = record(row.policyVersions);
			const parts = [
				text(versions.privacyPolicyVersion)
					? `${LL.account_consentPrivacyPolicy()}: ${versions.privacyPolicyVersion as string}`
					: null,
				text(versions.tosVersion)
					? `${LL.account_consentTerms()}: ${versions.tosVersion as string}`
					: null,
				typeof versions.consentVersion === 'number'
					? `${LL.account_consentVersion()}: ${versions.consentVersion}`
					: null
			].filter(Boolean);
			return [
				{
					kind: 'oauth_client',
					title: text(row.clientName) ?? clientId,
					// (No logo: the lite page loads no image but its own, `img-src data:`.)
					subtitle: clientId,
					rows: [
						{ label: LL.account_consentScopes(), value: scopes.join(', ') || '-' },
						...accountReleaseRows(LL, row.informationRelease),
						{ label: LL.account_consentGrantedAt(), value: when(row.grantedAt) },
						{ label: LL.account_consentExpiresAt(), value: expires(row.expiresAt) },
						{ label: LL.account_consentPolicyVersions(), value: parts.join(' / ') || '-' }
					]
				}
			];
		}
		if (row.kind === 'statement') {
			const statementId = text(row.statementId, 1024);
			if (!statementId) return [];
			const statuses: Record<string, string> = {
				granted: LL.account_consentStatusGranted(),
				withdrawn: LL.account_consentStatusWithdrawn(),
				denied: LL.account_consentStatusDenied()
			};
			const selected: Record<string, string> = {
				once: LL.account_consentSelectedOnce(),
				always: LL.account_consentSelectedAlways(),
				none: LL.account_consentSelectedNone()
			};
			// (The sign-in Flow takes a choice's value up to 128 characters; the API answers it as kept.)
			const status = text(row.status) ?? '-';
			const value = text(row.selectedValue);
			return [
				{
					kind: 'statement',
					title: text(row.title) ?? statementId,
					subtitle: text(row.category) ?? statementId,
					rows: [
						{
							label: LL.account_consentStatus(),
							value: Object.hasOwn(statuses, status) ? statuses[status] : status
						},
						{ label: LL.account_consentVersionLabel(), value: text(row.version) ?? '-' },
						{ label: LL.account_consentStatementId(), value: statementId },
						...(value
							? [
									{
										label: LL.account_consentSelectedValue(),
										value: Object.hasOwn(selected, value) ? selected[value] : value
									}
								]
							: []),
						{ label: LL.account_consentGrantedAt(), value: when(row.grantedAt) },
						{ label: LL.account_consentExpiresAt(), value: expires(row.expiresAt) }
					]
				}
			];
		}
		return [];
	});
}

/** The audit actions the page describes (the SPA's ACTION_LABELS); others shown as recorded. */
function activityLabel(action: string, LL: LL): string {
	const labels: Record<string, () => string> = {
		'account.guest.created': LL.account_operationGuestCreated,
		'account.guest.upgrade_failed': LL.account_operationGuestUpgradeFailed,
		'account.guest.upgrade_started': LL.account_operationGuestUpgradeStarted,
		'account.guest.upgraded': LL.account_operationGuestUpgraded,
		'account.profile.name_updated': LL.account_operationNameUpdated,
		'account.email.added': LL.account_operationEmailAdded,
		'account.email.changed': LL.account_operationEmailChanged,
		'account.email.reauthenticated': LL.account_operationEmailReauthenticated,
		'account.device.updated': LL.account_operationDeviceUpdated,
		'account.device.unlinked': LL.account_operationDeviceUnlinked,
		'account.passkey.created': LL.account_operationPasskeyCreated,
		'account.passkey.updated': LL.account_operationPasskeyUpdated,
		'account.passkey.deleted': LL.account_operationPasskeyDeleted,
		'account.passkey.reauthenticated': LL.account_operationPasskeyReauthenticated,
		'account.totp.enrollment_started': LL.account_operationTotpEnrollmentStarted,
		'account.totp.activated': LL.account_operationTotpActivated,
		'account.totp.updated': LL.account_operationTotpUpdated,
		'account.totp.removed': LL.account_operationTotpRemoved,
		'account.totp.backup_codes_regenerated': LL.account_operationTotpBackupCodesRegenerated,
		'account.totp.reauthenticated': LL.account_operationTotpReauthenticated,
		'account.session.revoked': LL.account_operationSessionRevoked,
		'account.social_account.linked': LL.account_operationSocialLinked,
		'account.social_account.unlinked': LL.account_operationSocialUnlinked
	};
	return Object.hasOwn(labels, action) ? labels[action]() : action;
}

export interface LiteAccountActivity {
	items: Array<{ id: string; label: string; at: string; iso: string | null }>;
	/** The next page's cursor (a link to it), when there is one. */
	nextCursor: string | null;
}

export function liteAccountActivity(
	json: Record<string, unknown>,
	LL: LL,
	locale: string
): LiteAccountActivity {
	const rows = Array.isArray(json.operations) ? json.operations.slice(0, 100) : [];
	const seen = new Set<string>();
	const items = rows.flatMap((raw) => {
		const row = record(raw);
		const id = text(row.id, 256);
		const action = text(row.action);
		if (!id || !action || seen.has(id)) return [];
		seen.add(id);
		const seconds = typeof row.created_at === 'number' ? row.created_at : null;
		const millis = seconds === null ? null : seconds < 1e12 ? seconds * 1000 : seconds;
		return [
			{
				id,
				label: activityLabel(action, LL),
				at: formatTimestamp(seconds, locale),
				iso: millis === null || !Number.isFinite(millis) ? null : new Date(millis).toISOString()
			}
		];
	});
	const pagination = record(json.pagination);
	const cursor = text(pagination.next_cursor, 1024);
	return {
		items,
		nextCursor:
			pagination.has_more !== false && cursor && /^[A-Za-z0-9_.~=-]+$/u.test(cursor) ? cursor : null
	};
}

export interface LiteAccountPasskeyItem {
	id: string;
	name: string;
	createdAt: string;
}

/** The passkeys (named by their provider, as the SPA; their device name and ID not shown). */
export function liteAccountPasskeys(
	json: Record<string, unknown>,
	LL: LL,
	locale: string
): LiteAccountPasskeyItem[] {
	const rows = Array.isArray(json.passkeys) ? json.passkeys : [];
	return rows.flatMap((raw) => {
		const row = record(raw);
		const id = liteAccountItemId(row.id);
		if (!id) return [];
		return [
			{
				id,
				name: text(record(row.provider).name) ?? LL.account_passkeys(),
				createdAt: formatTimestamp(row.created_at as number | null, locale)
			}
		];
	});
}
