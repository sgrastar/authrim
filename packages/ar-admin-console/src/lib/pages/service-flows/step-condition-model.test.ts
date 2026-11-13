import { describe, expect, it } from 'vitest';
import type { ConditionRule } from '#lib/ui/patterns/condition-model.js';
import { changeOperator, ruleProblem } from '#lib/ui/patterns/condition-model.js';
import { conditionAnswersOf, conditionAttributesOf } from './condition-choices';
import {
	conditionFieldsOf,
	expressionOf,
	hasIncompleteRule,
	ruleComplete,
	ruleOf,
	sourceOf,
	valueOfGroup,
	valueOfRules,
	valueOfWhen,
	whenOf,
	withRuleFields
} from './step-condition-model';
import type { Schema } from '#lib/api/schema-setting.js';
import type { ScreenListItem } from '#lib/api/screens.js';

const rule = (field: string, operator: ConditionRule['operator'], value: ConditionRule['value']) =>
	({ id: `r-${field}`, kind: 'rule', field, operator, value }) satisfies ConditionRule;

describe('who a step is shown to', () => {
	it('saves each kind of rule as the condition the Flow runs', () => {
		expect(expressionOf(rule('age', 'gte', 18))).toEqual({
			type: 'user.age',
			operator: 'gte',
			value: 18
		});
		expect(expressionOf(rule('attribute:nationality', 'not_in', ['JP', ' US ']))).toEqual({
			type: 'user.attribute',
			attribute: 'nationality',
			operator: 'not_in',
			values: ['JP', 'US']
		});
		expect(expressionOf(rule('attribute:birthdate', 'lt', '2008-01-01'))).toEqual({
			type: 'user.attribute',
			attribute: 'birthdate',
			operator: 'lt',
			value: '2008-01-01'
		});
		expect(expressionOf(rule('answer:plan', 'eq', 'pro'))).toEqual({
			type: 'screen.answer',
			attribute: 'plan',
			operator: 'eq',
			value: 'pro'
		});
		expect(expressionOf(rule('answer:marketing', 'eq', true))).toEqual({
			type: 'screen.answer',
			attribute: 'marketing',
			operator: 'eq',
			value: true
		});
		expect(expressionOf(rule('app', 'eq', 'client_member_app'))).toEqual({
			type: 'client_id',
			operator: 'eq',
			value: 'client_member_app'
		});
		expect(expressionOf(rule('locale', 'in', ['ja', 'en']))).toEqual({
			type: 'locale',
			operator: 'in',
			values: ['ja', 'en']
		});
		expect(expressionOf(rule('attribute:department', 'exists', null))).toEqual({
			type: 'user.attribute',
			attribute: 'department',
			operator: 'exists'
		});
	});

	it('keeps a rule being written, but saves only complete ones and says one is open', () => {
		const open = [
			rule('age', 'gte', null),
			rule('age', 'gte', 200),
			rule('age', 'gte', 17.5),
			rule('attribute:nationality', 'in', []),
			rule('attribute:birthdate', 'lt', 'soon'),
			rule('attribute:', 'eq', 'x'),
			rule('attribute:Bad Key', 'eq', 'x'),
			rule('locale', 'exists', null),
			rule('role', 'eq', 'admin')
		];
		for (const candidate of open) expect(ruleComplete(candidate), candidate.field).toBe(false);
		const value = valueOfRules([rule('age', 'gte', 18), rule('age', 'gte', null)]);
		expect(hasIncompleteRule(value)).toBe(true);
		expect(whenOf(value)).toEqual([{ type: 'user.age', operator: 'gte', value: 18 }]);
		expect(hasIncompleteRule(valueOfRules([rule('age', 'gte', 18)]))).toBe(false);
		expect(hasIncompleteRule(undefined)).toBe(false);
	});

	it('reads a saved condition back as the rule it was saved from', () => {
		const rules = [
			rule('age', 'lt', 18),
			rule('attribute:nationality', 'not_in', ['JP']),
			rule('answer:plan', 'ne', 'free'),
			rule('locale', 'eq', 'ja'),
			rule('attribute:department', 'not_exists', null)
		];
		for (const original of rules) {
			const saved = expressionOf(original);
			expect(ruleOf(saved, original.id)).toEqual(original);
		}
	});

	it('reads one saved without an operator as the operator it means', () => {
		expect(ruleOf({ type: 'locale', value: 'ja' }, 'r')).toMatchObject({
			field: 'locale',
			operator: 'eq',
			value: 'ja'
		});
		expect(
			ruleOf({ type: 'user.attribute', attribute: 'country', values: ['JP'] }, 'r')
		).toMatchObject({ field: 'attribute:country', operator: 'in', value: ['JP'] });
	});

	it('cannot show what the Flow editor makes beyond it, so the flow is not saved over', () => {
		expect(ruleOf({ type: 'user.role', value: 'admin' }, 'r')).toBeNull();
		expect(ruleOf({ type: 'user.age', operator: 'in', values: [1] }, 'r')).toBeNull();
		expect(ruleOf({ type: 'locale', operator: 'eq', values: ['ja', 'en'] }, 'r')).toBeNull();
		expect(ruleOf({ type: 'locale', operator: 'eq', value: 'ja', match: 'any' }, 'r')).toBeNull();
		expect(
			valueOfWhen([
				{ type: 'locale', value: 'ja' },
				{ type: 'user.group', value: 'g' }
			])
		).toBeNull();
		expect(valueOfWhen(undefined)).toEqual([]);
		expect(valueOfWhen([{ type: 'locale', value: 'ja' }])).toHaveLength(1);
	});

	it('names what a rule compares by its field key', () => {
		expect(sourceOf('age')).toEqual({ source: 'age', key: '' });
		expect(sourceOf('attribute:address.country')).toEqual({
			source: 'attribute',
			key: 'address.country'
		});
		expect(sourceOf('answer:Plan Choice')).toEqual({ source: 'answer', key: 'Plan Choice' });
		expect(sourceOf('role:admin')).toBeNull();
		expect(sourceOf('attribute:Upper')).toBeNull();
	});
});

