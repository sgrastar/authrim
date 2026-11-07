import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_KEY_PATTERN, groupDetailFromRow, httpAdminGroups } from './admin-groups';
import { teamErrorCode } from './admin-team';
import { ConflictError } from './api-error';
import { fakeAdminGroups, sampleGroupDetails } from './fake/admin-groups-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('admin groups from the wire', () => {
	it('reads a group with its members and grants, counting what it lists', () => {
		const group = groupDetailFromRow({
			id: 'g1',
			group_key: 'ops',
			display_name: 'Ops',
			description: null,
			member_count: 9,
			members: [{ id: 'm1', admin_user_id: 'a1', email: 'a@example.com', name: null }],
			grants: [
				{
					id: 'gr1',
					admin_role_id: 'r1',
					role_name: 'ar_support',
					role_display_name: 'Support',
					expires_at: 5
				}
			]
		});
		expect(group.member_count).toBe(1);
		expect(group.grant_count).toBe(1);
		expect(group.members[0]).toMatchObject({ admin_user_id: 'a1', name: null });
		expect(group.grants[0]).toMatchObject({
			role_id: 'r1',
			role_name: 'ar_support',
			expires_at: 5
		});
	});

	it('accepts the keys the API accepts', () => {
		expect(GROUP_KEY_PATTERN.test('support-desk_2')).toBe(true);
		expect(GROUP_KEY_PATTERN.test('Ops')).toBe(false);
		// A letter or digit first, as the API asks.
		expect(GROUP_KEY_PATTERN.test('_ops')).toBe(false);
		expect(GROUP_KEY_PATTERN.test('-ops')).toBe(false);
		expect(GROUP_KEY_PATTERN.test('7-ops')).toBe(true);
		expect(GROUP_KEY_PATTERN.test('a'.repeat(65))).toBe(false);
	});
});

describe('requests', () => {
	it('adds a member with a PUT for the tenant it was made for', async () => {
		const fetchMock = vi.fn(async () => json({ success: true, added: true }, 201));
		vi.stubGlobal('fetch', fetchMock);
		await httpAdminGroups('acme').addMember('g 1', 'a/1');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/admin-groups/g%201/members/a%2F1');
		expect(init.method).toBe('PUT');
		expect(new Headers(init.headers).get('X-Tenant-Id')).toBe('acme');
	});

	it('creates a group without an empty description, and clears one with null', async () => {
		const fetchMock = vi.fn(async () =>
			json({ id: 'g1', group_key: 'ops', display_name: 'Ops' }, 201)
		);
		vi.stubGlobal('fetch', fetchMock);
		const client = httpAdminGroups('acme');
		await client.create({ group_key: ' ops ', display_name: ' Ops ', description: '  ' });
		await client.update('g1', { display_name: 'Ops', description: '' });
		const bodies = fetchMock.mock.calls.map(
			(call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as unknown
		);
		expect(bodies[0]).toEqual({ group_key: 'ops', display_name: 'Ops' });
		expect(bodies[1]).toEqual({ display_name: 'Ops', description: null });
	});
});

describe('the fake client', () => {
	it('refuses a key or a role twice, as the API does', async () => {
		const client = fakeAdminGroups();
		await expect(client.create({ group_key: 'ops', display_name: 'Again' })).rejects.toBeInstanceOf(
			ConflictError
		);
		await expect(client.addGrant('grp_ops', { role_id: 'role_ar_support' })).rejects.toBeInstanceOf(
			ConflictError
		);
	});

	it('keeps the only open-ended tenant admin role a group gives', async () => {
		const groups = sampleGroupDetails();
		groups[0].grants.push({
			id: 'grt_ta',
			role_id: 'role_ar_tenant_admin',
			role_name: 'ar_tenant_admin',
			role_display_name: 'Tenant Administrator',
			expires_at: null,
			created_at: 0
		});
		groups[0].members = groups[0].members.slice(0, 1);
		const client = fakeAdminGroups({ groups });
		for (const attempt of [
			() => client.removeMember('grp_ops', 'adm_1'),
			() => client.removeGrant('grp_ops', 'grt_ta'),
			() => client.setGrantExpiry('grp_ops', 'grt_ta', Date.now() + 1000),
			() => client.remove('grp_ops')
		]) {
			await expect(attempt()).rejects.toSatisfy(
				(error) => teamErrorCode(error) === 'last_tenant_admin'
			);
		}
		// With someone else holding the role, the same change goes through.
		await fakeAdminGroups({ groups, otherTenantAdmin: true }).removeMember('grp_ops', 'adm_1');
	});

	it('keeps the last current tenant admin even when the role has an end', async () => {
		const groups = sampleGroupDetails();
		groups[0].grants.push({
			id: 'grt_ta',
			role_id: 'role_ar_tenant_admin',
			role_name: 'ar_tenant_admin',
			role_display_name: 'Tenant Administrator',
			expires_at: Date.now() + 86_400_000,
			created_at: 0
		});
		// One active member and one suspended: only the active one counts.
		groups[0].members[1].status = 'suspended';
		const client = fakeAdminGroups({ groups });
		await expect(client.removeMember('grp_ops', 'adm_1')).rejects.toSatisfy(
			(error) => teamErrorCode(error) === 'last_tenant_admin'
		);
		// A later end is fine: they stay an administrator until then.
		await client.setGrantExpiry('grp_ops', 'grt_ta', Date.now() + 2 * 86_400_000);
		// Removing the suspended member takes no current administrator away.
		await client.removeMember('grp_ops', 'adm_2');
	});

	it('answers a change someone else made first', async () => {
		const client = fakeAdminGroups({ failOn: { addMember: 'admin_group_changed' } });
		await expect(client.addMember('grp_ops', 'adm_3')).rejects.toSatisfy(
			(error) => teamErrorCode(error) === 'admin_group_changed'
		);
	});
});
