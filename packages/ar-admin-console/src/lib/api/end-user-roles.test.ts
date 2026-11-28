import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ConflictError } from './api-error';
import { effectiveFromBody, httpEndUserRoles, roleFromRow } from './end-user-roles';
import { createFakeAuthz } from './fake/end-user-authz-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = [string, RequestInit];
function stub(body: unknown) {
	const fetchMock = vi.fn(async () => json(body));
	vi.stubGlobal('fetch', fetchMock);
	return () => fetchMock.mock.calls as unknown as Call[];
}

describe('roles from the wire', () => {
	it('reads the permissions from whichever field the answer has', () => {
		expect(roleFromRow({ id: 'r', permissions_json: '["a:b"]' }).permissions).toEqual(['a:b']);
		expect(roleFromRow({ id: 'r', added_permissions: ['c:d'] }).permissions).toEqual(['c:d']);
		expect(roleFromRow({ id: 'r', permissions_json: 'not json' }).permissions).toEqual([]);
	});

	it('reads a preset role by its flag or type, and the id of a created one', () => {
		expect(roleFromRow({ id: 'r', is_system: 1 }).is_system).toBe(true);
		expect(roleFromRow({ id: 'r', role_type: 'system' }).is_system).toBe(true);
		expect(roleFromRow({ role_id: 'new', name: 'x', grant_tier: 2 })).toMatchObject({
			id: 'new',
			grant_tier: 2
		});
	});

	it('reads where each effective role comes from', () => {
		const effective = effectiveFromBody({
			permissions: [{ permission: 'a:b', source_id: 'r', source_name: 'editor' }],
			roles: [
				{ role_id: 'r', role_name: 'editor', scope: 'global', via: { kind: 'direct' } },
				{
					role_id: 'r',
					role_name: 'editor',
					scope: 'group',
					scope_target: 'group:g',
					via: { kind: 'group', group_id: 'p', through_group_id: 'g' }
				}
			]
		});
		expect(effective.permissions[0]).toEqual({
			permission: 'a:b',
			role_id: 'r',
			role_name: 'editor'
		});
		expect(effective.roles[0].via).toEqual({ kind: 'direct' });
		expect(effective.roles[1]).toMatchObject({
			scope_type: 'group',
			via: { kind: 'group', group_id: 'p', through_group_id: 'g' }
		});
	});
});

describe('requests', () => {
	it('reads a role the API wraps, and one it does not', async () => {
		stub({ role: { id: 'r', name: 'x', grant_tier: 3 } });
		await expect(httpEndUserRoles('acme').get('r')).resolves.toMatchObject({ grant_tier: 3 });
		stub({ id: 'r', name: 'x', grant_tier: 2 });
		await expect(httpEndUserRoles('acme').get('r')).resolves.toMatchObject({ grant_tier: 2 });
	});

	it('creates a role with its tier, without repeated permissions', async () => {
		const calls = stub({ role_id: 'r', name: 'editor' });
		await httpEndUserRoles('acme').create({
			name: ' editor ',
			description: '',
			permissions: ['a:b', 'a:b'],
			grant_tier: 2
		});
		expect(JSON.parse(String(calls()[0][1].body))).toEqual({
			name: 'editor',
			permissions: ['a:b'],
			grant_tier: 2
		});
	});

	it('saves only what changed', async () => {
		const calls = stub({});
		await httpEndUserRoles('acme').update('r 1', { grant_tier: 1 });
		expect(calls()[0][0]).toBe('/api/admin/roles/r%201');
		expect(calls()[0][1].method).toBe('PATCH');
		expect(JSON.parse(String(calls()[0][1].body))).toEqual({ grant_tier: 1 });
	});

	it('gives a user a role with `scope` and the end in Unix seconds, as that route takes them', async () => {
		const calls = stub({ success: true });
		await httpEndUserRoles('acme').assignToUser('u', {
			role_id: 'r',
			scope_type: 'resource',
			scope_target: 'resource:documents:42',
			expires_at: 1_900_000_000_000
		});
		expect(calls()[0][0]).toBe('/api/admin/users/u/roles');
		expect(JSON.parse(String(calls()[0][1].body))).toEqual({
			role_id: 'r',
			scope: 'resource',
			scope_target: 'resource:documents:42',
			expires_at: 1_900_000_000
		});
	});

	it('reads the users given a role, a page at a time', async () => {
		const calls = stub({
			assignments: [
				{ assignment_id: 'a', user_id: 'u', scope: 'tenant', assigned_at: 1_700_000_000_000 }
			],
			pagination: { page: 2, total: 21, hasNext: true }
		});
		const page = await httpEndUserRoles('acme').assignments('r', { page: 2, limit: 20 });
		expect(calls()[0][0]).toBe('/api/admin/roles/r/assignments?page=2&limit=20');
		expect(page).toMatchObject({ total: 21, hasNext: true });
		expect(page.items[0]).toMatchObject({ id: 'a', scope_type: 'tenant' });
	});
});

