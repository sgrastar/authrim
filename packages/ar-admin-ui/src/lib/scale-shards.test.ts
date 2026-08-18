import { describe, expect, it } from 'vitest';
import {
	getShardScaleRange,
	isShardCountValidForRegions,
	normalizeShardCountForRegions
} from './scale-shards';

describe('scale shard controls', () => {
	it('uses five-region increments when five regions are active', () => {
		expect(getShardScaleRange(5)).toEqual({ min: 5, max: 125, step: 5 });
		expect([5, 10, 15, 20].every((value) => isShardCountValidForRegions(value, 5))).toBe(true);
	});

	it('uses three-region increments when three regions are active', () => {
		expect(getShardScaleRange(3)).toEqual({ min: 3, max: 126, step: 3 });
		expect([3, 6, 9, 12].every((value) => isShardCountValidForRegions(value, 3))).toBe(true);
	});

	it('rounds up after a region-count change without exceeding the maximum', () => {
		expect(normalizeShardCountForRegions(4, 5)).toBe(5);
		expect(normalizeShardCountForRegions(10, 3)).toBe(12);
		expect(normalizeShardCountForRegions(128, 5)).toBe(125);
	});

	it('rejects shard counts that are not a multiple of the active region count', () => {
		expect(isShardCountValidForRegions(4, 3)).toBe(false);
		expect(isShardCountValidForRegions(6, 3)).toBe(true);
		expect(isShardCountValidForRegions(0, 3)).toBe(false);
	});
});
