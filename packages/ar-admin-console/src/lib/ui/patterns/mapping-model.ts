/**
 * Attribute mappings: each attribute on the receiving side is filled from one or more
 * attributes of the sending side through transforms applied in order. Inbound (an IdP's
 * claims → Authrim's attributes) and outbound (Authrim's attributes → a destination) use the
 * same shape. Transform ids follow the legacy editor's operations (TransformOperation).
 *
 * Order: until a combining step ("Combine attributes", "First attribute with a value"),
 * a step applies to each source attribute on its own; the combining step makes one value of
 * them; later steps apply to that value. So "lower case → combine" lowers each part, and
 * "combine → lower case" lowers the result.
 *
 * Operations, parameter names and defaults follow the runtime engine
 * (@authrim/ar-lib-field-mapping, core/transforms.ts), which evaluates what is saved here.
 *
 * TODO(api): read and write through the field-mapping versions API. The runtime runs
 * `transforms: MappingTransformStep[]`, each step reading `inputEdgeIds` (source values or
 * earlier steps' outputs). Compile these steps into that graph: a step before the combining
 * step becomes one runtime step per source edge; the combining step reads all of their
 * outputs; later steps chain on its output. Positions on a canvas are not needed any more.
 * The sample output is computed by the engine itself (mapping-preview.ts), so the console
 * never shows a result the runtime would not produce.
 * TODO(runtime): the "Generate a value" steps (constant_text / _boolean / _number) have no
 * runtime operation yet. Add one `constant` operation to TRANSFORM_OPERATION_SCHEMAS —
 * parameters `value` and `valueType` (string | boolean | number), no input edges — and
 * compile these three to it. A mapping made only of such a step has no source edge.
 * TODO(runtime): these steps have no runtime operation yet either: keep_part, remove_text,
 * replace_text, regex_replace, to_halfwidth, to_fullwidth, strip_accents, ascii_digits,
 * value_map, text_to_number, date_format (with its time zone), filter_values, json_extract_array,
 * array_build, conditional, has_value, normalize_empty, json_extract_or, default_if_empty
 * and hash. The console computes all but hash for the sample
 * (mapping-preview.ts, localStep / localCombine), which is the behaviour to implement:
 * strings only (each item of a list), anything else passes through.
 * - hash is HMAC-SHA-256 with a per-tenant key (add it to scripts/setup-keys.sh), hex or
 *   base64url.
 * - Tables (value_map) are saved as JSON text: [["from", "to"], …].
 * - conditional saves its condition as the console's ConditionGroup (JSON text); the
 *   attributes it reads become extra input edges of the step, besides the value it changes.
 * - Regular expressions run on the server, so bound them there: at most REGEX_MAX
 *   characters, a length limit on the input, and preferably a linear-time engine (RE2-like)
 *   so no pattern can hang a worker.
 * TODO(api): boolean settings (trimItems, omitEmpty, unique) are saved as booleans, as the
 * runtime expects; the key map of "Build JSON" is JSON text ({"mail": "email"}).
 */

/** Attribute types as the catalogs name them; "[]" marks multi-valued. */
export type MappingType = 'string' | 'string[]' | 'number' | 'boolean' | 'date' | 'object';

import type { ConditionGroup } from './condition-model';

export interface MappingField {
	key: string;
	label?: string;
	type: MappingType;
	/** Receiving side: must be filled. */
	required?: boolean;
	/** Sending side: a sample value (a recent sign-in, a test user), for the sample output. */
	example?: string | readonly string[];
}

/**
 * Every operation of the runtime but "copy" (no step at all copies the value as it is).
 * Grouped as the legacy editor groups them, with "Combine attributes" and "First attribute
 * with a value" together under combining.
 */
