import { describe, expect, it, vi } from 'vitest';
import { authzAccess } from '#lib/access/access.js';
import { persona } from '#lib/access/personas.js';
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import { ApiError, ConflictError } from '#lib/api/api-error.js';
import type { EndUserGroup } from '#lib/api/end-user-groups.js';
import {
	problems,
	type ConditionField,
	type ConditionGroup
} from '#lib/ui/patterns/condition-model.js';
import { claimsOf, toggleClaim } from '#lib/settings/claim-list.js';
import { askedCheck, checkInput, formProblems, viaLabel, EMPTY_FORM } from './access-check-model';
import { authzRefusal, refusalText } from './authz-errors';
import {
	conditionFromExpression,
	conditionToSave,
	expressionFromCondition,
	fieldsFromCatalog
} from './dynamic-rule-model';
import {
	childrenOf,
	creatableKinds,
	descendantsOf,
	groupKeyProblem,
	parentChoices,
	scopeTarget,
	scopeTargetProblem,
	suggestKey
} from './group-model';
import {
	minimumGrantTier,
	permissionProblem,
	roleChanges,
	roleNameProblem,
	tierChoices
} from './role-model';
import { groupSearch, userSearch } from './user-picker';

const group = (id: string, parent: string | null = null): EndUserGroup => ({
	id,
	group_key: id,
	display_name: id.toUpperCase(),
	description: null,
	parent_group_id: parent,
	lifecycle_state: 'active',
	kind: 'static',
	external_id: null,
	member_count: 0,
	managed: false,
	created_at: null,
	updated_at: null
});

describe('who may do what', () => {
	it('gives a tenant administrator groups, roles and the ceiling of their role', () => {
		const access = authzAccess(persona('tenant').access);
		expect(access).toMatchObject({
			groupsRead: true,
			groupsWrite: true,
			rolesWrite: true,
			check: true,
			grantCeiling: 2
		});
	});

	it('gives a viewer reading only, and the lowest ceiling', () => {
		const access = authzAccess(persona('viewer').access);
		expect(access).toMatchObject({ groupsRead: true, groupsWrite: false, rolesWrite: false });
		expect(access.grantCeiling).toBe(1);
	});

	it('gives the super administrator the highest ceiling', () => {
		expect(authzAccess(persona('platform').access).grantCeiling).toBe(3);
	});

	it('reads relationships with the roles’ read, changes and checks with write, deletes with delete', () => {
		expect(authzAccess(persona('tenant').access)).toMatchObject({
			rebacRead: true,
			rebacWrite: true,
			rebacDelete: true
		});
		expect(authzAccess(persona('viewer').access)).toMatchObject({
			rebacRead: true,
			rebacWrite: false,
			rebacDelete: false
		});
		// Without the roles’ read nothing is open, whatever else is held.
		const onlyWrite = authzAccess({
			platform: false,
			roles: [],
			permissions: ['admin:roles:write', 'admin:roles:delete']
		});
		expect(onlyWrite).toMatchObject({ rebacRead: false, rebacWrite: false, rebacDelete: false });
		// Custom role with the permissions but not the tenant administrator role: read-only.
		const custom = authzAccess({
			platform: false,
			roles: ['custom_role'],
			permissions: ['admin:roles:read', 'admin:roles:write', 'admin:roles:delete']
		});
		expect(custom).toMatchObject({ rebacRead: true, rebacWrite: false, rebacDelete: false });
		// The role without the permission is no better.
		const roleOnly = authzAccess({
			platform: false,
			roles: ['ar_tenant_admin'],
			permissions: ['admin:roles:read']
		});
		expect(roleOnly).toMatchObject({ rebacRead: true, rebacWrite: false, rebacDelete: false });
		const both = authzAccess({
			platform: false,
			roles: ['ar_tenant_admin'],
			permissions: ['admin:roles:read', 'admin:roles:write']
		});
		expect(both).toMatchObject({ rebacWrite: true, rebacDelete: false });
		expect(authzAccess(persona('platform').access).rebacWrite).toBe(true);
	});
});

