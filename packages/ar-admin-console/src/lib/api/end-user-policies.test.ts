import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import {
	conditionTypesFromBody,
	httpEndUserPolicies,
	policyFromRow,
	simulationBody,
	simulationFromBody
} from './end-user-policies';
import { createFakePolicies } from './fake/end-user-policies-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = [string, RequestInit];
function stub(body: unknown, status = 200) {
	const fetchMock = vi.fn(async () => json(body, status));
	vi.stubGlobal('fetch', fetchMock);
	return () => fetchMock.mock.calls as unknown as Call[];
}

describe('policies from the wire', () => {
	it('reads a rule, its times as milliseconds', () => {
		expect(
			policyFromRow({
				id: 'p',
				name: 'N',
				description: '',
				priority: 7,
				effect: 'deny',
				resource_types: ['a'],
				actions: null,
				conditions: [{ type: 'in_group', params: { group_id: 'g' } }, 'junk'],
				enabled: false,
				created_at: 1_700_000_000,
				updated_at: 1_700_000_000_000
			})
		).toEqual({
			id: 'p',
			name: 'N',
			description: null,
			priority: 7,
			effect: 'deny',
			resource_types: ['a'],
			actions: [],
			conditions: [
				{ type: 'in_group', params: { group_id: 'g' } },
				{ type: '', params: {} }
			],
			enabled: false,
			created_at: 1_700_000_000_000,
			updated_at: 1_700_000_000_000
		});
	});

	it('reads the condition vocabulary, naming a parameter by its label when it has one', () => {
		const types = conditionTypesFromBody({
			condition_types: [
				{
					type: 'in_group',
					category: 'group',
					label: 'In Group',
					description: 'd',
					params: [
						{ name: 'group_id', type: 'string', required: true, label: 'Group' },
						{ name: 'x' }
					]
				}
			],
			categories: [{ id: 'group', label: 'Group-Based', icon: 'x' }]
		});
		expect(types.types[0].params).toEqual([
			{ name: 'group_id', type: 'string', required: true, label: 'Group' },
			{ name: 'x', type: 'string', required: false, label: 'x' }
		]);
		expect(types.categories).toEqual([{ id: 'group', label: 'Group-Based' }]);
	});

	it('reads a simulation, with its details when it has them, and refuses one without a decision', () => {
		expect(
			simulationFromBody({
				allowed: false,
				reason: 'r',
				decided_by: 'p',
				details: { subject_groups: 'unknown' },
				evaluated_rules: 3
			})
		).toEqual({
			allowed: false,
			reason: 'r',
			decided_by: 'p',
			details: { subject_groups: 'unknown' },
			evaluated_rules: 3
		});
		expect(simulationFromBody({ allowed: true, reason: 'ok' })).toMatchObject({
			decided_by: null,
			details: null,
			evaluated_rules: null
		});
		expect(() => simulationFromBody({ reason: 'x' })).toThrow();
	});

	it('leaves the groups out of a simulation to resolve them, and sends a list as given', () => {
		const input = {
			subject_id: 'u',
			group_ids: null as string[] | null,
			owner_id: '',
			attributes: [] as { name: string; value: string }[],
			role_names: ['editor'],
			resource_type: 'doc',
			resource_id: '1',
			resource_group_ids: [],
			action: 'read',
			timestamp: null
		};
		expect(simulationBody(input)).toEqual({
			context: {
				subject: { id: 'u', roles: [{ name: 'editor', scope: 'global' }] },
				resource: { type: 'doc', id: '1' },
				action: { name: 'read' }
			},
			save_history: false
		});
		type Body = { context: Record<string, Record<string, unknown>> };
		// An empty list is "explicitly no groups", not "resolve".
		const none = simulationBody({ ...input, group_ids: [] }) as Body;
		expect(none.context.subject.groupIds).toEqual([]);
		const owned = simulationBody({
			...input,
			owner_id: ' usr_o ',
			attributes: [{ name: 'tier', value: ' gold ' }]
		}) as Body;
		expect(owned.context.resource.ownerId).toBe('usr_o');
		expect(owned.context.subject.verifiedAttributes).toEqual([
			{ name: 'tier', value: ' gold ', source: 'manual' }
		]);
		const given = simulationBody({
			...input,
			group_ids: ['g'],
			resource_group_ids: ['rg'],
			timestamp: 5
		}) as Body;
		expect(given.context.subject.groupIds).toEqual(['g']);
		expect(given.context.resource.groupIds).toEqual(['rg']);
		expect(given.context.timestamp).toBe(5);
	});
});

