import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ConflictError } from './api-error';
import {
	GROUP_KEY_PATTERN,
	groupDetailFromRow,
	groupFromRow,
	httpEndUserGroups,
	MalformedResponseError,
	memberFromRow,
	msOrNull
} from './end-user-groups';
import { createFakeAuthz } from './fake/end-user-authz-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = [string, RequestInit];
function stub(...bodies: unknown[]) {
	const fetchMock = vi.fn(async () => json(bodies.length > 1 ? bodies.shift() : bodies[0]));
	vi.stubGlobal('fetch', fetchMock);
	return () => fetchMock.mock.calls as unknown as Call[];
}

describe('groups from the wire', () => {
	it('marks the group the service-group catalog owns, by its own key only', () => {
		expect(groupFromRow({ id: 'g1', kind: 'dynamic', group_key: 'dynamic:g1' }).managed).toBe(true);
		expect(groupFromRow({ id: 'g1', kind: 'dynamic', group_key: 'dynamic:other' }).managed).toBe(
			false
		);
		expect(groupFromRow({ id: 'g1', kind: 'static', group_key: 'dynamic:g1' }).managed).toBe(false);
	});

	it('reads unknown kinds and states as the safe defaults, and names from the key', () => {
		expect(
			groupFromRow({ id: 'g', group_key: 'ops', kind: 'weird', lifecycle_state: 'x' })
		).toMatchObject({
			kind: 'static',
			lifecycle_state: 'active',
			display_name: 'ops',
			member_count: 0
		});
	});

	it('reads a detail with its parents and grants, times in milliseconds', () => {
		const group = groupDetailFromRow({
			id: 'g',
			group_key: 'g',
			display_name: 'G',
			parent_chain: [{ id: 'p', group_key: 'p', display_name: 'P', lifecycle_state: 'active' }],
			roles: [
				{
					id: 'a',
					role_id: 'r',
					scope_type: 'group',
					scope_target: 'group:p',
					expires_at: 2_000_000_000
				}
			]
		});
		expect(group.parent_chain[0].id).toBe('p');
		expect(group.roles[0]).toMatchObject({ scope_type: 'group', expires_at: 2_000_000_000_000 });
	});

	it('reads a membership row, its source and whether it grants', () => {
		expect(
			memberFromRow({
				subject_id: 'u',
				assignment_source: 'dynamic',
				effective: true,
				stale_after: 1_800_000_000,
				user_email: 'u@example.com'
			})
		).toMatchObject({
			source: 'dynamic',
			effective: true,
			stale_after: 1_800_000_000_000,
			email: 'u@example.com'
		});
	});

	it('reads seconds and milliseconds alike, and nothing as null', () => {
		expect(msOrNull(1_800_000_000)).toBe(1_800_000_000_000);
		expect(msOrNull(1_800_000_000_000)).toBe(1_800_000_000_000);
		expect(msOrNull('1800000000')).toBe(1_800_000_000_000);
		expect(msOrNull(0)).toBeNull();
		expect(msOrNull(null)).toBeNull();
	});

	it('accepts the keys the groups API accepts', () => {
		expect(GROUP_KEY_PATTERN.test('engineering.backend')).toBe(true);
		expect(GROUP_KEY_PATTERN.test('scim:sales')).toBe(true);
		expect(GROUP_KEY_PATTERN.test('-x')).toBe(false);
		expect(GROUP_KEY_PATTERN.test('a'.repeat(129))).toBe(false);
	});
});

