export const MAX_SCALE_SHARDS = 128;

export interface ShardScaleRange {
	min: number;
	max: number;
	step: number;
}

export function getShardScaleRange(
	activeRegionCount: number,
	maximum = MAX_SCALE_SHARDS
): ShardScaleRange {
	if (!Number.isInteger(activeRegionCount) || activeRegionCount < 1) {
		throw new Error('active_region_count_invalid');
	}
	if (!Number.isInteger(maximum) || maximum < activeRegionCount) {
		throw new Error('maximum_shard_count_invalid');
	}

	return {
		min: activeRegionCount,
		max: Math.floor(maximum / activeRegionCount) * activeRegionCount,
		step: activeRegionCount
	};
}

export function isShardCountValidForRegions(
	shardCount: number,
	activeRegionCount: number,
	maximum = MAX_SCALE_SHARDS
): boolean {
	if (!Number.isInteger(shardCount) || shardCount < 1) return false;
	if (!Number.isInteger(activeRegionCount) || activeRegionCount < 1) return false;
	if (shardCount > maximum) return false;
	return shardCount % activeRegionCount === 0;
}

export function normalizeShardCountForRegions(
	shardCount: number,
	activeRegionCount: number,
	maximum = MAX_SCALE_SHARDS
): number {
	const range = getShardScaleRange(activeRegionCount, maximum);
	const finiteShardCount = Number.isFinite(shardCount)
		? Math.max(1, Math.ceil(shardCount))
		: range.min;
	const roundedUp = Math.ceil(finiteShardCount / range.step) * range.step;
	return Math.min(range.max, Math.max(range.min, roundedUp));
}