export type TransformId =
	| 'trim'
	| 'normalize'
	| 'case'
	| 'affix_text'
	| 'keep_part'
	| 'remove_text'
	| 'replace_text'
	| 'regex_replace'
	| 'to_halfwidth'
	| 'to_fullwidth'
	| 'strip_accents'
	| 'ascii_digits'
	| 'text_to_boolean'
	| 'value_map'
	| 'text_to_number'
	| 'date_format'
	| 'filter_values'
	| 'hash'
	| 'default_if_empty'
	| 'as_array'
	| 'split'
	| 'join'
	| 'first'
	| 'concat'
	| 'fallback'
	| 'oidc_pairwise_sub'
	| 'saml_edu_person_targeted_id'
	| 'json_build'
	| 'json_extract_text'
	| 'json_extract_boolean'
	| 'json_extract_integer'
	| 'json_extract_array'
	| 'conditional'
	| 'has_value'
	| 'normalize_empty'
	| 'json_extract_or'
	| 'array_build'
	| 'constant_text'
	| 'constant_boolean'
	| 'constant_number';

/** Eight groups of at most seven, in the order they are usually wanted. */
export type TransformCategory =
	| 'clean'
	| 'edit'
	| 'convert'
	| 'multi'
	| 'combine'
	| 'generate'
	| 'identifier'
	| 'json'
	| 'plugin';

export const TRANSFORM_CATEGORIES: readonly TransformCategory[] = [
	'clean',
	'edit',
	'convert',
	'multi',
	'combine',
	'generate',
	'identifier',
	'json',
	'plugin'
];

/**
 * Steps from plugins: the tenant's own processing (a script, a call to its own service).
 * Only the place for them so far — the group is listed, empty.
 * TODO(api): list the tenant's installed plugin steps (id, name, description, settings as a
 * parameter schema like TransformParam) and add them to the picker under this group; a
 * mapping saves such a step as `plugin:<id>` with its settings.
 * TODO(runtime): run plugin steps in a sandbox with a time and memory budget, the value in
 * and out as JSON; a failing plugin gives no value and a reason in the trace, never an
 * error for the whole sign-in.
 */
export const PLUGIN_CATEGORY: TransformCategory = 'plugin';

/** Another setting's value that makes a setting apply ("fixed" chosen for "otherwise"). */
export interface ParamWhen {
	key: string;
	is: string | readonly string[];
}

export interface TransformParam {
	key: string;
	/** A choice (mode: lower / upper / title) or free text (a delimiter, a prefix). */
	options?: readonly string[];
	/** On or off (trim each value); stored as a boolean. */
	flag?: boolean;
	required?: boolean;
	/** Free text holding a comma-separated list of values. */
	list?: boolean;
	/** Monospace free text (a JSON path, a key map). */
	code?: boolean;
	/** Filled in when the step is added (the runtime's own default; "true" for a flag). */
	initial?: string;
	/** A table of pairs (from → to), saved as JSON text. */
	pairs?: boolean;
	/** Shown, and needed, only while another setting has this value. */
	when?: ParamWhen | readonly ParamWhen[];
	/** A condition over the source attributes (ConditionBuilder), saved as JSON text. */
	condition?: boolean;
	/** An IANA time zone ("Asia/Tokyo"), chosen from the browser's list. */
	zone?: boolean;
}

export interface TransformDef {
	id: TransformId;
	category: TransformCategory;
	/** Makes one value of several source attributes. */
	combines?: boolean;
	/** Fewest source attributes a combining step works with (default 2). */
	minSources?: number;
	/** Makes its value itself (a fixed value): needs no source, and ignores what comes in. */
	generates?: boolean;
	params: readonly TransformParam[];
}

/** The list settings the runtime offers on steps that handle several values. */
const LIST_FLAGS: readonly TransformParam[] = [
	{ key: 'trimItems', flag: true },
	{ key: 'omitEmpty', flag: true },
	{ key: 'unique', flag: true }
];

