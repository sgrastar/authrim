/**
 * What the Relationships pages (Access → Relationships) work with, apart from drawing it:
 * relation expressions as an editable tree (and back, and when the tree cannot draw one), the
 * definition, tuple and check forms with what is wrong with them, and what to tell the admin when
 * the API refuses a change.
 *
 * Expression grammar (ar-lib-core `rebac/types.ts`): `direct` (a relation on the same object),
 * `union` / `intersection` (any / all of the children), `exclusion` (base but not subtract) and
 * `tuple_to_userset` (follow the `tupleset` relation to another object and ask the
 * `computed_userset` relation there). An expression the tree cannot draw (an unknown type, extra
 * keys) is kept as JSON and sent as it is.
 */
import { ApiError } from '#lib/api/api-error.js';
import type {
	DefinitionChanges,
	DefinitionInput,
	RebacCheckInput,
	RebacTuple,
	RelationDefinition,
	TupleInput
} from '#lib/api/end-user-rebac.js';
import { hasMessage, type MessageKey } from '#lib/i18n/i18n.svelte.js';
import { apiCode, authzRefusal, type AuthzRefusal } from './authz-errors';

/** The areas of the Relationships page. */
export type RelationshipsTab = 'tuples' | 'definitions' | 'check';
export const RELATIONSHIP_TABS: readonly RelationshipsTab[] = ['tuples', 'definitions', 'check'];

// ---------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------

export const EXPRESSION_KINDS = [
	'direct',
	'union',
	'intersection',
	'exclusion',
	'tuple_to_userset'
] as const;
export type ExpressionKind = (typeof EXPRESSION_KINDS)[number];

/** How deep the tree is drawn (deeper expressions stay JSON). */
export const MAX_EXPRESSION_DEPTH = 8;

export interface ExprDraft {
	/** Identity of the node while it is edited. */
	key: number;
	kind: ExpressionKind;
	/** `direct`: the relation. */
	relation: string;
	/** `tuple_to_userset`: the relation that leads to the other object… */
	tupleset: string;
	/** …and the relation asked there. */
	computed: string;
	/** `union`, `intersection`. */
	children: ExprDraft[];
	/** `exclusion`. */
	base: ExprDraft | null;
	subtract: ExprDraft | null;
}

let serial = 0;
export function newExpr(kind: ExpressionKind = 'direct'): ExprDraft {
	serial += 1;
	const node: ExprDraft = {
		key: serial,
		kind,
		relation: '',
		tupleset: '',
		computed: '',
		children: [],
		base: null,
		subtract: null
	};
	if (kind === 'union' || kind === 'intersection') node.children = [newExpr(), newExpr()];
	if (kind === 'exclusion') {
		node.base = newExpr();
		node.subtract = newExpr();
	}
	return node;
}

