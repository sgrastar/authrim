/**
 * How the system log names what it shows: a source and an event by the console's words where it
 * has them (`slog.src.<surface>`, `slog.ev.<event>`), otherwise by their code; and the options
 * of the source and severity filters.
 */
import type { AuditSeverity } from '#lib/api/admin-audit.js';
import type { SystemLogEntry, SystemLogResult } from '#lib/api/system-log.js';
import type { MessageKey } from '#lib/i18n/messages/ja.js';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
type HasMessage = (key: string) => boolean;

/** The sources the console knows, in the order the filter lists them. */
export const SYSTEM_LOG_SOURCES: readonly string[] = [
	'authrim/account_webhook_outbox',
	'authrim/directory_connector_heartbeat',
	'authrim/saml_metadata_scheduler'
];

/** `authrim/<surface>` → `<surface>`; anything else as it is. */
export function surfaceOf(source: string): string {
	return source.startsWith('authrim/') ? source.slice('authrim/'.length) : source;
}

/** The console's name for a source, or null to show its code. */
export function sourceLabelKey(source: string, hasMessage: HasMessage): MessageKey | null {
	const key = `slog.src.${surfaceOf(source)}`;
	return hasMessage(key) ? (key as MessageKey) : null;
}

/** A source as a person reads it: its name, else its code. */
export function sourceLabel(source: string, t: Translate, hasMessage: HasMessage): string {
	const key = sourceLabelKey(source, hasMessage);
	return key ? t(key) : surfaceOf(source);
}

/** The console's name for an event, or null to show its code. */
export function eventLabelKey(code: string, hasMessage: HasMessage): MessageKey | null {
	const key = `slog.ev.${code}`;
	return hasMessage(key) ? (key as MessageKey) : null;
}

/** An event as a person reads it: its name, else its code, else "unknown". Never empty. */
export function eventLabel(code: string, t: Translate, hasMessage: HasMessage): string {
	const key = eventLabelKey(code, hasMessage);
	if (key) return t(key);
	return code || t('slog.event.unknown');
}

/** The source filter's options: all sources, then the known ones (and `current`, if it is not one). */
export function sourceOptions(
	t: Translate,
	hasMessage: HasMessage,
	current = ''
): Array<{ value: string; label: string }> {
	const sources =
		current && !SYSTEM_LOG_SOURCES.includes(current)
			? [...SYSTEM_LOG_SOURCES, current]
			: SYSTEM_LOG_SOURCES;
	return [
		{ value: '', label: t('slog.filter.source.all') },
		...sources.map((source) => ({
			value: source,
			label: sourceLabelKey(source, hasMessage)
				? `${sourceLabel(source, t, hasMessage)} (${surfaceOf(source)})`
				: surfaceOf(source)
		}))
	];
}

export const SEVERITIES: readonly AuditSeverity[] = ['debug', 'info', 'warn', 'error', 'critical'];

export const SEVERITY_LABEL: Record<AuditSeverity, MessageKey> = {
	debug: 'slog.severity.debug',
	info: 'slog.severity.info',
	warn: 'slog.severity.warn',
	error: 'slog.severity.error',
	critical: 'slog.severity.critical'
};

/** A problem is a warning sign; only a count that asks for action takes the danger colour. */
export const SEVERITY_TONE: Record<AuditSeverity, 'neutral' | 'info' | 'warning'> = {
	debug: 'neutral',
	info: 'info',
	warn: 'warning',
	error: 'warning',
	critical: 'warning'
};

/** What the API accepts as a filter value: a name, a code or an ID. */
export const FILTER_VALUE_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/u;

/** Whether an event-name filter can be sent to the API (empty means "no filter"). */
export function isValidFilterValue(value: string): boolean {
	return value === '' || FILTER_VALUE_PATTERN.test(value);
}

/** The severity to show, or null for one the console does not know. */
export function severityOf(entry: Pick<SystemLogEntry, 'severity'>): AuditSeverity | null {
	return SEVERITIES.includes(entry.severity) ? entry.severity : null;
}

export const RESULT_LABEL: Record<SystemLogResult, MessageKey> = {
	success: 'slog.result.success',
	failure: 'slog.result.failure',
	partial: 'slog.result.partial'
};

export const RESULT_TONE: Record<SystemLogResult, 'success' | 'warning'> = {
	success: 'success',
	failure: 'warning',
	partial: 'warning'
};

/** The result to show, or null for one the console does not know. */
export function resultOf(entry: Pick<SystemLogEntry, 'result'>): SystemLogResult | null {
	return entry.result in RESULT_LABEL ? entry.result : null;
}

/** The details as indented JSON, or null when there is nothing to show. */
export function detailsJson(details: SystemLogEntry['details']): string | null {
	return details && typeof details === 'object' && Object.keys(details).length > 0
		? JSON.stringify(details, null, 2)
		: null;
}
