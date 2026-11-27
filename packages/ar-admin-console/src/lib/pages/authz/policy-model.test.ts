import { describe, expect, it } from 'vitest';
import { authzAccess } from '#lib/access/access.js';
import { persona } from '#lib/access/personas.js';
import type { ConditionTypeInfo, PolicyRule } from '#lib/api/end-user-policies.js';
import { sampleConditionTypes, samplePolicies } from '#lib/api/fake/end-user-policies-fake.js';
import {
	conditionDraftOf,
	conditionResult,
	draftOf,
	emptyDraft,
	groupIdsOf,
	inputOf,
	newConditionDraft,
	paramKind,
	policyChanges,
	policyResult,
	simulationInput,
	simulationProblems,
	timestampOf,
	toFieldsMode,
	toJsonMode
} from './policy-model';

const { types } = sampleConditionTypes({ withOddCondition: true });
const info = (type: string): ConditionTypeInfo => {
	const found = types.find((entry) => entry.type === type);
	if (!found) throw new Error(type);
	return found;
};

describe('how a parameter is drawn', () => {
	it('follows the API’s declared type, with groups picked by name of parameter', () => {
		expect(paramKind({ name: 'role', type: 'string' })).toBe('string');
		expect(paramKind({ name: 'startHour', type: 'number' })).toBe('number');
		expect(paramKind({ name: 'x', type: 'boolean' })).toBe('boolean');
		expect(paramKind({ name: 'roles', type: 'string[]' })).toBe('strings');
		expect(paramKind({ name: 'allowedDays', type: 'number[]' })).toBe('numbers');
		expect(paramKind({ name: 'group_id', type: 'string' })).toBe('group');
		expect(paramKind({ name: 'group_ids', type: 'string[]' })).toBe('groups');
		// Only those names: another list of strings is plain text.
		expect(paramKind({ name: 'other_ids', type: 'string[]' })).toBe('strings');
		expect(paramKind({ name: 'ranges', type: 'object[]' })).toBeNull();
	});
});

describe('a condition as fields', () => {
	it('builds the condition from what was entered, leaving optional text out', () => {
		const draft = newConditionDraft(1, info('time_in_range'));
		draft.text.startHour = '9';
		draft.text.endHour = '18';
		expect(conditionResult(draft, info('time_in_range')).condition).toEqual({
			type: 'time_in_range',
			params: { startHour: 9, endHour: 18 }
		});
		draft.text.timezone = ' Asia/Tokyo ';
		// Typed values are sent as typed, never trimmed.
		expect(conditionResult(draft, info('time_in_range')).condition?.params.timezone).toBe(
			' Asia/Tokyo '
		);
	});

	it('names the parameters that are missing or not numbers', () => {
		const draft = newConditionDraft(1, info('time_in_range'));
		draft.text.endHour = 'late';
		expect(conditionResult(draft, info('time_in_range'))).toEqual({
			condition: null,
			problems: { startHour: 'pol.cond.required', endHour: 'pol.cond.number' }
		});
	});

	it('takes lists of text and of numbers', () => {
		const roles = newConditionDraft(1, info('has_any_role'));
		expect(conditionResult(roles, info('has_any_role')).problems).toEqual({
			roles: 'pol.cond.required'
		});
		roles.lists.roles = [' editor ', '', 'admin'];
		expect(conditionResult(roles, info('has_any_role')).condition?.params).toEqual({
			roles: [' editor ', 'admin']
		});
		const days = newConditionDraft(2, info('day_of_week'));
		days.lists.allowedDays = ['1', 'x'];
		expect(conditionResult(days, info('day_of_week')).problems).toEqual({
			allowedDays: 'pol.cond.number'
		});
		days.lists.allowedDays = ['1', '5'];
		expect(conditionResult(days, info('day_of_week')).condition?.params).toEqual({
			allowedDays: [1, 5]
		});
	});

	it('takes the ids of the groups picked', () => {
		const one = newConditionDraft(1, info('in_group'));
		expect(conditionResult(one, info('in_group')).problems).toEqual({
			group_id: 'pol.cond.required'
		});
		one.groups.group_id = [{ value: 'grp_jp', label: 'Japan office' }];
		expect(conditionResult(one, info('in_group')).condition).toEqual({
			type: 'in_group',
			params: { group_id: 'grp_jp' }
		});
		const many = newConditionDraft(2, info('in_all_groups'));
		many.groups.group_ids = [
			{ value: 'a', label: 'A' },
			{ value: 'b', label: 'B' }
		];
		expect(conditionResult(many, info('in_all_groups')).condition?.params).toEqual({
			group_ids: ['a', 'b']
		});
		// A type without parameters is complete as it is.
		expect(conditionResult(newConditionDraft(3, info('same_group')), info('same_group'))).toEqual({
			condition: { type: 'same_group', params: {} },
			problems: {}
		});
	});
});