describe('what the builder offers', () => {
	const label = (source: string, name?: string) => (name ? `${source}: ${name}` : source);
	const schema = (fieldKey: string, type: Schema['type'], extra: Partial<Schema> = {}) =>
		({ fieldKey, label: fieldKey, type, isActive: true, status: 'active', ...extra }) as Schema;

	it('offers the standard attributes, then the tenant’s own, each compared as its type allows', () => {
		const attributes = conditionAttributesOf(
			[
				schema('nationality', 'enum', {
					validation: { enum_options: [{ value: 'JP', label: 'Japan' }] }
				}),
				schema('points', 'number'),
				schema('birthdate', 'date'),
				schema('retired', 'string', { isActive: false })
			],
			'en',
			(key) => key
		);
		expect(attributes.map((attribute) => attribute.key)).toEqual([
			'birthdate',
			'gender',
			'locale',
			'zoneinfo',
			'address.country',
			'address.region',
			'nationality',
			'points'
		]);
		const fields = conditionFieldsOf({ attributes, answers: [], apps: [], locales: [], label });
		const of = (key: string) => fields.find((field) => field.key === key);
		expect(of('attribute:birthdate')?.operators).toContain('lt');
		expect(of('attribute:nationality')).toMatchObject({
			type: 'enum',
			options: [{ value: 'JP', label: 'Japan' }]
		});
		expect(of('attribute:points')?.type).toBe('number');
		expect(of('age')?.accepts?.(151)).toBe(false);
		expect(ruleProblem(rule('age', 'gte', 151), fields)).toBe('invalidValue');
		expect(ruleProblem(rule('attribute:birthdate', 'lt', '2008-02-30'), fields)).toBe(
			'invalidValue'
		);
	});

	it('offers the choices made on the flow’s screens and sent to the Flow, not those stored to the profile', () => {
		const screens = [
			{
				screen_key: 'survey',
				fields: [
					{
						field: 'plan',
						label: 'Plan',
						block_type: 'radio',
						store_to_profile: false,
						options: [{ value: 'pro', label: 'Pro' }]
					},
					{ field: 'opt_in', label: 'News', block_type: 'checkbox', store_to_profile: false },
					{
						field: 'kept',
						label: 'Kept',
						block_type: 'select',
						store_to_profile: false,
						answer_targets: ['record']
					},
					{ field: 'nationality', label: 'Nationality', block_type: 'select' }
				]
			},
			{
				screen_key: 'other',
				fields: [{ field: 'x', label: 'X', block_type: 'radio', store_to_profile: false }]
			}
		] as unknown as ScreenListItem[];
		const answers = conditionAnswersOf(screens, ['survey']);
		expect(answers).toEqual([
			{ key: 'plan', label: 'Plan', choices: [{ value: 'pro', label: 'Pro' }] },
			{ key: 'opt_in', label: 'News', checkbox: true, choices: [] }
		]);
		const fields = conditionFieldsOf({ attributes: [], answers, apps: [], locales: [], label });
		expect(fields.find((field) => field.key === 'answer:opt_in')?.type).toBe('boolean');
	});

	it('keeps a rule on something no longer offered, so it is shown, not lost', () => {
		const fields = withRuleFields([], [rule('attribute:removed', 'eq', 'x')], label);
		expect(fields).toEqual([
			expect.objectContaining({ key: 'attribute:removed', label: 'attribute: removed' })
		]);
	});

	it('checks a rule by the kind of value its field takes, even with the step not open', () => {
		const fields = conditionFieldsOf({
			attributes: [
				{ key: 'joined', label: 'Joined', type: 'date' },
				{ key: 'points', label: 'Points', type: 'number' }
			],
			answers: [],
			apps: [],
			locales: [],
			label
		});
		const value = valueOfGroup(
			{
				id: 'g',
				kind: 'group',
				match: 'all',
				children: [rule('attribute:joined', 'eq', '2026-02-30')]
			},
			fields
		);
		// Read back alone, without the fields: still not one that can be saved.
		expect(hasIncompleteRule(value)).toBe(true);
		const points = valueOfGroup(
			{ id: 'g', kind: 'group', match: 'all', children: [rule('attribute:points', 'eq', 'abc')] },
			fields
		);
		expect(hasIncompleteRule(points)).toBe(true);
		const fine = valueOfGroup(
			{
				id: 'g',
				kind: 'group',
				match: 'all',
				children: [
					rule('attribute:joined', 'gte', '2026-01-01'),
					rule('attribute:points', 'gt', 10)
				]
			},
			fields
		);
		expect(hasIncompleteRule(fine)).toBe(false);
	});

	it('does not order an attribute with several values (a list has no order)', () => {
		const fields = conditionFieldsOf({
			attributes: [{ key: 'scores', label: 'Scores', type: 'number', multi: true }],
			answers: [],
			apps: [],
			locales: [],
			label
		});
		const operators = fields.find((field) => field.key === 'attribute:scores')?.operators;
		expect(operators).not.toContain('gt');
		expect(operators).toContain('in');
	});

	it('offers a key asked on several screens with all their choices, and not one asked two ways', () => {
		const screens = [
			{
				screen_key: 'one',
				fields: [
					{
						field: 'plan',
						label: 'Plan',
						block_type: 'radio',
						store_to_profile: false,
						options: [{ value: 'free', label: 'Free' }]
					},
					{ field: 'mixed', label: 'Mixed', block_type: 'checkbox', store_to_profile: false }
				]
			},
			{
				screen_key: 'two',
				fields: [
					{
						field: 'plan',
						label: 'Plan',
						block_type: 'select',
						store_to_profile: false,
						options: [
							{ value: 'free', label: 'Free' },
							{ value: 'enterprise', label: 'Enterprise' }
						]
					},
					{
						field: 'mixed',
						label: 'Mixed',
						block_type: 'radio',
						store_to_profile: false,
						options: [{ value: 'a', label: 'A' }]
					}
				]
			}
		] as unknown as ScreenListItem[];
		expect(conditionAnswersOf(screens, ['one', 'two'])).toEqual([
			{
				key: 'plan',
				label: 'Plan',
				choices: [
					{ value: 'free', label: 'Free' },
					{ value: 'enterprise', label: 'Enterprise' }
				]
			}
		]);
	});

	it('checks the items of a list by the kind of value of an attribute with several values', () => {
		const fields = conditionFieldsOf({
			attributes: [
				{ key: 'scores', label: 'Scores', type: 'number', multi: true },
				{ key: 'visits', label: 'Visits', type: 'date', multi: true }
			],
			answers: [],
			apps: [],
			locales: [],
			label
		});
		const of = (children: ConditionRule[]) =>
			valueOfGroup({ id: 'g', kind: 'group', match: 'all', children }, fields);
		expect(hasIncompleteRule(of([rule('attribute:scores', 'not_in', ['10', 'abc'])]))).toBe(true);
		expect(hasIncompleteRule(of([rule('attribute:visits', 'in', ['2026-02-30'])]))).toBe(true);
		expect(hasIncompleteRule(of([rule('attribute:scores', 'in', ['10', '20.5'])]))).toBe(false);
	});

	it('keeps the kind a rule was written for when its field is not offered, once each', () => {
		const date = { ...rule('attribute:joined', 'eq', '2026-02-30'), valueKind: 'date' as const };
		const fields = withRuleFields([], [date, { ...date, id: 'again' }], label);
		expect(fields).toHaveLength(1);
		const value = valueOfGroup({ id: 'g', kind: 'group', match: 'all', children: [date] }, fields);
		expect(hasIncompleteRule(value)).toBe(true);
	});

	it('does not offer the answers of a screen people sign in on (the Flow keeps none)', () => {
		const screens = [
			{
				screen_key: 'signin',
				fields: [
					{ field: 'method', label: 'Method', block_type: 'auth_widget' },
					{
						field: 'plan',
						label: 'Plan',
						block_type: 'radio',
						store_to_profile: false,
						options: [{ value: 'pro', label: 'Pro' }]
					}
				]
			}
		] as unknown as ScreenListItem[];
		expect(conditionAnswersOf(screens, ['signin'])).toEqual([]);
	});

	it('does not offer a hidden part, nor one in a hidden row', () => {
		const radio = (field: string, extra = {}) => ({
			field,
			label: field,
			block_type: 'radio',
			store_to_profile: false,
			options: [{ value: 'a', label: 'A' }],
			...extra
		});
		const screens = [
			{
				screen_key: 's',
				fields: [
					radio('hidden', { display_condition: { mode: 'hidden' } }),
					{
						field: 'row',
						label: '',
						block_type: 'layout_row',
						display_condition: { mode: 'hidden' }
					},
					radio('in_hidden_row'),
					{ field: 'row2', label: '', block_type: 'layout_row' },
					radio('shown')
				]
			}
		] as unknown as ScreenListItem[];
		expect(conditionAnswersOf(screens, ['s']).map((answer) => answer.key)).toEqual(['shown']);
	});

	it('turns a number kept as text in a list back into a number when one is compared', () => {
		const field = { key: 'attribute:points', label: 'Points', type: 'number' as const };
		expect(changeOperator(rule('attribute:points', 'in', ['10']), 'eq', field).value).toBe(10);
	});
});
