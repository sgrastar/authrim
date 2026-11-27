/**
 * A dynamic group's rule, between the service-group catalog's expression and the console's
 * condition builder (`condition-model.ts`).
 *
 * The catalog compares an attribute with `eq`, `in`, `contains`, `lt`, `lte`, `gt`, `gte` and
 * combines with `all`, `any` and `not`. The builder's "is not", "is not one of" and "does not
 * contain" are `not` around the comparison, and its "none of" is `not(any(…))`. A rule the
 * builder cannot show (a `member` reference to another group, `not(all(…))`, a `not` around
 * something else) is shown as it is, read only.
 */
import type { CatalogField, ExpressionValue, GroupExpression } from '#lib/api/end-user-groups.js';
import {
	nextId,
	type ConditionField,
	type ConditionGroup,
	type ConditionNode,
	type ConditionRule,
	type ConditionValue,
	type FieldType,
	type Operator
} from '#lib/ui/patterns/condition-model.js';

type Attribute = Extract<GroupExpression, { op: 'attribute' }>;

const OPERATORS: Readonly<Record<string, readonly Operator[]>> = {
	string: ['eq', 'ne', 'in', 'not_in'],
	number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
	boolean: ['eq'],
	list: ['contains', 'not_contains']
};

type ElementType = 'string' | 'number' | 'boolean';

/** The type of one value of a field: its own, or its elements' for a list (`number[]` → number). */
function elementType(type: string): ElementType {
	const base = type.endsWith('[]') ? type.slice(0, -2) : type;
	return base === 'number' || base === 'boolean' ? base : 'string';
}

/** A value as the field's element type takes it; undefined when it is not one. */
function typedValue(value: unknown, element: ElementType): ExpressionValue | undefined {
	if (element === 'number') {
		const number = typeof value === 'number' ? value : Number(String(value).trim());
		return String(value).trim() !== '' && Number.isFinite(number) ? number : undefined;
	}
	if (element === 'boolean') {
		if (typeof value === 'boolean') return value;
		const text = String(value).trim().toLowerCase();
		return text === 'true' ? true : text === 'false' ? false : undefined;
	}
	return typeof value === 'string' ? value : String(value);
}

function builderType(type: string): FieldType {
	if (type === 'number') return 'number';
	if (type === 'boolean') return 'boolean';
	if (type.endsWith('[]')) return 'string[]';
	return 'string';
}

/**
 * The catalog's fields as the builder's, in name order. A field the person can write themselves
 * is offered too: the API refuses it only when the group (or one below it) carries roles.
 */
export function fieldsFromCatalog(
	fields: Readonly<Record<string, CatalogField>>
): ConditionField[] {
	return Object.entries(fields)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, field]) => {
			const type = builderType(field.type);
			const element = elementType(field.type);
			return {
				key,
				label: key,
				type,
				operators: OPERATORS[type === 'string[]' ? 'list' : type],
				// A list of numbers or of yes/no is compared with one of those, typed as text here.
				...(type === 'string[]' && element !== 'string'
					? { accepts: (value: string | number) => typedValue(value, element) !== undefined }
					: {})
			};
		});
}

const NEGATED: Partial<Record<Operator, Attribute['compare']>> = {
	ne: 'eq',
	not_in: 'in',
	not_contains: 'contains'
};
const POSITIVE: Partial<Record<Operator, Attribute['compare']>> = {
	eq: 'eq',
	in: 'in',
	contains: 'contains',
	lt: 'lt',
	lte: 'lte',
	gt: 'gt',
	gte: 'gte'
};