describe('requests', () => {
	it('lists with the filters asked for', async () => {
		const calls = stub({
			groups: [{ id: 'g', group_key: 'g' }],
			pagination: { total: 1, hasNext: false }
		});
		const page = await httpEndUserGroups('acme').list({
			q: ' eng ',
			kind: 'dynamic',
			page: 2,
			limit: 10
		});
		expect(calls()[0][0]).toBe('/api/admin/groups?q=eng&kind=dynamic&page=2&limit=10');
		expect(page).toMatchObject({ total: 1, hasNext: false });
		expect(page.items[0].id).toBe('g');
	});

	it('reads every child of a group, page after page, by the parent filter', async () => {
		const calls = stub(
			{ groups: [{ id: 'a', parent_group_id: 'p' }], pagination: { page: 1, hasNext: true } },
			{ groups: [{ id: 'b', parent_group_id: 'p' }], pagination: { page: 2, hasNext: false } }
		);
		const children = await httpEndUserGroups('acme').children('p');
		expect(children.map((group) => group.id)).toEqual(['a', 'b']);
		expect(calls()[0][0]).toBe('/api/admin/groups?parent_group_id=p&page=1&limit=100');
		expect(calls()[1][0]).toContain('page=2');
	});

	it('never answers part of the children as all of them', async () => {
		stub({ groups: [], pagination: { hasNext: true } });
		await expect(httpEndUserGroups('acme').children('p')).rejects.toThrow();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'server_error' }, 500))
		);
		await expect(httpEndUserGroups('acme').children('p')).rejects.toBeInstanceOf(ApiError);
	});

	it('takes a body that is not a list page as a failure, not as no children', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"groups": [', { status: 200 }))
		);
		await expect(httpEndUserGroups('acme').children('p')).rejects.toBeInstanceOf(
			MalformedResponseError
		);
		stub({ groups: {}, pagination: { hasNext: false } });
		await expect(httpEndUserGroups('acme').children('p')).rejects.toBeInstanceOf(
			MalformedResponseError
		);
		stub({ groups: [] });
		await expect(httpEndUserGroups('acme').list()).rejects.toBeInstanceOf(MalformedResponseError);
	});

	it('keeps only the children when the server does not filter', async () => {
		stub({
			groups: [
				{ id: 'a', parent_group_id: 'p' },
				{ id: 'x', parent_group_id: null }
			],
			pagination: { hasNext: false }
		});
		const children = await httpEndUserGroups('acme').children('p');
		expect(children.map((group) => group.id)).toEqual(['a']);
	});

	it('reads whether the caller may change who is in a group, and nothing when not said', () => {
		expect(
			groupDetailFromRow({ id: 'g', can_manage_membership: false }).can_manage_membership
		).toBe(false);
		expect(groupDetailFromRow({ id: 'g' }).can_manage_membership).toBeNull();
	});

	it('keeps a rule save’s publication state', async () => {
		stub({ revision: 5, groups: [], publication: { status: 'expiry_pending' } });
		const saved = await httpEndUserGroups('acme').saveDynamic(
			{ id: 'x', key: 'jp', displayName: 'JP', description: '', enabled: true, condition: null },
			4
		);
		expect(saved.publication).toEqual({ status: 'expiry_pending' });
		stub({ revision: 6, groups: [] });
		await expect(
			httpEndUserGroups('acme').saveDynamic(
				{ id: 'x', key: 'jp', displayName: 'JP', description: '', enabled: true, condition: null },
				5
			)
		).resolves.toMatchObject({ publication: null });
	});

	it('sends only what changed, a cleared description as null and a top-level move as null', async () => {
		const calls = stub({ group: { id: 'g' } });
		await httpEndUserGroups('acme').update('g 1', { description: '  ', parent_group_id: null });
		const [url, init] = calls()[0];
		expect(url).toBe('/api/admin/groups/g%201');
		expect(init.method).toBe('PUT');
		expect(JSON.parse(String(init.body))).toEqual({ description: null, parent_group_id: null });
	});

	it('adds a member with its window in seconds', async () => {
		const calls = stub({ success: true });
		await httpEndUserGroups('acme').addMember('g', ' u1 ', { expires_at: 1_800_000_000_500 });
		expect(JSON.parse(String(calls()[0][1].body))).toEqual({
			subject_id: 'u1',
			expires_at: 1_800_000_000
		});
	});

	it('names the grant to remove by role and scope', async () => {
		const calls = stub({ success: true });
		await httpEndUserGroups('acme').revokeRole('g', {
			role_id: 'r',
			scope_type: 'group',
			scope_target: 'group:p'
		});
		expect(calls()[0][0]).toBe(
			'/api/admin/groups/g/roles/r?scope_type=group&scope_target=group%3Ap'
		);
		expect(calls()[0][1].method).toBe('DELETE');
	});

	it('grants a role with an end in seconds and no empty target', async () => {
		const calls = stub({ success: true });
		await httpEndUserGroups('acme').grantRole('g', {
			role_id: 'r',
			scope_type: 'global',
			scope_target: ' ',
			expires_at: 1_900_000_000_000
		});
		expect(JSON.parse(String(calls()[0][1].body))).toEqual({
			role_id: 'r',
			scope_type: 'global',
			expires_at: 1_900_000_000
		});
	});

	it('saves a dynamic rule with the revision read, and creates one without an id', async () => {
		const calls = stub({ revision: 4, groups: [{ id: 'x', key: 'jp', displayName: 'JP' }] });
		const client = httpEndUserGroups('acme');
		await client.saveDynamic(
			{ key: 'jp', displayName: 'JP', description: '', enabled: true, condition: null },
			3
		);
		expect(calls()[0][0]).toBe('/api/admin/service-groups');
		expect(calls()[0][1].method).toBe('POST');
		expect(JSON.parse(String(calls()[0][1].body))).toMatchObject({ key: 'jp', ifMatch: 3 });
		await client.saveDynamic(
			{ id: 'x', key: 'jp', displayName: 'JP', description: '', enabled: true, condition: null },
			4
		);
		expect(calls()[1][0]).toBe('/api/admin/service-groups/x');
		expect(calls()[1][1].method).toBe('PUT');
	});

	it('reads the catalog with its fields and scans', async () => {
		stub({
			revision: 7,
			groups: [
				{
					id: 'g',
					key: 'jp',
					displayName: 'JP',
					enabled: false,
					condition: { op: 'member', groupId: 'o' }
				}
			],
			fields: { nickname: { type: 'string', selfWritable: true } },
			scans: [{ binding_ref: 'account-0', rule_version: 6, status: 'processing' }]
		});
		const catalog = await httpEndUserGroups('acme').catalog();
		expect(catalog.revision).toBe(7);
		expect(catalog.groups[0]).toMatchObject({ enabled: false, condition: { op: 'member' } });
		expect(catalog.fields.nickname).toEqual({ type: 'string', pii: false, selfWritable: true });
		expect(catalog.scans[0]).toMatchObject({ rule_version: 6, status: 'processing' });
	});

	it('reads a user’s memberships and the groups they resolve to', async () => {
		stub({
			user_id: 'u',
			memberships: [
				{
					subject_id: 'u',
					group_id: 'g',
					group_key: 'g',
					assignment_source: 'manual',
					effective: true
				}
			],
			resolved: { direct_group_ids: ['g'], effective_groups: [{ id: 'p', direct: false }] }
		});
		const groups = await httpEndUserGroups('acme').userGroups('u');
		expect(groups.memberships[0]).toMatchObject({ group_id: 'g', source: 'manual' });
		expect(groups.effective).toEqual([
			{ id: 'p', group_key: null, display_name: null, direct: false }
		]);
	});

	it('keeps the API’s code of a refusal', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				json({ error: 'group_managed_by_service_group', error_description: 'x' }, 409)
			)
		);
		await expect(httpEndUserGroups('acme').remove('g')).rejects.toSatisfy(
			(error) =>
				error instanceof ConflictError && error.body.error === 'group_managed_by_service_group'
		);
	});
});

