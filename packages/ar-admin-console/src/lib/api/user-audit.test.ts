import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';

vi.mock('./admin-request', () => ({
	API_BASE_URL: '',
	adminFetch: vi.fn()
}));

import { adminFetch } from './admin-request';
import {
	UserAuditIncompleteError,
	httpUserAudit,
	isIncompleteError,
	userAuditPageFrom,
	userAuditParams
} from './user-audit';

const from = new Date('2026-11-07T09:00:00.400Z');
const to = new Date('2026-11-08T09:00:00.400Z');

describe('user audit client', () => {
	afterEach(() => vi.mocked(adminFetch).mockReset());

	it('always sends a bounded period at second precision, and never a page', () => {
		const params = userAuditParams({ from, to, userId: 'usr_1', action: 'auth.login.failed' });
		expect(Object.fromEntries(params)).toEqual({
			limit: '50',
			user_id: 'usr_1',
			action: 'auth.login.failed',
			start_date: '2026-11-07T09:00:00Z',
			end_date: '2026-11-08T09:00:01Z'
		});
		const next = userAuditParams({ from, to, cursor: 'c1' });
		expect(next.get('cursor')).toBe('c1');
		expect(next.has('page')).toBe(false);
		expect(next.has('user_id')).toBe(false);
	});

	it('reads the cursor page, the lag and the hot-only coverage', () => {
		expect(
			userAuditPageFrom({
				entries: [{ id: 'a', action: 'x', createdAt: '2026-11-07T09:00:00Z' }],
				pagination: { has_more: true, next_cursor: 'c2' },
				coverage: { consistency: 'eventual', pending_deliveries: 0 }
			})
		).toMatchObject({ next: 'c2', mayLag: true, hotOnly: false });
		expect(
			userAuditPageFrom({
				entries: [],
				pagination: { has_more: false, next_cursor: null },
				coverage: { consistency: 'local_hot_only', pending_deliveries: null }
			})
		).toEqual({ entries: [], next: null, mayLag: false, hotOnly: true });
		expect(
			userAuditPageFrom({
				entries: [],
				coverage: { consistency: 'snapshot', pending_deliveries: 3 }
			}).mayLag
		).toBe(true);
	});

	it('reads the empty offset-shaped answer for an unknown user as an empty page', () => {
		expect(
			userAuditPageFrom({ entries: [], pagination: { page: 1, limit: 50, total: 0 } } as never)
		).toEqual({ entries: [], next: null, mayLag: false, hotOnly: false });
	});

	it('tells "narrow the period" from any other failure', async () => {
		const respond = (status: number, body: unknown) =>
			vi.mocked(adminFetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
		respond(503, { error: 'log_query_incomplete', complete: false });
		const error = await httpUserAudit.list({ from, to }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UserAuditIncompleteError);
		expect(isIncompleteError(error)).toBe(true);

		respond(500, { error: 'server_error' });
		const other = await httpUserAudit.list({ from, to }).catch((e: unknown) => e);
		expect(other).toBeInstanceOf(ApiError);
		expect(isIncompleteError(other)).toBe(false);

		respond(503, { error: 'unavailable' });
		expect(isIncompleteError(await httpUserAudit.list({ from, to }).catch((e: unknown) => e))).toBe(
			false
		);
	});
});
