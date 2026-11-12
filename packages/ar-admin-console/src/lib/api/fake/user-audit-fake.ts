/**
 * In-memory end-user event log for Storybook, tests and the console dev mock. It answers the
 * Admin API's wire format (`GET /api/admin/audit-logs`: camelCase entries, cursor pagination,
 * `coverage`) for the real query parameters, and the client goes through the same encoding and
 * decoding as the HTTP one. Users and addresses are fictional (documentation ranges).
 */
import { ApiError } from '../api-error';
import {
	USER_AUDIT_PAGE_SIZE,
	UserAuditIncompleteError,
	userAuditPageFrom,
	userAuditParams,
	type UserAuditClient,
	type UserAuditEntry
} from '../user-audit';

export interface FakeUserAuditOptions {
	/** The events that exist; defaults to `sampleUserAuditEntries()`. */
	entries?: UserAuditEntry[];
	/** No events at all. */
	empty?: boolean;
	/** Milliseconds each call takes. */
	delay?: number;
	/** Every list call fails: a status, or `incomplete` (the period was too large to read). */
	fail?: 403 | 500 | 'incomplete';
	/** Fail only the calls that follow a cursor (the first page loads). */
	failMore?: boolean;
	/** The list never answers (to show loading). */
	hang?: boolean;
	/** Say the newest events may not be visible yet. */
	mayLag?: boolean;
	/** Say only recent records were read: events older than two days are not returned. */
	hotOnly?: boolean;
	pageSize?: number;
}

/** The "now" of the sample data. */
export const USER_AUDIT_NOW = Date.UTC(2026, 10, 7, 3, 0, 0);
const MINUTE = 60_000;

export const SAMPLE_USER_IDS = [
	'usr_2c1e9a40',
	'usr_7b35d1f8',
	'usr_a94c06e2',
	'usr_e10f58b3',
	'usr_5d7a3c19'
] as const;

const ADDRESSES = [
	'203.0.113.24',
	'198.51.100.77',
	'192.0.2.140',
	'2001:db8::5a1',
	'203.0.113.9',
	'198.51.100.18'
];
const AGENTS = [
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
];
const CLIENTS = ['app_portal', 'app_billing', 'app_mobile'];

interface Scenario {
	action: string;
	result?: 'success' | 'failure';
	severity?: 'info' | 'warn' | 'error';
	errorCode?: string;
	errorMessage?: string;
	metadata?: Record<string, unknown>;
	/** Events that happen to a session or a client carry them. */
	session?: boolean;
	client?: boolean;
	/** No user (e.g. a rate limit hit before sign-in). */
	anonymous?: boolean;
}

const SCENARIOS: Scenario[] = [
	{
		action: 'auth.login.succeeded',
		result: 'success',
		client: true,
		metadata: { method: 'passkey' }
	},
	{ action: 'auth.passkey.succeeded', result: 'success', client: true },
	{
		action: 'auth.password.failed',
		result: 'failure',
		severity: 'warn',
		errorCode: 'invalid_credentials',
		errorMessage: 'The password did not match',
		metadata: { attempts: 2 }
	},
	{ action: 'session.user.created', result: 'success', session: true, client: true },
	{
		action: 'token.access.issued',
		result: 'success',
		session: true,
		client: true,
		metadata: { scope: 'openid profile email', expiresIn: 3600 }
	},
	{ action: 'token.refresh.rotated', result: 'success', session: true, client: true },
	{
		action: 'consent.granted',
		result: 'success',
		client: true,
		metadata: { scope: 'openid profile email' }
	},
	{ action: 'auth.email_code.succeeded', result: 'success', client: true },
	{
		action: 'auth.email_code.failed',
		result: 'failure',
		severity: 'warn',
		errorCode: 'invalid_code',
		errorMessage: 'The code was not valid or had expired'
	},
	{ action: 'session.user.destroyed', result: 'success', session: true },
	{ action: 'user.logout', result: 'success', session: true },
	{
		action: 'auth.external_idp.succeeded',
		result: 'success',
		client: true,
		metadata: { provider: 'example-idp' }
	},
	{
		action: 'auth.login.failed',
		result: 'failure',
		severity: 'warn',
		errorCode: 'access_denied',
		errorMessage: 'The account is suspended',
		client: true
	},
	{ action: 'token.access.revoked', result: 'success', session: true, client: true },
	{ action: 'user.password_changed', result: 'success', severity: 'info' },
	{ action: 'user.updated', result: 'success', metadata: { fields: ['display_name'] } },
	{ action: 'consent.revoked', result: 'success', client: true },
	{
		action: 'security.rate_limit.exceeded',
		result: 'failure',
		severity: 'error',
		anonymous: true,
		errorCode: 'rate_limited',
		metadata: { endpoint: '/authorize', limit: 60 }
	},
	{ action: 'user.email_verified', result: 'success' },
	{
		action: 'security.account.locked',
		result: 'success',
		severity: 'warn',
		metadata: { reason: 'too_many_failures' }
	}
];