describe('requests', () => {
	it('reads a total that comes as text (a BIGINT column from PostgreSQL)', async () => {
		stub({
			rules: [],
			pagination: { page: '1', limit: '20', total: '21', total_pages: 2 }
		});
		await expect(httpEndUserPolicies('acme').list()).resolves.toMatchObject({
			page: 1,
			limit: 20,
			total: 21,
			hasNext: true
		});
	});

	it('lists with the filters and reads the page', async () => {
		const calls = stub({
			rules: [{ id: 'p', name: 'N' }],
			pagination: { page: 2, limit: 1, total: 5, total_pages: 5 }
		});
		const page = await httpEndUserPolicies('acme').list({
			enabled: false,
			search: 'doc',
			page: 2,
			limit: 1
		});
		expect(calls()[0][0]).toBe('/api/admin/policies?enabled=false&search=doc&page=2&limit=1');
		expect(page).toMatchObject({ page: 2, total: 5, hasNext: true });
	});

	it('reads a rule the API wraps, and creates one by its rule_id', async () => {
		stub({ rule: { id: 'p', name: 'N' } });
		await expect(httpEndUserPolicies('acme').get('p')).resolves.toMatchObject({ id: 'p' });
		const calls = stub({ success: true, rule_id: 'new1' }, 201);
		await expect(
			httpEndUserPolicies('acme').create({
				name: ' N ',
				description: '',
				priority: 3,
				effect: 'allow',
				resource_types: [],
				actions: ['read'],
				conditions: [],
				enabled: true
			})
		).resolves.toEqual({ id: 'new1' });
		expect(calls()[0][1].method).toBe('POST');
		expect(JSON.parse(String(calls()[0][1].body))).toMatchObject({ name: 'N', priority: 3 });
	});

	it('saves only what is given, and deletes by id', async () => {
		const calls = stub({ success: true });
		await httpEndUserPolicies('acme').update('p 1', { effect: 'deny' });
		expect(calls()[0][0]).toBe('/api/admin/policies/p%201');
		expect(calls()[0][1].method).toBe('PUT');
		expect(JSON.parse(String(calls()[0][1].body))).toEqual({ effect: 'deny' });
		await httpEndUserPolicies('acme').remove('p');
		expect(calls()[1][1].method).toBe('DELETE');
	});

	it('shows the API’s refusal of a condition it cannot evaluate', async () => {
		stub(
			{
				error: 'invalid_request',
				error_description: 'conditions[0].type is not a known condition type'
			},
			400
		);
		await expect(httpEndUserPolicies('acme').update('p', { conditions: [] })).rejects.toMatchObject(
			{
				status: 400
			}
		);
	});
});

