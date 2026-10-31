import { executeTransformStep } from '@authrim/ar-lib-field-mapping/authoring';
import type { FieldRef, SourceValueEnvelope } from '@authrim/ar-lib-field-mapping/contract';
import { holds } from './condition-model';
import { asciiDigits, stripAccents } from './text-fold';
import { toFullwidth, toHalfwidth } from './text-width';
import {
	parseCondition,
	parsePairs,
	patternWorks,
	transformDef,
	type Mapping,
	type MappingField,
	type TransformStep
} from './mapping-model';

/**
 * What a mapping makes of the source attributes' sample values, step by step — computed by
 * the runtime engine itself (@authrim/ar-lib-field-mapping), so the console never shows a
 * result the runtime would not produce.
 *
 * Steps run as the console orders them (see mapping-model): until a combining step, on each
 * source attribute's value; the combining step makes one value of them; later steps work on
 * that. Identifier steps (pairwise sub, eduPersonTargetedID) depend on the app and the user
 * at sign-in, so from there the sample says so instead of guessing.
 *
 * TODO(runtime): fixed values (constant_*) and the steps in LOCAL_STEPS are computed here
 * until the engine has them; then run them through it like the rest. What localStep does is
 * the behaviour the engine should have. hash needs the tenant's key, so the sample leaves it
 * to run time, like the identifiers.
 */

/** A value at one point, or "decided at sign-in". */
export type SampleValue = { known: true; value: unknown } | { known: false };

export interface SampleTrace {
	/** The sample values of the source attributes, in order. */
	input: SampleValue[];
	/** After each step: one value per source attribute, or one after combining. */
	steps: SampleValue[][];
	output: SampleValue;
}

const REF: FieldRef = { side: 'derived', namespace: 'preview', path: 'value' };
const AT_SIGN_IN: SampleValue = { known: false };

function runStep(step: TransformStep, values: unknown[]): unknown {
	const edgeValues = new Map<string, SourceValueEnvelope>(
		values.map((value, index) => [`in${index}`, { value, sourceRef: REF }])
	);
	const result = executeTransformStep({
		step: {
			id: step.id,
			inputEdgeIds: [...edgeValues.keys()],
			operation: step.transform as never,
			parameters: step.params,
			outputTargetRef: REF
		},
		edgeValues
	});
	return result.value?.value ?? null;
}

function fixedValue(step: TransformStep): unknown {
	const text = String(step.params.value ?? '');
	if (step.transform === 'constant_boolean') return text === 'true';
	if (step.transform === 'constant_number') return text.trim() === '' ? null : Number(text);
	return text;
}

/** The text steps the engine does not have yet, on one string. */
function textOn(step: TransformStep, text: string): string | null {
	const p = step.params;
	const str = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : '');
	switch (step.transform) {
		case 'keep_part': {
			const mark = str('delimiter');
			if (!mark) return text;
			const at = p.occurrence === 'last' ? text.lastIndexOf(mark) : text.indexOf(mark);
			// Without the character there is nothing to cut: the value stays as it is.
			if (at < 0) return text;
			return p.keep === 'after' ? text.slice(at + mark.length) : text.slice(0, at);
		}
		case 'remove_text':
			return str('text') ? text.split(str('text')).join('') : text;
		case 'replace_text': {
			const find = str('find');
			if (!find) return text;
			if (p.ignoreCase !== true) return text.split(find).join(str('replacement'));
			const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			return text.replace(new RegExp(escaped, 'giu'), () => str('replacement'));
		}
		case 'to_halfwidth':
			return toHalfwidth(text, p.katakana === true);
		case 'to_fullwidth':
			return toFullwidth(text, p.katakana === true);
		case 'strip_accents':
			return stripAccents(text);
		case 'ascii_digits':
			return asciiDigits(text);
		case 'value_map': {
			const same = (a: string) =>
				p.ignoreCase === true ? a.toLowerCase() === text.toLowerCase() : a === text;
			const hit = parsePairs(p.entries).find(([from]) => same(from));
			if (hit) return hit[1];
			return p.otherwise === 'none' ? null : p.otherwise === 'fixed' ? str('fallbackValue') : text;
		}
		case 'regex_replace': {
			const pattern = str('pattern');
			if (!pattern || !patternWorks(pattern)) return null;
			const flags = p.ignoreCase === true ? 'giu' : 'gu';
			return text.replace(new RegExp(pattern, flags), str('replacement'));
		}
		default:
			return text;
	}
}

