import { describe, expect, it } from 'vitest';
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
import {
	newStep,
	transformDef,
	type Mapping,
	type MappingField,
	type TransformStep
} from './mapping-model';
import { previewMapping, type SampleValue } from './mapping-preview';

const targetRef: FieldRef = { side: 'derived', namespace: 'preview', path: 'value' };
const step = (
	transform: TransformStep['transform'],
	params: TransformStep['params'] = {}
): TransformStep => {
	const initial = newStep(transform, transform);
	return { ...initial, params: { ...initial.params, ...params } };
};

/** Build the native graph independently from the preview to compare every intermediate state. */
function compare(inputs: (string | undefined)[], steps: TransformStep[]) {
	const sources: MappingField[] = inputs.map((example, i) => ({
		key: `in${i}`,
		type: 'string',
		example
	}));
	const mapping: Mapping = {
		id: 'parity',
		sources: sources.map((field) => field.key),
		target: 'out',
		steps
	};
	const sourceValues: SourceValueEnvelope[] = [];
	const graph: MappingRuleGraph = {
		id: 'parity',
		targetRef,
		edges: sources.map((field, i) => {
			const sourceRef: FieldRef = { side: 'source', namespace: 'sample', path: field.key };
			if (inputs[i] !== undefined) sourceValues.push({ value: inputs[i], sourceRef });
			return { id: field.key, sourceRef, targetRef };
		}),
		transforms: [],
		output: { edgeIndex: 0 }
	};
	let refs: MappingValueReference[] = inputs.map((_, edgeIndex) => ({ edgeIndex }));
	const expected: MappingEvaluationValue[][] = [];
	for (const [index, editor] of steps.entries()) {
		const schema = TRANSFORM_OPERATION_SCHEMAS.find(
			(schema) => schema.operation === editor.transform
		);
		if (!schema) throw new Error('Parity fixture requires native operations');
		const lanes = transformDef(editor.transform).combines ? [refs] : refs.map((ref) => [ref]);
		refs = lanes.map((inputs, lane) => {
			const stepIndex = graph.transforms.length;
			graph.transforms.push({
				id: `${index}:${lane}`,
				operation: schema.operation,
				parameters: editor.params,
				inputs
			});
			return { stepIndex };
		});
		expected.push(
			refs.map((output) => evaluateMappingRule({ rule: { ...graph, output }, sourceValues }).output)
		);
	}
	const trace = previewMapping(mapping, sources);
	if (!trace) throw new Error('Expected preview trace');
	const tagged = (sample: SampleValue): MappingEvaluationValue => {
		if (!sample.known) throw new Error('Expected a known runtime state');
		if (sample.state === 'absent') return { kind: 'absent' };
		if (sample.state === 'failed') return { kind: 'failed' };
		if (sample.state === 'suppressed') return { kind: 'suppressed' };
		return { kind: 'value', envelope: { value: sample.value, sourceRef: targetRef } };
	};
	const comparable = (value: MappingEvaluationValue) =>
		value.kind === 'value' ? { kind: value.kind, value: value.envelope.value } : value;
	expect(trace.steps.map((row) => row.map(tagged).map(comparable))).toEqual(
		expected.map((row) => row.map(comparable))
	);
	expect(comparable(tagged(trace.output))).toEqual(
		comparable(expected.at(-1)?.[0] ?? { kind: 'absent' })
	);
	return trace;
}

const absentSourceCases: {
	transform: TransformStep['transform'];
	params: TransformStep['params'];
	output: unknown;
}[] = [
	{ transform: 'default_if_empty', params: { value: 'en' }, output: 'en' },
	{ transform: 'has_value', params: {}, output: false }
];

describe('native graph preview state propagation', () => {
	it.each(absentSourceCases)(
		'evaluates $transform against a single source with an undefined example',
		({ transform, params, output }) => {
			const trace = compare([undefined], [step(transform, params)]);
			expect(trace.input).toEqual([{ known: true, value: undefined, state: 'absent' }]);
			expect(trace.steps).toEqual([[{ known: true, value: output }]]);
			expect(trace.output).toEqual({ known: true, value: output });
		}
	);

	it('keeps fallback absence through normalize_empty instead of fabricating X', () => {
		const trace = compare(
			['', ''],
			[step('fallback'), step('normalize_empty', { emptyAs: 'fixed', emptyValue: 'X' })]
		);
		expect(trace.output).toEqual({ known: true, value: undefined, state: 'absent' });
	});

	it('skips text_to_number on fallback absence and then applies the default', () => {
		const trace = compare(
			['', ''],
			[step('fallback'), step('text_to_number'), step('default_if_empty', { value: '42' })]
		);
		expect(trace.output).toEqual({ known: true, value: '42' });
	});

	it('lets fallback consume a missing source without converting it to null', () => {
		expect(
			compare([undefined, '42'], [step('trim'), step('fallback'), step('text_to_number')]).output
		).toEqual({ known: true, value: 42 });
	});

	it('distinguishes null from absence and propagates conversion failure through a default', () => {
		const trace = compare(
			['', ''],
			[
				step('fallback'),
				step('default_if_empty', { value: '' }),
				step('normalize_empty', { emptyAs: 'none' }),
				step('text_to_number'),
				step('default_if_empty', { value: '42' })
			]
		);
		expect(trace.steps[2]).toEqual([{ known: true, value: null }]);
		expect(trace.output).toEqual({ known: true, value: null, state: 'failed' });
	});

	it('propagates a failed input through combining and subsequent defaults', () => {
		expect(
			compare(
				['invalid', '42'],
				[step('text_to_number'), step('fallback'), step('default_if_empty', { value: '0' })]
			).output
		).toEqual({ known: true, value: null, state: 'failed' });
	});

	it('preserves native null from JSON extraction before empty/default operations', () => {
		expect(
			compare(
				['{}'],
				[
					step('json_extract_text', { path: 'missing' }),
					step('normalize_empty', { emptyAs: 'fixed', emptyValue: 'X' }),
					step('has_value')
				]
			).output
		).toEqual({ known: true, value: true });
	});

	it('retains native absence across a preview-only operation boundary', () => {
		const trace = previewMapping(
			{
				id: 'mixed',
				sources: ['in'],
				target: 'out',
				steps: [
					step('json_extract_or', { path: 'missing', defaultValue: '' }),
					step('fallback'),
					step('normalize_empty', { emptyAs: 'fixed', emptyValue: 'X' })
				]
			},
			[{ key: 'in', type: 'string', example: '{}' }]
		);
		expect(trace?.output).toEqual({ known: true, value: undefined, state: 'absent' });
	});

	it('preserves identifier suppression when a prepared runtime context is available', () => {
		const identifier = step('persistent_identifier');
		const trace = previewMapping(
			{ id: 'suppressed', sources: [], target: 'out', steps: [identifier, step('trim')] },
			[],
			{ runtimeContext: { suppressedIdentifiers: { [identifier.id]: true } } }
		);
		expect(trace?.steps).toEqual([
			[{ known: true, value: null, state: 'suppressed' }],
			[{ known: true, value: null, state: 'suppressed' }]
		]);
		expect(trace?.output).toEqual({ known: true, value: null, state: 'suppressed' });
	});
});
