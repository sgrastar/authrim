/**
 * Who a flow step is shown to: the rules of its "shown to" field (a ConditionBuilder whose rules
 * must all hold), and the conditions they are saved as (ar-lib-core `FlowStepWhen`). No rule:
 * everyone.
 *
 * A rule compares something known of the person or the run, named by its field key:
 * - `attribute:<key>`: one of their attributes (a standard profile one or the tenant's own);
 * - `age`: their age in whole years (from their date of birth);
 * - `answer:<key>`: a choice they made on a screen before;
 * - `app`: the app they came from;
 * - `locale`: the language the screens are shown in.
 *
 * The field keeps each rule as JSON text, so a rule being written is kept as it is; only complete
 * rules become conditions, and a flow with an incomplete one is not saved (`hasIncompleteRule`).
 * Every condition a rule is saved as reads back as the same rule. A saved condition the form
 * cannot show as a rule (one made in the Flow editor: a role, a group, a policy) leaves the flow
 * shown, not saved, as the form would drop it.
 */
import {
	FLOW_CONDITION_PROFILE_ATTRIBUTES,
	MAX_FLOW_CONDITION_AGE,
	MAX_FLOW_CONDITION_ALL,
	MAX_SCREEN_ANSWER_CONDITION_KEY_LENGTH,
	MAX_USER_ATTRIBUTE_CONDITION_KEY_LENGTH,
	isOrderableConditionValue,
	type FlowConditionExpression,
	type FlowStepWhen
} from '@authrim/ar-lib-core/types/flow-step-condition';
import type {
	ConditionField,
	ConditionGroup,
	ConditionRule,
	ConditionValue,
	Operator
} from '#lib/ui/patterns/condition-model.js';
import type { AccountValue } from './flow-spec';

export type ConditionSource = 'attribute' | 'age' | 'answer' | 'app' | 'locale';

/** The most rules a step's field takes (the conditions an `all` combines). */
export const MAX_CONDITION_RULES = MAX_FLOW_CONDITION_ALL;

/** The standard profile attributes a condition can compare, before the tenant's own. */
export const STANDARD_CONDITION_ATTRIBUTES: readonly string[] = FLOW_CONDITION_PROFILE_ATTRIBUTES;

const TYPE: Record<ConditionSource, FlowConditionExpression['type']> = {
	attribute: 'user.attribute',
	age: 'user.age',
	answer: 'screen.answer',
	app: 'client_id',
	locale: 'locale'
};

/** Every way a source can be compared (an attribute's type may offer fewer, see the fields). */
const SOURCE_OPERATORS: Record<ConditionSource, readonly Operator[]> = {
	attribute: ['eq', 'ne', 'in', 'not_in', 'exists', 'not_exists', 'lt', 'lte', 'gt', 'gte'],
	age: ['gte', 'gt', 'lte', 'lt', 'eq', 'ne'],
	answer: ['eq', 'ne', 'in', 'not_in', 'exists', 'not_exists'],
	app: ['eq', 'ne', 'in', 'not_in'],
	locale: ['eq', 'ne', 'in', 'not_in']
};

const LISTS: ReadonlySet<Operator> = new Set(['in', 'not_in']);
const ORDERING: ReadonlySet<Operator> = new Set(['lt', 'lte', 'gt', 'gte']);
const PRESENCE: ReadonlySet<Operator> = new Set(['exists', 'not_exists']);
const ATTRIBUTE_KEY = /^[a-z][a-z0-9_.:-]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** What a rule's field key names: the source, and the attribute or answer it compares. */
export function sourceOf(fieldKey: string): { source: ConditionSource; key: string } | null {
	if (fieldKey === 'age' || fieldKey === 'app' || fieldKey === 'locale') {
		return { source: fieldKey, key: '' };
	}
	const at = fieldKey.indexOf(':');
	if (at <= 0) return null;
	const source = fieldKey.slice(0, at);
	const key = fieldKey.slice(at + 1);
	if (source !== 'attribute' && source !== 'answer') return null;
	const max =
		source === 'attribute'
			? MAX_USER_ATTRIBUTE_CONDITION_KEY_LENGTH
			: MAX_SCREEN_ANSWER_CONDITION_KEY_LENGTH;
	if (!key || key.length > max || key.trim() !== key) return null;
	if (source === 'attribute' && !ATTRIBUTE_KEY.test(key)) return null;
	return { source, key };
}

/** The field key of a source (and the attribute or answer it compares). */
export function fieldKeyOf(source: ConditionSource, key = ''): string {
	return source === 'attribute' || source === 'answer' ? `${source}:${key}` : source;
}