export const TRANSFORMS: readonly TransformDef[] = [
	{ id: 'trim', category: 'clean', params: [] },
	{
		id: 'normalize',
		category: 'clean',
		params: [{ key: 'mode', options: ['whitespace', 'unicode'], required: true }]
	},
	{
		id: 'case',
		category: 'clean',
		params: [{ key: 'mode', options: ['lower', 'upper', 'title'], required: true }]
	},
	{ id: 'affix_text', category: 'edit', params: [{ key: 'prefix' }, { key: 'suffix' }] },
	{
		// The part before or after a character: "taro" or "example.com" of taro@example.com.
		id: 'keep_part',
		category: 'edit',
		params: [
			{ key: 'delimiter', required: true, initial: '@' },
			{ key: 'keep', options: ['before', 'after'], required: true },
			{ key: 'occurrence', options: ['first', 'last'], required: true }
		]
	},
	{ id: 'remove_text', category: 'edit', params: [{ key: 'text', required: true }] },
	{
		id: 'regex_replace',
		category: 'edit',
		params: [
			{ key: 'pattern', required: true, code: true },
			{ key: 'replacement', code: true },
			{ key: 'ignoreCase', flag: true }
		]
	},
	{
		id: 'replace_text',
		category: 'edit',
		params: [
			{ key: 'find', required: true },
			{ key: 'replacement' },
			{ key: 'ignoreCase', flag: true }
		]
	},
	// Japanese systems: letters, digits, symbols and the space always; katakana if asked.
	{ id: 'to_halfwidth', category: 'clean', params: [{ key: 'katakana', flag: true }] },
	{
		id: 'to_fullwidth',
		category: 'clean',
		params: [{ key: 'katakana', flag: true, initial: 'true' }]
	},
	{
		// No value, "", "   " or a full-width space (U+3000) all become one thing: no value, ""
		// or a text.
		id: 'normalize_empty',
		category: 'clean',
		params: [
			{ key: 'spaces', flag: true, initial: 'true' },
			{ key: 'emptyAs', options: ['none', 'empty', 'fixed'], required: true },
			{ key: 'emptyValue', required: true, when: { key: 'emptyAs', is: 'fixed' } }
		]
	},
	// José → Jose, ٤٢ → 42: for systems that take only ASCII (user names, IDs).
	{ id: 'strip_accents', category: 'clean', params: [] },
	{ id: 'ascii_digits', category: 'clean', params: [] },
	{
		id: 'value_map',
		category: 'convert',
		params: [
			{ key: 'entries', pairs: true, required: true },
			{ key: 'ignoreCase', flag: true },
			{ key: 'otherwise', options: ['as_is', 'none', 'fixed'], required: true },
			{ key: 'fallbackValue', required: true, when: { key: 'otherwise', is: 'fixed' } }
		]
	},
	{
		id: 'text_to_boolean',
		category: 'convert',
		params: [
			{ key: 'trueValues', list: true, initial: 'true, 1, yes, y, on, active, enabled' },
			{ key: 'falseValues', list: true, initial: 'false, 0, no, n, off, inactive, disabled' },
			{ key: 'nullValues', list: true, initial: 'null, none, n/a, unknown' }
		]
	},
	{ id: 'text_to_number', category: 'convert', params: [] },
	{
		id: 'date_format',
		category: 'convert',
		params: [
			{ key: 'from', options: ['auto', 'iso', 'unix_s', 'unix_ms'], required: true },
			{ key: 'to', options: ['iso', 'date', 'unix_s', 'unix_ms'], required: true },
			// Unix time has no zone; ISO 8601 gets the zone's offset (+09:00), a date its day.
			{ key: 'timeZone', zone: true, initial: 'UTC', when: { key: 'to', is: ['iso', 'date'] } }
		]
	},
	{
		// If other attributes meet a condition, this value; otherwise the value as it is,
		// no value, or another value. The condition may use any source attribute.
		id: 'conditional',
		category: 'convert',
		params: [
			{ key: 'condition', condition: true, required: true },
			// Text, true / false or a number: set to suit the receiving attribute when added.
			{ key: 'valueType', options: ['as_text', 'as_boolean', 'as_number'], required: true },
			{
				key: 'thenValue',
				required: true,
				when: { key: 'valueType', is: ['as_text', 'as_number'] }
			},
			{
				key: 'thenBool',
				options: ['true', 'false'],
				required: true,
				when: { key: 'valueType', is: 'as_boolean' }
			},
			{ key: 'elseMode', options: ['as_is', 'none', 'fixed'], required: true },
			{
				key: 'elseValue',
				required: true,
				when: [
					{ key: 'elseMode', is: 'fixed' },
					{ key: 'valueType', is: ['as_text', 'as_number'] }
				]
			},
			{
				key: 'elseBool',
				options: ['true', 'false'],
				initial: 'false',
				required: true,
				when: [
					{ key: 'elseMode', is: 'fixed' },
					{ key: 'valueType', is: 'as_boolean' }
				]
			}
		]
	},
	{
		// true when there is a value (not empty), false when not; or the other way round.
		id: 'has_value',
		category: 'convert',
		params: [{ key: 'invert', flag: true }]
	},
	{ id: 'as_array', category: 'multi', params: LIST_FLAGS },
	{
		id: 'split',
		category: 'multi',
		params: [{ key: 'delimiter', required: true, initial: ',' }, ...LIST_FLAGS]
	},
	{
		id: 'join',
		category: 'multi',
		params: [{ key: 'delimiter', required: true, initial: ',' }, ...LIST_FLAGS]
	},
	{ id: 'first', category: 'multi', params: LIST_FLAGS.slice(0, 2) },
	{
		// Keeps (or leaves out) the values that match: groups starting with "app-".
		id: 'filter_values',
		category: 'multi',
		params: [
			{
				key: 'how',
				options: ['starts_with', 'ends_with', 'contains', 'equals', 'regex'],
				required: true
			},
			{ key: 'match', required: true },
			{ key: 'exclude', flag: true },
			{ key: 'ignoreCase', flag: true }
		]
	},
	{
		id: 'concat',
		category: 'combine',
		combines: true,
		params: [{ key: 'delimiter', initial: ' ' }]
	},
	{ id: 'fallback', category: 'combine', combines: true, params: [] },
	{
		// A main group and extra groups → one list of groups.
		id: 'array_build',
		category: 'combine',
		combines: true,
		params: [
			{ key: 'omitEmpty', flag: true },
			{ key: 'unique', flag: true }
		]
	},
	// TODO(api): choose from the tenant's persistent identifier profiles; empty = the default.
	{
		id: 'oidc_pairwise_sub',
		category: 'identifier',
		params: [{ key: 'persistentIdentifierProfileId', code: true }]
	},
	{
		id: 'saml_edu_person_targeted_id',
		category: 'identifier',
		params: [{ key: 'persistentIdentifierProfileId', code: true }]
	},
	{
		// A pseudonymous ID that cannot be turned back (keyed by the tenant).
		id: 'hash',
		category: 'identifier',
		params: [{ key: 'encoding', options: ['hex', 'base64url'], required: true }]
	},
	{
		id: 'json_build',
		category: 'json',
		combines: true,
		minSources: 1,
		params: [
			{ key: 'keyMap', code: true },
			{ key: 'nullHandling', options: ['omit', 'include_null'], required: true }
		]
	},
	{
		id: 'json_extract_text',
		category: 'json',
		params: [{ key: 'path', required: true, code: true }]
	},
	{
		id: 'json_extract_boolean',
		category: 'json',
		params: [{ key: 'path', required: true, code: true }]
	},
	{
		id: 'json_extract_integer',
		category: 'json',
		params: [{ key: 'path', required: true, code: true }]
	},
	{
		id: 'json_extract_array',
		category: 'json',
		params: [{ key: 'path', required: true, code: true }]
	},
	{
		// A key that may be missing: a sign-in without a profile picture gets a default image.
		id: 'json_extract_or',
		category: 'json',
		params: [
			{ key: 'path', required: true, code: true },
			{ key: 'defaultValue', required: true },
			{ key: 'nullAsMissing', flag: true, initial: 'true' }
		]
	},
	{
		id: 'constant_text',
		category: 'generate',
		generates: true,
		params: [{ key: 'value', required: true }]
	},
	{
		id: 'constant_boolean',
		category: 'generate',
		generates: true,
		params: [{ key: 'value', options: ['true', 'false'], required: true }]
	},
	{
		id: 'constant_number',
		category: 'generate',
		generates: true,
		params: [{ key: 'value', required: true, code: true }]
	},
	// Fills in only what is missing, so it sits with the fixed values but needs a source.
	{ id: 'default_if_empty', category: 'generate', params: [{ key: 'value', required: true }] }
];

