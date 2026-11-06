/**
 * In-memory admin audit log for Storybook and tests. Follows the Admin API: newest first, the
 * same filters, pages by number (or by cursor, as the log archive does, with no total), the
 * list needs `admin:admin_audit:read` and what changed needs `admin:admin_audit:detail:read`.
 */
import { ApiError } from '../api-error';
import {
	AUDIT_PAGE_SIZE,
	type AdminAuditClient,
	type AdminAuditEntry,
	type AdminAuditPage
} from '../admin-audit';

export interface FakeAdminAuditOptions {
	/** The entries that exist; defaults to `sampleAuditEntries()`. */
	entries?: AdminAuditEntry[];
	/** Milliseconds each call takes. */
	delay?: number;
	/** Every list call fails: a status, or `incomplete` (the archive could not be read in full). */
	fail?: 403 | 500 | 'incomplete';
	/** The list never answers (to show loading). */
	hang?: boolean;
	/** Page with cursors and no total, as when rows come from the log archive. */
	cursor?: boolean;
	/** Say the newest entries may not be visible yet. */
	mayLag?: boolean;
	/** The admin may read what changed (before / after). Defaults to true. */
	detail?: boolean;
	pageSize?: number;
}

export const AUDIT_NOW = Date.UTC(2026, 10, 7, 3, 0, 0);
const MINUTE = 60_000;

const alice = {
	admin_user_id: 'adm_alice',
	admin_email: 'alice@example.com',
	admin_user_name: 'Alice Tanaka',
	actor_type: 'admin_user',
	actor_id: 'adm_alice',
	actor_display_name: 'Alice Tanaka'
};
const bob = {
	admin_user_id: 'adm_bob',
	admin_email: 'bob@example.com',
	admin_user_name: 'Bob Suzuki',
	actor_type: 'admin_user',
	actor_id: 'adm_bob',
	actor_display_name: 'Bob Suzuki'
};

function entry(
	id: string,
	minutesAgo: number,
	partial: Partial<AdminAuditEntry> & Pick<AdminAuditEntry, 'action'>
): AdminAuditEntry {
	return {
		id,
		tenant_id: 'acme',
		result: 'success',
		severity: 'info',
		resource_type: null,
		resource_id: null,
		ip_address: '203.0.113.10',
		user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15',
		request_id: `req_${id}`,
		session_id: 'ses_7f3a',
		metadata: {},
		created_at: AUDIT_NOW - minutesAgo * MINUTE,
		...alice,
		...partial
	};
}

/** A tenant's recent admin activity: settings, a role grant behind step-up, a refused one. */
export function sampleAuditEntries(): AdminAuditEntry[] {
	return [
		entry('aud_010', 2, {
			action: 'settings.update',
			resource_type: 'settings',
			resource_id: 'security',
			metadata: { category: 'security', keys: ['security.admin_step_up_overrides'] },
			before: { 'security.admin_step_up_overrides': {} },
			after: { 'security.admin_step_up_overrides': { 'client.secret.rotate': 'L2' } }
		}),
		entry('aud_009', 3, {
			action: 'admin.step_up.receipt_issued',
			resource_type: 'admin_session',
			resource_id: 'ses_7f3a',
			metadata: { operation: 'admin_step_up.policy.relax', level: 'L2', target_tenant_id: 'acme' }
		}),
		entry('aud_008', 18, {
			...bob,
			action: 'admin.role.grant',
			result: 'failure',
			severity: 'warn',
			resource_type: 'admin_user',
			resource_id: 'adm_carol',
			error_code: 'step_up_required',
			error_message: 'This operation needs an L2 step-up',
			metadata: { role: 'ar_tenant_admin' }
		}),
		entry('aud_007', 19, {
			...bob,
			action: 'admin.step_up.receipt_issued',
			resource_type: 'admin_session',
			resource_id: 'ses_91bc',
			session_id: 'ses_91bc',
			metadata: { operation: 'admin.role.grant', level: 'L2', target_tenant_id: 'acme' }
		}),
		entry('aud_006', 45, {
			action: 'client.secret.rotate',
			resource_type: 'client',
			resource_id: 'app_billing'
		}),
		entry('aud_005', 120, {
			actor_type: 'machine',
			actor_id: 'amp_ci_deploy',
			actor_display_name: 'ci-deploy',
			admin_user_id: null,
			admin_email: null,
			admin_user_name: null,
			action: 'client.update',
			resource_type: 'client',
			resource_id: 'app_portal',
			ip_address: '198.51.100.7',
			user_agent: 'authrim-cli/0.5.0'
		}),
		entry('aud_004', 240, {
			...bob,
			action: 'admin.passkey.add',
			resource_type: 'admin_user',
			resource_id: 'adm_bob'
		}),
		entry('aud_003', 1_500, {
			action: 'signing_key.rotate',
			resource_type: 'signing_key',
			resource_id: 'key_2026_11',
			severity: 'warn'
		})
	];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeAdminAudit(options: FakeAdminAuditOptions = {}): AdminAuditClient {
	const entries = [...(options.entries ?? sampleAuditEntries())].sort(
		(a, b) => b.created_at - a.created_at
	);
	const size = options.pageSize ?? AUDIT_PAGE_SIZE;
	const pause = () => (options.delay ? wait(options.delay) : Promise.resolve());

	return {
		async list(query) {
			await pause();
			if (options.hang) await new Promise(() => {});
			if (options.fail === 'incomplete') {
				throw new ApiError(503, 'log_query_incomplete', 'The log query is incomplete');
			}
			if (options.fail) throw new ApiError(options.fail, 'error', 'Could not list');
			const matching = entries.filter(
				(row) =>
					(!query.actor || row.admin_user_id === query.actor) &&
					(!query.action || row.action === query.action) &&
					(!query.result || row.result === query.result) &&
					(!query.from || row.created_at >= query.from.getTime()) &&
					(!query.to || row.created_at <= query.to.getTime())
			);
			// As the archive does, a cursor holds the query it came from and answers only that.
			const scope = JSON.stringify([
				query.actor,
				query.action,
				query.result,
				query.from?.toISOString(),
				query.to?.toISOString()
			]);
			let start = ((query.at && 'page' in query.at ? query.at.page : 1) - 1) * size;
			if (query.at && 'cursor' in query.at) {
				const cursor = JSON.parse(query.at.cursor) as { scope: string; start: number };
				if (cursor.scope !== scope) {
					throw new ApiError(400, 'invalid_request', 'Invalid log cursor for this query.');
				}
				start = cursor.start;
			}
			const items = matching.slice(start, start + size).map((row) => {
				const listed = { ...row };
				delete listed.before;
				delete listed.after;
				return listed;
			});
			const more = start + size < matching.length;
			const page: AdminAuditPage = options.cursor
				? {
						items,
						total: null,
						next: more ? { cursor: JSON.stringify({ scope, start: start + size }) } : null,
						mayLag: false
					}
				: {
						items,
						total: matching.length,
						next: more ? { page: start / size + 2 } : null,
						mayLag: false
					};
			page.mayLag = options.mayLag === true;
			return page;
		},
		async actions() {
			await pause();
			return [...new Set(entries.map((row) => row.action))].sort();
		},
		async get(id) {
			await pause();
			if (options.detail === false)
				throw new ApiError(403, 'forbidden', 'Insufficient permissions');
			const row = entries.find((candidate) => candidate.id === id);
			if (!row) throw new ApiError(404, 'not_found', 'Not found');
			return structuredClone(row);
		}
	};
}