describe('the fake', () => {
	it('refuses what the API refuses', async () => {
		const fake = createFakePolicies();
		await expect(
			fake.create({
				name: 'x',
				description: '',
				priority: 1,
				effect: 'allow',
				resource_types: [],
				actions: [],
				conditions: [{ type: 'nope', params: {} }],
				enabled: true
			})
		).rejects.toBeInstanceOf(ApiError);
		await expect(fake.get('missing')).rejects.toMatchObject({ status: 404 });
	});

	it('lists the group conditions with their parameters', async () => {
		const { types } = await createFakePolicies().conditionTypes();
		expect(types.find((type) => type.type === 'in_any_group')?.params[0].name).toBe('group_ids');
		expect(types.find((type) => type.type === 'same_group')?.params).toEqual([]);
	});

	it('decides a simulation by the groups given or found', async () => {
		const fake = createFakePolicies();
		const ask = (extra: object) =>
			fake.simulate({
				subject_id: 'usr_aiko',
				group_ids: null,
				owner_id: '',
				attributes: [],
				role_names: [],
				resource_type: 'document',
				resource_id: '',
				resource_group_ids: [],
				action: 'read',
				timestamp: null,
				...extra
			});
		await expect(ask({})).resolves.toMatchObject({
			allowed: true,
			decided_by: 'pol_jp',
			details: { subject_groups: 'resolved' }
		});
		await expect(ask({ group_ids: ['grp_eng'] })).resolves.toMatchObject({
			allowed: false,
			details: { subject_groups: 'given' }
		});
		// An empty list is given: no groups, so no group condition holds.
		await expect(ask({ group_ids: [] })).resolves.toMatchObject({
			allowed: false,
			details: { subject_groups: 'given' }
		});
		// The server returns no list of groups.
		expect((await ask({})).details).toEqual({ subject_groups: 'resolved' });
	});

	it('stops on unknown groups as the engine does, even for not_in_any_group and a later allow', async () => {
		const open = {
			description: null,
			resource_types: [],
			actions: [],
			enabled: true,
			created_at: null,
			updated_at: null
		};
		const fake = createFakePolicies({
			rules: [
				{
					...open,
					id: 'a',
					name: 'Not contractors',
					priority: 200,
					effect: 'allow',
					conditions: [{ type: 'not_in_any_group', params: { group_ids: ['grp_contractors'] } }]
				},
				{ ...open, id: 'b', name: 'Everyone', priority: 10, effect: 'allow', conditions: [] }
			]
		});
		const ask = (subject_id: string) =>
			fake.simulate({
				subject_id,
				group_ids: null,
				owner_id: '',
				attributes: [],
				role_names: [],
				resource_type: 'document',
				resource_id: '',
				resource_group_ids: [],
				action: 'read',
				timestamp: null
			});
		const unknown = await ask('usr_zed');
		expect(unknown).toMatchObject({
			allowed: false,
			decided_by: null,
			details: { subject_groups: 'unknown' }
		});
		expect(unknown.reason).toMatch(/groups.*unknown/);
		// A subject whose groups are found is decided by the rules as usual.
		await expect(ask('usr_ben')).resolves.toMatchObject({ allowed: true, decided_by: 'a' });
	});

	it('refuses a dynamic group in a negative condition, as the API does', async () => {
		const fake = createFakePolicies({
			dynamicGroupIds: ['grp_jp'],
			groupChildren: { grp_all: ['grp_jp'] }
		});
		const input = (effect: 'allow' | 'deny', type: string, params: Record<string, unknown>) => ({
			name: 'x',
			description: '',
			priority: 1,
			effect,
			resource_types: [],
			actions: [],
			conditions: [{ type, params }],
			enabled: true
		});
		const refused = (promise: Promise<unknown>) =>
			expect(promise).rejects.toMatchObject({
				status: 400,
				code: 'dynamic_group_negative_condition'
			});
		await refused(fake.create(input('allow', 'not_in_any_group', { group_ids: ['grp_jp'] })));
		// A group with a dynamic descendant counts too.
		await refused(fake.create(input('allow', 'not_in_any_group', { group_ids: ['grp_all'] })));
		await refused(fake.create(input('deny', 'in_group', { group_id: 'grp_jp' })));
		await refused(
			fake.create(input('deny', 'in_any_group', { group_ids: ['grp_eng', 'grp_all'] }))
		);
		await refused(fake.create(input('deny', 'same_group', {})));
		// Allowed: a positive condition in an allow rule, and groups that are not dynamic.
		await fake.create(input('allow', 'in_group', { group_id: 'grp_jp' }));
		await fake.create(input('deny', 'in_group', { group_id: 'grp_eng' }));
		await fake.create(input('allow', 'not_in_any_group', { group_ids: ['grp_eng'] }));
		// The same refusals apply on an update, to the rule as it would become.
		await refused(
			fake.update('pol_contractors', {
				conditions: [{ type: 'in_group', params: { group_id: 'grp_jp' } }]
			})
		);
		await refused(fake.update('pol_jp', { effect: 'deny' }));
		// Switching a rule on does not get it past the check: the whole merged rule is judged.
		const open = {
			description: null,
			resource_types: [],
			actions: [],
			created_at: null,
			updated_at: null
		};
		const off = createFakePolicies({
			dynamicGroupIds: ['grp_jp'],
			rules: [
				{
					...open,
					id: 'bad',
					name: 'Deny Japan office',
					priority: 1,
					effect: 'deny',
					enabled: false,
					conditions: [{ type: 'in_group', params: { group_id: 'grp_jp' } }]
				}
			]
		});
		await expect(off.update('bad', { enabled: true })).rejects.toMatchObject({
			status: 400,
			code: 'dynamic_group_negative_condition'
		});
		await off.update('bad', { effect: 'allow', enabled: true });
		// Disabling alone is never checked, even for a rule that already breaks the restriction.
		const broken = createFakePolicies({
			dynamicGroupIds: ['grp_jp'],
			rules: [
				{
					...open,
					id: 'on',
					name: 'Deny Japan office',
					priority: 1,
					effect: 'deny',
					enabled: true,
					conditions: [{ type: 'in_group', params: { group_id: 'grp_jp' } }]
				}
			]
		});
		await broken.update('on', { enabled: false });
		// A disable alongside another change is judged like any other change.
		await expect(broken.update('on', { enabled: false, priority: 2 })).rejects.toMatchObject({
			status: 400
		});
		// A deny rule may not name a role granted through a dynamic group (or an ancestor of one).
		const withRoles = createFakePolicies({
			dynamicGroupIds: ['grp_jp'],
			groupChildren: { grp_all: ['grp_jp'] },
			groupRoles: { grp_jp: ['japan_staff'], grp_all: ['everyone'], grp_eng: ['engineer'] }
		});
		const deny = (type: string, params: Record<string, unknown>) =>
			withRoles.create({
				name: 'x',
				description: '',
				priority: 1,
				effect: 'deny',
				resource_types: [],
				actions: [],
				conditions: [{ type, params }],
				enabled: true
			});
		await expect(deny('has_role', { role: 'japan_staff' })).rejects.toMatchObject({
			status: 400,
			code: 'dynamic_group_negative_condition'
		});
		await expect(deny('has_any_role', { roles: ['engineer', 'everyone'] })).rejects.toMatchObject({
			code: 'dynamic_group_negative_condition'
		});
		await expect(deny('has_all_roles', { roles: ['japan_staff'] })).rejects.toMatchObject({
			code: 'dynamic_group_negative_condition'
		});
		// A role of a group that is not dynamic, and an allow rule naming the role, are fine.
		await deny('has_role', { role: 'engineer' });
		await withRoles.create({
			name: 'x',
			description: '',
			priority: 1,
			effect: 'allow',
			resource_types: [],
			actions: [],
			conditions: [{ type: 'has_role', params: { role: 'japan_staff' } }],
			enabled: true
		});
		// Without dynamic groups a deny same_group is fine.
		await createFakePolicies({ dynamicGroupIds: [] }).create(input('deny', 'same_group', {}));
	});

	it('grants nothing from rules that rely on a dynamic group’s non-membership', async () => {
		const open = {
			description: null,
			resource_types: [],
			actions: [],
			enabled: true,
			created_at: null,
			updated_at: null
		};
		const fake = createFakePolicies({
			dynamicGroupIds: ['grp_jp'],
			rules: [
				{
					...open,
					id: 'stale',
					name: 'Not Japan office',
					priority: 200,
					effect: 'allow',
					conditions: [{ type: 'not_in_any_group', params: { group_ids: ['grp_jp'] } }]
				},
				{ ...open, id: 'later', name: 'Everyone', priority: 10, effect: 'allow', conditions: [] }
			]
		});
		const result = await fake.simulate({
			subject_id: 'usr_ben',
			group_ids: null,
			owner_id: '',
			attributes: [],
			role_names: [],
			resource_type: 'document',
			resource_id: '',
			resource_group_ids: [],
			action: 'read',
			timestamp: null
		});
		expect(result).toMatchObject({ allowed: false, decided_by: null });
		expect(result.reason).toBe(
			'Rule stale: not_in_any_group names grp_jp, whose membership a service group decides'
		);
	});

	it('grants nothing while a deny rule names a role granted through a dynamic group', async () => {
		const open = {
			description: null,
			resource_types: [],
			actions: [],
			enabled: true,
			created_at: null,
			updated_at: null
		};
		const fake = createFakePolicies({
			rules: [
				{
					...open,
					id: 'deny_role',
					name: 'Deny Japan staff',
					priority: 200,
					effect: 'deny',
					conditions: [{ type: 'has_role', params: { role: 'japan_staff' } }]
				},
				{ ...open, id: 'later', name: 'Everyone', priority: 10, effect: 'allow', conditions: [] }
			]
		});
		const result = await fake.simulate({
			subject_id: 'usr_ben',
			group_ids: [],
			owner_id: '',
			attributes: [],
			role_names: [],
			resource_type: 'document',
			resource_id: '',
			resource_group_ids: [],
			action: 'read',
			timestamp: null
		});
		expect(result).toMatchObject({ allowed: false, decided_by: null });
		expect(result.reason).toBe(
			"Rule deny_role: A deny rule's has_role names japan_staff, a role granted through a service group"
		);
	});

	it('does not let a later allow get past a deny that needs a target the check lacks', async () => {
		const open = {
			description: null,
			resource_types: [],
			actions: [],
			enabled: true,
			created_at: null,
			updated_at: null
		};
		const fake = createFakePolicies({
			dynamicGroupIds: [],
			rules: [
				{
					...open,
					id: 'deny_same',
					name: 'Deny outside the resource group',
					priority: 200,
					effect: 'deny',
					conditions: [{ type: 'same_group', params: {} }]
				},
				{ ...open, id: 'later', name: 'Everyone', priority: 10, effect: 'allow', conditions: [] }
			]
		});
		const ask = (extra: object) =>
			fake.simulate({
				subject_id: 'usr_aiko',
				group_ids: [],
				owner_id: '',
				attributes: [],
				role_names: [],
				resource_type: 'document',
				resource_id: '',
				resource_group_ids: [],
				action: 'read',
				timestamp: null,
				...extra
			});
		const missing = await ask({});
		expect(missing).toMatchObject({ allowed: false, decided_by: 'deny_same' });
		expect(missing.reason).toContain("the resource's groups");
		// With resource groups given the rules are evaluated as usual.
		await expect(ask({ resource_group_ids: ['grp_jp'] })).resolves.toMatchObject({
			allowed: true,
			decided_by: 'later'
		});
	});

	it('meets only the conditions it implements, owner and attributes included', async () => {
		const open = {
			description: null,
			resource_types: [],
			actions: [],
			enabled: true,
			created_at: null,
			updated_at: null
		};
		const fake = createFakePolicies({
			rules: [
				{
					...open,
					id: 'o',
					name: 'Owner',
					priority: 2,
					effect: 'allow',
					conditions: [{ type: 'is_resource_owner', params: {} }]
				},
				{
					...open,
					id: 't',
					name: 'Tier',
					priority: 1,
					effect: 'allow',
					conditions: [{ type: 'attribute_equals', params: { name: 'tier', value: 'gold' } }]
				},
				{
					...open,
					id: 'n',
					name: 'Not implemented',
					priority: 3,
					effect: 'allow',
					conditions: [{ type: 'numeric_between', params: { name: 'x', min: 0, max: 1 } }]
				}
			]
		});
		const ask = (extra: object) =>
			fake.simulate({
				subject_id: 'usr_aiko',
				group_ids: [],
				owner_id: '',
				attributes: [],
				role_names: [],
				resource_type: 'document',
				resource_id: '',
				resource_group_ids: [],
				action: 'read',
				timestamp: null,
				...extra
			});
		await expect(ask({})).resolves.toMatchObject({ allowed: false });
		await expect(ask({ owner_id: 'usr_aiko' })).resolves.toMatchObject({ decided_by: 'o' });
		await expect(ask({ attributes: [{ name: 'tier', value: 'gold' }] })).resolves.toMatchObject({
			decided_by: 't'
		});
		await expect(ask({ attributes: [{ name: 'tier', value: ' gold' }] })).resolves.toMatchObject({
			allowed: false
		});
	});
});
