/**
 * Rules of the policy pages (Access → Policies), kept out of the components so they can be
 * tested. The condition editor is driven by the API's own list of condition types
 * (`GET /api/admin/policies/condition-types`): a parameter is drawn by its declared type, and a
 * condition the editor cannot draw (an unknown type, a parameter of a type it does not know, a
 * value that does not fit) is edited as JSON instead, never dropped.
 */
import type {
	ConditionParam,
	ConditionTypeInfo,
	PolicyCondition,
	PolicyEffect,
	PolicyInput,
	PolicyRule,
	PolicySimulationInput
} from '#lib/api/end-user-policies.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';

/** How a parameter is drawn. `group` and `groups` are picked from the tenant's groups. */
export type ParamKind =
	| 'string'
	| 'number'
	| 'boolean'
	| 'strings'
	| 'numbers'
	| 'group'
	| 'groups';

/** The kind a parameter is drawn as, or null when the editor cannot draw it. */
export function paramKind(param: Pick<ConditionParam, 'name' | 'type'>): ParamKind | null {
	if (param.name === 'group_id' && param.type === 'string') return 'group';
	if (param.name === 'group_ids' && param.type === 'string[]') return 'groups';
	switch (param.type) {
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'string[]':
			return 'strings';
		case 'number[]':
			return 'numbers';
		default:
			return null;
	}
}

/** One condition being edited: its parameters by kind, or the whole condition as JSON. */
export interface ConditionDraft {
	/** Identifies the condition among its siblings while it is edited. */
	key: number;
	type: string;
	mode: 'fields' | 'json';
	/** String and number parameters, as typed. */
	text: Record<string, string>;
	flags: Record<string, boolean>;
	/** Lists of strings or numbers, as typed. */
	lists: Record<string, string[]>;
	/** Group parameters, picked. */
	groups: Record<string, PickerItem[]>;
	/** The whole condition (`{ "type": …, "params": … }`) while `mode` is `json`. */
	json: string;
	/** The condition as loaded: sent back verbatim while the fields still say what they did. */
	original?: PolicyCondition;
	/** What the fields made of `original` when it was loaded (to tell whether they were edited). */
	fingerprint?: string;
}

export interface PolicyDraft {
	name: string;
	description: string;
	priority: number | null;
	effect: PolicyEffect;
	resource_types: string[];
	actions: string[];
	enabled: boolean;
	conditions: ConditionDraft[];
}

export const DEFAULT_PRIORITY = 100;

export const emptyDraft = (): PolicyDraft => ({
	name: '',
	description: '',
	priority: DEFAULT_PRIORITY,
	effect: 'allow',
	resource_types: [],
	actions: [],
	enabled: true,
	conditions: []
});

const blank = (key: number, type: string): ConditionDraft => ({
	key,
	type,
	mode: 'fields',
	text: {},
	flags: {},
	lists: {},
	groups: {},
	json: ''
});

/** The condition as JSON text, for the editor's fallback. */
export const conditionJson = (condition: PolicyCondition): string =>
	JSON.stringify({ type: condition.type, params: condition.params }, null, 2);

/** A new condition of a type, its parameters empty. */
export function newConditionDraft(key: number, info: ConditionTypeInfo): ConditionDraft {
	const draft = blank(key, info.type);
	for (const param of info.params) {
		const kind = paramKind(param);
		if (kind === 'boolean') draft.flags[param.name] = false;
		else if (kind === 'strings' || kind === 'numbers') draft.lists[param.name] = [];
		else if (kind === 'group' || kind === 'groups') draft.groups[param.name] = [];
		else if (kind) draft.text[param.name] = '';
	}
	return draft;
}

/** Text a box can show and give back unchanged: not empty, no spaces at either end. */
const faithful = (value: string) => value !== '' && value === value.trim();
/** A list of texts the list box can show and give back unchanged (no empty or repeated entry). */
const faithfulList = (values: string[]) =>
	values.every((value) => value !== '') && new Set(values).size === values.length;

const isList = (value: unknown, check: (item: unknown) => boolean): value is unknown[] =>
	Array.isArray(value) && value.every(check);
const isNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/**
 * An existing condition as a draft. Drawn as fields while every parameter it holds is one the
 * type declares and fits its kind; otherwise it is kept as JSON, so that nothing is lost.
 * `label` names a group by its id for the picker (the page may know better).
 */
export function conditionDraftOf(
	key: number,
	condition: PolicyCondition,
	info: ConditionTypeInfo | undefined,
	label: (groupId: string) => string = (id) => id
): ConditionDraft {
	const asJson = (): ConditionDraft => ({
		...blank(key, condition.type),
		mode: 'json',
		json: conditionJson(condition)
	});
	if (!info) return asJson();
	const known = new Set(info.params.map((param) => param.name));
	if (Object.keys(condition.params).some((name) => !known.has(name))) return asJson();
	const draft = newConditionDraft(key, info);
	for (const param of info.params) {
		const kind = paramKind(param);
		if (!kind) return asJson();
		const value = condition.params[param.name];
		if (value === undefined) continue;
		switch (kind) {
			case 'string':
				if (typeof value !== 'string' || !faithful(value)) return asJson();
				draft.text[param.name] = value;
				break;
			case 'number':
				if (!isNumber(value)) return asJson();
				draft.text[param.name] = String(value);
				break;
			case 'boolean':
				if (typeof value !== 'boolean') return asJson();
				draft.flags[param.name] = value;
				break;
			case 'strings':
				if (!isList(value, (item) => typeof item === 'string') || !faithfulList(value as string[]))
					return asJson();
				draft.lists[param.name] = [...(value as string[])];
				break;
			case 'numbers':
				if (!isList(value, isNumber)) return asJson();
				draft.lists[param.name] = (value as number[]).map(String);
				break;
			case 'group':
				if (typeof value !== 'string' || (value !== '' && !faithful(value))) return asJson();
				draft.groups[param.name] = value ? [{ value, label: label(value), icon: 'users' }] : [];
				break;
			case 'groups':
				if (!isList(value, (item) => typeof item === 'string') || !faithfulList(value as string[]))
					return asJson();
				draft.groups[param.name] = (value as string[]).map((id) => ({
					value: id,
					label: label(id),
					icon: 'users' as const
				}));
				break;
		}
	}
	draft.original = condition;
	draft.fingerprint = JSON.stringify(conditionResult(draft, info).condition);
	return draft;
}

/** Switches a condition to JSON (from what it holds now) when its fields are complete enough. */
export function toJsonMode(draft: ConditionDraft, info: ConditionTypeInfo | undefined): void {
	const result = info ? conditionResult({ ...draft, mode: 'fields' }, info) : null;
	draft.json = conditionJson(
		result?.condition ?? { type: draft.type, params: paramsSoFar(draft, info) }
	);
	draft.mode = 'json';
}

/**
 * Switches a JSON condition back to fields. False (nothing changed) when the JSON is not a
 * condition of this type, or holds something the fields cannot draw.
 */
export function toFieldsMode(draft: ConditionDraft, info: ConditionTypeInfo | undefined): boolean {
	const result = jsonResult(draft.json);
	if (!info || !result.condition || result.condition.type !== info.type) return false;
	const next = conditionDraftOf(draft.key, result.condition, info);
	if (next.mode === 'json') return false;
	Object.assign(draft, next);
	return true;
}

/** Whatever the fields hold now, for a switch to JSON while some are still empty. */
function paramsSoFar(draft: ConditionDraft, info: ConditionTypeInfo | undefined) {
	const params: Record<string, unknown> = {};
	for (const param of info?.params ?? []) {
		const kind = paramKind(param);
		if (kind === 'string' && draft.text[param.name]?.trim())
			params[param.name] = draft.text[param.name];
		else if (
			kind === 'number' &&
			draft.text[param.name]?.trim() &&
			isNumber(Number(draft.text[param.name]))
		)
			params[param.name] = Number(draft.text[param.name]);
		else if (kind === 'boolean') params[param.name] = draft.flags[param.name] === true;
		else if (kind === 'strings')
			params[param.name] = (draft.lists[param.name] ?? []).filter((v) => v.trim());
		else if (kind === 'numbers')
			params[param.name] = (draft.lists[param.name] ?? [])
				.filter((v) => v.trim())
				.map(Number)
				.filter(isNumber);
		else if (kind === 'group' && draft.groups[param.name]?.[0])
			params[param.name] = draft.groups[param.name][0].value;
		else if (kind === 'groups')
			params[param.name] = (draft.groups[param.name] ?? []).map((item) => item.value);
	}
	return params;
}

