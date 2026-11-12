/**
 * The end-user event log: sign-ins, sessions, tokens, consents and account changes of the
 * selected tenant (`GET /api/admin/audit-logs`, `admin:audit:read`). Not the admin audit log
 * (`admin-audit.ts`), which records what administrators did.
 *
 * Cost model: the API reads and decrypts the whole requested period, applies the filters
 * afterwards, and stops at a budget (10,000 records / 4 MiB) with 503 `log_query_incomplete`.
 * Without a period it would read the tenant's whole history, so every request here carries a
 * bounded one. Pages are cursors; the API refuses `page` other than 1.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { ApiError, errorFromResponse } from './api-error';
import type { AuditResult, AuditSeverity } from './admin-audit';

/** One event, as the Admin API returns it (camelCase). Fields the API has no value for are absent or null. */
export interface UserAuditEntry {
	id: string;
	/** The user the event is about; null for events without one. */
	userId?: string | null;
	/** The event type (`auth.login.succeeded`, `user.suspend`…). */
	action: string;
	resourceType?: string | null;
	resourceId?: string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	clientId?: string | null;
	sessionId?: string | null;
	requestId?: string | null;
	result?: AuditResult | null;
	severity?: AuditSeverity | null;
	errorCode?: string | null;
	errorMessage?: string | null;
	metadata?: Record<string, unknown> | null;
	/** ISO instant. */
	createdAt: string;
}

export interface UserAuditQuery {
	/** Exact user id. */
	userId?: string;
	/** Exact event type (no wildcard). */
	action?: string;
	/** The period; always bounded. */
	from: Date;
	to: Date;
	/** Where the next page starts; the first page when omitted. */
	cursor?: string;
	limit?: number;
}

export interface UserAuditPage {
	entries: UserAuditEntry[];
	/** Where the next page starts; null at the end. No total is available. */
	next: string | null;
	/** The newest events may not be readable yet. */
	mayLag: boolean;
	/** Only recent records were read: older ones may be missing. */
	hotOnly: boolean;
}

export interface UserAuditClient {
	list(query: UserAuditQuery, signal?: AbortSignal): Promise<UserAuditPage>;
}

export const USER_AUDIT_PAGE_SIZE = 50;

/** The period was too large to read in full (503 `log_query_incomplete`): narrow it. */
export const LOG_QUERY_INCOMPLETE = 'log_query_incomplete';

export class UserAuditIncompleteError extends ApiError {
	constructor(message: string, body: Record<string, unknown> = {}) {
		super(503, LOG_QUERY_INCOMPLETE, message, body);
		this.name = 'UserAuditIncompleteError';
	}
}

/** Whether a failure is "the period was too large", whichever client raised it. */
export function isIncompleteError(error: unknown): boolean {
	return error instanceof ApiError && error.code === LOG_QUERY_INCOMPLETE;
}

/** An instant at second precision, as the API reads it; the start rounds down, the end up. */
export function instant(date: Date, round: 'down' | 'up'): string {
	const ms = date.getTime();
	const seconds = round === 'down' ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
	return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

/** The query string of a list request. Never asks for a page other than the first. */
export function userAuditParams(query: UserAuditQuery): URLSearchParams {
	const params = new URLSearchParams();
	params.set('limit', String(query.limit ?? USER_AUDIT_PAGE_SIZE));
	if (query.cursor) params.set('cursor', query.cursor);
	if (query.userId) params.set('user_id', query.userId);
	if (query.action) params.set('action', query.action);
	params.set('start_date', instant(query.from, 'down'));
	params.set('end_date', instant(query.to, 'up'));
	return params;
}

interface ListBody {
	entries?: unknown;
	pagination?: { has_more?: boolean; next_cursor?: string | null };
	coverage?: { consistency?: string; pending_deliveries?: number | null };
}

/** A list response (cursor-shaped, or the offset-shaped one of an unknown user) as one page. */
export function userAuditPageFrom(body: ListBody): UserAuditPage {
	const entries = Array.isArray(body.entries)
		? (body.entries as UserAuditEntry[]).filter((entry) => entry && typeof entry.id === 'string')
		: [];
	const cursor = body.pagination?.next_cursor;
	return {
		entries,
		next: body.pagination?.has_more && cursor ? cursor : null,
		mayLag:
			body.coverage?.consistency === 'eventual' || (body.coverage?.pending_deliveries ?? 0) > 0,
		hotOnly: body.coverage?.consistency === 'local_hot_only'
	};
}

export const httpUserAudit: UserAuditClient = {
	async list(query, signal) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/audit-logs?${userAuditParams(query)}`,
			{ signal }
		);
		if (!response.ok) {
			const error = await errorFromResponse(response);
			if (error.status === 503 && error.code === LOG_QUERY_INCOMPLETE) {
				throw new UserAuditIncompleteError(error.message, error.body);
			}
			throw error;
		}
		return userAuditPageFrom((await response.json()) as ListBody);
	}
};
