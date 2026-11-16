import { describe, expect, it } from 'vitest';
import {
	executeTransformStep,
	TRANSFORM_OPERATION_SCHEMAS
} from '@authrim/ar-lib-field-mapping/authoring';
import type { FieldRef } from '@authrim/ar-lib-field-mapping/contract';
import { TEXT_TRANSFORM_CASES } from '@authrim/ar-lib-field-mapping/test-support';
import { previewMapping } from './mapping-preview';
import { TRANSFORMS, type Mapping, type MappingField } from './mapping-model';
import { DEMOS } from './step-demos';
import { holds, ruleProblem, type ConditionRule } from './condition-model';

const ref: FieldRef = { side: 'source', namespace: 'preview', path: 'value' };

describe('shared text transform preview', () => {
	it.each(TEXT_TRANSFORM_CASES)(
		'matches runtime and the picker demo for $operation',
		({ operation, parameters, input, output }) => {
			const def = TRANSFORMS.find((def) => def.id === operation);
			if (!def) throw new Error(`Missing console transform ${operation}`);
			const mapping: Mapping = {
				id: 'map',
				target: 'out',
				sources: ['in'],
				steps: [{ id: 'step', transform: def.id, params: parameters }]
			};
			// MappingField's public sample type is text/list, while imported fixtures also exercise null.
			const fields: MappingField[] = [
				{
					key: 'in',
					type: Array.isArray(input) ? 'string[]' : 'string',
					example: typeof input === 'string' ? input : Array.isArray(input) ? input : ''
				}
			];
			const result = executeTransformStep({
				step: { id: 'step', operation, parameters, inputEdgeIds: ['in'], outputTargetRef: ref },
				edgeValues: new Map([['in', { value: fields[0].example, sourceRef: ref }]])
			});
			expect(previewMapping(mapping, fields)?.output).toEqual({
				known: true,
				value: result.value?.value ?? null,
				...(!result.value ? { state: 'failed' } : {})
			});
			expect(result.value?.value).toEqual(output);
			const demoOutput = DEMOS[def.id].chips
				.filter((chip) => chip.as !== 'drop')
				.map((chip) =>
					chip.parts
						.filter((part) => part.as !== 'drop')
						.map((part) => (part.as === 'swap' ? part.to : part.text))
						.join('')
				);
			expect(demoOutput).toEqual(Array.isArray(output) ? output.map(String) : [String(output)]);
			const schema = TRANSFORM_OPERATION_SCHEMAS.find((schema) => schema.operation === operation);
			for (const parameter of def.params) {
				if (parameter.options)
					expect(parameter.options).toEqual(
						schema?.parameters.find((p) => p.name === parameter.key)?.allowedValues
					);
			}
		}
	);

	it.each(TEXT_TRANSFORM_CASES)(
		'matches runtime for array, null, empty and failed inputs to $operation',
		({ operation, parameters }) => {
			const def = TRANSFORMS.find((def) => def.id === operation);
			if (!def) throw new Error('Unknown operation');
			const mapping: Mapping = {
				id: 'map',
				target: 'out',
				sources: ['in'],
				steps: [{ id: 'step', transform: def.id, params: parameters }]
			};
			for (const value of ['', ['abc', '', '１２３'], 'x'.repeat(33000)]) {
				const runtime = executeTransformStep({
					step: { id: 'step', operation, parameters, inputEdgeIds: ['in'], outputTargetRef: ref },
					edgeValues: new Map([['in', { value, sourceRef: ref }]])
				});
				expect(
					previewMapping(mapping, [{ key: 'in', type: 'string', example: value }])?.output
				).toEqual({
					known: true,
					value: runtime.value?.value ?? null,
					...(!runtime.value ? { state: 'failed' } : {})
				});
			}
		}
	);

	it('propagates failures through defaults instead of showing a fabricated value', () => {
		const mapping: Mapping = {
			id: 'map',
			target: 'out',
			sources: ['in'],
			steps: [
				{ id: 'bad', transform: 'text_to_number', params: {} },
				{ id: 'default', transform: 'default_if_empty', params: { value: '42' } }
			]
		};
		expect(
			previewMapping(mapping, [{ key: 'in', type: 'string', example: 'invalid' }])?.output
		).toEqual({ known: true, value: null, state: 'failed' });
	});

	it('uses the shared safe regex validator for conditions and evaluation', () => {
		const rule: ConditionRule = {
			id: 'r',
			kind: 'rule',
			field: 'name',
			operator: 'regex',
			value: '(a+)+'
		};
		expect(ruleProblem(rule, [{ key: 'name', label: 'Name', type: 'string' }])).toBe('badPattern');
		expect(
			holds({ id: 'g', kind: 'group', match: 'all', children: [rule] }, { name: 'a'.repeat(1000) })
		).toBe(false);
		rule.value = '^a+$';
		expect(ruleProblem(rule, [{ key: 'name', label: 'Name', type: 'string' }])).toBeNull();
		expect(
			holds({ id: 'g', kind: 'group', match: 'all', children: [rule] }, { name: 'a'.repeat(1025) })
		).toBe(false);
	});
});