/** A table setting ([["from", "to"], …] as JSON text) as its pairs; unreadable: none. */
export function parsePairs(text: unknown): [string, string][] {
	if (typeof text !== 'string' || !text) return [];
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed)
			? parsed
					.filter((pair): pair is unknown[] => Array.isArray(pair))
					.map((pair) => [String(pair[0] ?? ''), String(pair[1] ?? '')])
			: [];
	} catch {
		return [];
	}
}

/** Whether a setting applies now (its `when` is met). */
export function paramApplies(param: TransformParam, params: TransformStep['params']): boolean {
	if (!param.when) return true;
	const all: readonly ParamWhen[] = 'key' in param.when ? [param.when] : param.when;
	return all.every(({ key, is }) => {
		const now = String(params[key] ?? '');
		return typeof is === 'string' ? now === is : is.includes(now);
	});
}

/** A condition setting as its group; unreadable or empty: none. */
export function parseCondition(text: unknown): ConditionGroup | null {
	if (typeof text !== 'string' || !text) return null;
	try {
		const parsed = JSON.parse(text) as ConditionGroup;
		return parsed && parsed.kind === 'group' && Array.isArray(parsed.children) ? parsed : null;
	} catch {
		return null;
	}
}

/** Whether a condition has at least one rule on an attribute. */
const conditionSet = (group: ConditionGroup | null): boolean =>
	!!group &&
	group.children.some((child) => (child.kind === 'rule' ? !!child.field : conditionSet(child)));