function pad(n: number, width: number): string {
	return String(n).padStart(width, '0');
}

/** Seven days of events for five users, newest first, with successes and failures mixed. */
export function sampleUserAuditEntries(): UserAuditEntry[] {
	const entries: UserAuditEntry[] = [];
	for (let i = 0; i < 140; i++) {
		const scenario = SCENARIOS[(i * 7 + (i >> 3)) % SCENARIOS.length];
		const minutesAgo = 6 + i * 70 + (i % 5) * 9;
		const base: UserAuditEntry = {
			id: `evt_${pad(140 - i, 6)}`,
			userId: scenario.anonymous
				? null
				: SAMPLE_USER_IDS[(i * 3 + (i >> 2)) % SAMPLE_USER_IDS.length],
			action: scenario.action,
			resourceType: scenario.action.split('.')[0],
			resourceId: null,
			ipAddress: ADDRESSES[(i * 5) % ADDRESSES.length],
			userAgent: scenario.anonymous ? null : AGENTS[i % AGENTS.length],
			clientId: scenario.client ? CLIENTS[i % CLIENTS.length] : null,
			sessionId: scenario.session ? `ses_${pad((i * 9973) % 1_000_000, 6)}` : null,
			requestId: `req_${pad((i * 7919) % 1_000_000, 6)}`,
			result: scenario.result ?? 'success',
			severity: scenario.severity ?? 'info',
			errorCode: scenario.errorCode ?? null,
			errorMessage: scenario.errorMessage ?? null,
			metadata: scenario.metadata ?? {},
			createdAt: new Date(USER_AUDIT_NOW - minutesAgo * MINUTE).toISOString().replace('.000Z', 'Z')
		};
		entries.push(base);
	}
	return entries;
}

export interface FakeCoverage {
	mayLag?: boolean;
	hotOnly?: boolean;
}

/**
 * What `GET /api/admin/audit-logs` answers for these query parameters, as a status and a body.
 * Newest first; an exact `user_id` and `action`; the period; a cursor that holds the query it
 * came from; `page` other than 1 is refused.
 */
export function answerUserAuditList(
	params: URLSearchParams,
	all: readonly UserAuditEntry[],
	options: FakeCoverage & { pageSize?: number } = {}
): { status: number; body: Record<string, unknown> } {
	const page = params.get('page');
	if (page !== null && page !== '1') {
		return {
			status: 400,
			body: {
				error: 'invalid_request',
				error_description: 'Log lists use cursors, not page numbers'
			}
		};
	}
	const limit = Math.min(
		Math.max(Number(params.get('limit') ?? options.pageSize ?? 20) || 20, 1),
		100
	);
	const size = options.pageSize ? Math.min(limit, options.pageSize) : limit;
	const userId = params.get('user_id');
	const action = params.get('action');
	const start = params.get('start_date');
	const end = params.get('end_date');
	const startMs = start ? Date.parse(start) : null;
	const endMs = end ? Date.parse(end) : null;
	const oldest = USER_AUDIT_NOW - 2 * 24 * 60 * MINUTE;

	const matching = [...all]
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1))
		.filter((row) => {
			const at = Date.parse(row.createdAt);
			return (
				(!userId || row.userId === userId) &&
				(!action || row.action === action) &&
				(startMs === null || at >= startMs) &&
				(endMs === null || at <= endMs) &&
				(!options.hotOnly || at >= oldest)
			);
		});

	const scope = JSON.stringify([userId, action, start, end]);
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
			entries: matching.slice(from, from + size),
			pagination: {
				mode: 'cursor',
				limit: size,
				has_more: more,
				next_cursor: more ? JSON.stringify({ scope, start: from + size }) : null
			},
			coverage: {
				consistency: options.hotOnly ? 'local_hot_only' : options.mayLag ? 'eventual' : 'snapshot',
				pending_deliveries: options.mayLag ? 2 : 0,
				complete: true
			}
		}
	};
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeUserAudit(options: FakeUserAuditOptions = {}): UserAuditClient {
	const entries = options.empty ? [] : (options.entries ?? sampleUserAuditEntries());
	return {
		async list(query) {
			if (options.delay) await wait(options.delay);
			if (options.hang) await new Promise(() => {});
			if (options.fail === 'incomplete' || options.fail === 500 || options.fail === 403) {
				if (!options.failMore || query.cursor) {
					if (options.fail === 'incomplete') {
						throw new UserAuditIncompleteError('The log query is incomplete');
					}
					throw new ApiError(
						options.fail,
						options.fail === 403 ? 'forbidden' : 'server_error',
						'Could not list'
					);
				}
			}
			const { status, body } = answerUserAuditList(userAuditParams(query), entries, {
				...options,
				pageSize: options.pageSize ?? USER_AUDIT_PAGE_SIZE
			});
			if (status !== 200) {
				throw new ApiError(status, String(body.error ?? ''), String(body.error_description ?? ''));
			}
			return userAuditPageFrom(body);
		}
	};
}
