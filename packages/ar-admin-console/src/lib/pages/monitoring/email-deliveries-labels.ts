/**
 * How the email deliveries page names what it shows: a status by its words and tone, a kind of
 * message by the console's words where it has them (`edel.kind.<kind>`), otherwise by its code.
 */
import {
	EMAIL_DELIVERY_STATUSES,
	type EmailDelivery,
	type EmailDeliveryStatus
} from '#lib/api/email-deliveries.js';
import type { MessageKey } from '#lib/i18n/messages/ja.js';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
type HasMessage = (key: string) => boolean;
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const STATUSES = EMAIL_DELIVERY_STATUSES;

export const STATUS_LABEL: Record<EmailDeliveryStatus, MessageKey> = {
	requested: 'edel.status.requested',
	retrying: 'edel.status.retrying',
	provider_accepted: 'edel.status.provider_accepted',
	delivered: 'edel.status.delivered',
	deferred: 'edel.status.deferred',
	bounced: 'edel.status.bounced',
	failed: 'edel.status.failed',
	rejected: 'edel.status.rejected',
	complained: 'edel.status.complained',
	unknown: 'edel.status.unknown',
	expired: 'edel.status.expired',
	canceled: 'edel.status.canceled'
};

/** Green once the provider reported delivery, red when the message will not arrive. */
export const STATUS_TONE: Record<EmailDeliveryStatus, Tone> = {
	requested: 'neutral',
	retrying: 'warning',
	provider_accepted: 'info',
	delivered: 'success',
	deferred: 'warning',
	bounced: 'danger',
	failed: 'danger',
	rejected: 'danger',
	complained: 'danger',
	unknown: 'neutral',
	expired: 'neutral',
	canceled: 'neutral'
};

export function isEmailDeliveryStatus(value: string): value is EmailDeliveryStatus {
	return (STATUSES as readonly string[]).includes(value);
}

/** The status of a record, or null when the API answered one the console does not know. */
export function statusOf(item: EmailDelivery): EmailDeliveryStatus | null {
	return isEmailDeliveryStatus(item.status) ? item.status : null;
}

/** The console's name for a kind of message, or null to show its code. */
export function kindLabelKey(kind: string, hasMessage: HasMessage): MessageKey | null {
	const key = `edel.kind.${kind}`;
	return hasMessage(key) ? (key as MessageKey) : null;
}

/** A kind of message as a person reads it: its name, else its code. Never empty. */
export function kindLabel(kind: string, t: Translate, hasMessage: HasMessage): string {
	const key = kindLabelKey(kind, hasMessage);
	if (key) return t(key);
	return kind || t('edel.kind.unknown');
}

/** The status filter's options: every status, then the known ones. */
export function statusOptions(t: Translate): Array<{ value: string; label: string }> {
	return [
		{ value: '', label: t('edel.filter.status.all') },
		...STATUSES.map((status) => ({ value: status, label: t(STATUS_LABEL[status]) }))
	];
}
