import { describe as suite, expect, it } from 'vitest';
import {
	changeField,
	changeOperator,
	describe,
	holds,
	problems,
	type ConditionField,
	type ConditionGroup,
	type ConditionRule,
	type Wording
} from './condition-model';

const fields: ConditionField[] = [
	{
		key: 'country',
		label: 'Country',
		type: 'enum',
		options: [
			{ value: 'JP', label: 'Japan' },
			{ value: 'US', label: 'United States' }
		]
	},
	{ key: 'age', label: 'Age', type: 'number' },
	{ key: 'verified', label: 'Email verified', type: 'boolean' },
	{ key: 'groups', label: 'Groups', type: 'string[]' },
	{ key: 'email', label: 'Email', type: 'string' }
];

const words: Wording = {
	say: {
		eq: '{field} is {value}',
		ne: '{field} is not {value}',
		in: '{field} is one of {value}',
		not_in: '{field} is none of {value}',
		contains: '{field} include {value}',
		not_contains: '{field} do not include {value}',
		lt: '{field} < {value}',
		lte: '{field} ≤ {value}',
		gt: '{field} > {value}',
		gte: '{field} ≥ {value}',
		exists: '{field} is set',
		not_exists: '{field} is not set',
		regex: '{field} matches /{value}/'
	},
	and: ' and ',
	or: ' or ',
	none: 'none of: {list}',
	yes: 'yes',
	no: 'no',
	listSeparator: ', ',
	empty: '(not entered)'
};

suite('changing a rule', () => {
	const rule = {
		id: 'r',
		kind: 'rule' as const,
		field: 'email',
		operator: 'eq' as const,
		value: 'a@example.com'
	};

	it('keeps an operator that still applies and resets the value', () => {
		expect(changeField(rule, fields[0])).toMatchObject({
			field: 'country',
			operator: 'eq',
			value: 'JP'
		});
	});

	it('picks the first operator when the old one does not apply', () => {
		expect(changeField(rule, fields[3])).toMatchObject({ operator: 'contains', value: '' });
	});

	it('turns one value into a list and back', () => {
		const list = changeOperator(rule, 'in', fields[4]);
		expect(list.value).toEqual(['a@example.com']);
		expect(changeOperator(list, 'eq', fields[4]).value).toBe('a@example.com');
		expect(changeOperator(rule, 'exists', fields[4]).value).toBeNull();
	});
});

suite('problems', () => {
	it('finds rules that cannot be evaluated', () => {
		const tree: ConditionGroup = {
			id: 'g',
			kind: 'group',
			match: 'all',
			children: [
				{ id: 'a', kind: 'rule', field: 'age', operator: 'gt', value: null },
				{ id: 'b', kind: 'rule', field: 'email', operator: 'regex', value: '(' },
				{ id: 'c', kind: 'rule', field: 'verified', operator: 'eq', value: true }
			]
		};
		expect([...problems(tree, fields)]).toEqual([
			['a', 'noValue'],
			['b', 'badPattern']
		]);
	});
});

suite('describe', () => {
	it('reads a nested condition as a sentence', () => {
		const tree: ConditionGroup = {
			id: 'g',
			kind: 'group',
			match: 'all',
			children: [
				{ id: 'a', kind: 'rule', field: 'country', operator: 'in', value: ['JP', 'US'] },
				{
					id: 'h',
					kind: 'group',
					match: 'any',
					children: [
						{ id: 'b', kind: 'rule', field: 'verified', operator: 'eq', value: true },
						{ id: 'c', kind: 'rule', field: 'age', operator: 'gte', value: 18 }
					]
				}
			]
		};
		expect(describe(tree, fields, words)).toBe(
			'Country is one of Japan, United States and (Email verified is yes or Age ≥ 18)'
		);
	});

	it('says when a value is still missing', () => {
		const rule = {
			id: 'a',
			kind: 'rule' as const,
			field: 'age',
			operator: 'gte' as const,
			value: null
		};
		expect(describe(rule, fields, words)).toBe('Age ≥ (not entered)');
	});
});

suite('holds', () => {
	const record = { country: 'JP', groups: ['sales', 'admins'], age: '42', note: '' };
	const rule = (
		field: string,
		operator: ConditionRule['operator'],
		value: ConditionRule['value']
	) => ({ id: field, kind: 'rule', field, operator, value }) as ConditionRule;

	it('checks each kind of rule against the record', () => {
		expect(holds(rule('country', 'eq', 'JP'), record)).toBe(true);
		expect(holds(rule('country', 'in', ['US', 'JP']), record)).toBe(true);
		expect(holds(rule('groups', 'contains', 'admins'), record)).toBe(true);
		expect(holds(rule('age', 'gte', 40), record)).toBe(true);
		expect(holds(rule('note', 'exists', null), record)).toBe(false);
		expect(holds(rule('country', 'regex', '^J'), record)).toBe(true);
	});

	it('combines rules as all, any or none of', () => {
		const group = (match: 'all' | 'any' | 'none'): ConditionGroup => ({
			id: 'g',
			kind: 'group',
			match,
			children: [rule('country', 'eq', 'JP'), rule('country', 'eq', 'US')]
		});
		expect(holds(group('all'), record)).toBe(false);
		expect(holds(group('any'), record)).toBe(true);
		expect(holds(group('none'), record)).toBe(false);
	});
});
