import { describe, expect, it } from 'vitest';
import { flowSegments, removedSteps } from './flow-sequence';

const ORDER = ['iat', 'mapping', 'consent', 'role'];

describe('flowSegments', () => {
	it('offers each missing step only in the gap where it belongs', () => {
		expect(flowSegments(ORDER, ['mapping', 'role'])).toEqual([
			{ kind: 'gap', key: 'gap:start:mapping', options: ['iat'] },
			{ kind: 'step', key: 'step:mapping', id: 'mapping' },
			{ kind: 'gap', key: 'gap:mapping:role', options: ['consent'] },
			{ kind: 'step', key: 'step:role', id: 'role' },
			{ kind: 'gap', key: 'gap:role:end', options: [] }
		]);
	});

	it('keeps the fixed order whatever order steps were added in', () => {
		const steps = flowSegments(ORDER, ['role', 'iat', 'consent'])
			.filter((s) => s.kind === 'step')
			.map((s) => (s.kind === 'step' ? s.id : ''));
		expect(steps).toEqual(['iat', 'consent', 'role']);
	});

	it('gathers every step into one gap when none is in use', () => {
		expect(flowSegments(ORDER, [])).toEqual([
			{ kind: 'gap', key: 'gap:start:end', options: ORDER }
		]);
	});

	it('merges the gaps around a removed step into one that offers it again', () => {
		const before = flowSegments(ORDER, ['mapping', 'consent', 'role']);
		const after = flowSegments(ORDER, ['mapping', 'role']);
		expect(removedSteps(before, after)).toEqual(['step:consent']);
		expect(after.find((s) => s.key === 'gap:mapping:role')).toEqual({
			kind: 'gap',
			key: 'gap:mapping:role',
			options: ['consent']
		});
	});
});
