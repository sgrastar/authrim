import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.hoisted(() => vi.fn());
vi.mock('#lib/api/second-factors.js', () => ({ httpSecondFactors: { list } }));

import { CHECKLIST } from './checklist';
import { SATISFIED_BY } from './satisfied';

beforeEach(() => list.mockReset());

describe('the probe of the second-factor item', () => {
	const probe = SATISFIED_BY['second-factor'];

	it.each([
		[0, false],
		[1, true],
		[3, true]
	])('answers for %i second factors in use', async (active, expected) => {
		list.mockResolvedValue({ active_count: active, second_factors: [] });
		await expect(probe()).resolves.toBe(expected);
	});

	it('belongs to an item of the checklist, and only such items have a probe', () => {
		const ids = CHECKLIST.map((item) => item.id);
		for (const id of Object.keys(SATISFIED_BY)) expect(ids).toContain(id);
	});
});