/** The fixed value that suits a receiving attribute of this type. */
export function generatorFor(type: MappingType | undefined): TransformId {
	if (type === 'boolean') return 'constant_boolean';
	if (type === 'number') return 'constant_number';
	return 'constant_text';
}

/** A step that makes the value itself: the mapping needs no source attribute. */
export const generates = (mapping: Pick<Mapping, 'steps'>) =>
	mapping.steps.some((step) => transformDef(step.transform).generates);

export const transformDef = (id: TransformId) =>
	TRANSFORMS.find((def) => def.id === id) ?? TRANSFORMS[0];

export interface TransformStep {
	id: string;
	transform: TransformId;
	params: Record<string, string | boolean>;
}

export interface Mapping {
	id: string;
	/** Key of the receiving attribute. */
	target: string;
	/** Keys of the sending attributes, in order (fallback: first that has a value). */
	sources: string[];
	/** Applied in order; none copies the value as it is. */
	steps: TransformStep[];
}

/** A new step with its settings at their defaults. */
export function newStep(transform: TransformId, id: string): TransformStep {
	const def = transformDef(transform);
	const params = Object.fromEntries(
		def.params.map((p) => [
			p.key,
			p.flag ? p.initial === 'true' : p.pairs ? '[]' : (p.initial ?? p.options?.[0] ?? '')
		])
	);
	return { id, transform, params };
}

const isMulti = (type: MappingType) => type.endsWith('[]');
const single = (type: MappingType): MappingType => (isMulti(type) ? 'string' : type);

