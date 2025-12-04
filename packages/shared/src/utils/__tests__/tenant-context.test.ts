import { describe, it, expect } from 'vitest';
import { remapShardIndex } from '../tenant-context';

describe('remapShardIndex', () => {
  it('should keep shard index within range', () => {
    expect(remapShardIndex(15, 32)).toBe(15); // No remap
    expect(remapShardIndex(45, 32)).toBe(13); // Remap: 45 % 32 = 13
    expect(remapShardIndex(63, 32)).toBe(31); // Remap: 63 % 32 = 31
  });

  it('should handle scale-down scenarios', () => {
    // 64 → 32
    expect(remapShardIndex(0, 32)).toBe(0);
    expect(remapShardIndex(31, 32)).toBe(31);
    expect(remapShardIndex(32, 32)).toBe(0);
    expect(remapShardIndex(63, 32)).toBe(31);
  });

  it('should be idempotent for in-range shards', () => {
    for (let i = 0; i < 32; i++) {
      expect(remapShardIndex(i, 32)).toBe(i);
    }
  });

  it('should handle various scale-down ratios', () => {
    // 128 → 64
    expect(remapShardIndex(0, 64)).toBe(0);
    expect(remapShardIndex(64, 64)).toBe(0);
    expect(remapShardIndex(127, 64)).toBe(63);

    // 64 → 16
    expect(remapShardIndex(0, 16)).toBe(0);
    expect(remapShardIndex(16, 16)).toBe(0);
    expect(remapShardIndex(48, 16)).toBe(0);
    expect(remapShardIndex(63, 16)).toBe(15);

    // 96 → 32
    expect(remapShardIndex(0, 32)).toBe(0);
    expect(remapShardIndex(32, 32)).toBe(0);
    expect(remapShardIndex(64, 32)).toBe(0);
    expect(remapShardIndex(95, 32)).toBe(31);
  });

  it('should throw error for invalid shard count', () => {
    expect(() => remapShardIndex(10, 0)).toThrow('Invalid shard count: must be greater than 0');
    expect(() => remapShardIndex(10, -1)).toThrow('Invalid shard count: must be greater than 0');
    expect(() => remapShardIndex(10, -100)).toThrow('Invalid shard count: must be greater than 0');
  });

  it('should handle edge cases', () => {
    // Shard index 0 always maps to 0
    expect(remapShardIndex(0, 1)).toBe(0);
    expect(remapShardIndex(0, 64)).toBe(0);
    expect(remapShardIndex(0, 128)).toBe(0);

    // Single shard (all codes go to shard 0)
    expect(remapShardIndex(0, 1)).toBe(0);
    expect(remapShardIndex(10, 1)).toBe(0);
    expect(remapShardIndex(100, 1)).toBe(0);

    // Very large shard indices
    expect(remapShardIndex(1000, 32)).toBe(8); // 1000 % 32 = 8
    expect(remapShardIndex(999, 64)).toBe(39); // 999 % 64 = 39
  });

  it('should maintain distribution properties', () => {
    // When scaling down by half, each new shard should get codes from exactly 2 old shards
    const shardCount = 32;
    const oldShardCount = 64;

    // Check that old shards map to new shards correctly
    for (let oldShard = 0; oldShard < oldShardCount; oldShard++) {
      const newShard = remapShardIndex(oldShard, shardCount);
      expect(newShard).toBeGreaterThanOrEqual(0);
      expect(newShard).toBeLessThan(shardCount);

      // Verify the relationship: oldShard % shardCount === newShard
      expect(oldShard % shardCount).toBe(newShard);
    }
  });
});