describe('an existing condition as a draft', () => {
	it('is drawn as fields when it fits, with the groups named', () => {
		const draft = conditionDraftOf(
			1,
			{ type: 'in_any_group', params: { group_ids: ['g1', 'g2'] } },
			info('in_any_group'),
			(id) => `name of ${id}`
		);
		expect(draft.mode).toBe('fields');
		expect(draft.groups.group_ids).toEqual([
			expect.objectContaining({ value: 'g1', label: 'name of g1' }),
			expect.objectContaining({ value: 'g2', label: 'name of g2' })
		]);
	});

	it('is kept as JSON when the editor cannot draw it, so nothing is lost', () => {
		const odd = { type: 'ip_in_ranges', params: { ranges: [{ cidr: '10.0.0.0/8' }] } };
		expect(conditionDraftOf(1, odd, info('ip_in_ranges')).mode).toBe('json');
		// A type the API does not list.
		const unknown = conditionDraftOf(2, { type: 'future', params: { a: 1 } }, undefined);
		expect(unknown.mode).toBe('json');
		expect(conditionResult(unknown, undefined).condition).toEqual({
			type: 'future',
			params: { a: 1 }
		});
		// A parameter the type does not declare, or a value of the wrong kind.
		expect(
			conditionDraftOf(3, { type: 'has_role', params: { role: 'a', extra: 1 } }, info('has_role'))
				.mode
		).toBe('json');
		expect(
			conditionDraftOf(4, { type: 'has_role', params: { role: 7 } }, info('has_role')).mode
		).toBe('json');
	});

	it('moves between fields and JSON without losing what was entered', () => {
		const draft = conditionDraftOf(
			1,
			{ type: 'has_role', params: { role: 'editor' } },
			info('has_role')
		);
		toJsonMode(draft, info('has_role'));
		expect(draft.mode).toBe('json');
		expect(JSON.parse(draft.json)).toEqual({ type: 'has_role', params: { role: 'editor' } });
		draft.json = JSON.stringify({ type: 'has_role', params: { role: 'admin' } });
		expect(toFieldsMode(draft, info('has_role'))).toBe(true);
		expect(draft.mode).toBe('fields');
		expect(draft.text.role).toBe('admin');
		// JSON of another type or with an undeclared parameter does not go back.
		toJsonMode(draft, info('has_role'));
		draft.json = JSON.stringify({ type: 'has_role', params: { nope: 1 } });
		expect(toFieldsMode(draft, info('has_role'))).toBe(false);
		expect(draft.mode).toBe('json');
	});

	it('says what is wrong with JSON that is not a condition', () => {
		const base = conditionDraftOf(1, { type: 'x', params: {} }, undefined);
		expect(conditionResult({ ...base, json: '{' }, undefined).problems).toEqual({
			'': 'pol.cond.json'
		});
		expect(conditionResult({ ...base, json: '[]' }, undefined).problems).toEqual({
			'': 'pol.cond.jsonShape'
		});
		expect(conditionResult({ ...base, json: '{"type":"x"}' }, undefined).problems).toEqual({
			'': 'pol.cond.jsonShape'
		});
	});
});