/** The same node as another kind: what the kinds share is kept, the rest starts empty. */
export function withKind(node: ExprDraft, kind: ExpressionKind): ExprDraft {
	if (node.kind === kind) return node;
	const next = newExpr(kind);
	next.key = node.key;
	next.relation = node.relation;
	next.tupleset = node.tupleset;
	next.computed = node.computed;
	const kept = node.children.length > 0 ? node.children : [];
	if ((kind === 'union' || kind === 'intersection') && kept.length > 0) next.children = kept;
	if (kind === 'exclusion' && node.children.length >= 2) {
		next.base = node.children[0];
		next.subtract = node.children[1];
	}
	return next;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (row: Row, keys: string[]) => {
	const present = Object.keys(row);
	return present.length === keys.length && keys.every((key) => key in row);
};

/** The tree for a stored expression; null when it has a shape the tree cannot draw. */
export function exprToDraft(value: unknown, depth = 0): ExprDraft | null {
	if (!isRow(value) || depth > MAX_EXPRESSION_DEPTH) return null;
	switch (value.type) {
		case 'direct': {
			if (!sameKeys(value, ['type', 'relation']) || typeof value.relation !== 'string') return null;
			const node = newExpr('direct');
			node.relation = value.relation;
			return node;
		}
		case 'union':
		case 'intersection': {
			if (!sameKeys(value, ['type', 'children']) || !Array.isArray(value.children)) return null;
			const children = value.children.map((child) => exprToDraft(child, depth + 1));
			if (children.some((child) => child === null)) return null;
			const node = newExpr(value.type);
			node.children = children as ExprDraft[];
			return node;
		}
		case 'exclusion': {
			if (!sameKeys(value, ['type', 'base', 'subtract'])) return null;
			const base = exprToDraft(value.base, depth + 1);
			const subtract = exprToDraft(value.subtract, depth + 1);
			if (!base || !subtract) return null;
			const node = newExpr('exclusion');
			node.base = base;
			node.subtract = subtract;
			return node;
		}
		case 'tuple_to_userset': {
			if (!sameKeys(value, ['type', 'tupleset', 'computed_userset'])) return null;
			const { tupleset, computed_userset: computed } = value;
			if (
				!isRow(tupleset) ||
				!sameKeys(tupleset, ['relation']) ||
				typeof tupleset.relation !== 'string' ||
				!isRow(computed) ||
				!sameKeys(computed, ['relation']) ||
				typeof computed.relation !== 'string'
			)
				return null;
			const node = newExpr('tuple_to_userset');
			node.tupleset = tupleset.relation;
			node.computed = computed.relation;
			return node;
		}
		default:
			return null;
	}
}

/** The expression the API stores for a tree (names trimmed). */
export function draftToExpression(node: ExprDraft): unknown {
	switch (node.kind) {
		case 'direct':
			return { type: 'direct', relation: node.relation.trim() };
		case 'union':
		case 'intersection':
			return { type: node.kind, children: node.children.map(draftToExpression) };
		case 'exclusion':
			return {
				type: 'exclusion',
				base: node.base ? draftToExpression(node.base) : null,
				subtract: node.subtract ? draftToExpression(node.subtract) : null
			};
		case 'tuple_to_userset':
			return {
				type: 'tuple_to_userset',
				tupleset: { relation: node.tupleset.trim() },
				computed_userset: { relation: node.computed.trim() }
			};
	}
}

/** What is wrong with each node of a tree, by the node's key. */
export type ExprProblems = Record<number, MessageKey>;

const NAME = /^[^\s]+$/;
const nameProblem = (name: string): MessageKey | undefined =>
	name.trim() === ''
		? 'rb.expr.nameRequired'
		: NAME.test(name.trim())
			? undefined
			: 'rb.expr.nameInvalid';

export function expressionProblems(node: ExprDraft, found: ExprProblems = {}): ExprProblems {
	switch (node.kind) {
		case 'direct': {
			const problem = nameProblem(node.relation);
			if (problem) found[node.key] = problem;
			break;
		}
		case 'union':
		case 'intersection':
			if (node.children.length === 0) found[node.key] = 'rb.expr.childrenRequired';
			for (const child of node.children) expressionProblems(child, found);
			break;
		case 'exclusion':
			if (node.base) expressionProblems(node.base, found);
			if (node.subtract) expressionProblems(node.subtract, found);
			break;
		case 'tuple_to_userset': {
			const problem = nameProblem(node.tupleset) ?? nameProblem(node.computed);
			if (problem) found[node.key] = problem;
			break;
		}
	}
	return found;
}

export interface ExpressionWords {
	or: string;
	and: string;
	butNot: string;
}

/** An expression as one line: `owner or editor or parent → viewer`. Anything else: its type. */
export function describeExpression(value: unknown, words: ExpressionWords, nested = false): string {
	if (!isRow(value)) return '?';
	const wrap = (line: string) => (nested ? `(${line})` : line);
	switch (value.type) {
		case 'direct':
			return typeof value.relation === 'string' ? value.relation : '?';
		case 'union':
		case 'intersection': {
			const children = Array.isArray(value.children) ? value.children : [];
			const word = value.type === 'union' ? words.or : words.and;
			if (children.length === 0) return '?';
			if (children.length === 1) return describeExpression(children[0], words, nested);
			return wrap(
				children.map((child) => describeExpression(child, words, true)).join(` ${word} `)
			);
		}
		case 'exclusion':
			return wrap(
				`${describeExpression(value.base, words, true)} ${words.butNot} ${describeExpression(value.subtract, words, true)}`
			);
		case 'tuple_to_userset': {
			const tupleset = isRow(value.tupleset) ? String(value.tupleset.relation ?? '?') : '?';
			const computed = isRow(value.computed_userset)
				? String(value.computed_userset.relation ?? '?')
				: '?';
			return `${tupleset} → ${computed}`;
		}
		default:
			return typeof value.type === 'string' ? value.type : '?';
	}
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

export const DEFAULT_DEFINITION_PRIORITY = 0;

export interface DefinitionDraft {
	object_type: string;
	relation_name: string;
	description: string;
	priority: number | null;
	active: boolean;
	/** The expression is edited as JSON (always, when the tree cannot draw it). */
	jsonMode: boolean;
	json: string;
	expression: ExprDraft;
}

export function emptyDefinitionDraft(objectType = ''): DefinitionDraft {
	return {
		object_type: objectType,
		relation_name: '',
		description: '',
		priority: DEFAULT_DEFINITION_PRIORITY,
		active: true,
		jsonMode: false,
		json: '',
		expression: newExpr()
	};
}

export const prettyJson = (value: unknown): string => JSON.stringify(value ?? {}, null, 2);

export function definitionDraftOf(definition: RelationDefinition): DefinitionDraft {
	const drawn = exprToDraft(definition.expression);
	return {
		object_type: definition.object_type,
		relation_name: definition.relation_name,
		description: definition.description ?? '',
		priority: definition.priority,
		active: definition.active,
		jsonMode: drawn === null,
		json: prettyJson(definition.expression),
		expression: drawn ?? newExpr()
	};
}

export function definitionInputOf(definition: RelationDefinition): DefinitionInput {
	return {
		object_type: definition.object_type,
		relation_name: definition.relation_name,
		expression: definition.expression,
		description: definition.description ?? '',
		priority: definition.priority,
		active: definition.active
	};
}

/** Switch to the JSON text of what the tree holds. */
export function toJsonMode(draft: DefinitionDraft) {
	draft.json = prettyJson(draftToExpression(draft.expression));
	draft.jsonMode = true;
}

/** Back to the tree, when the JSON is one it can draw; false (nothing changes) when not. */
export function toTreeMode(draft: DefinitionDraft): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(draft.json);
	} catch {
		return false;
	}
	const drawn = exprToDraft(parsed);
	if (!drawn) return false;
	draft.expression = drawn;
	draft.jsonMode = false;
	return true;
}

