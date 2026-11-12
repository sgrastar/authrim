import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CursorStaleError,
	LegalHoldError,
	LifecycleConflictError,
	activateBody,
	adminUserFrom,
	lockBody,
	suspendBody,
	userActivityFrom,
	userDetailFrom,
	userSessionsFrom,
	httpAdminUsers,
	toEpochMs,
	usersListParams,
	usersPageFrom
} from './admin-users';
import { ApiError } from './api-error';
import { UserAuditIncompleteError } from './user-audit';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(response: Response) {
	const fetchMock = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('users from the wire', () => {
	it('reads times as milliseconds, whatever the API gave', () => {
		expect(toEpochMs(1_780_000_000_000)).toBe(1_780_000_000_000);
		expect(toEpochMs(1_780_000_000)).toBe(1_780_000_000_000);
		expect(toEpochMs('2026-11-07T00:00:00Z')).toBe(Date.UTC(2026, 10, 7));
		expect(toEpochMs(null)).toBeNull();
		expect(toEpochMs('soon')).toBeNull();
	});

	it('reads a user row with missing and odd values', () => {
		const user = adminUserFrom({
			id: 'u1',
			email: 'a@example.com',
			name: '',
			email_verified: 1,
			lifecycle_state: 'bogus',
			pii_status: 'deleted',
			created_at: 1_780_000_000_000,
			last_login_at: null
		});
		expect(user).toMatchObject({
			id: 'u1',
			email: 'a@example.com',
			name: null,
			email_verified: true,
			lifecycle_state: 'active',
			pii_status: 'deleted',
			created_at: 1_780_000_000_000,
			last_login_at: null
		});
	});
});

describe('the list query', () => {
	it('sends the page size, the search and where to start', () => {
		expect(Object.fromEntries(usersListParams({}))).toEqual({ limit: '50' });
		expect(
			Object.fromEntries(
				usersListParams({ search: ' a@example.com ', at: { cursor: 'c1' }, limit: 20 })
			)
		).toEqual({ limit: '20', search: 'a@example.com', cursor: 'c1' });
		expect(usersListParams({ at: { page: 3 } }).get('page')).toBe('3');
		expect(usersListParams({ at: { page: 3 } }).has('cursor')).toBe(false);
	});

	it('never sends the filters the sharded storage refuses', () => {
		const names = [...usersListParams({ search: 'x' }).keys()];
		expect(names).not.toContain('status');
		expect(names).not.toContain('verified');
		expect(names).not.toContain('pii_status');
		expect(names).not.toContain('lifecycle_state');
	});
});

describe('the two page shapes', () => {
	it('reads cursor paging, which has no total', () => {
		const page = usersPageFrom({
			users: [{ id: 'u1' }],
			pagination: { mode: 'cursor', limit: 50, nextCursor: 'c2', hasNext: true } as never
		});
		expect(page.users).toHaveLength(1);
		expect(page.next).toEqual({ cursor: 'c2' });
		expect(page.total).toBeUndefined();
		expect(
			usersPageFrom({ users: [], pagination: { nextCursor: null, hasNext: false } }).next
		).toBeNull();
	});

	it('reads an exact search as one page', () => {
		const page = usersPageFrom({
			users: [{ id: 'u1' }],
			pagination: { mode: 'exact', limit: 50, nextCursor: null, hasNext: false } as never
		});
		expect(page.next).toBeNull();
	});

	it('reads page-number paging with its total', () => {
		expect(
			usersPageFrom({
				users: [],
				pagination: { page: 1, limit: 20, total: 45, totalPages: 3, hasNext: true } as never
			})
		).toEqual({ users: [], next: { page: 2 }, total: 45 });
		expect(
			usersPageFrom({
				users: [],
				pagination: { page: 3, limit: 20, total: 45, totalPages: 3, hasNext: false } as never
			}).next
		).toBeNull();
	});
});

describe('the HTTP client', () => {
	it('lists with the search in the query and the tenant scope', async () => {
		const fetchMock = stubFetch(
			json({ users: [{ id: 'u1' }], pagination: { nextCursor: null, hasNext: false } })
		);
		const page = await httpAdminUsers.list({ search: 'a@example.com' });
		expect(page.users[0].id).toBe('u1');
		const [url] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/api/admin/users?');
		expect(String(url)).toContain('search=a%40example.com');
	});

	it('signals a stale cursor apart from other conflicts', async () => {
		stubFetch(json({ error: 'cursor_stale', error_description: 'restart' }, 409));
		await expect(httpAdminUsers.list({ at: { cursor: 'old' } })).rejects.toBeInstanceOf(
			CursorStaleError
		);
	});

	it('maps errors to ApiError with the status and code', async () => {
		stubFetch(json({ error: 'forbidden' }, 403));
		await expect(httpAdminUsers.list({})).rejects.toMatchObject({ status: 403, forbidden: true });
		stubFetch(json({ error: 'invalid_cursor' }, 400));
		await expect(httpAdminUsers.list({})).rejects.toMatchObject({
			status: 400,
			code: 'invalid_cursor'
		});
		stubFetch(json({ error: 'temporarily_unavailable' }, 503));
		const failure = await httpAdminUsers.list({}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ApiError);
		expect(failure).not.toBeInstanceOf(CursorStaleError);
	});

	it('creates with only the fields given, and reads the user back', async () => {
		const fetchMock = stubFetch(
			json({ user: { id: 'u9', email: 'new@example.com', name: 'New Person' } }, 201)
		);
		const result = await httpAdminUsers.create({
			email: ' new@example.com ',
			name: ' New Person '
		});
		expect(result).toMatchObject({ status: 'created', user: { id: 'u9' } });
		const [, init] = fetchMock.mock.calls[0];
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({
			email: 'new@example.com',
			name: 'New Person'
		});
		expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
	});

	it('omits an empty name, and reports an account still being written', async () => {
		const fetchMock = stubFetch(json({ status: 'pending', operation_id: 'op1' }, 202));
		const result = await httpAdminUsers.create({ email: 'a@example.com', name: '  ' });
		expect(result).toEqual({ status: 'pending', operationId: 'op1' });
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
			email: 'a@example.com'
		});
	});

	it('refuses a taken address as a conflict and bad input as a 400', async () => {
		stubFetch(json({ error: 'conflict' }, 409));
		await expect(httpAdminUsers.create({ email: 'a@example.com' })).rejects.toMatchObject({
			status: 409
		});
		stubFetch(json({ error: 'invalid_request', error_description: 'Email is required' }, 400));
		await expect(httpAdminUsers.create({ email: '' })).rejects.toMatchObject({
			status: 400,
			code: 'invalid_request'
		});
	});
});