describe('a policy as a draft and as input', () => {
	it('round-trips a stored policy to the same input', () => {
		for (const rule of samplePolicies()) {
			const draft = draftOf(rule, types);
			expect(policyResult(draft, types).input).toEqual(inputOf(rule));
		}
	});

	it('refuses a draft without a name, a whole priority or complete conditions', () => {
		const draft = emptyDraft();
		draft.priority = 1.5;
		draft.conditions.push(newConditionDraft(1, info('in_group')));
		const { input, problems } = policyResult(draft, types);
		expect(input).toBeNull();
		expect(problems.name).toBe('pol.edit.nameRequired');
		expect(problems.priority).toBe('pol.edit.priorityInvalid');
		expect(problems.conditions[1]).toEqual({ group_id: 'pol.cond.required' });
		draft.priority = null;
		expect(policyResult(draft, types).problems.priority).toBe('pol.edit.priorityInvalid');
	});

	it('trims and de-duplicates the resource types and actions', () => {
		const draft = emptyDraft();
		draft.name = ' Docs ';
		draft.resource_types = [' document ', 'document', ''];
		draft.actions = ['read'];
		expect(policyResult(draft, types).input).toMatchObject({
			name: 'Docs',
			resource_types: ['document'],
			actions: ['read'],
			priority: 100,
			effect: 'allow',
			enabled: true,
			conditions: []
		});
	});

	it('sends only what changed', () => {
		const rule = samplePolicies()[0];
		const saved = inputOf(rule);
		expect(policyChanges(saved, { ...saved })).toEqual({});
		expect(
			policyChanges(saved, { ...saved, effect: 'deny', actions: ['read', 'write'], priority: 5 })
		).toEqual({ effect: 'deny', actions: ['read', 'write'], priority: 5 });
		expect(
			policyChanges(saved, { ...saved, conditions: [{ type: 'is_resource_owner', params: {} }] })
		).toEqual({ conditions: [{ type: 'is_resource_owner', params: {} }] });
	});

	it('finds the groups a rule names, to show their names', () => {
		const rules: PolicyRule[] = samplePolicies();
		expect(groupIdsOf(rules[0], types)).toEqual(['grp_jp']);
		expect(groupIdsOf(rules[1], types)).toEqual(['grp_contractors', 'grp_sales']);
		expect(groupIdsOf(rules[2], types)).toEqual([]);
	});
});

describe('saving leaves what the admin did not edit as it was loaded', () => {
	const stored: PolicyRule = {
		id: 'p',
		name: ' Spaced name ',
		description: ' note ',
		priority: 5,
		effect: 'allow',
		resource_types: ['document', ' padded '],
		actions: ['', 'read'],
		conditions: [
			{ type: 'attribute_equals', params: { name: 'tier', value: ' gold ' } },
			{ type: 'has_any_role', params: { roles: ['a', ''] } },
			{ type: 'has_role', params: { role: 'editor' } },
			{ type: 'in_group', params: { group_id: 'grp_jp' } }
		],
		enabled: true,
		created_at: null,
		updated_at: null
	};
	const saved = inputOf(stored);

	it('keeps a description-only edit from touching actions, lists and conditions', () => {
		const draft = draftOf(stored, types);
		draft.description = 'new note';
		const { input } = policyResult(draft, types, saved);
		expect(input?.actions).toEqual(['', 'read']);
		expect(input?.resource_types).toEqual(['document', ' padded ']);
		expect(JSON.stringify(input?.conditions)).toBe(JSON.stringify(stored.conditions));
		expect(input?.name).toBe(' Spaced name ');
		expect(policyChanges(saved, input!)).toEqual({ description: 'new note' });
	});

	it('draws a condition as JSON when a box could not give its value back unchanged', () => {
		const draft = draftOf(stored, types);
		expect(draft.conditions.map((entry) => entry.mode)).toEqual([
			'json',
			'json',
			'fields',
			'fields'
		]);
		// The value with spaces is kept exactly.
		expect(JSON.parse(draft.conditions[0].json).params.value).toBe(' gold ');
	});

	it('never trims what is typed into a condition', () => {
		const draft = newConditionDraft(1, info('attribute_equals'));
		draft.text.name = 'tier';
		draft.text.value = ' gold ';
		expect(conditionResult(draft, info('attribute_equals')).condition?.params).toEqual({
			name: 'tier',
			value: ' gold '
		});
	});

	it('sends an edited condition, and still only that', () => {
		const draft = draftOf(stored, types);
		draft.conditions[2].text.role = 'admin';
		const { input } = policyResult(draft, types, saved);
		expect(input?.conditions[2]).toEqual({ type: 'has_role', params: { role: 'admin' } });
		expect(input?.conditions[0]).toEqual(stored.conditions[0]);
		expect(Object.keys(policyChanges(saved, input!))).toEqual(['conditions']);
	});

	it('adds to a list without rewriting its other elements, and removes only the one taken away', () => {
		const draft = draftOf(stored, types);
		draft.resource_types = [' padded ', 'document', ' invoice '];
		const { input } = policyResult(draft, types, saved);
		expect(input?.resource_types).toEqual([' padded ', 'document', 'invoice']);
		draft.resource_types = [' padded '];
		expect(policyResult(draft, types, saved).input?.resource_types).toEqual([' padded ']);
	});

	it('keeps a whitespace-only value in a text list and drops only the empty string', () => {
		const roles = newConditionDraft(1, info('has_any_role'));
		roles.lists.roles = ['  ', '', 'admin'];
		expect(conditionResult(roles, info('has_any_role')).condition?.params).toEqual({
			roles: ['  ', 'admin']
		});
		// A stored whitespace-only value can be drawn as it is (no JSON fallback needed).
		const stored = conditionDraftOf(
			2,
			{ type: 'has_any_role', params: { roles: [' ', 'a'] } },
			info('has_any_role')
		);
		expect(stored.mode).toBe('fields');
		expect(conditionResult(stored, info('has_any_role')).condition?.params.roles).toEqual([
			' ',
			'a'
		]);
		// Numbers are read trimmed: a blank one is no entry.
		const days = newConditionDraft(3, info('day_of_week'));
		days.lists.allowedDays = [' ', '1'];
		expect(conditionResult(days, info('day_of_week')).condition?.params.allowedDays).toEqual([1]);
	});

	it('tidies a list only once the admin changed it', () => {
		const draft = draftOf(stored, types);
		draft.actions = ['', 'read', ' write '];
		// The loaded elements stay as they were; only what was added is tidied.
		expect(policyResult(draft, types, saved).input?.actions).toEqual(['', 'read', 'write']);
	});
});

