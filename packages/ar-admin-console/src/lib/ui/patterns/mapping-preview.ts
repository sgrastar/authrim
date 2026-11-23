import {
	evaluateMappingRule,
	conditionFields,
	readMappingCondition,
	TRANSFORM_OPERATION_SCHEMAS
} from '@authrim/ar-lib-field-mapping/authoring';
import type {
	FieldRef,
	MappingEvaluationValue,
	MappingRuleGraph,
	MappingValueReference,
	SourceValueEnvelope
} from '@authrim/ar-lib-field-mapping/contract';
import { pseudoPersistentIdentifier } from './persistent-identifier-preview';
import {
	runtimeTransformParams,
	transformDef,
	type Mapping,
	type MappingField
} from './mapping-model';

/**
 * What a mapping makes of the source attributes' sample values, step by step — computed by
 * the runtime engine itself (@authrim/ar-lib-field-mapping), so the console never shows a
 * result the runtime would not produce.
 *
 * Steps run as the console orders them (see mapping-model): until a combining step, on each
 * source attribute's value; the combining step makes one value of them; later steps work on
 * that. A persistent identifier depends on the account, the app and the salt at sign-in, so
 * its sample is made up (see persistent-identifier-preview): the shape it will have, marked
 * as an illustration, and what comes after works on that. Hashes are decided at sign-in, and
 * the sample says so instead of guessing.
 *
 */

/** A value at one point, or "decided at sign-in". */
export type SampleValue =
	| {
			known: true;
			value: unknown;
			state?: Exclude<MappingEvaluationValue['kind'], 'value'>;
			/** Made up to show the shape (a persistent identifier), not what the mapping will make. */
			illustrative?: boolean;
	  }
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

/** Decided when the mapping runs: by the app and the user, the tenant's key, or the account and the salt. */
const AT_RUN_TIME = new Set(['hash', 'persistent_identifier']);

/** Null when no source has a sample and evaluation leaves every step and the output absent. */
export function previewMapping(
	mapping: Mapping,
	sources: readonly MappingField[],
	options: { runtimeContext?: Record<string, unknown>; targetRef?: FieldRef } = {}
): SampleTrace | null {
	const input = mapping.sources
		.filter(Boolean)
		.map((key) => sources.find((field) => field.key === key)?.example);
	const makesValue = mapping.steps.some((step) => transformDef(step.transform).generates);

	const graph: MappingRuleGraph = {
		id: mapping.id,
		targetRef: options.targetRef ?? REF,
		edges: [],
		transforms: [],
		output: { edgeIndex: 0 }
	};
	const sourceValues: SourceValueEnvelope[] = [];
	const sourceSamples: MappingEvaluationValue[] = [];
	const addSource = (value: unknown, field?: MappingField): MappingValueReference => {
		const edgeIndex = graph.edges.length;
		const sourceRef: FieldRef = field?.ref ?? { ...REF, side: 'source', path: `input${edgeIndex}` };
		graph.edges.push({ id: `input${edgeIndex}`, sourceRef, targetRef: options.targetRef ?? REF });
		sourceSamples.push(evaluationValue(value));
		if (value !== undefined) sourceValues.push({ value, sourceRef });
		return { edgeIndex };
	};
	let refs = input.map((value, index) =>
		addSource(
			value,
			sources.find((field) => field.key === mapping.sources.filter(Boolean)[index])
		)
	);
	const inputSamples = input.map((value) => sampleValue(evaluationValue(value)));
	const rows: (MappingValueReference[] | undefined)[] = [];
	let atSignIn = false;
	/** From this step on, the values rest on a made-up identifier. */
	let illustrativeFrom: number | undefined;

	for (const [index, step] of mapping.steps.entries()) {
		const def = transformDef(step.transform);
		const schema = TRANSFORM_OPERATION_SCHEMAS.find(
			(schema) => schema.operation === step.transform
		);
		// A persistent identifier is made up for the sample, unless the runtime's context is given.
		const pseudo =
			!atSignIn && step.transform === 'persistent_identifier' && !options.runtimeContext
				? pseudoPersistentIdentifier(step.params)
				: null;
		if (pseudo !== null) illustrativeFrom ??= index;
		if (
			atSignIn ||
			(pseudo === null &&
				AT_RUN_TIME.has(step.transform) &&
				!(step.transform === 'persistent_identifier' && options.runtimeContext))
		) {
			atSignIn = true;
			rows.push(undefined);
			continue;
		}
		const inputs = def.generates ? [[]] : def.combines ? [refs] : refs.map((ref) => [ref]);
		refs = inputs.map((inputs, lane): MappingValueReference => {
			const id = def.generates ? step.id : `step${index}:${lane}`;
			if (step.transform === 'conditional') {
				inputs = inputs.map((ref) => ({ ...ref, name: 'value' }));
				const condition = readMappingCondition(step.params.condition);
				if (condition)
					for (const field of conditionFields(condition)) {
						inputs.push({
							...addSource(
								sources.find((source) => source.key === field)?.example,
								sources.find((source) => source.key === field)
							),
							name: `field:${field}`
						});
					}
			}
			const stepIndex = graph.transforms.length;
			graph.transforms.push({
				id,
				// The made-up identifier goes in as a constant: what comes after works on it.
				operation: pseudo !== null ? 'constant_text' : (schema?.operation ?? 'hash'),
				parameters: pseudo !== null ? { value: pseudo } : runtimeTransformParams(step),
				inputs
			});
			return { stepIndex };
		});
		rows.push(refs);
	}
	// Evaluate once for the entire preview, including otherwise disconnected intermediate lanes.
	// Local operation boundaries never reset the budget or replay an upstream transform.
	const result = refs[0]
		? evaluateMappingRule({
				rule: { ...graph, output: refs[0] },
				sourceValues,
				evaluateAllSteps: true,
				runtimeContext: options.runtimeContext,
				// Persisted graph values use edge targets for JSON input naming.
				edgeValueReferences: options.targetRef ? 'target' : 'source'
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
	// What rests on a made-up identifier is marked, so it is not read as what the mapping makes.
	const mark = (sample: SampleValue, index: number): SampleValue =>
		illustrativeFrom !== undefined && index >= illustrativeFrom && sample.known
			? { ...sample, illustrative: true }
			: sample;
	return {
		input: inputSamples,
		steps: rows.map((row, index) =>
			row ? row.map((ref) => mark(sampleValue(read(ref)), index)) : [AT_SIGN_IN]
		),
		output: atSignIn
			? AT_SIGN_IN
			: result
				? mark(sampleValue(result.output), mapping.steps.length)
				: sampleValue({ kind: 'absent' })
	};
}
