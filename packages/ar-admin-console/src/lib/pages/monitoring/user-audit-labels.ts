/**
 * How the end-user event log names what it shows: an event by the console's words where it has
 * them (`uaud.ev.<event>`), otherwise by its code; and the common events, grouped, for the event
 * filter.
 */
import type { AuditResult } from '#lib/api/admin-audit.js';
import type { UserAuditEntry } from '#lib/api/user-audit.js';
import type { MessageKey } from '#lib/i18n/messages/ja.js';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
type HasMessage = (key: string) => boolean;

/** Only orders the event filter's options; the groups are not shown. */
export type UserAuditGroup =
	| 'signin'
	| 'session'
	| 'token'
	| 'consent'
	| 'account'
	| 'security'
	| 'other';

/** The events an admin most often looks for, in the order the filter lists them. */
export const USER_AUDIT_EVENTS: Readonly<Record<UserAuditGroup, readonly string[]>> = {
	signin: [
		'auth.login.succeeded',
		'auth.login.failed',
		'auth.passkey.succeeded',
		'auth.passkey.failed',
		'auth.password.succeeded',
		'auth.password.failed',
		'auth.email_code.succeeded',
		'auth.email_code.failed',
		'auth.totp.succeeded',
		'auth.totp.failed',
		'auth.magic_link.succeeded',
		'auth.magic_link.failed',
		'auth.external_idp.succeeded',
		'auth.external_idp.failed',
		'auth.saml.succeeded',
		'auth.saml.failed'
	],
	session: [
		'session.user.created',
		'session.user.destroyed',
		'session.user.refreshed',
		'user.logout',
		'user.sessions_revoked'
	],
	token: [
		'token.access.issued',
		'token.access.revoked',
		'token.refresh.issued',
		'token.refresh.rotated',
		'token.refresh.revoked',
		'token.batch.revoked'
	],
	consent: ['consent.granted', 'consent.denied', 'consent.revoked', 'user.consent_revoked'],
	account: [
		'user.created',
		'user.updated',
		'user.deleted',
		'user.password_changed',
		'user.email_verified',
		'account.email.changed',
		'user.activate',
		'user.suspend',
		'user.lock',
		'user.anonymized',
		'user.pii_deleted'
	],
	security: [
		'security.rate_limit.exceeded',
		'security.suspicious.login_attempt',
		'security.suspicious.credential_stuffing',
		'security.account.locked',
		'security.account.unlocked'
	],
	other: ['user.downstream_logout', 'user.downstream_logout_failed']
};

/** Every labelled event, grouped order. */
export const COMMON_USER_AUDIT_EVENTS: readonly string[] = Object.values(USER_AUDIT_EVENTS).flat();

/** The console's name for an event, or null to show its code. */
export function eventLabelKey(code: string, hasMessage: HasMessage): MessageKey | null {
	const key = `uaud.ev.${code}`;
	return hasMessage(key) ? (key as MessageKey) : null;
}

/** An event as a person reads it: its name, else its code, else "unknown". Never empty. */
export function eventLabel(code: string, t: Translate, hasMessage: HasMessage): string {
	const key = eventLabelKey(code, hasMessage);
	if (key) return t(key);
	return code || t('uaud.event.unknown');
}

/** The event filter's options: all events, then the common ones (and `current`, if it is not one). */
export function eventOptions(
	t: Translate,
	hasMessage: HasMessage,
	current = ''
): Array<{ value: string; label: string }> {
	const codes =
		current && !COMMON_USER_AUDIT_EVENTS.includes(current)
			? [...COMMON_USER_AUDIT_EVENTS, current]
			: COMMON_USER_AUDIT_EVENTS;
	return [
		{ value: '', label: t('uaud.filter.event.all') },
		...codes.map((code) => ({
			value: code,
			label: eventLabelKey(code, hasMessage) ? `${eventLabel(code, t, hasMessage)} (${code})` : code
		}))
	];
}

export const RESULT_LABEL: Record<AuditResult, MessageKey> = {
	success: 'uaud.result.success',
	failure: 'uaud.result.failure'
};

export const RESULT_TONE: Record<AuditResult, 'success' | 'warning'> = {
	success: 'success',
	failure: 'warning'
};

/** The result to show, or null when the event has none (or one the console does not know). */
export function resultOf(entry: Pick<UserAuditEntry, 'result'>): AuditResult | null {
	return entry.result === 'success' || entry.result === 'failure' ? entry.result : null;
}

export const SEVERITY_LABEL: Record<string, MessageKey> = {
	debug: 'uaud.severity.debug',
	info: 'uaud.severity.info',
	warn: 'uaud.severity.warn',
	error: 'uaud.severity.error',
	critical: 'uaud.severity.critical'
};

/** A metadata object as indented JSON, or null when there is nothing to show. */
export function metadataJson(metadata: UserAuditEntry['metadata']): string | null {
	return metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0
		? JSON.stringify(metadata, null, 2)
		: null;
}