/** Strings, and each string of a list; anything else passes through. */
function textStep(step: TransformStep, value: unknown): unknown {
	if (typeof value === 'string') return textOn(step, value);
	if (Array.isArray(value))
		return value.map((item) => (typeof item === 'string' ? textOn(step, item) : item));
	return value;
}

const isEmpty = (value: unknown) =>
	value === null ||
	value === undefined ||
	value === '' ||
	(Array.isArray(value) && value.length === 0);

/** A number from digits ("42", " -3.5 "); anything else is no value. */
function toNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string' || !/^\s*-?\d+(\.\d+)?\s*$/u.test(value)) return null;
	return Number(value.trim());
}

/** A date from ISO 8601 or Unix time; UTC throughout. */
function toDate(value: unknown, from: unknown): Date | null {
	const digits = typeof value === 'number' || /^\s*-?\d+(\.\d+)?\s*$/u.test(String(value));
	let ms: number;
	if (from === 'unix_s' || from === 'unix_ms' || (from === 'auto' && digits)) {
		const n = Number(value);
		const millis = from === 'unix_ms' || (from === 'auto' && Math.abs(n) >= 1e11);
		ms = millis ? n : n * 1000;
	} else {
		ms = Date.parse(String(value));
	}
	return Number.isFinite(ms) ? new Date(ms) : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The date and time as a clock in `zone` shows them, with that zone's offset then. */
function inZone(date: Date, zone: string): { day: string; iso: string } | null {
	let parts: Record<string, string>;
	try {
		parts = Object.fromEntries(
			new Intl.DateTimeFormat('en-US', {
				timeZone: zone,
				hourCycle: 'h23',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit'
			})
				.formatToParts(date)
				.map((part) => [part.type, part.value])
		);
	} catch {
		return null;
	}
	const day = `${parts.year}-${parts.month}-${parts.day}`;
	const wall = Date.UTC(
		+parts.year,
		+parts.month - 1,
		+parts.day,
		+parts.hour,
		+parts.minute,
		+parts.second
	);
	const minutes = Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60000);
	const offset =
		minutes === 0
			? 'Z'
			: `${minutes > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
	return { day, iso: `${day}T${parts.hour}:${parts.minute}:${parts.second}${offset}` };
}

function formatDate(date: Date, to: unknown, zone: unknown): unknown {
	if (to === 'unix_s') return Math.floor(date.getTime() / 1000);
	if (to === 'unix_ms') return date.getTime();
	const local = inZone(date, typeof zone === 'string' && zone ? zone : 'UTC');
	if (!local) return null;
	return to === 'date' ? local.day : local.iso;
}

function matches(step: TransformStep, item: string): boolean {
	const p = step.params;
	const match = typeof p.match === 'string' ? p.match : '';
	if (p.how === 'regex') {
		if (!patternWorks(match)) return false;
		return new RegExp(match, p.ignoreCase === true ? 'iu' : 'u').test(item);
	}
	const [a, b] = p.ignoreCase === true ? [item.toLowerCase(), match.toLowerCase()] : [item, match];
	if (p.how === 'starts_with') return a.startsWith(b);
	if (p.how === 'ends_with') return a.endsWith(b);
	if (p.how === 'equals') return a === b;
	return a.includes(b);
}

/** The steps the engine does not have yet, on one value (a list: each item where it applies). */
function localStep(
	step: TransformStep,
	value: unknown,
	record: Readonly<Record<string, unknown>>
): unknown {
	const each = (fn: (item: unknown) => unknown) =>
		Array.isArray(value) ? value.map(fn) : fn(value);
	switch (step.transform) {
		case 'conditional': {
			const p = step.params;
			// The value as its chosen type: "true" → true, "42" → 42.
			const typed = (text: unknown, bool: unknown) =>
				p.valueType === 'as_boolean'
					? bool === 'true'
					: p.valueType === 'as_number'
						? toNumber(String(text ?? ''))
						: String(text ?? '');
			const condition = parseCondition(p.condition);
			if (condition && holds(condition, record)) return typed(p.thenValue, p.thenBool);
			if (p.elseMode === 'none') return null;
			if (p.elseMode === 'fixed') return typed(p.elseValue, p.elseBool);
			return value;
		}
		case 'has_value':
			return isEmpty(value) === (step.params.invert === true);
		case 'normalize_empty': {
			const p = step.params;
			// \s covers the full-width space (U+3000) too.
			const blank =
				isEmpty(value) || (p.spaces === true && typeof value === 'string' && /^\s*$/u.test(value));
			if (!blank) return value;
			return p.emptyAs === 'empty' ? '' : p.emptyAs === 'fixed' ? String(p.emptyValue ?? '') : null;
		}
		case 'json_extract_or': {
			const path = typeof step.params.path === 'string' ? step.params.path : '';
			const found = path ? readPath(value, path) : undefined;
			const missing = found === undefined || (found === null && step.params.nullAsMissing === true);
			if (missing) return String(step.params.defaultValue ?? '');
			if (found === null) return null;
			return typeof found === 'object' && found !== null ? JSON.stringify(found) : String(found);
		}
		case 'default_if_empty':
			return isEmpty(value) ? String(step.params.value ?? '') : value;
		case 'text_to_number':
			return each(toNumber);
		case 'date_format':
			return each((item) => {
				if (isEmpty(item)) return null;
				const date = toDate(item, step.params.from);
				return date ? formatDate(date, step.params.to, step.params.timeZone) : null;
			});
		case 'json_extract_array': {
			const path = typeof step.params.path === 'string' ? step.params.path : '';
			const found = path ? readPath(value, path) : undefined;
			return Array.isArray(found) ? found : null;
		}
		case 'filter_values': {
			const list = Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
			return list.filter(
				(item) => typeof item === 'string' && matches(step, item) !== (step.params.exclude === true)
			);
		}
		default:
			return textStep(step, value);
	}
}

/** A JSON path ("groups", "user.roles[0]") read from JSON text or an object. */
function readPath(value: unknown, path: string): unknown {
	let current: unknown = value;
	if (typeof current === 'string') {
		try {
			current = JSON.parse(current);
		} catch {
			return undefined;
		}
	}
	for (const part of path.split('.')) {
		const name = part.match(/^[^[]+/u)?.[0];
		if (name) current = (current as Record<string, unknown> | null)?.[name];
		for (const index of part.matchAll(/\[(\d+)\]/gu))
			current = Array.isArray(current) ? current[Number(index[1])] : undefined;
	}
	return current;
}

/** The engine-less steps that make one value of all the sources' values. */
function localCombine(step: TransformStep, values: unknown[]): unknown {
	let list = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
	if (step.params.omitEmpty === true) list = list.filter((item) => !isEmpty(item));
	if (step.params.unique === true) list = [...new Set(list.map(String))];
	return list.filter((item) => item !== null && item !== undefined);
}

const LOCAL_STEPS = new Set([
	'keep_part',
	'remove_text',
	'replace_text',
	'regex_replace',
	'to_halfwidth',
	'to_fullwidth',
	'strip_accents',
	'ascii_digits',
	'value_map',
	'text_to_number',
	'date_format',
	'filter_values',
	'json_extract_array',
	'array_build',
	'conditional',
	'has_value',
	'normalize_empty',
	'json_extract_or',
	'default_if_empty'
]);
/** Decided when the mapping runs: by the app and the user, or by the tenant's key. */
const AT_RUN_TIME = new Set(['oidc_pairwise_sub', 'saml_edu_person_targeted_id', 'hash']);

/** Null when there is nothing to show: no source has a sample and no step makes a value. */
export function previewMapping(
	mapping: Mapping,
	sources: readonly MappingField[]
): SampleTrace | null {
	const input = mapping.sources
		.filter(Boolean)
		.map((key) => sources.find((field) => field.key === key)?.example);
	const makesValue = mapping.steps.some((step) => transformDef(step.transform).generates);
	if (!makesValue && input.every((value) => value === undefined)) return null;

	// What conditions read: every source attribute's sample value.
	const record = Object.fromEntries(sources.map((field) => [field.key, field.example]));
	let state: SampleValue[] = input.map((value) => ({ known: true, value: value ?? null }));
	const steps: SampleValue[][] = [];
	for (const step of mapping.steps) {
		const def = transformDef(step.transform);
		if (state.some((value) => !value.known) || AT_RUN_TIME.has(step.transform)) {
			state = [AT_SIGN_IN];
		} else if (def.generates) {
			state = [{ known: true, value: fixedValue(step) }];
		} else {
			const values = state.map((value) => (value.known ? value.value : null));
			state = LOCAL_STEPS.has(step.transform)
				? def.combines
					? [{ known: true, value: localCombine(step, values) }]
					: values.map((value) => ({ known: true, value: localStep(step, value, record) }))
				: def.combines
					? [{ known: true, value: runStep(step, values) }]
					: values.map((value) => ({ known: true, value: runStep(step, [value]) }));
		}
		steps.push(state);
	}
	// With several source attributes and no combining step, the first one is what arrives.
	return {
		input: input.map((value) => ({ known: true, value: value ?? null })),
		steps,
		output: state[0] ?? { known: true, value: null }
	};
}
