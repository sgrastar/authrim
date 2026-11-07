import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	adminFromRow,
	adminListSearch,
	httpAdminTeam,
	invitationBody,
	invitationFromRow,
	teamErrorCode
} from './admin-team';
import { ApiError, ConflictError } from './api-error';
import { fakeAdminTeam } from './fake/admin-team-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('administrators and invitations from the wire', () => {
	it('reads an admin row, with D1 booleans and missing times', () => {
		expect(
			adminFromRow({
				id: 'a1',
				email: 'a@example.com',
				name: '',
				status: 'bogus',
				mfa_enabled: 1,
				last_login_at: null,
				created_at: 5
			})
		).toEqual({
			id: 'a1',
			email: 'a@example.com',
			name: null,
			status: 'active',
			mfa_enabled: true,
			last_login_at: null,
			locked_until: null,
			created_at: 5
		});
	});

	it('reads an invitation with its role, scope and ranges', () => {
		const invitation = invitationFromRow({
			id: 'i1',
			email: 'b@example.com',
			status: 'expired',
			role: { id: 'r1', name: 'ar_super_admin', display_name: null },
			scope_type: 'global',
			allowed_ip_ranges: ['203.0.113.0/24', 7],
			ip_restriction_enabled: true,
			expires_at: 10,
			last_delivery_status: 'failed'
		});
		expect(invitation).toMatchObject({
			status: 'expired',
			role: { id: 'r1', name: 'ar_super_admin', display_name: null },
			scope_type: 'global',
			allowed_ip_ranges: ['203.0.113.0/24'],
			last_delivery_status: 'failed'
		});
	});
});

describe('requests', () => {
	it('asks for a page of admins with only the filters set', () => {
		expect(adminListSearch({ page: 2, limit: 20 })).toBe('page=2&limit=20');
		expect(
			adminListSearch({ page: 1, limit: 50, email: ' ken ', status: 'locked', mfa: false })
		).toBe('page=1&limit=50&email=ken&status=locked&mfa_enabled=false');
	});

	it('sends an invitation without empty optional fields, and no ranges when not restricted', () => {
		const body = invitationBody({
			email: ' new@example.com ',
			name: '  ',
			role_id: 'r1',
			scope_type: 'tenant',
			ip_restriction_enabled: false,
			allowed_ip_ranges: ['203.0.113.0/24'],
			group_ids: ['g1']
		});
		expect(body).toEqual({
			email: 'new@example.com',
			role_id: 'r1',
			scope_type: 'tenant',
			ip_restriction_enabled: false,
			allowed_ip_ranges: [],
			group_ids: ['g1']
		});
		expect(
			invitationBody({
				email: 'x@example.com',
				name: 'X',
				role_id: 'r1',
				scope_type: 'global',
				role_expires_at: 99,
				expires_in_hours: 72,
				ip_restriction_enabled: true,
				allowed_ip_ranges: [' 10.0.0.0/8 ', ''],
				group_ids: []
			})
		).toMatchObject({
			name: 'X',
			role_expires_at: 99,
			expires_in_hours: 72,
			allowed_ip_ranges: ['10.0.0.0/8']
		});
	});

	it('names the tenant it was made for on every request', async () => {
		const fetchMock = vi.fn(async () => json({ items: [], total: 0, page: 1, totalPages: 0 }));
		vi.stubGlobal('fetch', fetchMock);
		await httpAdminTeam('acme').listAdmins({ page: 1, limit: 20, email: 'k' });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/admins?page=1&limit=20&email=k');
		expect(new Headers(init.headers).get('X-Tenant-Id')).toBe('acme');
	});

	it('treats a created invitation whose email failed as not delivered', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'email_delivery_failed', invitation_id: 'inv_9' }, 502))
		);
		await expect(
			httpAdminTeam('acme').createInvitation({
				email: 'a@example.com',
				role_id: 'r1',
				scope_type: 'tenant',
				ip_restriction_enabled: false,
				allowed_ip_ranges: [],
				group_ids: []
			})
		).resolves.toEqual({ id: 'inv_9', delivered: false });
	});

	it('reads the default tenant from the cross-tenant list, and gives null when it cannot', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ items: [], total: 0, default_tenant_id: 'default' }))
		);
		await expect(httpAdminTeam('acme').defaultTenantId()).resolves.toBe('default');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'forbidden' }, 403))
		);
		await expect(httpAdminTeam('acme').defaultTenantId()).resolves.toBeNull();
	});

	it('keeps another 502 an error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'bad_gateway' }, 502))
		);
		await expect(httpAdminTeam('acme').resendInvitation('inv_1')).rejects.toBeInstanceOf(ApiError);
	});

	it('reads a resend that went out as delivered under the same invitation', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ success: true, expires_at: 1 }))
		);
		await expect(httpAdminTeam('acme').resendInvitation('inv_1')).resolves.toEqual({
			id: 'inv_1',
			delivered: true
		});
	});
});

