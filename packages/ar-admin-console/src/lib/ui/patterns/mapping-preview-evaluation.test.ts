import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateMappingRule } from '@authrim/ar-lib-field-mapping/authoring';
import { newStep, type Mapping, type TransformStep } from './mapping-model';
import { previewMapping } from './mapping-preview';

vi.mock('@authrim/ar-lib-field-mapping/authoring', { spy: true });

afterEach(() => vi.clearAllMocks());

function step(transform: TransformStep['transform'], params: TransformStep['params'] = {}) {
	const initial = newStep(transform, transform);
	return { ...initial, params: { ...initial.params, ...params } };
}

function preview(example: string, steps: TransformStep[]) {
	const mapping: Mapping = { id: 'single-pass', sources: ['in'], target: 'out', steps };
	return previewMapping(mapping, [{ key: 'in', type: 'string', example }]);
}

describe('single-pass mapping preview', () => {
	it('evaluates a large sixty-step chain once and reads every intermediate from its result', () => {
		const trace = preview(
			'é'.repeat(15000),
			Array.from({ length: 60 }, (_, index) => newStep('strip_accents', `s${index}`))
		);
		expect(evaluateMappingRule).toHaveBeenCalledTimes(1);
		expect(trace?.steps).toHaveLength(60);
		for (const row of trace?.steps ?? [])
			expect(row).toEqual([{ known: true, value: 'e'.repeat(15000) }]);
		expect(trace?.output).toEqual({ known: true, value: 'e'.repeat(15000) });
	});

	it('reuses evaluated inputs across multiple structure operation boundaries', () => {
		const nested = JSON.stringify({ nested: JSON.stringify({ label: 'é' }) });
		const trace = preview(` ${nested} `, [
			step('trim'),
			step('json_extract_or', { path: 'nested', defaultValue: '' }),
			step('strip_accents'),
			step('json_extract_or', { path: 'label', defaultValue: '' }),
			step('case', { mode: 'upper' })
		]);
		expect(evaluateMappingRule).toHaveBeenCalledTimes(1);
		expect(trace?.steps).toEqual(
			[nested, '{"label":"é"}', '{"label":"e"}', 'e', 'E'].map((value) => [{ known: true, value }])
		);
		expect(trace?.output).toEqual({ known: true, value: 'E' });
	});

	it('includes discarded steps and every source lane in the same evaluation', () => {
		const trace = previewMapping(
			{
				id: 'discarded',
				sources: ['first', 'second'],
				target: 'out',
				steps: [
					step('case', { mode: 'upper' }),
					step('constant_text', { value: ' fresh ' }),
					step('trim')
				]
			},
			[
				{ key: 'first', type: 'string', example: 'a' },
				{ key: 'second', type: 'string', example: 'b' }
			]
		);
		expect(evaluateMappingRule).toHaveBeenCalledTimes(1);
		expect(trace?.steps).toEqual([
			[
				{ known: true, value: 'A' },
				{ known: true, value: 'B' }
			],
			[{ known: true, value: ' fresh ' }],
			[{ known: true, value: 'fresh' }]
		]);
	});

	it('shares the work budget across native and structure operations', () => {
		const value = 'e'.repeat(1500);
		const trace = preview(
			value,
			Array.from({ length: 160 }, (_, index) =>
				index % 2 === 0
					? newStep('strip_accents', `s${index}`)
					: step('json_extract_or', { path: 'missing', defaultValue: value })
			)
		);
		expect(evaluateMappingRule).toHaveBeenCalledTimes(1);
		expect(trace?.steps[0]).toEqual([{ known: true, value }]);
		expect(trace?.output).toEqual({ known: true, value: null, state: 'failed' });
	});
});
