import { describe, expect, it } from 'vitest';
import {
	STRUCTURE_TRANSFORM_CASES,
	CONDITIONAL_PARAMETERS
} from '@authrim/ar-lib-field-mapping/test-support';
import { TRANSFORMS, type TransformStep } from './mapping-model';
import { previewMapping } from './mapping-preview';

describe('structure preview engine parity', () => {
	it.each(STRUCTURE_TRANSFORM_CASES)('shares backend $operation semantics', (example) => {
		const transform = TRANSFORMS.find((def) => def.id === example.operation)?.id;
		if (!transform) throw new Error('Missing console operation');
		const params: TransformStep['params'] = {};
		for (const [name, value] of Object.entries(example.parameters))
			params[name] =
				transform === 'constant_boolean' || typeof value === 'number'
					? String(value)
					: typeof value === 'boolean'
						? value
						: String(value);
		const result = previewMapping(
			{
				id: 'parity',
				sources: transform.startsWith('constant_') ? [] : ['synthetic'],
				target: 'output',
				steps: [{ id: 'step', transform, params }]
			},
			[{ key: 'synthetic', type: 'object', example: example.input }]
		);
		expect(result?.output).toEqual({ known: true, value: example.output });
	});
	it('binds a condition-only field and refuses an unsafe condition', () => {
		const mapping = {
			id: 'conditional',
			sources: ['value'],
			target: 'output',
			steps: [{ id: 'step', transform: 'conditional', params: CONDITIONAL_PARAMETERS }]
		} satisfies Parameters<typeof previewMapping>[0];
		const sources = [
			{ key: 'value', type: 'string', example: 'original' },
			{ key: 'department', type: 'string', example: 'Engineering' }
		] satisfies Parameters<typeof previewMapping>[1];
		expect(previewMapping(mapping, sources)?.output).toEqual({ known: true, value: 'member' });
		mapping.steps[0].params = {
			...CONDITIONAL_PARAMETERS,
			condition: JSON.stringify({
				kind: 'rule',
				field: 'department',
				operator: 'regex',
				value: '(a+)+$'
			})
		};
		expect(previewMapping(mapping, sources)?.output).toMatchObject({ state: 'failed' });
	});
	it('never fabricates a hash, including when runtimeContext is supplied', () => {
		expect(
			previewMapping(
				{
					id: 'hash',
					sources: ['value'],
					target: 'output',
					steps: [{ id: 'step', transform: 'hash', params: { encoding: 'hex' } }]
				},
				[{ key: 'value', type: 'string', example: 'synthetic' }],
				{ runtimeContext: { tenantId: 'untrusted-source', hash: 'invented' } }
			)?.output
		).toEqual({ known: false });
	});
	it('refuses malformed typed constant controls', () => {
		for (const transform of [
			'constant_boolean',
			'constant_number'
		] satisfies TransformStep['transform'][])
			expect(
				previewMapping(
					{
						id: 'invalid',
						sources: [],
						target: 'output',
						steps: [{ id: 'step', transform, params: { value: 'invalid' } }]
					},
					[]
				)?.output
			).toMatchObject({ state: 'failed' });
	});
});
