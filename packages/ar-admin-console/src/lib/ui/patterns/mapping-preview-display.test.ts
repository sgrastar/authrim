import { describe, expect, it } from 'vitest';
import { ar } from '../../i18n/messages/ar';
import { de } from '../../i18n/messages/de';
import { en } from '../../i18n/messages/en';
import { ja } from '../../i18n/messages/ja';
import { previewMapping, sampleStateKey, type SampleValue } from './mapping-preview';

describe('mapping sample state display', () => {
	it('shows conversion failure through a default as failure, not null or missing', () => {
		const trace = previewMapping(
			{
				id: 'failed',
				sources: ['in'],
				target: 'out',
				steps: [
					{ id: 'number', transform: 'text_to_number', params: {} },
					{ id: 'default', transform: 'default_if_empty', params: { value: '42' } }
				]
			},
			[{ key: 'in', type: 'string', example: 'abc' }]
		);
		if (!trace) throw new Error('Expected a preview');
		expect(trace.steps.map((row) => row.map(sampleStateKey))).toEqual([
			['map.sample.failed'],
			['map.sample.failed']
		]);
		expect(sampleStateKey(trace.output)).toBe('map.sample.failed');
	});

	it.each([ja, en, de, ar])(
		'distinguishes failure, null, missing and suppression in every locale',
		(catalog) => {
			const samples: SampleValue[] = [
				{ known: true, value: null, state: 'failed' },
				{ known: true, value: null },
				{ known: true, value: undefined, state: 'absent' },
				{ known: true, value: null, state: 'suppressed' }
			];
			const labels = samples.map((sample) => {
				const key = sampleStateKey(sample);
				if (!key) throw new Error('Expected a state label');
				return catalog[key];
			});
			expect(labels.every((label) => label.length > 0)).toBe(true);
			expect(new Set(labels).size).toBe(4);
		}
	);
});
