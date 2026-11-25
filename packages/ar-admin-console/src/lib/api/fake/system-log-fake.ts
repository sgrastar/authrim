/**
 * In-memory system log for Storybook, tests and the console dev mock. It answers the Admin API's
 * wire format (`GET /api/admin/system-logs`: snake_case entries, cursor pagination, `coverage`)
 * for the real query parameters, and the client goes through the same encoding and decoding as
 * the HTTP one. The sample is a tenant's week: dropped webhook queues while webhooks were off,
 * connector heartbeats that failed, SAML metadata refreshes.
 */
import { ApiError } from '../api-error';
import {
	SYSTEM_LOG_PAGE_SIZE,
	SystemLogIncompleteError,
	systemLogPageFrom,
	systemLogParams,
	type SystemLogClient,
	type SystemLogEntry
} from '../system-log';

export interface FakeSystemLogOptions {
	/** The entries that exist; defaults to `sampleSystemLogEntries()`. */
	entries?: SystemLogEntry[];
	/** No entries at all. */
	empty?: boolean;
	/** Milliseconds each call takes. */
	delay?: number;
	/** Every list call fails: a status, or `incomplete` (the period was too large to read). */
	fail?: 403 | 500 | 'incomplete';
	/** Fail only the calls that follow a cursor (the first page loads). */
	failMore?: boolean;
	/** The list never answers (to show loading). */
	hang?: boolean;
	/** Say the newest entries may not be visible yet. */
	mayLag?: boolean;
	/** Say only recent records were read: entries older than two days are not returned. */
	hotOnly?: boolean;
	pageSize?: number;
}

/** The "now" of the sample data. */
export const SYSTEM_LOG_NOW = Date.UTC(2026, 10, 25, 9, 0, 0);
const MINUTE = 60_000;
const TENANT = 'tenant_demo';

interface Scenario {
	source: string;
	event_type: string;
	event_category: string;
	result: SystemLogEntry['result'];
	severity: SystemLogEntry['severity'];
	error_code?: string;
	target_type?: string;
	target_id?: string;
	details: Record<string, unknown>;
	/** Minutes between two occurrences. */
	every: number;
	/** Minutes before "now" of the newest occurrence. */
	offset: number;
}

const SCENARIOS: Scenario[] = [
	{
		source: 'authrim/account_webhook_outbox',
		event_type: 'webhook.outbox.dropped',
		event_category: 'audit',
		result: 'success',
		severity: 'warn',
		target_type: 'account_webhook_outbox',
		target_id: TENANT,
		details: {
			capability: 'webhooks',
			reason: 'capability_disabled',
			dropped: 3,
			event_types: { 'account.created': 2, 'account.email.changed': 1 }
		},
		every: 60,
		offset: 7
	},
	{
		source: 'authrim/directory_connector_heartbeat',
		event_type: 'directory_connector_heartbeat.failed',
		event_category: 'audit',
		result: 'failure',
		severity: 'warn',
		error_code: 'signature_mismatch',
		target_type: 'directory_connector_instance',
		target_id: 'dci_01HZX4K9',
		details: { connector_id: 'dc_campus_ad', reason: 'signature_mismatch' },
		every: 300,
		offset: 42
	},
	{
		source: 'authrim/saml_metadata_scheduler',
		event_type: 'saml.provider.metadata_refreshed',
		event_category: 'audit',
		result: 'success',
		severity: 'info',
		target_type: 'saml_provider',
		target_id: 'saml_federation_idp',
		details: { trigger: 'automatic', changed: false, entity_count: 1 },
		every: 1440,
		offset: 180
	},
	{
		source: 'authrim/saml_metadata_scheduler',
		event_type: 'saml.provider.metadata_refresh_failed',
		event_category: 'audit',
		result: 'failure',
		severity: 'error',
		error_code: 'metadata_fetch_timeout',
		target_type: 'saml_provider',
		target_id: 'saml_partner_idp',
		details: { trigger: 'automatic', error_code: 'metadata_fetch_timeout', attempts: 3 },
		every: 2880,
		offset: 600
	}
];

function pad(n: number, width: number): string {
	return String(n).padStart(width, '0');
}