describe('groups', () => {
	const groups = [group('a'), group('b', 'a'), group('c', 'b'), group('d')];

	it('finds the groups below one, at any depth', () => {
		expect([...descendantsOf(groups, 'a')].sort()).toEqual(['b', 'c']);
		expect(childrenOf(groups, 'a').map((item) => item.id)).toEqual(['b']);
	});

	it('never offers a group, or one below it, as its own parent', () => {
		expect(parentChoices(groups, 'a').map((item) => item.id)).toEqual(['d']);
		expect(parentChoices(groups, 'c').map((item) => item.id)).toEqual(['a', 'b', 'd']);
	});

	it('offers each kind only to who may create it, by its own API', () => {
		expect(creatableKinds({ groupsWrite: true, rulesRead: true, rulesWrite: true })).toEqual([
			'static',
			'dynamic'
		]);
		expect(creatableKinds({ groupsWrite: true, rulesRead: false, rulesWrite: false })).toEqual([
			'static'
		]);
		expect(creatableKinds({ groupsWrite: false, rulesRead: true, rulesWrite: true })).toEqual([
			'dynamic'
		]);
		// Writing the catalog without reading it cannot make a dynamic group (its revision is read).
		expect(creatableKinds({ groupsWrite: false, rulesRead: false, rulesWrite: true })).toEqual([]);
	});

	it('checks a key by the rule of its kind', () => {
		expect(groupKeyProblem(' ')).toBe('grp.new.keyRequired');
		expect(groupKeyProblem('Sales.EU')).toBeUndefined();
		expect(groupKeyProblem('Sales.EU', 'dynamic')).toBe('grp.new.dynamicKeyInvalid');
		expect(groupKeyProblem('sales-eu', 'dynamic')).toBeUndefined();
	});

	it('suggests a key from the name, starting a dynamic one with a letter', () => {
		expect(suggestKey('Sales EU')).toBe('sales-eu');
		expect(suggestKey('2026 cohort', 'dynamic')).toBe('g-2026-cohort');
		expect(groupKeyProblem(suggestKey('2026 cohort', 'dynamic'), 'dynamic')).toBeUndefined();
	});

	it('builds and checks a scope target as the API reads it', () => {
		expect(scopeTarget('group', 'g1')).toBe('group:g1');
		expect(scopeTarget('resource', 'documents:42')).toBe('resource:documents:42');
		expect(scopeTarget('global', 'x')).toBe('');
		expect(scopeTargetProblem('group', '')).toBe('az.scope.groupRequired');
		expect(scopeTargetProblem('resource', 'resource:a:b:c')).toBe('az.scope.resourceInvalid');
		expect(scopeTargetProblem('resource', 'resource:a:b')).toBeUndefined();
		expect(scopeTargetProblem('tenant', '')).toBeUndefined();
	});
});