/** What a step gives for the type it receives. */
export function outputType(
	transform: TransformId,
	input: MappingType,
	params: TransformStep['params'] = {}
): MappingType {
	switch (transform) {
		case 'filter_values':
		case 'json_extract_array':
		case 'array_build':
			return 'string[]';
		case 'hash':
			return 'string';
		case 'conditional':
			return params.valueType === 'as_boolean'
				? 'boolean'
				: params.valueType === 'as_number'
					? 'number'
					: 'string';
		case 'has_value':
			return 'boolean';
		case 'json_extract_or':
			return 'string';
		case 'normalize_empty':
			return input;
		case 'text_to_number':
			return 'number';
		case 'date_format':
			return params.to === 'unix_s' || params.to === 'unix_ms' ? 'number' : 'date';
		case 'default_if_empty':
			return input;
		case 'split':
		case 'as_array':
			return 'string[]';
		case 'join':
		case 'concat':
		case 'trim':
		case 'normalize':
		case 'case':
		case 'affix_text':
		case 'oidc_pairwise_sub':
		case 'saml_edu_person_targeted_id':
		case 'json_extract_text':
		case 'constant_text':
			return 'string';
		case 'first':
			return single(input);
		case 'text_to_boolean':
		case 'json_extract_boolean':
		case 'constant_boolean':
			return 'boolean';
		case 'json_extract_integer':
		case 'constant_number':
			return 'number';
		case 'json_build':
			return 'object';
		case 'keep_part':
		case 'remove_text':
		case 'replace_text':
		case 'regex_replace':
		case 'to_halfwidth':
		case 'to_fullwidth':
		case 'strip_accents':
		case 'ascii_digits':
		case 'value_map':
			// Text in, text out; a list stays a list (each item).
			return isMulti(input) ? 'string[]' : 'string';
		default:
			return input;
	}
}

/** Longest regular expression accepted (the runtime's JSON path limit). */
export const REGEX_MAX = 512;

/** Whether a pattern can be used: it compiles and is not too long. */
export function patternWorks(pattern: string): boolean {
	if (pattern.length > REGEX_MAX) return false;
	try {
		new RegExp(pattern, 'u');
		return true;
	} catch {
		return false;
	}
}

/** A date may go into a text attribute (written as ISO 8601); the reverse needs a step. */
const datesAsText = (out: MappingType, target: MappingType) =>
	single(out) === 'date' && single(target) === 'string';

export type MappingProblem =
	| { kind: 'noSource' }
	| { kind: 'needsCombine' }
	| { kind: 'combineNeedsMore' }
	| { kind: 'unknownSource'; key: string }
	| { kind: 'missingParam'; step: number; param: string }
	| { kind: 'notNumber'; step: number }
	| { kind: 'badPattern'; step: number }
	| { kind: 'manyIntoOne' }
	| { kind: 'typeMismatch'; from: MappingType; to: MappingType };

/** The type that reaches the receiving attribute. */
export function resultType(
	mapping: Mapping,
	sources: readonly MappingField[]
): MappingType | undefined {
	let types = mapping.sources
		.filter(Boolean)
		.map((key) => sources.find((field) => field.key === key)?.type)
		.filter((type): type is MappingType => !!type);
	if (types.length === 0 && !generates(mapping)) return undefined;
	for (const step of mapping.steps) {
		const def = transformDef(step.transform);
		if (def.generates) {
			// Whatever came in, the value is made here.
			types = [outputType(step.transform, 'string', step.params)];
		} else if (def.combines) {
			types = [
				step.transform === 'fallback' ? types[0] : outputType(step.transform, types[0], step.params)
			];
		} else {
			types = types.map((type) => outputType(step.transform, type, step.params));
		}
	}
	return types[0];
}