export type ConditionProblem =
	| 'pol.cond.required'
	| 'pol.cond.number'
	| 'pol.cond.json'
	| 'pol.cond.jsonShape';

export interface ConditionResult {
	condition: PolicyCondition | null;
	/** Problems by parameter name; the key `''` is the whole condition (JSON). */
	problems: Record<string, ConditionProblem>;
}

/** The text of a number parameter as a number, or null when it is not one. */
export function numberOf(text: string): number | null {
	const value = text.trim();
	if (value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** A condition draft as the condition to send, or what is wrong with it. */
export function conditionResult(
	draft: ConditionDraft,
	info: ConditionTypeInfo | undefined
): ConditionResult {
	if (draft.mode === 'json' || !info) return jsonResult(draft.json);
	const params: Record<string, unknown> = {};
	const problems: Record<string, ConditionProblem> = {};
	for (const param of info.params) {
		const kind = paramKind(param);
		const name = param.name;
		switch (kind) {
			case 'string': {
				// Never trimmed: the engine compares the value as it is.
				const value = draft.text[name] ?? '';
				if (value.trim()) params[name] = value;
				else if (param.required) problems[name] = 'pol.cond.required';
				break;
			}
			case 'number': {
				const raw = draft.text[name] ?? '';
				const value = numberOf(raw);
				if (value !== null) params[name] = value;
				else if (raw.trim() !== '') problems[name] = 'pol.cond.number';
				else if (param.required) problems[name] = 'pol.cond.required';
				break;
			}
			case 'boolean':
				params[name] = draft.flags[name] === true;
				break;
			case 'strings':
			case 'numbers': {
				// Text lists drop only the empty string (a whitespace-only value is a value);
				// numbers are read trimmed, so a blank one is no entry.
				const items = (draft.lists[name] ?? []).filter((item) =>
					kind === 'numbers' ? item.trim() !== '' : item !== ''
				);
				if (kind === 'numbers') {
					const numbers = items.map(numberOf);
					if (numbers.some((value) => value === null)) problems[name] = 'pol.cond.number';
					else params[name] = numbers;
				} else params[name] = items;
				if (!problems[name] && items.length === 0 && param.required)
					problems[name] = 'pol.cond.required';
				break;
			}
			case 'group': {
				const value = draft.groups[name]?.[0]?.value;
				if (value) params[name] = value;
				else if (param.required) problems[name] = 'pol.cond.required';
				break;
			}
			case 'groups': {
				const ids = (draft.groups[name] ?? []).map((item) => item.value);
				params[name] = ids;
				if (ids.length === 0 && param.required) problems[name] = 'pol.cond.required';
				break;
			}
			default:
				// A parameter the editor cannot draw: conditionDraftOf never makes a fields draft of it.
				problems[name] = 'pol.cond.json';
		}
	}
	return Object.keys(problems).length > 0
		? { condition: null, problems }
		: { condition: { type: info.type, params }, problems };
}

function jsonResult(text: string): ConditionResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { condition: null, problems: { '': 'pol.cond.json' } };
	}
	const row = value as { type?: unknown; params?: unknown } | null;
	if (
		!row ||
		typeof row !== 'object' ||
		Array.isArray(row) ||
		typeof row.type !== 'string' ||
		!row.type ||
		!row.params ||
		typeof row.params !== 'object' ||
		Array.isArray(row.params)
	)
		return { condition: null, problems: { '': 'pol.cond.jsonShape' } };
	return {
		condition: { type: row.type, params: row.params as Record<string, unknown> },
		problems: {}
	};
}

export type PolicyNameProblem = 'pol.edit.nameRequired' | 'pol.edit.nameLength';

export function policyNameProblem(name: string): PolicyNameProblem | undefined {
	const value = name.trim();
	if (!value) return 'pol.edit.nameRequired';
	if (value.length > 255) return 'pol.edit.nameLength';
	return undefined;
}

