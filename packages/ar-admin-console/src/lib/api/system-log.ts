/**
 * The system log: what the platform itself did in the selected tenant (a cron, an outbox, a
 * delivery), with no administrator and no end user behind it (`GET /api/admin/system-logs`,
 * `admin:system_logs:read`). Not the end-user event log (`user-audit.ts`) and not the admin
 * audit log (`admin-audit.ts`).
 *
 * Cost model: as the other logs, the API reads the requested period from the log archive and
 * stops at a budget with 503 `log_query_incomplete`, so every request here carries a bounded
 * period. Pages are cursors. Entries carry no personal data, so one permission covers the list
 * and the entry in full, and the list already carries each entry's details.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { ApiError, errorFromResponse } from './api-error';
import type { AuditSeverity } from './admin-audit';
import { LOG_QUERY_INCOMPLETE, instant } from './user-audit';

export type SystemLogResult = 'success' | 'failure' | 'partial';

/** One entry, as the Admin API returns it (`SystemLogEntry`). */
export interface SystemLogEntry {
	id: string;
	tenant_id: string;
	/** Where it happened: `authrim/<surface>` (`authrim/account_webhook_outbox`). */
	source: string;
	/** The event name (`webhook.outbox.dropped`). */
	event_type: string;
	event_category: string;
	result: SystemLogResult;
	severity: AuditSeverity;
	error_code: string | null;
	/** What it was about, when there is one. Never a user. */
	target_type: string | null;
	target_id: string | null;
	request_id: string | null;
	/** Counts, times, codes and IDs of the event. */
	details: Record<string, unknown>;
	/** Epoch milliseconds. */
	created_at: number;
	retention_until: number | null;
}

export interface SystemLogQuery {
	/** Exact source (`authrim/<surface>`). */
	source?: string;
	/** Exact event name. */
	eventType?: string;
	severity?: AuditSeverity;
	result?: SystemLogResult;
	targetId?: string;
	/** The period; always bounded. */
	from: Date;
	to: Date;
	/** Where the next page starts; the first page when omitted. */
	cursor?: string;
	limit?: number;
}

export interface SystemLogPage {
	entries: SystemLogEntry[];
	/** Where the next page starts; null at the end. No total is available. */
	next: string | null;
	/** The newest entries may not be readable yet. */
	mayLag: boolean;
	/** Only recent records were read: older ones may be missing. */
	hotOnly: boolean;
}

export interface SystemLogClient {
	list(query: SystemLogQuery, signal?: AbortSignal): Promise<SystemLogPage>;
}

export const SYSTEM_LOG_PAGE_SIZE = 50;

/** The period was too large to read in full (503 `log_query_incomplete`): narrow it. */
export class SystemLogIncompleteError extends ApiError {
	constructor(message: string, body: Record<string, unknown> = {}) {
		super(503, LOG_QUERY_INCOMPLETE, message, body);
		this.name = 'SystemLogIncompleteError';
	}
}

/** The query string of a list request. */
export function systemLogParams(query: SystemLogQuery): URLSearchParams {
	const params = new URLSearchParams();
	params.set('limit', String(query.limit ?? SYSTEM_LOG_PAGE_SIZE));
	if (query.cursor) params.set('cursor', query.cursor);
	if (query.source) params.set('source', query.source);
	if (query.eventType) params.set('event_type', query.eventType);
	if (query.severity) params.set('severity', query.severity);
	if (query.result) params.set('result', query.result);
	if (query.targetId) params.set('target_id', query.targetId);
	params.set('start_date', instant(query.from, 'down'));
	params.set('end_date', instant(query.to, 'up'));
	return params;
}

interface ListBody {
	items?: unknown;
	pagination?: { has_more?: boolean; next_cursor?: string | null };
	coverage?: { consistency?: string; pending_deliveries?: number | null };
}

/** A list response as one page. */
export function systemLogPageFrom(body: ListBody): SystemLogPage {
	const entries = Array.isArray(body.items)
		? (body.items as SystemLogEntry[]).filter((entry) => entry && typeof entry.id === 'string')
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

export const httpSystemLog: SystemLogClient = {
	async list(query, signal) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/system-logs?${systemLogParams(query)}`,
			{ signal }
		);
		if (!response.ok) {
			const error = await errorFromResponse(response);
			if (error.status === 503 && error.code === LOG_QUERY_INCOMPLETE) {
				throw new SystemLogIncompleteError(error.message, error.body);
			}
			throw error;
		}
		return systemLogPageFrom((await response.json()) as ListBody);
	}
};