/** A whole number of years a person can be. */
export function isAge(value: string | number): boolean {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= MAX_FLOW_CONDITION_AGE
	);
}

function scalar(value: unknown): value is string | number | boolean {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function filled(value: unknown): boolean {
	return typeof value === 'string' ? value.trim() !== '' : scalar(value);
}

/**
 * Whether a rule can be saved as a condition: a field the form knows, a way its source can be
 * compared, and a value that compares (an age a whole number of years, an ordering a number or a
 * date, a list not empty). Checked without the field lists, which may not be loaded.
 */
/**
 * A rule as the field keeps it: with the kind of value its field takes, when the field says (a
 * number, a date), so a rule can be checked before saving without the field lists, which may not
 * be loaded (or the step's panel open).
 */
export type StoredRule = ConditionRule & { valueKind?: 'number' | 'date' };

/** The kind of value a field takes, for the rules it compares. */
function valueKindOf(field: ConditionField | undefined): StoredRule['valueKind'] {
	if (!field) return undefined;
	if (field.type === 'number') return 'number';
	return field.accepts === isDate ? 'date' : undefined;
}

const NUMBER_TEXT = /^-?\d+(\.\d+)?$/u;

/** A number written as text (an item of a list compared with a number attribute). */
const isNumberText = (value: string | number) =>
	typeof value === 'number' ? Number.isFinite(value) : NUMBER_TEXT.test(value.trim());

/** Whether an item of a list is of the kind its field takes. */
function fitsKind(item: string, kind: StoredRule['valueKind']): boolean {
	if (kind === 'number') return isNumberText(item);
	if (kind === 'date') return isDate(item);
	return true;
}

export function ruleComplete(rule: StoredRule): boolean {
	const named = sourceOf(rule.field);
	if (!named || !SOURCE_OPERATORS[named.source].includes(rule.operator)) return false;
	if (PRESENCE.has(rule.operator)) return true;
	const value = rule.value;
	if (LISTS.has(rule.operator)) {
		return (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every((item) => item.trim() !== '' && fitsKind(item.trim(), rule.valueKind))
		);
	}
	if (Array.isArray(value) || !filled(value)) return false;
	if (named.source === 'age') return typeof value === 'number' && isAge(value);
	if (rule.valueKind === 'number' && typeof value !== 'number') return false;
	if (rule.valueKind === 'date' && (typeof value !== 'string' || !isDate(value.trim()))) {
		return false;
	}
	if (ORDERING.has(rule.operator)) {
		return typeof value !== 'boolean' && isOrderableConditionValue(value);
	}
	return true;
}

/** The condition a complete rule is saved as; null for one still being written. */
export function expressionOf(rule: ConditionRule): FlowConditionExpression | null {
	if (!ruleComplete(rule)) return null;
	const named = sourceOf(rule.field) as { source: ConditionSource; key: string };
	const expression: FlowConditionExpression = {
		type: TYPE[named.source],
		operator: rule.operator as FlowConditionExpression['operator']
	};
	if (named.key) expression.attribute = named.key;
	if (PRESENCE.has(rule.operator)) return expression;
	const value = rule.value;
	if (Array.isArray(value)) expression.values = value.map((item) => item.trim());
	else expression.value = typeof value === 'string' ? value.trim() : (value as number | boolean);
	return expression;
}

/**
 * The rule a saved condition is shown as (with the id given), or null when the form cannot show
 * it: a kind it does not offer, or one it would save another way. One saved without an operator
 * reads as the operator it means (equal to its value, or one of its values).
 */
export function ruleOf(condition: unknown, id: string): ConditionRule | null {
	if (!isRecord(condition)) return null;
	const source = (Object.keys(TYPE) as ConditionSource[]).find(
		(candidate) => TYPE[candidate] === condition.type
	);
	if (!source) return null;
	const key = source === 'attribute' || source === 'answer' ? condition.attribute : '';
	if (typeof key !== 'string') return null;
	const values = condition.values;
	const operator = (condition.operator ?? (Array.isArray(values) ? 'in' : 'eq')) as Operator;
	let value: ConditionValue = null;
	if (!PRESENCE.has(operator)) {
		const items: unknown[] = Array.isArray(values)
			? values
			: condition.value === undefined
				? []
				: [condition.value];
		if (LISTS.has(operator)) {
			if (!items.every((item): item is string => typeof item === 'string')) return null;
			value = items;
		} else {
			if (items.length !== 1 || !scalar(items[0])) return null;
			value = items[0];
		}
	}
	const rule: ConditionRule = { id, kind: 'rule', field: fieldKeyOf(source, key), operator, value };
	const back = expressionOf(rule);
	// Only one the form saves the same way again (its meaning, if not its spelling).
	return back && stable(back) === stable(normalized(condition, operator)) ? rule : null;
}

/** A saved condition as the form would save it: an operator named, a list as `values`. */
function normalized(condition: Record<string, unknown>, operator: Operator): unknown {
	const { operator: _operator, value, values, ...rest } = condition;
	const out: Record<string, unknown> = { ...rest, operator };
	if (PRESENCE.has(operator)) return out;
	const items: unknown[] = Array.isArray(values) ? values : value === undefined ? [] : [value];
	if (LISTS.has(operator)) out.values = items;
	else out.value = items[0];
	return out;
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function ruleFromJson(text: string): StoredRule | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.field !== 'string') {
			return null;
		}
		const value = parsed.value;
		const readable =
			value === null ||
			scalar(value) ||
			(Array.isArray(value) && value.every((item) => typeof item === 'string'));
		return {
			id: parsed.id,
			kind: 'rule',
			field: parsed.field,
			operator: (typeof parsed.operator === 'string' ? parsed.operator : 'eq') as Operator,
			value: readable ? (value as ConditionValue) : null,
			...(parsed.valueKind === 'number' || parsed.valueKind === 'date'
				? { valueKind: parsed.valueKind }
				: {})
		};
	} catch {
		return null;
	}
}