/** Seven days of system events, newest first. */
export function sampleSystemLogEntries(): SystemLogEntry[] {
	const entries: SystemLogEntry[] = [];
	const week = 7 * 24 * 60;
	for (const scenario of SCENARIOS) {
		for (let minutes = scenario.offset, n = 0; minutes < week; minutes += scenario.every, n++) {
			const at = SYSTEM_LOG_NOW - minutes * MINUTE;
			entries.push({
				id: `sys_${scenario.event_type.replace(/\W/g, '_')}_${pad(n, 4)}`,
				tenant_id: TENANT,
				source: scenario.source,
				event_type: scenario.event_type,
				event_category: scenario.event_category,
				result: scenario.result,
				severity: scenario.severity,
				error_code: scenario.error_code ?? null,
				target_type: scenario.target_type ?? null,
				target_id: scenario.target_id ?? null,
				request_id: null,
				details:
					scenario.event_type === 'webhook.outbox.dropped'
						? { ...scenario.details, dropped: 1 + (n % 4), recorded_at: at }
						: scenario.details,
				created_at: at,
				retention_until: at + 90 * 24 * 60 * MINUTE
			});
		}
	}
	return entries.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
}

/**
 * What `GET /api/admin/system-logs` answers for these query parameters, as a status and a body.
 * Newest first; exact `source`, `event_type`, `severity`, `result`, `target_id`; the period; a
 * cursor that holds the query it came from.
 */
export function answerSystemLogList(
	params: URLSearchParams,
	all: readonly SystemLogEntry[],
	options: { mayLag?: boolean; hotOnly?: boolean; pageSize?: number } = {}
): { status: number; body: Record<string, unknown> } {
	// The API refuses a filter value that is not a name, a code or an ID (400).
	for (const name of ['source', 'event_type', 'severity', 'result', 'target_id']) {
		const value = params.get(name);
		if (value !== null && value !== '' && !/^[A-Za-z0-9._:/-]{1,200}$/u.test(value)) {
			return {
				status: 400,
				body: { error: 'AR060003', error_description: `Invalid ${name} filter.` }
			};
		}
	}
	const limit = Math.min(
		Math.max(Number(params.get('limit') ?? options.pageSize ?? 50) || 50, 1),
		100
	);
	const size = options.pageSize ? Math.min(limit, options.pageSize) : limit;
	const filters = ['source', 'event_type', 'severity', 'result', 'target_id'] as const;
	const wanted = Object.fromEntries(filters.map((name) => [name, params.get(name)]));
	const start = params.get('start_date');
	const end = params.get('end_date');
	const startMs = start ? Date.parse(start) : null;
	const endMs = end ? Date.parse(end) : null;
	const oldest = SYSTEM_LOG_NOW - 2 * 24 * 60 * MINUTE;

	const matching = [...all]
		.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
		.filter(
			(row) =>
				filters.every((name) => !wanted[name] || row[name] === wanted[name]) &&
				(startMs === null || row.created_at >= startMs) &&
				(endMs === null || row.created_at <= endMs) &&
				(!options.hotOnly || row.created_at >= oldest)
		);

	const scope = JSON.stringify([...filters.map((name) => wanted[name]), start, end]);
	let from = 0;
	const cursor = params.get('cursor');
	if (cursor) {
		let parsed: { scope?: string; start?: number } = {};
		try {
			parsed = JSON.parse(cursor) as typeof parsed;
		} catch {
			// falls through to the refusal below
		}
		if (parsed.scope !== scope || typeof parsed.start !== 'number') {
			return {
				status: 400,
				body: { error: 'invalid_request', error_description: 'Invalid log cursor for this query.' }
			};
		}
		from = parsed.start;
	}
	const more = from + size < matching.length;
	return {
		status: 200,
		body: {
			items: matching.slice(from, from + size),
			pagination: {
				mode: 'cursor',
				limit: size,
				has_more: more,
				next_cursor: more ? JSON.stringify({ scope, start: from + size }) : null
			},
			coverage: {
				consistency: options.hotOnly ? 'local_hot_only' : options.mayLag ? 'eventual' : 'snapshot',
				pending_deliveries: options.mayLag ? 2 : 0,
				complete: !options.mayLag && !options.hotOnly
			}
		}
	};
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeSystemLog(options: FakeSystemLogOptions = {}): SystemLogClient {
	const entries = options.empty ? [] : (options.entries ?? sampleSystemLogEntries());
	return {
		async list(query) {
			if (options.delay) await wait(options.delay);
			if (options.hang) await new Promise(() => {});
			if (options.fail && (!options.failMore || query.cursor)) {
				if (options.fail === 'incomplete') {
					throw new SystemLogIncompleteError('The log query is incomplete');
				}
				throw new ApiError(
					options.fail,
					options.fail === 403 ? 'forbidden' : 'server_error',
					'Could not list'
				);
			}
			const { status, body } = answerSystemLogList(systemLogParams(query), entries, {
				mayLag: options.mayLag,
				hotOnly: options.hotOnly,
				pageSize: options.pageSize ?? SYSTEM_LOG_PAGE_SIZE
			});
			if (status !== 200) {
				throw new ApiError(status, String(body.error ?? ''), String(body.error_description ?? ''));
			}
			return systemLogPageFrom(body);
		}
	};
}