export function mappingProblems(
	mapping: Mapping,
	sources: readonly MappingField[],
	targets: readonly MappingField[]
): MappingProblem[] {
	const picked = mapping.sources.filter(Boolean);
	const made = generates(mapping);
	if (picked.length === 0 && !made) return [{ kind: 'noSource' }];
	const found: MappingProblem[] = [];
	const combining = mapping.steps
		.map((step) => transformDef(step.transform))
		.find((def) => def.combines);
	// A fixed value needs no source; combining is for sources, so is not asked for then.
	if (!made && picked.length > 1 && !combining) found.push({ kind: 'needsCombine' });
	if (!made && combining && picked.length < (combining.minSources ?? 2))
		found.push({ kind: 'combineNeedsMore' });
	for (const key of picked) {
		if (!sources.some((field) => field.key === key)) found.push({ kind: 'unknownSource', key });
	}
	mapping.steps.forEach((step, index) => {
		for (const param of transformDef(step.transform).params) {
			if (!paramApplies(param, step.params)) continue;
			const empty = param.pairs
				? parsePairs(step.params[param.key]).length === 0
				: param.condition
					? !conditionSet(parseCondition(step.params[param.key]))
					: !step.params[param.key];
			if (param.required && empty) {
				found.push({ kind: 'missingParam', step: index + 1, param: param.key });
			}
		}
		const value = step.params.value;
		if (step.transform === 'constant_number' && typeof value === 'string' && value.trim()) {
			if (!Number.isFinite(Number(value.trim())))
				found.push({ kind: 'notNumber', step: index + 1 });
		}
		if (step.transform === 'conditional' && step.params.valueType === 'as_number') {
			const numbers = [
				step.params.thenValue,
				step.params.elseMode === 'fixed' ? step.params.elseValue : ''
			];
			if (
				numbers.some((n) => typeof n === 'string' && n.trim() && !Number.isFinite(Number(n.trim())))
			)
				found.push({ kind: 'notNumber', step: index + 1 });
		}
		const pattern = step.params.pattern;
		if (step.transform === 'regex_replace' && typeof pattern === 'string' && pattern) {
			if (!patternWorks(pattern)) found.push({ kind: 'badPattern', step: index + 1 });
		}
		const match = step.params.match;
		if (step.transform === 'filter_values' && step.params.how === 'regex') {
			if (typeof match === 'string' && match && !patternWorks(match))
				found.push({ kind: 'badPattern', step: index + 1 });
		}
	});
	const out = resultType(mapping, sources);
	const target = targets.find((field) => field.key === mapping.target)?.type;
	if (out && target && !found.some((p) => p.kind === 'needsCombine')) {
		if (isMulti(out) && !isMulti(target)) found.push({ kind: 'manyIntoOne' });
		else if (single(out) !== single(target) && target !== 'object' && !datesAsText(out, target))
			found.push({ kind: 'typeMismatch', from: out, to: target });
	}
	return found;
}

export const unmappedRequired = (targets: readonly MappingField[], mappings: readonly Mapping[]) =>
	targets.filter((field) => field.required && !mappings.some((m) => m.target === field.key));

export const unusedSources = (sources: readonly MappingField[], mappings: readonly Mapping[]) =>
	sources.filter((field) => !mappings.some((m) => m.sources.includes(field.key)));

const withoutId = ({ transform, params }: TransformStep) => ({ transform, params });

/** One-press fixes for a problem: the step to add at the end. */
export function fixesFor(
	problem: MappingProblem
): { label: 'first' | 'join' | 'bool' | 'concat'; step: Omit<TransformStep, 'id'> }[] {
	switch (problem.kind) {
		case 'manyIntoOne':
			return [
				{ label: 'first', step: { transform: 'first', params: {} } },
				{ label: 'join', step: { transform: 'join', params: { delimiter: ',' } } }
			];
		case 'typeMismatch':
			return problem.to === 'boolean'
				? [{ label: 'bool', step: withoutId(newStep('text_to_boolean', '')) }]
				: [];
		case 'needsCombine':
			return [{ label: 'concat', step: { transform: 'concat', params: { delimiter: ' ' } } }];
		default:
			return [];
	}
}
