/**
 * Conditions built in the console: groups (all / any / none of) holding rules
 * (field · operator · value) and further groups. The model is the UI's; pages convert it to
 * the API's shape.
 * TODO(api): adapters to ServiceGroup `Expression` ({ op: 'all' | 'any' | 'not' | 'attribute'
 * | 'member' }) and policy `RuleCondition` / `CompoundCondition` (ar-lib-core
 * types/policy-rules.ts). "none of" maps to not(any). Service groups allow 11 levels; keep
 * MAX_DEPTH at or below what each API accepts.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum';

export interface ConditionField {
	key: string;
	label: string;
	type: FieldType;
	/** enum: the values to choose from. */
	options?: readonly { value: string; label: string }[];
}

export type Operator =
	| 'eq'
	| 'ne'
	| 'in'
	| 'not_in'
	| 'contains'
	| 'not_contains'
	| 'lt'
	| 'lte'
	| 'gt'
	| 'gte'
	| 'exists'
	| 'not_exists'
	| 'regex';

export type ConditionValue = string | number | boolean | string[] | null;

export interface ConditionRule {
	id: string;
	kind: 'rule';
	field: string;
	operator: Operator;
	value: ConditionValue;
}

export interface ConditionGroup {
	id: string;
	kind: 'group';
	match: 'all' | 'any' | 'none';
	children: ConditionNode[];
}

export type ConditionNode = ConditionRule | ConditionGroup;

/** Levels of groups a person can still follow. */
export const MAX_DEPTH = 3;

export const OPERATORS_BY_TYPE: Record<FieldType, readonly Operator[]> = {
	string: ['eq', 'ne', 'in', 'not_in', 'regex', 'exists', 'not_exists'],
	number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'not_exists'],
	boolean: ['eq'],
	'string[]': ['contains', 'not_contains', 'exists', 'not_exists'],
	enum: ['eq', 'ne', 'in', 'not_in']
};

export const takesList = (operator: Operator) => operator === 'in' || operator === 'not_in';
export const takesNoValue = (operator: Operator) =>
	operator === 'exists' || operator === 'not_exists';

export function defaultValue(
	field: ConditionField | undefined,
	operator: Operator
): ConditionValue {
	if (takesNoValue(operator)) return null;
	if (takesList(operator)) return [];
	if (field?.type === 'boolean') return true;
	if (field?.type === 'number') return null;
	if (field?.type === 'enum') return field.options?.[0]?.value ?? '';
	return '';
}

let counter = 0;
export const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

export function newRule(fields: readonly ConditionField[]): ConditionRule {
	const field = fields[0];
	const operator = field ? OPERATORS_BY_TYPE[field.type][0] : 'eq';
	return {
		id: nextId('rule'),
		kind: 'rule',
		field: field?.key ?? '',
		operator,
		value: defaultValue(field, operator)
	};
}

export function newGroup(
	fields: readonly ConditionField[],
	match: ConditionGroup['match'] = 'all'
): ConditionGroup {
	return { id: nextId('group'), kind: 'group', match, children: [newRule(fields)] };
}

/** Another field: keep the operator when it still applies, otherwise start over. */
export function changeField(rule: ConditionRule, field: ConditionField): ConditionRule {
	const allowed = OPERATORS_BY_TYPE[field.type];
	const operator = allowed.includes(rule.operator) ? rule.operator : allowed[0];
	return { ...rule, field: field.key, operator, value: defaultValue(field, operator) };
}

/** Another operator: carry the value over where it still makes sense (one ↔ list). */
export function changeOperator(
	rule: ConditionRule,
	operator: Operator,
	field: ConditionField | undefined
): ConditionRule {
	if (takesNoValue(operator)) return { ...rule, operator, value: null };
	const value = rule.value;
	if (takesList(operator)) {
		const list = Array.isArray(value)
			? value
			: value === null || value === ''
				? []
				: [String(value)];
		return { ...rule, operator, value: list };
	}
	if (Array.isArray(value))
		return { ...rule, operator, value: value[0] ?? defaultValue(field, operator) };
	return { ...rule, operator, value: value ?? defaultValue(field, operator) };
}

export type RuleProblem = 'noField' | 'noValue' | 'notNumber' | 'badPattern';