const scalar = (value: unknown): value is ExpressionValue =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function ruleOf(expression: Attribute, negated: boolean): ConditionRule | null {
	const operator: Operator | undefined = negated
		? ({ eq: 'ne', in: 'not_in', contains: 'not_contains' } as const)[
				expression.compare as 'eq' | 'in' | 'contains'
			]
		: expression.compare;
	if (!operator) return null;
	let value: ConditionValue;
	if (operator === 'in' || operator === 'not_in') {
		if (!Array.isArray(expression.value)) return null;
		value = expression.value.map(String);
	} else if (operator === 'contains' || operator === 'not_contains') {
		// A list field's element is typed as text in the builder (`true`, `42`); the save turns it
		// back into the catalog's element type.
		if (!scalar(expression.value)) return null;
		value = String(expression.value);
	} else {
		if (!scalar(expression.value)) return null;
		value = expression.value;
	}
	return { id: nextId('rule'), kind: 'rule', field: expression.field, operator, value };
}

function nodeOf(expression: GroupExpression): ConditionNode | null {
	switch (expression.op) {
		case 'attribute':
			return ruleOf(expression, false);
		case 'all':
		case 'any': {
			const children = expression.args.map(nodeOf);
			if (children.some((child) => child === null)) return null;
			return {
				id: nextId('group'),
				kind: 'group',
				match: expression.op,
				children: children as ConditionNode[]
			};
		}
		case 'not': {
			const inner = expression.arg;
			if (inner.op === 'attribute') return ruleOf(inner, true);
			if (inner.op === 'any') {
				const group = nodeOf(inner);
				return group && group.kind === 'group' ? { ...group, match: 'none' } : null;
			}
			return null;
		}
		default:
			return null;
	}
}

/**
 * The rule as the builder's condition (always a group at the top), an empty group for no rule,
 * or null when the builder cannot show it.
 */
export function conditionFromExpression(expression: GroupExpression | null): ConditionGroup | null {
	if (!expression) return { id: nextId('group'), kind: 'group', match: 'all', children: [] };
	const node = nodeOf(expression);
	if (!node) return null;
	return node.kind === 'group'
		? node
		: { id: nextId('group'), kind: 'group', match: 'all', children: [node] };
}

function attributeOf(rule: ConditionRule, fieldType: string | undefined): GroupExpression {
	const negated = NEGATED[rule.operator];
	const compare = negated ?? POSITIVE[rule.operator] ?? 'eq';
	const element = elementType(fieldType ?? 'string');
	// Each value in the type the catalog's field holds (a number list compares numbers).
	const typed = (item: unknown): ExpressionValue => typedValue(item, element) ?? String(item);
	const raw = rule.value;
	let value: ExpressionValue | ExpressionValue[];
	if (Array.isArray(raw)) value = raw.map(typed);
	else if (raw === null) value = '';
	else value = typed(raw);
	const attribute: GroupExpression = { op: 'attribute', field: rule.field, compare, value };
	return negated ? { op: 'not', arg: attribute } : attribute;
}

function expressionOf(
	node: ConditionNode,
	fields: Readonly<Record<string, CatalogField>>
): GroupExpression | null {
	if (node.kind === 'rule') return attributeOf(node, fields[node.field]?.type);
	const args = node.children
		.map((child) => expressionOf(child, fields))
		.filter((child): child is GroupExpression => child !== null);
	if (args.length === 0) return null;
	if (node.match === 'none') return { op: 'not', arg: { op: 'any', args } };
	return { op: node.match, args };
}

/**
 * The condition as the catalog's expression, its values in the types of the catalog's fields;
 * null when it has no rules (no members by rule).
 */
export function expressionFromCondition(
	condition: ConditionGroup,
	fields: Readonly<Record<string, CatalogField>>
): GroupExpression | null {
	return expressionOf(condition, fields);
}

/**
 * The condition a rule save sends: the one read, exactly as it was, unless the admin changed it
 * in the builder. Reading wraps a single comparison in a group; writing that back unasked would
 * look like a new rule to the API (and expire the memberships it gave) on a mere rename.
 */
export function conditionToSave(
	loaded: GroupExpression | null,
	edited: boolean,
	condition: ConditionGroup | null,
	fields: Readonly<Record<string, CatalogField>>
): GroupExpression | null {
	if (!edited || !condition) return loaded;
	return expressionFromCondition(condition, fields);
}
