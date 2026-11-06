/**
 * The admin audit log: what administrators (and machine and agent callers) did in the selected
 * tenant. `GET /api/admin/admin-audit-log` lists entries newest first with filters
 * (`admin:admin_audit:read`); `GET /api/admin/admin-audit-log/{id}` adds what changed, before
 * and after (`admin:admin_audit:detail:read`, and the read is itself audited, so it is asked
 * for, not loaded with every row).
 *
 * The list pages by number (`page`, `totalPages`) where rows are read from the database, and by
 * cursor (`pagination.next_cursor`, no total) where they are read from the log archive; the
 * client gives both as one `next` position.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

export type AuditResult = 'success' | 'failure';
export type AuditSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

/** One entry, as the Admin API returns it (`AdminAuditLogEntryBase`). */
export interface AdminAuditEntry {
	id: string;
	tenant_id?: string;
	admin_user_id?: string | null;
	admin_email?: string | null;
	admin_user_name?: string | null;
	/** `admin_user`, `machine` or `agent`. */
	actor_type?: string;
	actor_id?: string | null;
	actor_display_name?: string | null;
	action: string;
	resource_type?: string | null;
	resource_id?: string | null;
	result: AuditResult;
	severity?: AuditSeverity;
	error_code?: string | null;
	error_message?: string | null;
	ip_address?: string | null;
	user_agent?: string | null;
	request_id?: string | null;
	session_id?: string | null;
	metadata?: Record<string, unknown> | null;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	/** Epoch milliseconds. */
	created_at: number;
}

/** Where the next page starts. */
export type AuditPosition = { page: number } | { cursor: string };

export interface AdminAuditQuery {
	/** Only this admin user (`admin_user_id`). */
	actor?: string;
	action?: string;
	result?: AuditResult;
	from?: Date;
	to?: Date;
	/** Where to start; the first page when omitted. */
	at?: AuditPosition;
	limit?: number;
}

export interface AdminAuditPage {
	items: AdminAuditEntry[];
	/** All matching entries; null when the archive is read (cursor pages give no total). */
	total: number | null;
	next: AuditPosition | null;
	/** The newest entries may not be readable yet: the archive view catches up later. */
	mayLag: boolean;
}

export interface AdminAuditClient {
	list(query: AdminAuditQuery, signal?: AbortSignal): Promise<AdminAuditPage>;
	/** Action names seen in this tenant, for the action filter. */
	actions(signal?: AbortSignal): Promise<string[]>;
	/** One entry with what changed (before / after). */
	get(id: string, createdAt?: number, signal?: AbortSignal): Promise<AdminAuditEntry>;
}

export const AUDIT_PAGE_SIZE = 50;

/** The query string of a list request. */
export function auditListParams(query: AdminAuditQuery): URLSearchParams {
	const params = new URLSearchParams();
	params.set('limit', String(query.limit ?? AUDIT_PAGE_SIZE));
	if (query.at && 'cursor' in query.at) params.set('cursor', query.at.cursor);
	else params.set('page', String(query.at?.page ?? 1));
	if (query.actor) params.set('admin_user_id', query.actor);
	if (query.action) params.set('action', query.action);
	if (query.result) params.set('result', query.result);
	// Instants, not days: the API reads a bare date as the whole day.
	if (query.from) params.set('start_date', query.from.toISOString());
	if (query.to) params.set('end_date', query.to.toISOString());
	return params;
}

interface ListBody {
	items?: AdminAuditEntry[];
	total?: number;
	page?: number;
	totalPages?: number;
	pagination?: { has_more?: boolean; next_cursor?: string | null };
	coverage?: { consistency?: string; pending_deliveries?: number | null };
}

/** A list response, in either of its two page shapes, as one page. */
export function auditPageFrom(body: ListBody): AdminAuditPage {
	const items = Array.isArray(body.items) ? body.items : [];
	const mayLag =
		body.coverage?.consistency === 'eventual' || (body.coverage?.pending_deliveries ?? 0) > 0;
	if (body.pagination) {
		const cursor = body.pagination.next_cursor;
		return {
			items,
			total: null,
			next: body.pagination.has_more && cursor ? { cursor } : null,
			mayLag
		};
	}
	const page = body.page ?? 1;
	const pages = body.totalPages ?? 1;
	return {
		items,
		total: typeof body.total === 'number' ? body.total : items.length,
		next: page < pages ? { page: page + 1 } : null,
		mayLag
	};
}

const BASE = '/api/admin/admin-audit-log';

export const httpAdminAudit: AdminAuditClient = {
	async list(query, signal) {
		const response = await adminFetch(`${API_BASE_URL}${BASE}?${auditListParams(query)}`, {
			signal
		});
		if (!response.ok) throw await errorFromResponse(response);
		return auditPageFrom((await response.json()) as ListBody);
	},
	async actions(signal) {
		const response = await adminFetch(`${API_BASE_URL}${BASE}/actions/list`, { signal });
		if (!response.ok) throw await errorFromResponse(response);
		const body = (await response.json()) as { items?: unknown };
		return Array.isArray(body.items)
			? body.items.filter((item): item is string => typeof item === 'string')
			: [];
	},
	async get(id, createdAt, signal) {
		const hint = createdAt === undefined ? '' : `?event_at=${encodeURIComponent(createdAt)}`;
		const response = await adminFetch(`${API_BASE_URL}${BASE}/${encodeURIComponent(id)}${hint}`, {
			signal
		});
		if (!response.ok) throw await errorFromResponse(response);
		return (await response.json()) as AdminAuditEntry;
	}
};