describe('the groups a role is given to', () => {
	it('reads them a page at a time', async () => {
		const calls = stub({
			group_assignments: [
				{
					assignment_id: 'g1',
					group_id: 'grp',
					group_key: 'staff',
					group_display_name: 'Staff',
					scope: 'group',
					scope_target: 'group:other',
					assigned_by: 'adm',
					expires_at: 1_900_000_000,
					assigned_at: 1_700_000_000_000
				},
				{ assignment_id: 'g2', group_id: 'gone', group_key: null, scope: 'tenant' }
			],
			pagination: { page: 1, limit: 20, total: 2, hasNext: false }
		});
		const page = await httpEndUserRoles('acme').groupAssignments('r', { page: 1, limit: 20 });
		expect(calls()[0][0]).toBe('/api/admin/roles/r/group-assignments?page=1&limit=20');
		expect(page).toMatchObject({ total: 2, hasNext: false });
		expect(page.items[0]).toEqual({
			id: 'g1',
			group_id: 'grp',
			group_key: 'staff',
			group_display_name: 'Staff',
			scope_type: 'group',
			scope_target: 'group:other',
			assigned_by: 'adm',
			expires_at: 1_900_000_000_000,
			assigned_at: 1_700_000_000_000
		});
		expect(page.items[1]).toMatchObject({ group_key: null, group_display_name: null });
	});

	it('lists them in the fake, with the group and the scope', async () => {
		const { roles } = createFakeAuthz();
		const all = await roles.groupAssignments('role_editor');
		expect(all.items.map((item) => item.group_id).sort()).toEqual(['grp_eng', 'grp_jp']);
		expect(all.items.find((item) => item.group_id === 'grp_jp')).toMatchObject({
			scope_type: 'group',
			scope_target: 'group:grp_jp'
		});
		expect((await roles.groupAssignments('role_billing')).items).toEqual([]);
	});
});

describe('the fake client', () => {
	it('holds roles to the grant ceiling', async () => {
		const { roles } = createFakeAuthz({ ceiling: 1 });
		await expect(
			roles.create({ name: 'strong', description: '', permissions: ['a:b'], grant_tier: 2 })
		).rejects.toSatisfy((error) => error instanceof ApiError && error.status === 403);
		await expect(
			roles.assignToUser('usr_aiko', {
				role_id: 'role_billing',
				scope_type: 'global',
				scope_target: '',
				expires_at: null
			})
		).rejects.toSatisfy((error) => error instanceof ApiError && error.status === 403);
	});

	it('refuses deleting a role given to someone, and a grant twice', async () => {
		const { roles } = createFakeAuthz();
		await expect(roles.remove('role_editor')).rejects.toBeInstanceOf(ConflictError);
		await expect(
			roles.assignToUser('usr_chen', {
				role_id: 'role_editor',
				scope_type: 'global',
				scope_target: '',
				expires_at: null
			})
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('says which roles a user holds through a group and its parents', async () => {
		const { roles } = createFakeAuthz();
		// Chen is in Backend, below Engineering, which has the editor role.
		const effective = await roles.effectivePermissions('usr_chen');
		expect(effective.roles).toContainEqual(
			expect.objectContaining({
				role_id: 'role_editor',
				via: { kind: 'group', group_id: 'grp_eng', through_group_id: 'grp_backend' }
			})
		);
	});
});