describe('dynamic rules', () => {
	const catalog = {
		country: { type: 'string', pii: false, selfWritable: false },
		level: { type: 'number', pii: false, selfWritable: false },
		tags: { type: 'string[]', pii: false, selfWritable: false },
		scores: { type: 'number[]', pii: false, selfWritable: false },
		flags: { type: 'boolean[]', pii: false, selfWritable: false }
	};
	const fields: ConditionField[] = fieldsFromCatalog(catalog);

	it('offers each field only the comparisons the catalog can make', () => {
		expect(fields.map((field) => [field.key, field.operators])).toEqual([
			['country', ['eq', 'ne', 'in', 'not_in']],
			['flags', ['contains', 'not_contains']],
			['level', ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']],
			['scores', ['contains', 'not_contains']],
			['tags', ['contains', 'not_contains']]
		]);
	});

	it('takes only values of a list field’s element type', () => {
		const scores = fields.find((field) => field.key === 'scores')!;
		const flags = fields.find((field) => field.key === 'flags')!;
		expect(scores.accepts?.('42')).toBe(true);
		expect(scores.accepts?.('x')).toBe(false);
		expect(flags.accepts?.('true')).toBe(true);
		expect(flags.accepts?.('yes')).toBe(false);
		expect(fields.find((field) => field.key === 'tags')!.accepts).toBeUndefined();
	});

	it('writes list elements in the field’s element type', () => {
		const rule = {
			op: 'all' as const,
			args: [
				{ op: 'attribute' as const, field: 'scores', compare: 'contains' as const, value: 7 },
				{ op: 'attribute' as const, field: 'flags', compare: 'contains' as const, value: true },
				{ op: 'attribute' as const, field: 'tags', compare: 'contains' as const, value: '7' },
				{ op: 'attribute' as const, field: 'level', compare: 'in' as const, value: [1, 2] }
			]
		};
		const condition = conditionFromExpression(rule) as ConditionGroup;
		// The builder holds what is typed as text…
		for (const child of condition.children)
			if (child.kind === 'rule' && child.field !== 'flags')
				child.value = Array.isArray(child.value) ? child.value.map(String) : String(child.value);
		// …and the catalog gets the field's types back.
		expect(expressionFromCondition(condition, catalog)).toEqual(rule);
	});

	it('loads a list element as text the builder accepts, and saves it in its type', () => {
		const loaded = {
			op: 'all' as const,
			args: [
				{ op: 'attribute' as const, field: 'flags', compare: 'contains' as const, value: true },
				{ op: 'attribute' as const, field: 'scores', compare: 'contains' as const, value: 7 }
			]
		};
		const condition = conditionFromExpression(loaded) as ConditionGroup;
		expect(condition.children.map((child) => child.kind === 'rule' && child.value)).toEqual([
			'true',
			'7'
		]);
		// Nothing for the builder to object to: an unedited save is not stopped.
		expect(problems(condition, fields).size).toBe(0);
		expect(expressionFromCondition(condition, catalog)).toEqual(loaded);
	});

	it('sends the condition read, untouched, when only the name changed', () => {
		const loaded = {
			op: 'attribute' as const,
			field: 'country',
			compare: 'eq' as const,
			value: 'JP'
		};
		const condition = conditionFromExpression(loaded);
		// Read, it is a group around the comparison; saved unedited, it is the comparison itself.
		expect(conditionToSave(loaded, false, condition, catalog)).toBe(loaded);
		expect(conditionToSave(loaded, true, condition, catalog)).toEqual({
			op: 'all',
			args: [loaded]
		});
		expect(conditionToSave(null, false, conditionFromExpression(null), catalog)).toBeNull();
	});

	it('reads a rule into the builder and writes it back the same', () => {
		const rule = {
			op: 'all' as const,
			args: [
				{ op: 'attribute' as const, field: 'country', compare: 'in' as const, value: ['JP', 'US'] },
				{
					op: 'not' as const,
					arg: {
						op: 'attribute' as const,
						field: 'tags',
						compare: 'contains' as const,
						value: 'guest'
					}
				},
				{
					op: 'not' as const,
					arg: {
						op: 'any' as const,
						args: [{ op: 'attribute' as const, field: 'level', compare: 'lt' as const, value: 2 }]
					}
				}
			]
		};
		const condition = conditionFromExpression(rule) as ConditionGroup;
		expect(
			condition.children.map((child) => (child.kind === 'rule' ? child.operator : child.match))
		).toEqual(['in', 'not_contains', 'none']);
		expect(expressionFromCondition(condition, catalog)).toEqual(rule);
	});

	it('wraps a single comparison in a group, and reads no rule as an empty one', () => {
		const single = conditionFromExpression({
			op: 'attribute',
			field: 'country',
			compare: 'eq',
			value: 'JP'
		});
		expect(single?.match).toBe('all');
		expect(single?.children).toHaveLength(1);
		const none = conditionFromExpression(null) as ConditionGroup;
		expect(none.children).toEqual([]);
		expect(expressionFromCondition(none, catalog)).toBeNull();
	});

	it('refuses to draw what the builder cannot show', () => {
		expect(conditionFromExpression({ op: 'member', groupId: 'g' })).toBeNull();
		expect(
			conditionFromExpression({
				op: 'not',
				arg: { op: 'all', args: [{ op: 'member', groupId: 'g' }] }
			})
		).toBeNull();
		expect(
			conditionFromExpression({
				op: 'not',
				arg: { op: 'attribute', field: 'level', compare: 'lt', value: 2 }
			})
		).toBeNull();
	});

	it('writes a number field’s list as numbers', () => {
		const condition: ConditionGroup = {
			id: 'g',
			kind: 'group',
			match: 'any',
			children: [{ id: 'r', kind: 'rule', field: 'level', operator: 'eq', value: 3 }]
		};
		expect(expressionFromCondition(condition, catalog)).toEqual({
			op: 'any',
			args: [{ op: 'attribute', field: 'level', compare: 'eq', value: 3 }]
		});
	});
});

describe('roles', () => {
	it('checks a new role’s name as the API does', () => {
		expect(roleNameProblem('')).toBe('eur.new.nameRequired');
		expect(roleNameProblem('a')).toBe('eur.new.nameLength');
		expect(roleNameProblem('1abc')).toBe('eur.new.nameInvalid');
		expect(roleNameProblem('end_user')).toBe('eur.new.nameReserved');
		expect(roleNameProblem('ar_editor')).toBe('eur.new.nameReserved');
		expect(roleNameProblem('editor')).toBeUndefined();
	});

	it('checks a permission as the API does', () => {
		expect(permissionProblem('documents:read')).toBeUndefined();
		expect(permissionProblem('documents:read_all')).toBeUndefined();
		expect(permissionProblem('Documents:read')).toBe('eur.new.permissionInvalid');
		for (const permission of [
			'documents:42:read',
			'documents:DOC-42.v2:read',
			'documents:*',
			'*:*',
			'*',
			' documents:read '
		]) {
			expect(permissionProblem(permission)).toBeUndefined();
		}
		for (const permission of [
			'my-docs:read',
			'2docs:read',
			'documents:Read',
			'documents::read',
			'documents:doc 1:read',
			'documents:doc\u00001:read',
			'documents:doc_1:*',
			'*:read',
			'a:b:c:d',
			'documents'
		]) {
			expect(permissionProblem(permission)).toBe('eur.new.permissionInvalid');
		}
	});

	it('knows the grant tier floor of wildcards, as the API does', () => {
		expect(minimumGrantTier(['documents:read', 'documents:doc_1:read'])).toBe(1);
		expect(minimumGrantTier(['documents:*'])).toBe(2);
		expect(minimumGrantTier(['documents:*', ' * '])).toBe(3);
		expect(minimumGrantTier(['*:*'])).toBe(3);
		expect(minimumGrantTier(['*:read'])).toBe(1);
	});

	it('offers tiers up to the ceiling, and the role’s own', () => {
		expect(tierChoices(2)).toEqual([1, 2]);
		expect(tierChoices(1, 3)).toEqual([1, 3]);
		expect(tierChoices(0)).toEqual([]);
	});

	it('sends only what changed, permissions compared as a set', () => {
		const saved = { description: 'x', permissions: ['a:b', 'c:d'], grant_tier: 1 };
		expect(roleChanges(saved, { ...saved, permissions: ['c:d', 'a:b'] })).toEqual({});
		expect(roleChanges(saved, { ...saved, grant_tier: 2, description: ' x ' })).toEqual({
			grant_tier: 2
		});
		expect(roleChanges(saved, { ...saved, permissions: ['a:b'] })).toEqual({
			permissions: ['a:b']
		});
	});
});

describe('the access check form', () => {
	it('asks for a user and a resource:action permission', () => {
		expect(formProblems(EMPTY_FORM)).toEqual({
			subject: 'acc.form.subjectRequired',
			permission: 'acc.form.permissionRequired'
		});
		expect(
			formProblems({ ...EMPTY_FORM, subject_id: 'u', permission: 'documents', resource_id: 'a b' })
		).toEqual({ permission: 'acc.form.permissionInvalid', resource: 'acc.form.resourceInvalid' });
	});

	it('leaves out what was not entered', () => {
		expect(
			checkInput({ ...EMPTY_FORM, subject_id: ' u ', permission: 'a:b', resource_group_id: 'g' })
		).toEqual({
			subject_id: 'u',
			permission: 'a:b',
			resource_id: undefined,
			resource_group_id: 'g'
		});
	});

	it('passes a relationship only with both its parts', () => {
		expect(
			formProblems({ ...EMPTY_FORM, subject_id: 'u', permission: 'a:b', rebac_relation: 'viewer' })
		).toEqual({ rebac: 'acc.form.rebacIncomplete' });
		expect(
			checkInput({
				...EMPTY_FORM,
				subject_id: 'u',
				permission: 'a:b',
				rebac_relation: ' viewer ',
				rebac_object: 'document:1'
			}).rebac
		).toEqual({ relation: 'viewer', object: 'document:1' });
	});

	it('freezes what was asked into a copy of its own', () => {
		const form = { ...EMPTY_FORM, subject_id: 'usr_1', permission: 'a:b', resource_group_id: 'g' };
		const asked = askedCheck(form, 'Aiko', 'Japan office');
		form.subject_id = 'usr_2';
		expect(asked).toEqual({
			subjectId: 'usr_1',
			subjectLabel: 'Aiko',
			permission: 'a:b',
			resourceId: null,
			resourceGroup: 'Japan office',
			rebac: null
		});
	});

	it('names the known ways a check is allowed', () => {
		expect(viaLabel('group_role')).toBe('acc.via.groupRole');
		expect(viaLabel('something_new')).toBeNull();
	});
});

describe('refusals', () => {
	const conflict = (description: string, code = 'conflict') =>
		new ConflictError(description, { error: code, error_description: description });

	it('tells the API’s 409s apart by their code or wording', () => {
		expect(
			authzRefusal(conflict('The group has child groups: move or delete them first')).key
		).toBe('grp.error.hasChildren');
		expect(
			authzRefusal(
				conflict('A role granted to a group has this group as its scope: remove that grant first')
			).key
		).toBe('grp.error.scopedGrant');
		expect(authzRefusal(conflict('x', 'group_managed_by_service_group')).key).toBe(
			'grp.error.managed'
		);
		expect(authzRefusal(conflict('group_version_conflict', 'group_version_conflict')).key).toBe(
			'grp.error.catalogChanged'
		);
		expect(authzRefusal(conflict('Role changed or is assigned to a group.')).key).toBe(
			'eur.error.inUseGroup'
		);
	});

	it('goes by the code, whatever the words say', () => {
		const byCode: [string, string][] = [
			['group_has_children', 'grp.error.hasChildren'],
			['group_referenced_as_scope', 'grp.error.scopedGrant'],
			['membership_other_source', 'grp.error.otherSource'],
			['group_version_conflict', 'grp.error.catalogChanged'],
			['role_in_use', 'eur.error.inUse'],
			['role_version_conflict', 'eur.error.changed']
		];
		// A policy refused for a dynamic group in a negative condition is a 400, not a 409.
		expect(
			authzRefusal(
				new ApiError(400, 'dynamic_group_negative_condition', 'Words nobody matches', {
					error: 'dynamic_group_negative_condition'
				})
			)
		).toEqual({ key: 'pol.error.dynamicNegative' });
		for (const [code, key] of byCode)
			expect(authzRefusal(conflict('Words nobody matches', code)).key).toBe(key);
		// A role in use is told apart from a changed role by its code, not its words.
		expect(authzRefusal(conflict('Role changed since it was read.', 'role_in_use')).key).toBe(
			'eur.error.inUse'
		);
	});

	it('keeps the API’s words for a refusal not known here', () => {
		const refusal = authzRefusal(conflict('Something new'));
		expect(refusal).toEqual({ key: 'az.error.conflict', detail: 'Something new' });
		expect(refusalText(conflict('Something new'), (key) => key)).toBe(
			'az.error.conflict (Something new)'
		);
	});

	it('reads a 403 as the ceiling, a cancelled step-up as cancelled', () => {
		expect(authzRefusal(new ApiError(403, 'forbidden', 'Forbidden')).key).toBe(
			'az.error.beyondCeiling'
		);
		expect(authzRefusal(new StepUpCancelledError()).key).toBe('az.error.cancelled');
		expect(authzRefusal(new Error('boom')).key).toBe('az.error.generic');
	});
});

describe('finding a user', () => {
	const options = { typedAsId: 'use id', searchRefused: 'refused', canSearch: true };
	it('offers what was typed as a user ID when nothing matches, never an address', async () => {
		const list = vi.fn(async () => ({ users: [], next: null, total: 0 }));
		const search = userSearch({ list } as never, options);
		await expect(search('usr_1', new AbortController().signal)).resolves.toEqual([
			expect.objectContaining({ value: 'usr_1', description: 'use id' })
		]);
		await expect(search('a@example.com', new AbortController().signal)).resolves.toEqual([]);
		await expect(search('', new AbortController().signal)).resolves.toEqual([]);
	});

	it('offers an ID with colons whole, as typed', async () => {
		const list = vi.fn(async () => ({ users: [], next: null, total: 0 }));
		const search = userSearch({ list } as never, options);
		await expect(search('team:alice', new AbortController().signal)).resolves.toEqual([
			expect.objectContaining({ value: 'team:alice', label: 'team:alice' })
		]);
	});

	it('leaves out users already in', async () => {
		const list = vi.fn(async () => ({
			users: [{ id: 'usr_1', email: 'a@example.com', name: 'A' }],
			next: null,
			total: 1
		}));
		const search = userSearch({ list } as never, { ...options, exclude: () => new Set(['usr_1']) });
		await expect(search('a@example.com', new AbortController().signal)).resolves.toEqual([]);
	});

	it('does not search without the users’ read permission: the typed ID is offered', async () => {
		const list = vi.fn();
		const search = userSearch({ list } as never, { ...options, canSearch: false });
		await expect(search('usr_9', new AbortController().signal)).resolves.toEqual([
			expect.objectContaining({ value: 'usr_9', description: 'use id' })
		]);
		expect(list).not.toHaveBeenCalled();
	});

	it('tells a refused search (403) from a failed one', async () => {
		const refused = userSearch(
			{ list: vi.fn(async () => Promise.reject(new ApiError(403, 'forbidden', 'no'))) } as never,
			options
		);
		await expect(refused('usr_9', new AbortController().signal)).resolves.toEqual([
			expect.objectContaining({ value: 'usr_9', description: 'refused' })
		]);
		const broken = userSearch(
			{ list: vi.fn(async () => Promise.reject(new TypeError('network'))) } as never,
			options
		);
		await expect(broken('usr_9', new AbortController().signal)).rejects.toBeInstanceOf(TypeError);
	});
});

describe('RBAC claims in tokens', () => {
	const offered = ['roles', 'groups', 'permissions'];

	it('reads none and the default', () => {
		expect(claimsOf('none')).toEqual([]);
		expect(claimsOf('roles, groups')).toEqual(['roles', 'groups']);
		expect(claimsOf(undefined)).toEqual([]);
	});

	it('stores the claims in the order offered, none as none, and keeps unknown ones', () => {
		expect(toggleClaim('groups', 'roles', true, offered)).toBe('roles,groups');
		expect(toggleClaim('roles', 'roles', false, offered)).toBe('none');
		expect(toggleClaim('roles,future_claim', 'groups', true, offered)).toBe(
			'roles,groups,future_claim'
		);
	});
});

describe('finding a group', () => {
	it('offers what was typed as a group ID when the search is refused (no groups read)', async () => {
		const options = { typedAsId: 'use id', searchRefused: 'refused' };
		const refused = groupSearch(
			{ list: vi.fn(async () => Promise.reject(new ApiError(403, 'forbidden', 'no'))) } as never,
			options
		);
		await expect(refused('grp_jp', new AbortController().signal)).resolves.toEqual([
			expect.objectContaining({ value: 'grp_jp', label: 'grp_jp', description: 'refused' })
		]);
		await expect(refused('', new AbortController().signal)).resolves.toEqual([]);
		const broken = groupSearch({
			list: vi.fn(async () => Promise.reject(new TypeError('network')))
		} as never);
		await expect(broken('grp_jp', new AbortController().signal)).rejects.toBeInstanceOf(TypeError);
	});

	it('offers a typed group ID nothing matched, only where the picker asks for it', async () => {
		const list = vi.fn(async () => ({ items: [], page: 1, limit: 20, total: 0, hasNext: false }));
		await expect(
			groupSearch({ list } as never, { typedAsId: 'use id' })('grp_x', new AbortController().signal)
		).resolves.toEqual([expect.objectContaining({ value: 'grp_x', description: 'use id' })]);
		// A parent picker offers only groups found.
		await expect(
			groupSearch({ list } as never)('grp_x', new AbortController().signal)
		).resolves.toEqual([]);
	});
});