/** Whether the JSON text is one the tree can draw (to offer the way back). */
export function jsonIsDrawable(json: string): boolean {
	try {
		return exprToDraft(JSON.parse(json)) !== null;
	} catch {
		return false;
	}
}

export interface DefinitionProblems {
	object_type?: MessageKey;
	relation_name?: MessageKey;
	priority?: MessageKey;
	json?: MessageKey;
	expression: ExprProblems;
}

const TYPE_NAME = /^[A-Za-z0-9_.-]+$/;

export function definitionResult(
	draft: DefinitionDraft,
	creating: boolean
): { input: DefinitionInput | null; problems: DefinitionProblems } {
	const problems: DefinitionProblems = { expression: {} };
	if (creating) {
		const objectType = draft.object_type.trim();
		if (!objectType) problems.object_type = 'rb.def.objectTypeRequired';
		else if (!TYPE_NAME.test(objectType)) problems.object_type = 'rb.def.objectTypeInvalid';
		const relation = nameProblem(draft.relation_name);
		if (relation) problems.relation_name = 'rb.def.relationRequired';
	}
	if (draft.priority === null || !Number.isSafeInteger(draft.priority))
		problems.priority = 'rb.def.priorityInvalid';
	let expression: unknown = null;
	if (draft.jsonMode) {
		try {
			expression = JSON.parse(draft.json);
			if (!isRow(expression) || typeof expression.type !== 'string')
				problems.json = 'rb.def.jsonShape';
		} catch {
			// The JSON field itself says where it is wrong; this is only that it cannot be saved.
			problems.json = 'rb.def.jsonInvalid';
		}
	} else {
		problems.expression = expressionProblems(draft.expression);
		expression = draftToExpression(draft.expression);
	}
	if (
		problems.object_type ||
		problems.relation_name ||
		problems.priority ||
		problems.json ||
		Object.keys(problems.expression).length > 0
	)
		return { input: null, problems };
	return {
		input: {
			object_type: draft.object_type.trim(),
			relation_name: draft.relation_name.trim(),
			expression,
			description: draft.description.trim(),
			priority: draft.priority as number,
			active: draft.active
		},
		problems
	};
}

