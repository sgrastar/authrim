/**
 * The lite account page's widgets (lite plan PR7b): each one's data as the page draws it, read
 * from ar-management's account APIs as the SPA's widgets read them
 * (lib/components/account/widgets/*). Only what a widget shows is kept: no ID the page does not
 * post back, nothing of another person.
 */
import { formatTimestamp } from '#lib/utils/date.js';
import type { liteMessages } from './messages';
import { record } from './totp-passkey';

type LL = Awaited<ReturnType<typeof liteMessages>>['LL'];

function text(value: unknown, max = 512): string | null {
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
		name: text(profile.name, 200),
		email: text(profile.email, 320),
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
	const rows = Array.isArray(json.sessions) ? json.sessions.slice(0, 100) : [];
	return rows.flatMap((raw) => {
		const row = record(raw);
		const id = liteAccountItemId(row.id);
		if (!id) return [];
		const title = [text(row.browser, 100), text(row.os, 100)].filter(Boolean).join(' / ');
		return [
			{
				id,
				title: title || LL.account_unknownDevice(),
				current: row.current === true,
				location: regionName(text(row.country_code, 8)),
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
	const rows = Array.isArray(json.devices) ? json.devices.slice(0, 100) : [];
	return rows.flatMap((raw) => {
		const row = record(raw);
		const id = text(row.id, 256);
		if (!id) return [];
		return [
			{
				title: text(row.display_name, 200) ?? text(row.fallback_display_name, 200) ?? id,
				current: row.current === true,
				meta: `${text(row.platform, 100) ?? ''} / ${formatTimestamp(
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
	  };

export function liteAccountConsents(
	json: Record<string, unknown>,
	LL: LL,
	locale: string
): LiteAccountConsentItem[] {
	const rows = Array.isArray(json.consents) ? json.consents.slice(0, 200) : [];
	const when = (value: unknown) => formatTimestamp(value as number | null, locale);
	const expires = (value: unknown) =>
		typeof value === 'number' ? when(value) : LL.account_consentNoExpiry();
	return rows.flatMap((raw): LiteAccountConsentItem[] => {
		const row = record(raw);
		if (row.kind === 'oauth_client') {
			const clientId = text(row.clientId, 256);
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
				text(versions.privacyPolicyVersion, 64)
					? `${LL.account_consentPrivacyPolicy()}: ${versions.privacyPolicyVersion as string}`
					: null,
				text(versions.tosVersion, 64)
					? `${LL.account_consentTerms()}: ${versions.tosVersion as string}`
					: null,
				typeof versions.consentVersion === 'number'
					? `${LL.account_consentVersion()}: ${versions.consentVersion}`
					: null
			].filter(Boolean);
			return [
				{
					kind: 'oauth_client',
					title: text(row.clientName, 200) ?? clientId,
					// (No logo: the lite page loads no image but its own, `img-src data:`.)
					subtitle: clientId,
					rows: [
						{ label: LL.account_consentScopes(), value: scopes.join(', ') || '-' },
						{ label: LL.account_consentGrantedAt(), value: when(row.grantedAt) },
						{ label: LL.account_consentExpiresAt(), value: expires(row.expiresAt) },
						{ label: LL.account_consentPolicyVersions(), value: parts.join(' / ') || '-' }
					]
				}
			];
		}
		if (row.kind === 'statement') {
			const statementId = text(row.statementId, 256);
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
			const status = text(row.status, 64) ?? '-';
			const value = text(row.selectedValue, 64);
			return [
				{
					kind: 'statement',
					title: text(row.title, 200) ?? statementId,
					subtitle: text(row.category, 200) ?? statementId,
					rows: [
						{
							label: LL.account_consentStatus(),
							value: Object.hasOwn(statuses, status) ? statuses[status] : status
						},
						{ label: LL.account_consentVersionLabel(), value: text(row.version, 64) ?? '-' },
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
		const action = text(row.action, 200);
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
