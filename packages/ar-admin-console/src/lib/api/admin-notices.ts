/**
 * The admin notices API: what the header's notification area and the Notifications page read.
 * `GET /api/admin/notices` lists the signed-in admin's open notices for the selected tenant;
 * the other calls read, dismiss (information only), resolve (the rest) and publish one.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import type { MessageKey } from '#lib/i18n/messages/ja.js';
import { formatTime, type TimeZoneMode } from '#lib/ui/time/format-time.js';
import type { NotificationSeverity, ShellNotification } from '#lib/shell/notifications.js';
import { notificationHref } from '#lib/shell/notifications.js';

export type NoticeScope = 'platform' | 'tenant' | 'client' | 'admin_user';
export type NoticeSource = 'system' | 'announcement';

/** A notice as the Admin API returns it. */
export interface AdminNotice {
	id: string;
	scope_type: NoticeScope;
	tenant_id: string | null;
	client_id: string | null;
	admin_user_id: string | null;
	severity: NotificationSeverity;
	source: NoticeSource;
	category: string;
	/** Console message key suffix (`notice.msg.<key>`) for system notices. */
	message_key: string | null;
	params: Record<string, string | number>;
	title: string;
	body: string | null;
	/** A console path starting with `/admin/`. */
	link: string | null;
	created_by: string | null;
	created_at: number;
	expires_at: number | null;
	resolved_at: number | null;
	resolved_by: string | null;
	/** Only information can be dismissed; the others are resolved. */
	dismissible: boolean;
}

export interface PublishNoticeInput {
	scope_type: NoticeScope;
	client_id?: string;
	admin_user_id?: string;
	severity: NotificationSeverity;
	title: string;
	body?: string;
	link?: string;
	/** Epoch milliseconds. */
	expires_at?: number;
}

export interface AdminNoticesClient {
	list(signal?: AbortSignal): Promise<AdminNotice[]>;
	get(id: string, signal?: AbortSignal): Promise<AdminNotice>;
	dismiss(id: string): Promise<void>;
	resolve(id: string): Promise<AdminNotice>;
	publish(input: PublishNoticeInput): Promise<AdminNotice>;
}

export const TITLE_MAX = 200;
export const BODY_MAX = 2000;

// ---------------------------------------------------------------------------------------------
// From the wire

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value !== null && typeof value === 'object' ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const orNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
const numOrNull = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;

const SEVERITY: readonly NotificationSeverity[] = ['critical', 'high', 'caution', 'info'];
const SCOPES: readonly NoticeScope[] = ['platform', 'tenant', 'client', 'admin_user'];

export function noticeFromRow(value: unknown): AdminNotice {
	const row = record(value);
	const severity = SEVERITY.find((item) => item === row.severity) ?? 'info';
	const params: Record<string, string | number> = {};
	for (const [key, item] of Object.entries(record(row.params))) {
		if (typeof item === 'string' || typeof item === 'number') params[key] = item;
	}
	return {
		id: text(row.id),
		scope_type: SCOPES.find((item) => item === row.scope_type) ?? 'tenant',
		tenant_id: orNull(row.tenant_id),
		client_id: orNull(row.client_id),
		admin_user_id: orNull(row.admin_user_id),
		severity,
		source: row.source === 'system' ? 'system' : 'announcement',
		category: text(row.category),
		message_key: orNull(row.message_key),
		params,
		title: text(row.title),
		body: orNull(row.body),
		link: orNull(row.link),
		created_by: orNull(row.created_by),
		created_at: numOrNull(row.created_at) ?? 0,
		expires_at: numOrNull(row.expires_at),
		resolved_at: numOrNull(row.resolved_at),
		resolved_by: orNull(row.resolved_by),
		// Only information can be dismissed, whatever an older API says.
		dismissible: row.dismissible === true && severity === 'info'
	};
}

// ---------------------------------------------------------------------------------------------
// To the page and the header

/** A link that stays inside the console. */
export const isConsolePath = (value: string | null | undefined): value is string =>
	typeof value === 'string' && value.startsWith('/admin/') && !value.startsWith('//');

export interface NoticeTextContext {
	t: (key: MessageKey, params?: Record<string, string | number>) => string;
	hasMessage: (key: string) => boolean;
}

/** The localized message of a system notice, otherwise the title it was published with. */
export function noticeText(notice: AdminNotice, ctx: NoticeTextContext): string {
	if (notice.message_key) {
		const key = `notice.msg.${notice.message_key}`;
		if (ctx.hasMessage(key)) return ctx.t(key as MessageKey, notice.params);
	}
	return notice.title;
}

export interface NoticeShellContext extends NoticeTextContext {
	locale: string;
	zone: TimeZoneMode;
}

export function noticeToShell(notice: AdminNotice, ctx: NoticeShellContext): ShellNotification {
	return {
		id: notice.id,
		severity: notice.severity,
		text: noticeText(notice, ctx),
		time: formatTime(notice.created_at, { locale: ctx.locale, zone: ctx.zone })?.text
	};
}

/** Where the header sends a notice: its own page, which shows the detail and the link. */
export const noticeHref = notificationHref;

// ---------------------------------------------------------------------------------------------
// Over HTTP

const BASE = `${API_BASE_URL}/api/admin/notices`;

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	return record(await response.json().catch(() => ({})));
}

export const httpAdminNotices: AdminNoticesClient = {
	async list(signal) {
		const body = await readJson(await adminFetch(BASE, { signal }));
		return (Array.isArray(body.items) ? body.items : []).map(noticeFromRow);
	},
	async get(id, signal) {
		const body = await readJson(await adminFetch(`${BASE}/${encodeURIComponent(id)}`, { signal }));
		return noticeFromRow(body.notice);
	},
	async dismiss(id) {
		const response = await adminFetch(`${BASE}/${encodeURIComponent(id)}/dismiss`, {
			method: 'POST'
		});
		if (!response.ok) throw await errorFromResponse(response);
	},
	async resolve(id) {
		const body = await readJson(
			await adminFetch(`${BASE}/${encodeURIComponent(id)}/resolve`, { method: 'POST' })
		);
		return noticeFromRow(body.notice);
	},
	async publish(input) {
		const body = await readJson(
			await adminFetch(BASE, {
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			})
		);
		return noticeFromRow(body.notice);
	}
};

/** The API's own code of a failed call (`notice_resolved`…); a 409 keeps it in the body. */
export function noticeErrorCode(error: unknown): string {
	if (error !== null && typeof error === 'object' && 'body' in error) {
		const code = record((error as { body: unknown }).body).error;
		if (typeof code === 'string') return code;
	}
	return error !== null && typeof error === 'object' && 'code' in error
		? text((error as { code: unknown }).code)
		: '';
}