describe('error codes', () => {
	it('reads the API code even from a 409, which the shared mapping calls a conflict', () => {
		const conflict = new ConflictError('x', { error: 'last_tenant_admin' });
		expect(conflict.code).toBe('conflict');
		expect(teamErrorCode(conflict)).toBe('last_tenant_admin');
		expect(teamErrorCode(new ApiError(403, 'forbidden', 'x'))).toBe('forbidden');
		expect(teamErrorCode(new Error('x'))).toBe('');
	});
});

describe('the fake client', () => {
	it('pages and filters like the API', async () => {
		const client = fakeAdminTeam();
		const first = await client.listAdmins({ page: 1, limit: 2 });
		expect(first.admins).toHaveLength(2);
		expect(first.total).toBe(5);
		expect((await client.listAdmins({ page: 1, limit: 20, status: 'suspended' })).total).toBe(1);
		expect((await client.listAdmins({ page: 1, limit: 20, mfa: false })).total).toBe(1);
	});

	it('refuses to suspend the last active administrator', async () => {
		const client = fakeAdminTeam({
			admins: [
				{
					id: 'only',
					email: 'only@example.com',
					name: null,
					status: 'active',
					mfa_enabled: true,
					last_login_at: null,
					locked_until: null,
					created_at: 0
				}
			]
		});
		await expect(client.suspend('only')).rejects.toSatisfy(
			(error) => teamErrorCode(error) === 'last_tenant_admin'
		);
	});

	it('sends an expired invitation again with a new time limit', async () => {
		const client = fakeAdminTeam();
		const before = (await client.listInvitations(true)).find((item) => item.id === 'inv_3')!;
		expect(before.status).toBe('expired');
		await client.resendInvitation('inv_3');
		const after = (await client.listInvitations(false)).find((item) => item.id === 'inv_3')!;
		expect(after.status).toBe('pending');
		expect(after.expires_at).toBeGreaterThan(before.expires_at);
	});

	it('keeps the time limit chosen for a new invitation', async () => {
		const client = fakeAdminTeam();
		const { id } = await client.createInvitation({
			email: 'week@example.com',
			role_id: 'role_ar_support',
			scope_type: 'tenant',
			expires_in_hours: 168,
			ip_restriction_enabled: false,
			allowed_ip_ranges: [],
			group_ids: []
		});
		const created = (await client.listInvitations(false)).find((item) => item.id === id)!;
		expect(created.expires_at - created.created_at).toBe(168 * 3_600_000);
	});

	it('refuses a second pending invitation and keeps an undelivered one', async () => {
		const client = fakeAdminTeam({ emailDown: true });
		const input = {
			email: 'fresh@example.com',
			role_id: 'role_ar_support',
			scope_type: 'tenant' as const,
			ip_restriction_enabled: false,
			allowed_ip_ranges: [],
			group_ids: []
		};
		const created = await client.createInvitation(input);
		expect(created.delivered).toBe(false);
		expect((await client.listInvitations(false)).some((item) => item.id === created.id)).toBe(true);
		await expect(client.createInvitation(input)).rejects.toSatisfy(
			(error) => teamErrorCode(error) === 'invitation_exists'
		);
	});
});
