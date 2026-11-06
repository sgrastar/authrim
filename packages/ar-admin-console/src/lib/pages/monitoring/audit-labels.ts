/**
 * How the admin activity names what it shows: an operation by the console's words where it has
 * them (`aud.action.<action>`), otherwise by its API name; who did it; and, for a step-up, which
 * operation was checked and how strongly.
 */
import type { AdminAuditEntry, AuditResult, AuditSeverity } from '#lib/api/admin-audit.js';
import type { MessageKey } from '#lib/i18n/messages/ja.js';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The console's name for an action, or null to show the API's own (`settings.update`). */
export function actionLabelKey(
	action: string,
	hasMessage: (key: string) => boolean
): MessageKey | null {
	const key = `aud.action.${action}`;
	return hasMessage(key) ? (key as MessageKey) : null;
}

export const RESULT_LABEL: Record<AuditResult, MessageKey> = {
	success: 'aud.result.success',
	failure: 'aud.result.failure'
};

export const RESULT_TONE: Record<AuditResult, 'success' | 'warning'> = {
	success: 'success',
	failure: 'warning'
};

export const SEVERITY_LABEL: Record<AuditSeverity, MessageKey> = {
	debug: 'aud.severity.debug',
	info: 'aud.severity.info',
	warn: 'aud.severity.warn',
	error: 'aud.severity.error',
	critical: 'aud.severity.critical'
};

/** Who did it, as a person reads it: their name, else their email, else the actor's id. */
export function actorName(entry: AdminAuditEntry, t: Translate): string {
	return (
		entry.actor_display_name ||
		entry.admin_user_name ||
		entry.admin_email ||
		entry.actor_id ||
		entry.admin_user_id ||
		t('aud.actor.unknown')
	);
}

/** A badge for callers that are not people (a machine, an agent); null for an admin user. */
export function actorKindKey(entry: AdminAuditEntry): MessageKey | null {
	if (entry.actor_type === 'machine') return 'aud.actor.machine';
	if (entry.actor_type === 'agent') return 'aud.actor.agent';
	return null;
}

export interface StepUpFacts {
	/** The catalog name of the operation the step-up was for (`admin.role.grant`). */
	operation: string;
	level: 'L1' | 'L2';
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** What a step-up entry checked, or null for an entry that is not a step-up. */
export function stepUpFacts(entry: AdminAuditEntry): StepUpFacts | null {
	if (!isStepUp(entry.action)) return null;
	const operation = text(entry.metadata?.operation);
	const level = entry.metadata?.level;
	if (!operation || (level !== 'L1' && level !== 'L2')) return null;
	return { operation, level };
}

/** Actions that record a step-up (`admin.step_up.receipt_issued`, and any added later). */
export function isStepUp(action: string): boolean {
	return action.startsWith('admin.step_up.') || action.startsWith('admin_step_up.');
}

/** Metadata keys a step-up entry shows in their own rows, left out of "More information". */
export const STEP_UP_KEYS: readonly string[] = ['operation', 'level'];