/** The rules a field holds, in order (anything unreadable is not a rule). */
export function rulesOf(value: AccountValue | undefined): StoredRule[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => ruleFromJson(entry) ?? []).slice(0, MAX_CONDITION_RULES);
}

/** The field's value for its rules. */
export function valueOfRules(rules: readonly StoredRule[]): string[] {
	return rules.map((rule) =>
		JSON.stringify({
			id: rule.id,
			field: rule.field,
			operator: rule.operator,
			value: rule.value,
			...(rule.valueKind ? { valueKind: rule.valueKind } : {})
		})
	);
}

/** The builder's group for a field: its rules, all of which must hold. */
export function groupOf(value: AccountValue | undefined): ConditionGroup {
	return { id: 'shown-to', kind: 'group', match: 'all', children: rulesOf(value) };
}

/**
 * The field's value for the builder's group (its rules; groups are not offered), each with the
 * kind of value its field takes as `fields` say (one whose field is not among them keeps its own).
 */
export function valueOfGroup(group: ConditionGroup, fields: readonly ConditionField[]): string[] {
	return valueOfRules(
		group.children.flatMap((child): StoredRule[] => {
			if (child.kind !== 'rule') return [];
			const { valueKind: kept, ...rule } = child as StoredRule;
			const field = fields.find((candidate) => candidate.key === rule.field);
			const valueKind = field ? valueKindOf(field) : kept;
			return [valueKind ? { ...rule, valueKind } : rule];
		})
	);
}

/** Whether a field has a rule still being written (the flow cannot be saved with it). */
export function hasIncompleteRule(value: AccountValue | undefined): boolean {
	return rulesOf(value).some((rule) => !ruleComplete(rule));
}

/** The conditions a field's rules are saved as (none: shown to everyone). */
export function whenOf(value: AccountValue | undefined): FlowStepWhen {
	return rulesOf(value).flatMap((rule) => expressionOf(rule) ?? []);
}

/**
 * The field's value for a saved step's conditions, or null when one of them cannot be shown as a
 * rule (the flow is then shown, not saved). No condition: no value.
 */
export function valueOfWhen(when: FlowStepWhen | undefined): string[] | null {
	if (!when || when.length === 0) return [];
	if (when.length > MAX_CONDITION_RULES) return null;
	const rules = when.map((condition, index) => ruleOf(condition, `rule-${index + 1}`));
	return rules.every((rule): rule is ConditionRule => rule !== null) ? valueOfRules(rules) : null;
}

/** An attribute a rule can compare, as the tenant's schema has it. */
export interface ConditionAttribute {
	key: string;
	label: string;
	type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
	/** Several values (a list): compared by its items, never ordered. */
	multi?: boolean;
	choices?: readonly { value: string; label: string }[];
}

/** A choice part of a screen of the flow, whose answer a rule can compare. */
export interface ConditionAnswer {
	key: string;
	label: string;
	/** A checkbox: ticked or not (no choices). */
	checkbox?: boolean;
	choices: readonly { value: string; label: string }[];
}

/** What the builder offers, by what the tenant has; the labels in the console's language. */
export interface ConditionChoices {
	attributes: readonly ConditionAttribute[];
	answers: readonly ConditionAnswer[];
	apps: readonly { value: string; label: string }[];
	locales: readonly { value: string; label: string }[];
	label: (source: ConditionSource, name?: string) => string;
}