describe('the fake client', () => {
	it('refuses deleting a group with children, a managed group, and a key twice', async () => {
		const { groups } = createFakeAuthz();
		await expect(groups.remove('grp_eng')).rejects.toBeInstanceOf(ConflictError);
		await expect(groups.remove('grp_jp')).rejects.toSatisfy(
			(error) =>
				error instanceof ConflictError && error.body.error === 'group_managed_by_service_group'
		);
		await expect(
			groups.create({
				group_key: 'engineering',
				display_name: 'x',
				description: '',
				parent_group_id: null
			})
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('refuses removing a membership from another source, and a change above the ceiling', async () => {
		const { groups } = createFakeAuthz({ ceiling: 0 });
		await expect(groups.removeMember('grp_sales', 'usr_ben')).rejects.toBeInstanceOf(ConflictError);
		await expect(groups.addMember('grp_eng', 'usr_chen')).rejects.toSatisfy(
			(error) => error instanceof ApiError && error.status === 403
		);
	});

	it('refuses a rule saved on an old revision', async () => {
		const { groups } = createFakeAuthz();
		const catalog = await groups.catalog();
		const definition = catalog.groups[0];
		await groups.saveDynamic({ ...definition, enabled: false }, catalog.revision);
		await expect(groups.saveDynamic(definition, catalog.revision)).rejects.toSatisfy(
			(error) => error instanceof ConflictError && error.body.error === 'group_version_conflict'
		);
		expect((await groups.get(definition.id)).lifecycle_state).toBe('inactive');
	});
});