describe('one user from the wire', () => {
	it('takes a maker logo only when it is an image data URI', () => {
		const png = 'data:image/png;base64,AAAA';
		const detail = userDetailFrom({
			user: { id: 'u1' },
			passkeys: [
				{ id: 'a', provider: { name: 'A', icon_light: png, icon_dark: null } },
				{ id: 'b', provider: { name: 'B', icon_light: 'https://example.com/x.png' } },
				{ id: 'c', provider: 'C' },
				{ id: 'd', provider: null }
			]
		});
		expect(detail.passkeys.map((p) => p.providerIcon)).toEqual([
			{ light: png, dark: png },
			null,
			null,
			null
		]);
	});

	it('reads the user with how they sign in', () => {
		const detail = userDetailFrom({
			user: { id: 'u1', email: 'a@example.com', lifecycle_state: 'active' },
			passkeys: [
				{
					id: 'p1',
					device_name: '',
					provider: { name: 'iCloud Keychain' },
					created_at: 1_780_000_000_000
				},
				{ id: 'p2', device_name: 'Key', provider: 'YubiKey', last_used_at: 1_780_000_000 }
			],
			totp_credentials: [{ id: 't1', label: 'App', status: 'active' }]
		});
		expect(detail.restricted).toBe(false);
		expect(detail.passkeys[0]).toMatchObject({
			deviceName: null,
			provider: 'iCloud Keychain',
			createdAt: 1_780_000_000_000,
			lastUsedAt: null
		});
		expect(detail.passkeys[1]).toMatchObject({
			provider: 'YubiKey',
			lastUsedAt: 1_780_000_000_000
		});
		expect(detail.totp).toEqual([
			{ id: 't1', label: 'App', status: 'active', createdAt: null, lastUsedAt: null }
		]);
	});

	it('knows a user read without credentials', () => {
		const detail = userDetailFrom({
			user: { id: 'u1', lifecycle_state: 'locked' },
			passkeys: [],
			totp_credentials: [],
			restricted: true
		});
		expect(detail.restricted).toBe(true);
		expect(detail.user.lifecycle_state).toBe('locked');
	});

	it('reads sessions with the API’s ISO times and total', () => {
		const sessions = userSessionsFrom({
			sessions: [
				{
					id: 's1',
					created_at: '2026-11-12T01:00:00.000Z',
					last_accessed_at: '2026-11-12T02:00:00.000Z',
					expires_at: '2026-11-13T01:00:00.000Z',
					ip_address: '203.0.113.5',
					user_agent: ''
				}
			],
			pagination: { total: 12 }
		});
		expect(sessions.total).toBe(12);
		expect(sessions.sessions[0]).toEqual({
			id: 's1',
			createdAt: Date.UTC(2026, 10, 12, 1),
			lastActiveAt: Date.UTC(2026, 10, 12, 2),
			expiresAt: Date.UTC(2026, 10, 13, 1),
			ipAddress: '203.0.113.5',
			userAgent: null
		});
	});

	it('reads activity with the result from its details', () => {
		const activity = userActivityFrom({
			data: [
				{
					id: 'a1',
					action: 'auth.login.failed',
					details: { result: 'failure' },
					timestamp: 1_780_000_000_000
				},
				{ id: 'a2', action: 'user.updated', details: null, timestamp: '2026-11-12T00:00:00Z' }
			],
			pagination: { has_more: true }
		});
		expect(activity.more).toBe(true);
		expect(activity.entries.map((entry) => entry.result)).toEqual(['failure', null]);
		expect(activity.entries[1].at).toBe(Date.UTC(2026, 10, 12));
	});
});