const TEXT_OPERATORS: readonly Operator[] = ['eq', 'ne', 'in', 'not_in', 'exists', 'not_exists'];
const ORDERED_OPERATORS: readonly Operator[] = [
	'eq',
	'ne',
	'lt',
	'lte',
	'gt',
	'gte',
	'exists',
	'not_exists'
];

const isDate = (value: string | number) =>
	typeof value === 'string' &&
	/^\d{4}-\d{2}-\d{2}$/u.test(value) &&
	isOrderableConditionValue(value);

/** The fields of the builder: the person's age, their attributes, the answers, the app, the language. */
export function conditionFieldsOf(choices: ConditionChoices): ConditionField[] {
	const fields: ConditionField[] = [
		{
			key: 'age',
			label: choices.label('age'),
			type: 'number',
			operators: SOURCE_OPERATORS.age,
			accepts: isAge
		}
	];
	for (const attribute of choices.attributes) {
		const label = choices.label('attribute', attribute.label);
		const key = fieldKeyOf('attribute', attribute.key);
		if (!sourceOf(key)) continue;
		if (attribute.multi) {
			// A list matches when one of its items does; it has no order to compare.
			const choicesOf = attribute.choices ?? [];
			fields.push(
				choicesOf.length > 0
					? { key, label, type: 'enum', options: choicesOf, operators: TEXT_OPERATORS }
					: attribute.type === 'number'
						? { key, label, type: 'number', operators: TEXT_OPERATORS, accepts: isNumberText }
						: attribute.type === 'date'
							? { key, label, type: 'string', operators: TEXT_OPERATORS, accepts: isDate }
							: { key, label, type: 'string', operators: TEXT_OPERATORS }
			);
		} else if (attribute.type === 'number') {
			fields.push({ key, label, type: 'number', operators: ORDERED_OPERATORS });
		} else if (attribute.type === 'date') {
			fields.push({ key, label, type: 'string', operators: ORDERED_OPERATORS, accepts: isDate });
		} else if (attribute.type === 'boolean') {
			fields.push({ key, label, type: 'boolean', operators: ['eq', 'exists', 'not_exists'] });
		} else if (attribute.choices && attribute.choices.length > 0) {
			fields.push({
				key,
				label,
				type: 'enum',
				options: attribute.choices,
				operators: TEXT_OPERATORS
			});
		} else {
			fields.push({ key, label, type: 'string', operators: TEXT_OPERATORS });
		}
	}
	for (const answer of choices.answers) {
		const key = fieldKeyOf('answer', answer.key);
		if (!sourceOf(key)) continue;
		if (answer.checkbox) {
			fields.push({
				key,
				label: choices.label('answer', answer.label),
				type: 'boolean',
				operators: ['eq']
			});
			continue;
		}
		fields.push({
			key,
			label: choices.label('answer', answer.label),
			type: answer.choices.length > 0 ? 'enum' : 'string',
			...(answer.choices.length > 0 ? { options: answer.choices } : {}),
			operators: TEXT_OPERATORS
		});
	}
	fields.push(
		choices.apps.length > 0
			? {
					key: 'app',
					label: choices.label('app'),
					type: 'enum',
					options: choices.apps,
					operators: SOURCE_OPERATORS.app
				}
			: {
					key: 'app',
					label: choices.label('app'),
					type: 'string',
					operators: SOURCE_OPERATORS.app
				},
		{
			key: 'locale',
			label: choices.label('locale'),
			type: 'enum',
			options: choices.locales,
			operators: SOURCE_OPERATORS.locale
		}
	);
	return fields;
}

/**
 * The fields with those the saved rules name but the lists do not have (an attribute since
 * removed, an answer of a screen no longer in the flow), so a rule is shown as it is, not lost.
 */
export function withRuleFields(
	fields: readonly ConditionField[],
	rules: readonly StoredRule[],
	label: (source: ConditionSource, name?: string) => string
): ConditionField[] {
	const extra = new Map<string, ConditionField>();
	for (const rule of rules) {
		if (extra.has(rule.field) || fields.some((field) => field.key === rule.field)) continue;
		const named = sourceOf(rule.field);
		if (!named) continue;
		// The kind of value the rule was written for is kept (and checked) until its field is back.
		const kind = rule.valueKind ?? (typeof rule.value === 'number' ? 'number' : undefined);
		extra.set(rule.field, {
			key: rule.field,
			label: label(named.source, named.key || undefined),
			type: kind === 'number' ? 'number' : 'string',
			operators: SOURCE_OPERATORS[named.source],
			...(kind === 'date' ? { accepts: isDate } : {})
		});
	}
	return [...fields, ...extra.values()];
}
