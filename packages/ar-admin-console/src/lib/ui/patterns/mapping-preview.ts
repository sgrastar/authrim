import {
	evaluateMappingRule,
	TRANSFORM_OPERATION_SCHEMAS
} from '@authrim/ar-lib-field-mapping/authoring';
import type {
	FieldRef,
	MappingEvaluationValue,
	MappingRuleGraph,
	MappingValueReference,
	SourceValueEnvelope
} from '@authrim/ar-lib-field-mapping/contract';
import { holds } from './condition-model';
import {
	identifierRuntimeParams,
	parseCondition,
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
 * that. Persistent identifier steps depend on the account, the app and the salt
 * at sign-in, so from there the sample says so instead of guessing.
 *
 * TODO(runtime): fixed values (constant_*) and the steps in LOCAL_STEPS are computed here
 * until the engine has them; then run them through it like the rest. What localStep does is
 * the behaviour the engine should have. hash needs the tenant's key, so the sample leaves it
 * to run time, like the identifiers.
 */

/** A value at one point, or "decided at sign-in". */
export type SampleValue =
	| { known: true; value: unknown; state?: Exclude<MappingEvaluationValue['kind'], 'value'> }
	| { known: false };

/** Keep runtime states explicit at the display boundary; null remains an ordinary value. */
function sampleValue(value: MappingEvaluationValue): SampleValue {
	if (value.kind === 'value') return { known: true, value: value.envelope.value };
	return { known: true, value: value.kind === 'absent' ? undefined : null, state: value.kind };
}

/** Distinct display labels for runtime states; ordinary values use their own text. */
export function sampleStateKey(
	sample: SampleValue
):
	| 'map.sample.atSignIn'
	| 'map.sample.failed'
	| 'map.sample.suppressed'
	| 'map.sample.absent'
	| 'map.sample.null'
	| 'map.sample.empty'
	| undefined {
	if (!sample.known) return 'map.sample.atSignIn';
	if (sample.state === 'failed') return 'map.sample.failed';
	if (sample.state === 'suppressed') return 'map.sample.suppressed';
	if (sample.state === 'absent' || sample.value === undefined) return 'map.sample.absent';
	if (sample.value === null) return 'map.sample.null';
	if (sample.value === '') return 'map.sample.empty';
	return undefined;
}

function evaluationValue(value: unknown): MappingEvaluationValue {
	return value === undefined
		? { kind: 'absent' }
		: { kind: 'value', envelope: { value, sourceRef: REF } };
}

export interface SampleTrace {
	/** The sample values of the source attributes, in order. */
	input: SampleValue[];
	/** After each step: one value per source attribute, or one after combining. */
	steps: SampleValue[][];
	output: SampleValue;
}

const REF: FieldRef = { side: 'derived', namespace: 'preview', path: 'value' };
const AT_SIGN_IN: SampleValue = { known: false };

function fixedValue(step: TransformStep): unknown {
	const text = String(step.params.value ?? '');
	if (step.transform === 'constant_boolean') return text === 'true';
	if (step.transform === 'constant_number') return text.trim() === '' ? null : Number(text);
	return text;
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

/** The steps the engine does not have yet, on one value (a list: each item where it applies). */
function localStep(
	step: TransformStep,
	value: unknown,
	record: Readonly<Record<string, unknown>>
): unknown {
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
		case 'json_extract_or': {
			const path = typeof step.params.path === 'string' ? step.params.path : '';
			const found = path ? readPath(value, path) : undefined;
			const missing = found === undefined || (found === null && step.params.nullAsMissing === true);
			if (missing) return String(step.params.defaultValue ?? '');
			if (found === null) return null;
			return typeof found === 'object' && found !== null ? JSON.stringify(found) : String(found);
		}
		case 'json_extract_array': {
			const path = typeof step.params.path === 'string' ? step.params.path : '';
			const found = path ? readPath(value, path) : undefined;
			return Array.isArray(found) ? found : null;
		}
		default:
			return value;
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
	'json_extract_array',
	'array_build',
	'conditional',
	'json_extract_or'
]);
/** Decided when the mapping runs: by the app and the user, the tenant's key, or the account and the salt. */
const AT_RUN_TIME = new Set(['hash', 'persistent_identifier']);

/** Null when no source has a sample and evaluation leaves every step and the output absent. */
export function previewMapping(
	mapping: Mapping,
	sources: readonly MappingField[],
	options: { runtimeContext?: Record<string, unknown> } = {}
): SampleTrace | null {
	const input = mapping.sources
		.filter(Boolean)
		.map((key) => sources.find((field) => field.key === key)?.example);
	const makesValue = mapping.steps.some((step) => transformDef(step.transform).generates);

	const record = Object.fromEntries(sources.map((field) => [field.key, field.example]));
	const graph: MappingRuleGraph = {
		id: mapping.id,
		targetRef: REF,
		edges: [],
		transforms: [],
		output: { edgeIndex: 0 }
	};
	const sourceValues: SourceValueEnvelope[] = [];
	const sourceSamples: MappingEvaluationValue[] = [];
	const stepPreparers = new Map<
		string,
		(inputs: readonly MappingEvaluationValue[]) => MappingEvaluationValue
	>();
	const addSource = (value: unknown): MappingValueReference => {
		const edgeIndex = graph.edges.length;
		const sourceRef: FieldRef = { ...REF, side: 'source', path: `input${edgeIndex}` };
		graph.edges.push({ id: `input${edgeIndex}`, sourceRef, targetRef: REF });
		sourceSamples.push(evaluationValue(value));
		if (value !== undefined) sourceValues.push({ value, sourceRef });
		return { edgeIndex };
	};
	let refs = input.map(addSource);
	const inputSamples = input.map((value) => sampleValue(evaluationValue(value)));
	const rows: (MappingValueReference[] | undefined)[] = [];
	let atSignIn = false;

	for (const [index, step] of mapping.steps.entries()) {
		const def = transformDef(step.transform);
		const schema = TRANSFORM_OPERATION_SCHEMAS.find(
			(schema) => schema.operation === step.transform
		);
		if (
			atSignIn ||
			(AT_RUN_TIME.has(step.transform) &&
				!(step.transform === 'persistent_identifier' && options.runtimeContext))
		) {
			atSignIn = true;
			rows.push(undefined);
			continue;
		}
		if (def.generates && !schema) {
			refs = [addSource(fixedValue(step))];
		} else {
			const inputs = def.generates ? [[]] : def.combines ? [refs] : refs.map((ref) => [ref]);
			refs = inputs.map((inputs, lane): MappingValueReference => {
				const id = def.generates ? step.id : `step${index}:${lane}`;
				if (!schema) {
					// The evaluator invokes preview-only operations once, using cached dependency
					// values and the same failure/suppression propagation and budget as native steps.
					stepPreparers.set(id, (inputs) => {
						if (!LOCAL_STEPS.has(step.transform)) return { kind: 'failed' };
						const values = inputs.map((input) =>
							input.kind === 'value' ? input.envelope.value : undefined
						);
						return evaluationValue(
							def.combines ? localCombine(step, values) : localStep(step, values[0], record)
						);
					});
				}
				const stepIndex = graph.transforms.length;
				graph.transforms.push({
					id,
					// concat accepts ordered inputs and absence; only preview-local prepared values use it.
					operation: schema?.operation ?? 'concat',
					parameters: schema
						? step.transform === 'persistent_identifier'
							? identifierRuntimeParams(step.params)
							: step.params
						: {},
					inputs
				});
				return { stepIndex };
			});
		}
		rows.push(refs);
	}
	// Evaluate once for the entire preview, including otherwise disconnected intermediate lanes.
	// Local operation boundaries never reset the budget or replay an upstream transform.
	const result = refs[0]
		? evaluateMappingRule({
				rule: { ...graph, output: refs[0] },
				sourceValues,
				stepPreparers,
				evaluateAllSteps: true,
				runtimeContext: options.runtimeContext
			})
		: undefined;
	// Absence-consuming operations must run before deciding there is no sample to display.
	if (
		!makesValue &&
		input.every((value) => value === undefined) &&
		!atSignIn &&
		(!result ||
			(result.output.kind === 'absent' &&
				[...result.steps.values()].every((value) => value.kind === 'absent')))
	)
		return null;
	const read = (ref: MappingValueReference): MappingEvaluationValue =>
		('stepIndex' in ref ? result?.steps.get(ref.stepIndex) : sourceSamples[ref.edgeIndex]) ?? {
			kind: 'failed'
		};
	return {
		input: inputSamples,
		steps: rows.map((row) => (row ? row.map((ref) => sampleValue(read(ref))) : [AT_SIGN_IN])),
		output: atSignIn
			? AT_SIGN_IN
			: result
				? sampleValue(result.output)
				: sampleValue({ kind: 'absent' })
	};
}