export const priorityProblem = (priority: number | null): 'pol.edit.priorityInvalid' | undefined =>
	priority !== null && Number.isSafeInteger(priority) ? undefined : 'pol.edit.priorityInvalid';

export interface PolicyProblems {
	name?: PolicyNameProblem;
	priority?: 'pol.edit.priorityInvalid';
	/** Problems of each condition, by the draft's `key`. */
	conditions: Record<number, Record<string, ConditionProblem>>;
}

export interface PolicyResult {
	input: PolicyInput | null;
	problems: PolicyProblems;
}

/**
 * The draft as the input to send, or its problems (shown once the admin tries to save). What the
 * admin did not edit is kept as loaded (`saved`): a stored value is never tidied up on the way
 * (a blank entry in a list, the spaces around a condition's value), since the engine reads it
 * as it is.
 */
export function policyResult(
	draft: PolicyDraft,
	types: readonly ConditionTypeInfo[],
	saved: PolicyInput | null = null
): PolicyResult {
	const problems: PolicyProblems = { conditions: {} };
	const name = policyNameProblem(draft.name);
	if (name) problems.name = name;
	const priority = priorityProblem(draft.priority);
	if (priority) problems.priority = priority;
	const conditions: PolicyCondition[] = [];
	for (const entry of draft.conditions) {
		const result = conditionResult(
			entry,
			types.find((info) => info.type === entry.type)
		);
		if (!result.condition) problems.conditions[entry.key] = result.problems;
		else if (
			entry.mode === 'fields' &&
			entry.original &&
			entry.fingerprint === JSON.stringify(result.condition)
		)
			conditions.push(entry.original);
		else conditions.push(result.condition);
	}
	if (problems.name || problems.priority || Object.keys(problems.conditions).length > 0)
		return { input: null, problems };
	const text = (value: string, kept: string | undefined) =>
		kept !== undefined && value.trim() === kept.trim() ? kept : value.trim();
	const list = (values: readonly string[], kept: readonly string[] | undefined) =>
		kept === undefined ? cleaned(values) : editedList(values, kept);
	return {
		input: {
			name: text(draft.name, saved?.name),
			description: text(draft.description, saved?.description),
			priority: draft.priority as number,
			effect: draft.effect,
			resource_types: list(draft.resource_types, saved?.resource_types),
			actions: list(draft.actions, saved?.actions),
			conditions,
			enabled: draft.enabled
		},
		problems
	};
}

/**
 * A list after the admin edited it, against the list as loaded: an element still there stays
 * exactly as it was (spaces, even an empty string included), and only what was added is tidied
 * (trimmed, no blank, no repeat of one already added). Removing an element removes only it.
 */
function editedList(values: readonly string[], loaded: readonly string[]): string[] {
	const pool = [...loaded];
	const out: string[] = [];
	for (const value of values) {
		const at = pool.indexOf(value);
		if (at >= 0) {
			pool.splice(at, 1);
			out.push(value);
			continue;
		}
		const added = value.trim();
		if (added && !out.includes(added)) out.push(added);
	}
	return out;
}

const cleaned = (values: readonly string[]): string[] => [
	...new Set(values.map((value) => value.trim()).filter(Boolean))
];

/** What changed between the saved rule and the input, to send only that. */
export function policyChanges(saved: PolicyInput, next: PolicyInput): Partial<PolicyInput> {
	const changes: Partial<PolicyInput> = {};
	if (next.name !== saved.name) changes.name = next.name;
	if (next.description !== saved.description) changes.description = next.description;
	if (next.priority !== saved.priority) changes.priority = next.priority;
	if (next.effect !== saved.effect) changes.effect = next.effect;
	if (next.enabled !== saved.enabled) changes.enabled = next.enabled;
	if (JSON.stringify(next.resource_types) !== JSON.stringify(saved.resource_types))
		changes.resource_types = next.resource_types;
	if (JSON.stringify(next.actions) !== JSON.stringify(saved.actions))
		changes.actions = next.actions;
	if (JSON.stringify(next.conditions) !== JSON.stringify(saved.conditions))
		changes.conditions = next.conditions;
	return changes;
}

