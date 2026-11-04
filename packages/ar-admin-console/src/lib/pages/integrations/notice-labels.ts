import { noticeErrorCode, type AdminNotice } from '#lib/api/admin-notices.js';
import { ApiError } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { NotificationSeverity } from '#lib/shell/notifications.js';

export const SEVERITY_LABEL: Record<NotificationSeverity, MessageKey> = {
	critical: 'nt.severity.critical',
	high: 'nt.severity.high',
	caution: 'nt.severity.caution',
	info: 'nt.severity.info'
};

/** A failure is a warning, not a red badge; information is blue; a caution is plain. */
export const SEVERITY_TONE: Record<NotificationSeverity, 'warning' | 'neutral' | 'info'> = {
	critical: 'warning',
	high: 'warning',
	caution: 'neutral',
	info: 'info'
};

export function scopeLabel(
	notice: AdminNotice,
	t: (key: MessageKey, params?: Record<string, string | number>) => string
): string {
	switch (notice.scope_type) {
		case 'platform':
			return t('nt.scope.platform');
		case 'client':
			return notice.client_id
				? t('nt.scope.client.id', { id: notice.client_id })
				: t('nt.scope.client');
		case 'admin_user':
			return t('nt.scope.admin_user');
		default:
			return t('nt.scope.tenant');
	}
}

/** What to tell the admin when an action on a notice failed. */
export function actionErrorKey(error: unknown): MessageKey {
	const code = noticeErrorCode(error);
	if (code === 'notice_resolved') return 'nt.err.resolved';
	if (code === 'notice_not_dismissible') return 'nt.err.notDismissible';
	if (error instanceof ApiError) {
		if (error.status === 403) return 'nt.err.forbidden';
		if (error.status === 404) return 'nt.err.notFound';
	}
	return 'nt.err.generic';
}