describe('the bodies of a state change', () => {
	it('suspends with the reason, the hours and the sessions ended', () => {
		expect(suspendBody({ reason: 'investigation', detail: ' spam ', durationHours: 48 })).toEqual({
			reason_code: 'investigation',
			reason_detail: 'spam',
			duration_hours: 48,
			revoke_sessions: true
		});
		expect(suspendBody({ reason: 'other' })).toEqual({
			reason_code: 'other',
			revoke_sessions: true
		});
	});

	it('locks with the end as an ISO time', () => {
		expect(lockBody({ reason: 'brute_force', unlockAt: Date.UTC(2026, 11, 1) })).toEqual({
			reason_code: 'brute_force',
			unlock_at: '2026-12-01T00:00:00.000Z',
			revoke_sessions: true
		});
	});

	it('reactivates with the reason only', () => {
		expect(activateBody({ reason: 'false_positive', detail: '  ' })).toEqual({
			reason_code: 'false_positive'
		});
	});
});

describe('the HTTP client for one user', () => {
	it('reads a user by its encoded id', async () => {
		const fetchMock = stubFetch(json({ user: { id: 'a/b' }, passkeys: [], totp_credentials: [] }));
		const detail = await httpAdminUsers.get('a/b');
		expect(detail.user.id).toBe('a/b');
		expect(String(fetchMock.mock.calls[0][0])).toContain('/api/admin/users/a%2Fb');
	});

	it('answers a missing user with a 404', async () => {
		stubFetch(json({ error: 'not_found' }, 404));
		await expect(httpAdminUsers.get('x')).rejects.toMatchObject({ status: 404, notFound: true });
	});

	it('updates with only the fields given, an emptied one as an empty string', async () => {
		const fetchMock = stubFetch(json({ user: { id: 'u1', name: 'New' } }));
		const user = await httpAdminUsers.update('u1', { name: 'New', phone_number: '' });
		expect(user.name).toBe('New');
		const [, init] = fetchMock.mock.calls[0];
		expect(init.method).toBe('PUT');
		expect(JSON.parse(init.body as string)).toEqual({ name: 'New', phone_number: '' });
	});

	it('suspends, locks and reactivates through their own endpoints', async () => {
		const fetchMock = stubFetch(json({ status: 'ok' }));
		await httpAdminUsers.suspend('u1', { reason: 'other', durationHours: 2 });
		await httpAdminUsers.lock('u1', { reason: 'other' });
		await httpAdminUsers.activate('u1', { reason: 'other' });
		const urls = fetchMock.mock.calls.map(([url]) => String(url).replace(/^.*\/api/, '/api'));
		expect(urls).toEqual([
			'/api/admin/users/u1/suspend',
			'/api/admin/users/u1/lock',
			'/api/admin/users/u1/activate'
		]);
		expect(fetchMock.mock.calls.every(([, init]) => init.method === 'POST')).toBe(true);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
			reason_code: 'other',
			duration_hours: 2,
			revoke_sessions: true
		});
	});

	it('tells a state that changed meanwhile from other conflicts', async () => {
		stubFetch(json({ error: 'lifecycle_conflict', error_description: 'changed' }, 409));
		await expect(httpAdminUsers.suspend('u1', { reason: 'other' })).rejects.toBeInstanceOf(
			LifecycleConflictError
		);
		stubFetch(json({ error: 'conflict' }, 409));
		const other = await httpAdminUsers.activate('u1', { reason: 'other' }).catch((e: unknown) => e);
		expect(other).not.toBeInstanceOf(LifecycleConflictError);
	});

	it('refuses a bad reason as a 400', async () => {
		stubFetch(json({ error: 'invalid_request', error_description: 'Must be one of' }, 400));
		await expect(httpAdminUsers.lock('u1', { reason: 'other' })).rejects.toMatchObject({
			status: 400
		});
	});

	it('deletes, and names a legal hold', async () => {
		const fetchMock = stubFetch(json({ success: true }));
		await httpAdminUsers.remove('u1');
		expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
		stubFetch(
			json({ error: 'legal_hold_active', error_description: 'held', hold_id: 'hold_9' }, 409)
		);
		const failure = await httpAdminUsers.remove('u1').catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(LegalHoldError);
		expect(failure).toMatchObject({ holdId: 'hold_9', status: 409 });
	});

	it('lists the active sessions of a user, ten at most', async () => {
		const fetchMock = stubFetch(json({ sessions: [], pagination: { total: 0 } }));
		await httpAdminUsers.sessions('u1');
		const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
		expect(url.pathname).toBe('/api/admin/sessions');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			user_id: 'u1',
			status: 'active',
			limit: '10'
		});
	});

	it('reads the last ten events of a user', async () => {
		const fetchMock = stubFetch(json({ data: [], pagination: { has_more: false } }));
		await httpAdminUsers.activity('u1');
		const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
		expect(url.pathname).toBe('/api/admin/users/u1/activity-log');
		expect(url.searchParams.get('limit')).toBe('10');
	});

	it('asks for the last 7 days only, from the given time', async () => {
		const fetchMock = stubFetch(json({ data: [], pagination: { has_more: false } }));
		const now = Date.UTC(2026, 10, 12, 3, 0, 0);
		await httpAdminUsers.activity('u1', undefined, now);
		const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
		expect(url.searchParams.get('from')).toBe('2026-11-05T03:00:00Z');
		expect(url.searchParams.get('to')).toBe('2026-11-12T03:00:00Z');
	});

	it('rounds the period to whole seconds, the start down and the end up', async () => {
		const fetchMock = stubFetch(json({ data: [], pagination: { has_more: false } }));
		const now = Date.UTC(2026, 10, 12, 3, 0, 0, 900);
		await httpAdminUsers.activity('u1', undefined, now);
		const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
		const from = Math.floor(Date.parse(url.searchParams.get('from')!) / 1000);
		const to = Math.floor(Date.parse(url.searchParams.get('to')!) / 1000);
		// The API cuts both to the second; an event at 03:00:00.400 is inside, the start is not later.
		expect(Math.floor(Date.UTC(2026, 10, 12, 3, 0, 0, 400) / 1000)).toBeLessThanOrEqual(to);
		expect(url.searchParams.get('to')).toBe('2026-11-12T03:00:01Z');
		expect(from).toBeLessThanOrEqual(Math.floor((now - 7 * 86_400_000) / 1000));
		expect(url.searchParams.get('from')).toBe('2026-11-05T03:00:00Z');
	});

	it('signals a period too large to read apart from other failures', async () => {
		stubFetch(json({ error: 'log_query_incomplete', error_description: 'Too large' }, 503));
		const failure = await httpAdminUsers.activity('u1').catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(UserAuditIncompleteError);
		stubFetch(json({ error: 'server_error' }, 503));
		const other = await httpAdminUsers.activity('u1').catch((error: unknown) => error);
		expect(other).not.toBeInstanceOf(UserAuditIncompleteError);
	});
});