describe('the simulation form', () => {
	const form = {
		resource_type: 'document',
		resource_id: '',
		owner_id: '',
		action: 'read',
		timestamp: ''
	};

	it('asks for the user, the resource type and the action', () => {
		expect(simulationProblems({ ...form, resource_type: ' ', action: '' }, '')).toEqual({
			subject: 'pol.sim.subjectRequired',
			resourceType: 'pol.sim.resourceTypeRequired',
			action: 'pol.sim.actionRequired'
		});
		expect(simulationProblems(form, 'usr_1')).toEqual({});
	});

	it('reads the date and time typed, or refuses it', () => {
		expect(timestampOf('')).toBeNull();
		expect(timestampOf('2026-11-28T09:30:00+09:00')).toBe(Date.UTC(2026, 10, 28, 0, 30));
		expect(timestampOf('not a date')).toBeNull();
		expect(simulationProblems({ ...form, timestamp: 'soon' }, 'usr_1').timestamp).toBe(
			'pol.sim.timestampInvalid'
		);
	});

	it('builds the input, groups left to the server (null) or given, even none', () => {
		const input = simulationInput(
			{ ...form, owner_id: ' usr_o ' },
			' usr_1 ',
			null,
			[' editor ', 'editor', ''],
			['grp_a'],
			[
				{ key: ' tier ', value: ' gold ' },
				{ key: ' ', value: 'x' }
			]
		);
		expect(input).toEqual({
			subject_id: 'usr_1',
			group_ids: null,
			role_names: ['editor'],
			resource_type: 'document',
			resource_id: '',
			owner_id: 'usr_o',
			attributes: [{ name: 'tier', value: ' gold ' }],
			resource_group_ids: ['grp_a'],
			action: 'read',
			timestamp: null
		});
		expect(simulationInput(form, 'u', [], [], []).group_ids).toEqual([]);
		expect(simulationInput(form, 'u', [' g ', 'g'], [], []).group_ids).toEqual(['g']);
	});
});

describe('who may use the policies page', () => {
	it('simulates with the roles’ read and write permissions (the simulate permission comes with read)', () => {
		expect(authzAccess(persona('tenant').access).policiesSimulate).toBe(true);
		const only = (...permissions: string[]) =>
			authzAccess({ platform: false, roles: [], permissions }).policiesSimulate;
		// The simulate permission alone does not pass the policy routes' write gate…
		expect(only('admin:roles:read', 'admin:policy:simulate')).toBe(false);
		expect(only('admin:policy:simulate')).toBe(false);
		// …and the roles' read permission carries it (a compatibility ceiling on the API).
		expect(only('admin:roles:read', 'admin:roles:write')).toBe(true);
		expect(only('admin:roles:read', 'admin:roles:write', 'admin:policy:simulate')).toBe(true);
		expect(only('admin:roles:write')).toBe(false);
	});
});
