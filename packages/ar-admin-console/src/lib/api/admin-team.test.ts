import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	adminDetailFromRow,
	adminFromRow,
	adminListSearch,
	httpAdminTeam,
	invitationBody,
	invitationFromRow,
	teamErrorCode
} from './admin-team';
import { ApiError, ConflictError } from './api-error';
import { fakeAdminTeam, sampleHoldings } from './fake/admin-team-fake';

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

describe('an administrator in full', () => {
	it('tells direct roles from group ones, and keeps only a direct one removable', () => {
		const detail = adminDetailFromRow({
			id: 'a1',
			email: 'a@example.com',
			roles: [
				{
					id: 'r1',
					role_id: 'r1',
					assignment_id: 'asg_1',
					name: 'ar_support',
					source: 'direct',
					scope_type: 'tenant'
				},
				{
					id: 'r2',
					role_id: 'r2',
					assignment_id: 'group:m:g',
					name: 'ar_viewer',
					source: 'group',
					scope_type: 'global',
					admin_group_id: 'grp_1',
					admin_group_name: 'Ops'
				}
			],
			groups: [{ id: 'grp_1', group_key: 'ops', display_name: 'Ops' }],
			passkeys: [{ id: 'pk', device_name: null, provider: { name: 'YubiKey 5' }, created_at: 1 }]
		});
		expect(detail.roles[0]).toMatchObject({
			source: 'direct',
			assignment_id: 'asg_1',
			group: null
		});
		expect(detail.roles[1]).toMatchObject({
			source: 'group',
			assignment_id: null,
			scope_type: 'global',
			group: { id: 'grp_1', name: 'Ops' }
		});
		expect(detail.groups[0].group_key).toBe('ops');
		expect(detail.passkeys[0]).toMatchObject({ provider: 'YubiKey 5', last_used_at: null });
	});

	it("changes a direct assignment's end through the roles API, and can clear it", async () => {
		const fetchMock = vi.fn(async () => json({ success: true }));
		vi.stubGlobal('fetch', fetchMock);
		await httpAdminTeam('acme').setAssignmentExpiry('role 1', 'asg/1', null);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/admin-roles/role%201/assignments/asg%2F1');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(String(init.body))).toEqual({ expires_at: null });
	});
});

describe('an ended assignment, given again', () => {
	it("finds the admin's ended assignment of the role and scope, and nothing on failure", async () => {
		const past = Date.now() - 1000;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				json({
					items: [
						{ id: 'a_other', admin_user_id: 'x', scope_type: 'tenant', expires_at: past },
						{ id: 'a_live', admin_user_id: 'me', scope_type: 'tenant', expires_at: null },
						{ id: 'a_global', admin_user_id: 'me', scope_type: 'global', expires_at: past },
						{ id: 'a_ended', admin_user_id: 'me', scope_type: 'tenant', expires_at: past }
					]
				})
			)
		);
		await expect(httpAdminTeam('acme').findEndedAssignment('r1', 'me', 'tenant')).resolves.toBe(
			'a_ended'
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'forbidden' }, 403))
		);
		await expect(
			httpAdminTeam('acme').findEndedAssignment('r1', 'me', 'tenant')
		).resolves.toBeNull();
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

	it('refuses a role already held directly for the same scope, and removing the last tenant admin', async () => {
		const client = fakeAdminTeam();
		await expect(
			client.grantRole('adm_1', { role_id: 'role_ar_tenant_admin', scope_type: 'tenant' })
		).rejects.toBeInstanceOf(ConflictError);
		await expect(client.removeAssignment('adm_1', 'asg_1')).rejects.toSatisfy(
			(error) => teamErrorCode(error) === 'last_tenant_admin'
		);
		await client.grantRole('adm_2', { role_id: 'role_ar_tenant_admin', scope_type: 'tenant' });
		await client.removeAssignment('adm_1', 'asg_1');
		expect((await client.getAdmin('adm_1')).roles.map((role) => role.source)).toEqual(['group']);
	});

	it('keeps an open-ended tenant admin: an end on the last one is refused', async () => {
		const client = fakeAdminTeam();
		await client.grantRole('adm_2', {
			role_id: 'role_ar_tenant_admin',
			scope_type: 'tenant',
			expires_at: Date.now() + 86_400_000
		});
		await expect(
			client.setAssignmentExpiry('role_ar_tenant_admin', 'asg_1', Date.now() + 86_400_000)
		).rejects.toSatisfy((error) => teamErrorCode(error) === 'last_tenant_admin');
		await expect(
			client.setAssignmentExpiry('role_ar_support', 'asg_1', null)
		).rejects.toBeInstanceOf(ApiError);
	});

	it('allows changes that leave a current administrator when none was open-ended', async () => {
		const later = Date.now() + 86_400_000;
		const holdings = sampleHoldings();
		holdings.adm_1.roles[0].expires_at = later;
		const client = fakeAdminTeam({ holdings });
		// Extending an end, and deleting someone else, are fine while a current admin stays.
		await client.setAssignmentExpiry('role_ar_tenant_admin', 'asg_1', later + 1000);
		await client.deleteAdmin('adm_5');
		// Giving the last open-ended one an end is refused, as by the API.
		await client.grantRole('adm_2', { role_id: 'role_ar_tenant_admin', scope_type: 'tenant' });
		const adm2 = (await client.getAdmin('adm_2')).roles.find(
			(role) => role.name === 'ar_tenant_admin'
		)!;
		await expect(
			client.setAssignmentExpiry('role_ar_tenant_admin', adm2.assignment_id!, later)
		).rejects.toSatisfy((error) => teamErrorCode(error) === 'last_tenant_admin');
	});

	it('refuses to suspend the only tenant administrator even with other admins active', async () => {
		const client = fakeAdminTeam();
		await expect(client.suspend('adm_1')).rejects.toSatisfy(
			(error) => teamErrorCode(error) === 'last_tenant_admin'
		);
		await client.suspend('adm_2');
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
			],
			holdings: {
				only: {
					roles: [
						{
							role_id: 'role_ar_tenant_admin',
							name: 'ar_tenant_admin',
							display_name: null,
							scope_type: 'tenant',
							assignment_id: 'asg_only',
							source: 'direct',
							group: null,
							assigned_at: 0,
							expires_at: null
						}
					],
					groups: [],
					passkeys: []
				}
			}
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