export function ruleProblem(
	rule: ConditionRule,
	fields: readonly ConditionField[]
): RuleProblem | null {
	const field = fields.find((f) => f.key === rule.field);
	if (!field) return 'noField';
	if (takesNoValue(rule.operator) || field.type === 'boolean') return null;
	const value = rule.value;
	if (takesList(rule.operator)) return Array.isArray(value) && value.length > 0 ? null : 'noValue';
	if (value === null || value === '') return 'noValue';
	if (field.type === 'number' && typeof value !== 'number') return 'notNumber';
	if (rule.operator === 'regex') {
		try {
			new RegExp(String(value));
		} catch {
			return 'badPattern';
		}
	}
	return null;
}

/** Every rule with a problem, anywhere in the tree. */
export function problems(
	node: ConditionNode,
	fields: readonly ConditionField[]
): Map<string, RuleProblem> {
	const found = new Map<string, RuleProblem>();
	const walk = (n: ConditionNode) => {
		if (n.kind === 'group') n.children.forEach(walk);
		else {
			const problem = ruleProblem(n, fields);
			if (problem) found.set(n.id, problem);
		}
	};
	walk(node);
	return found;
}

export interface Wording {
	/** Sentence templates per operator: "{field} is {value}". */
	say: Record<Operator, string>;
	and: string;
	or: string;
	/** "none of: {list}" */
	none: string;
	yes: string;
	no: string;
	/** Joins list values: ", ". */
	listSeparator: string;
	/** Stands in for a value not entered yet: "(not entered)". */
	empty: string;
}

/** The condition as one sentence, for a preview above the builder and for screen readers. */
export function describe(
	node: ConditionNode,
	fields: readonly ConditionField[],
	words: Wording,
	nested = false
): string {
	if (node.kind === 'rule') {
		const field = fields.find((f) => f.key === node.field);
		const show = (v: string | number | boolean) => {
			if (typeof v === 'boolean') return v ? words.yes : words.no;
			const option = field?.options?.find((o) => o.value === v);
			return option ? option.label : String(v);
		};
		const value =
			Array.isArray(node.value) && node.value.length
				? node.value.map(show).join(words.listSeparator)
				: node.value === null || node.value === '' || Array.isArray(node.value)
					? words.empty
					: show(node.value);
		return words.say[node.operator]
			.replace('{field}', field?.label ?? node.field)
			.replace('{value}', value);
	}
	const parts = node.children.map((child) => describe(child, fields, words, true));
	if (node.match === 'none') return words.none.replace('{list}', parts.join(words.or));
	const text = parts.join(node.match === 'all' ? words.and : words.or);
	return nested && parts.length > 1 ? `(${text})` : text;
}

export function depthOf(node: ConditionNode): number {
	return node.kind === 'rule' ? 0 : 1 + Math.max(0, ...node.children.map(depthOf));
}

const isBlank = (value: unknown) =>
	value === null ||
	value === undefined ||
	value === '' ||
	(Array.isArray(value) && value.length === 0);

/** One rule against a record of attribute values ({ department: "Sales", groups: [...] }). */
function ruleHolds(rule: ConditionRule, record: Readonly<Record<string, unknown>>): boolean {
	const actual = record[rule.field];
	const expected = rule.value;
	const text = (v: unknown) =>
		typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
	const list = Array.isArray(expected) ? expected.map(text) : [];
	const number = (v: unknown) => (typeof v === 'number' ? v : Number(text(v).trim() || NaN));
	switch (rule.operator) {
		case 'eq':
			return text(actual) === text(expected);
		case 'ne':
			return text(actual) !== text(expected);
		case 'in':
			return list.includes(text(actual));
		case 'not_in':
			return !list.includes(text(actual));
		case 'contains':
			return Array.isArray(actual) && actual.map(text).includes(text(expected));
		case 'not_contains':
			return !(Array.isArray(actual) && actual.map(text).includes(text(expected)));
		case 'lt':
			return number(actual) < number(expected);
		case 'lte':
			return number(actual) <= number(expected);
		case 'gt':
			return number(actual) > number(expected);
		case 'gte':
			return number(actual) >= number(expected);
		case 'exists':
			return !isBlank(actual);
		case 'not_exists':
			return isBlank(actual);
		case 'regex': {
			try {
				return new RegExp(text(expected), 'u').test(text(actual));
			} catch {
				return false;
			}
		}
	}
}

/**
 * Whether a condition holds for a record of attribute values — for previews (the mapping's
 * sample output). The APIs evaluate their own conditions on the server.
 */
export function holds(node: ConditionNode, record: Readonly<Record<string, unknown>>): boolean {
	if (node.kind === 'rule') return ruleHolds(node, record);
	const results = node.children.map((child) => holds(child, record));
	if (node.match === 'all') return results.every(Boolean);
	if (node.match === 'any') return results.some(Boolean);
	return !results.some(Boolean);
}