/** What differs from the saved definition (the object type and the name never change). */
export function definitionChanges(
	saved: DefinitionInput,
	next: DefinitionInput
): DefinitionChanges {
	const changes: DefinitionChanges = {};
	if (JSON.stringify(next.expression) !== JSON.stringify(saved.expression))
		changes.expression = next.expression;
	if (next.description !== saved.description) changes.description = next.description;
	if (next.priority !== saved.priority) changes.priority = next.priority;
	if (next.active !== saved.active) changes.active = next.active;
	return changes;
}

/** The relation names the definitions of one object type declare (for the pickers). */
export const relationNamesOf = (
	definitions: readonly RelationDefinition[],
	objectType: string
): string[] =>
	[
		...new Set(
			definitions.filter((entry) => entry.object_type === objectType).map((e) => e.relation_name)
		)
	].sort();

// ---------------------------------------------------------------------------------------------
// Tuples
// ---------------------------------------------------------------------------------------------

export type SubjectKind = 'user' | 'group' | 'object';
export const SUBJECT_KINDS: readonly SubjectKind[] = ['user', 'group', 'object'];

export interface TupleForm {
	kind: SubjectKind;
	/** The user or the group picked (its id). */
	subject_id: string;
	/** An object edge: the source object's type and id. */
	object_type: string;
	object_id: string;
	relation: string;
	to_type: string;
	to_id: string;
}

export const EMPTY_TUPLE_FORM: TupleForm = {
	kind: 'user',
	subject_id: '',
	object_type: '',
	object_id: '',
	relation: '',
	to_type: '',
	to_id: ''
};

export type TupleProblems = Partial<Record<keyof TupleForm, MessageKey>>;

export function tupleProblems(form: TupleForm): TupleProblems {
	const problems: TupleProblems = {};
	if (form.kind === 'user' && !form.subject_id.trim())
		problems.subject_id = 'rb.tuple.userRequired';
	if (form.kind === 'group' && !form.subject_id.trim())
		problems.subject_id = 'rb.tuple.groupRequired';
	if (form.kind === 'object') {
		const type = form.object_type.trim();
		if (!type) problems.object_type = 'rb.tuple.sourceTypeRequired';
		else if (!TYPE_NAME.test(type)) problems.object_type = 'rb.def.objectTypeInvalid';
		if (!form.object_id.trim()) problems.object_id = 'rb.tuple.sourceIdRequired';
	}
	if (nameProblem(form.relation)) problems.relation = 'rb.tuple.relationRequired';
	const toType = form.to_type.trim();
	if (!toType) problems.to_type = 'rb.tuple.typeRequired';
	else if (!TYPE_NAME.test(toType)) problems.to_type = 'rb.def.objectTypeInvalid';
	if (!form.to_id.trim()) problems.to_id = 'rb.tuple.idRequired';
	return problems;
}

/** The request for a valid form: a user is a direct subject, a group means its members. */
export function tupleInputOf(form: TupleForm, expiresAt: number | null): TupleInput {
	const common = {
		relation: form.relation.trim(),
		to_type: form.to_type.trim(),
		to_id: form.to_id.trim(),
		expires_at: expiresAt
	};
	if (form.kind === 'user')
		return { ...common, from_type: 'subject', from_id: form.subject_id.trim() };
	if (form.kind === 'group')
		return {
			...common,
			from_type: 'group',
			from_id: form.subject_id.trim(),
			from_relation: 'member'
		};
	return { ...common, from_type: form.object_type.trim(), from_id: form.object_id.trim() };
}