/** The rule as the input it was saved from (to tell what the admin changed). */
export const inputOf = (rule: PolicyRule): PolicyInput => ({
	name: rule.name,
	description: rule.description ?? '',
	priority: rule.priority,
	effect: rule.effect,
	resource_types: rule.resource_types,
	actions: rule.actions,
	conditions: rule.conditions,
	enabled: rule.enabled
});

/** A draft of a rule, its conditions drawn by the types the API lists. */
export function draftOf(
	rule: PolicyRule,
	types: readonly ConditionTypeInfo[],
	label?: (groupId: string) => string
): PolicyDraft {
	return {
		name: rule.name,
		description: rule.description ?? '',
		priority: rule.priority,
		effect: rule.effect,
		resource_types: [...rule.resource_types],
		actions: [...rule.actions],
		enabled: rule.enabled,
		conditions: rule.conditions.map((condition, index) =>
			conditionDraftOf(
				index + 1,
				condition,
				types.find((info) => info.type === condition.type),
				label
			)
		)
	};
}

/** The ids of the groups a rule's conditions name, for showing their names. */
export function groupIdsOf(rule: PolicyRule, types: readonly ConditionTypeInfo[]): string[] {
	const ids = new Set<string>();
	for (const condition of rule.conditions) {
		const info = types.find((entry) => entry.type === condition.type);
		for (const param of info?.params ?? []) {
			const kind = paramKind(param);
			const value = condition.params[param.name];
			if (kind === 'group' && typeof value === 'string' && value) ids.add(value);
			if (kind === 'groups' && Array.isArray(value))
				for (const id of value) if (typeof id === 'string' && id) ids.add(id);
		}
	}
	return [...ids];
}

/** The conditions as one line for a list ("2 conditions"), by count. */
export const conditionCount = (rule: Pick<PolicyRule, 'conditions'>) => rule.conditions.length;

// ---------------------------------------------------------------------------------------------
// The simulation form

export interface SimulationForm {
	resource_type: string;
	resource_id: string;
	/** Who owns the resource (`is_resource_owner`). */
	owner_id: string;
	action: string;
	/** A date and time the admin typed (empty: now). */
	timestamp: string;
}

export const EMPTY_SIMULATION: SimulationForm = {
	resource_type: '',
	resource_id: '',
	owner_id: '',
	action: '',
	timestamp: ''
};

/** The date and time typed (`2026-11-28T09:30`, local time unless it says an offset), or null. */
export function timestampOf(text: string): number | null {
	const value = text.trim();
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export interface SimulationProblems {
	subject?: MessageKey;
	resourceType?: MessageKey;
	action?: MessageKey;
	timestamp?: MessageKey;
}

export function simulationProblems(form: SimulationForm, subjectId: string): SimulationProblems {
	const problems: SimulationProblems = {};
	if (!subjectId.trim()) problems.subject = 'pol.sim.subjectRequired';
	if (!form.resource_type.trim()) problems.resourceType = 'pol.sim.resourceTypeRequired';
	if (!form.action.trim()) problems.action = 'pol.sim.actionRequired';
	if (form.timestamp.trim() && timestampOf(form.timestamp) === null)
		problems.timestamp = 'pol.sim.timestampInvalid';
	return problems;
}

export function simulationInput(
	form: SimulationForm,
	subjectId: string,
	groupIds: string[] | null,
	roleNames: string[],
	resourceGroupIds: string[],
	attributes: { key: string; value: string }[] = []
): PolicySimulationInput {
	const names = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];
	return {
		subject_id: subjectId.trim(),
		group_ids: groupIds === null ? null : names(groupIds),
		role_names: names(roleNames),
		resource_type: form.resource_type.trim(),
		resource_id: form.resource_id.trim(),
		owner_id: form.owner_id.trim(),
		attributes: attributes
			.filter((row) => row.key.trim())
			.map((row) => ({ name: row.key.trim(), value: row.value })),
		resource_group_ids: names(resourceGroupIds),
		action: form.action.trim(),
		timestamp: timestampOf(form.timestamp)
	};
}