export interface TupleSubject {
	kind: 'user' | 'groupMembers' | 'group' | 'object';
	/** The id (a user, a group) or `type:id` (an object). */
	label: string;
}

/** Who a stored tuple names as its subject. */
export function subjectOf(
	tuple: Pick<RebacTuple, 'from_type' | 'from_id' | 'from_relation'>
): TupleSubject {
	if (tuple.from_type === 'subject' || tuple.from_type === 'user')
		return { kind: 'user', label: tuple.from_id };
	if (tuple.from_type === 'group')
		return {
			kind: tuple.from_relation === 'member' ? 'groupMembers' : 'group',
			label: tuple.from_id
		};
	return { kind: 'object', label: `${tuple.from_type}:${tuple.from_id}` };
}

// ---------------------------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------------------------

export interface CheckForm {
	user_id: string;
	relation: string;
	object_type: string;
	object_id: string;
}

export const EMPTY_CHECK_FORM: CheckForm = {
	user_id: '',
	relation: '',
	object_type: '',
	object_id: ''
};

export type CheckProblems = Partial<Record<keyof CheckForm, MessageKey>>;

export function checkProblems(form: CheckForm): CheckProblems {
	const problems: CheckProblems = {};
	if (!form.user_id.trim()) problems.user_id = 'rb.check.userRequired';
	if (nameProblem(form.relation)) problems.relation = 'rb.tuple.relationRequired';
	if (!form.object_type.trim()) problems.object_type = 'rb.tuple.typeRequired';
	if (!form.object_id.trim()) problems.object_id = 'rb.tuple.idRequired';
	return problems;
}

export const checkInputOf = (form: CheckForm): RebacCheckInput => ({
	user_id: form.user_id.trim(),
	relation: form.relation.trim(),
	object_type: form.object_type.trim(),
	object_id: form.object_id.trim()
});

/** The sentence for a way the engine resolved a check, when it is one known here. */
export function resolvedViaKey(via: string | null): MessageKey | null {
	if (!via) return null;
	const key = `rb.via.${via}`;
	return hasMessage(key) ? (key as MessageKey) : null;
}

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

export type RebacContext = 'tuple' | 'definition' | 'check';

/** The API's code for a tuple kind it does not take (`error_code` of the error body). */
const TUPLE_TYPE_REFUSED_CODE = 'AR050010';
/** Fallback for an answer without the code field: its wording. */
const TUPLE_TYPE_REFUSED_TEXT = /tuple type (is )?not allowed|rebac-tuple-type-not-allowed/i;

/** What to tell the admin when the API refuses a change on the Relationships pages. */
export function rebacRefusal(error: unknown, context: RebacContext): AuthzRefusal {
	if (error instanceof ApiError) {
		const errorCode = error.body.error_code ?? error.body.code;
		const described = `${error.message} ${String(error.body.error_description ?? '')}`;
		if (
			errorCode === TUPLE_TYPE_REFUSED_CODE ||
			(typeof errorCode !== 'string' && TUPLE_TYPE_REFUSED_TEXT.test(described))
		)
			return { key: 'rb.error.tupleTypeNotAllowed' };
		if (apiCode(error) === 'capability_disabled') return authzRefusal(error);
		if (error.status === 409 && context === 'tuple') return { key: 'rb.error.tupleExists' };
		if (error.status === 409 && context === 'definition')
			return { key: 'rb.error.definitionExists' };
		if (error.status === 403) return { key: 'rb.error.forbidden' };
		if (error.status === 400 && context === 'definition')
			return {
				key: 'rb.error.definitionInvalid',
				detail:
					(typeof error.body.error_description === 'string' && error.body.error_description) ||
					error.message
			};
	}
	return authzRefusal(error);
}

export function rebacRefusalText(
	error: unknown,
	context: RebacContext,
	translate: (key: MessageKey) => string
): string {
	const refusal = rebacRefusal(error, context);
	return refusal.detail ? `${translate(refusal.key)} (${refusal.detail})` : translate(refusal.key);
}
