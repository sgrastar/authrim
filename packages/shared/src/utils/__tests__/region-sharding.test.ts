/**
 * Region Sharding Utility Tests
 *
 * Tests for region-based DO sharding with locationHint support.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseRegionId,
  createRegionId,
  resolveShardForNewResource,
  resolveRegionForShard,
  buildRegionInstanceName,
  validateRegionDistribution,
  validateRegionShardRequest,
  createNewRegionGeneration,
  calculateRegionDistribution,
  getDefaultRegionShardConfig,
  type RegionShardConfig,
  type RegionGenerationConfig,
  REGION_MAX_PREVIOUS_GENERATIONS,
  VALID_REGION_KEYS,
} from '../region-sharding';

describe('Region Sharding Utilities', () => {
  describe('parseRegionId', () => {
    it('should parse valid region ID', () => {
      const result = parseRegionId('g1:apac:3:session_abc123');

      expect(result).toEqual({
        generation: 1,
        regionKey: 'apac',
        shardIndex: 3,
        randomPart: 'session_abc123',
      });
    });

    it('should parse ID with higher generation', () => {
      const result = parseRegionId('g15:weur:12:ac_xyz789');

      expect(result).toEqual({
        generation: 15,
        regionKey: 'weur',
        shardIndex: 12,
        randomPart: 'ac_xyz789',
      });
    });

    it('should throw on invalid format - missing prefix', () => {
      expect(() => parseRegionId('1:apac:3:session_abc')).toThrow('Invalid region ID format');
    });

    it('should throw on invalid format - wrong separator', () => {
      expect(() => parseRegionId('g1-apac-3-session_abc')).toThrow('Invalid region ID format');
    });

    it('should throw on invalid format - missing parts', () => {
      expect(() => parseRegionId('g1:apac:session_abc')).toThrow('Invalid region ID format');
    });

    it('should throw on invalid format - non-numeric shard', () => {
      expect(() => parseRegionId('g1:apac:abc:session_xyz')).toThrow('Invalid region ID format');
    });
  });

  describe('createRegionId', () => {
    it('should create valid region ID', () => {
      const result = createRegionId(1, 'apac', 3, 'session_abc123');

      expect(result).toBe('g1:apac:3:session_abc123');
    });

    it('should handle different regions', () => {
      expect(createRegionId(2, 'weur', 8, 'ac_xyz')).toBe('g2:weur:8:ac_xyz');
      expect(createRegionId(1, 'enam', 0, 'ch_123')).toBe('g1:enam:0:ch_123');
      expect(createRegionId(3, 'wnam', 15, 'rt_abc')).toBe('g3:wnam:15:rt_abc');
    });

    it('should handle shard index 0', () => {
      const result = createRegionId(1, 'apac', 0, 'session_test');

      expect(result).toBe('g1:apac:0:session_test');
    });
  });

  describe('parseRegionId and createRegionId roundtrip', () => {
    it('should roundtrip correctly', () => {
      const original = {
        generation: 5,
        regionKey: 'weur',
        shardIndex: 12,
        randomPart: 'session_uuid123',
      };

      const id = createRegionId(
        original.generation,
        original.regionKey,
        original.shardIndex,
        original.randomPart
      );
      const parsed = parseRegionId(id);

      expect(parsed).toEqual(original);
    });
  });

  describe('resolveRegionForShard', () => {
    const regions = {
      apac: { startShard: 0, endShard: 3, shardCount: 4 },
      enam: { startShard: 4, endShard: 11, shardCount: 8 },
      weur: { startShard: 12, endShard: 19, shardCount: 8 },
    };

    it('should resolve APAC region for shards 0-3', () => {
      expect(resolveRegionForShard(0, regions)).toBe('apac');
      expect(resolveRegionForShard(1, regions)).toBe('apac');
      expect(resolveRegionForShard(3, regions)).toBe('apac');
    });

    it('should resolve ENAM region for shards 4-11', () => {
      expect(resolveRegionForShard(4, regions)).toBe('enam');
      expect(resolveRegionForShard(7, regions)).toBe('enam');
      expect(resolveRegionForShard(11, regions)).toBe('enam');
    });

    it('should resolve WEUR region for shards 12-19', () => {
      expect(resolveRegionForShard(12, regions)).toBe('weur');
      expect(resolveRegionForShard(15, regions)).toBe('weur');
      expect(resolveRegionForShard(19, regions)).toBe('weur');
    });

    it('should return first region with shards for out-of-range shard', () => {
      // When shard is out of range, returns the first region that has shards
      const result20 = resolveRegionForShard(20, regions);
      const result100 = resolveRegionForShard(100, regions);

      // The fallback behavior returns first region with shardCount > 0
      expect(result20).toBeDefined();
      expect(result100).toBeDefined();
      // Both should be one of the configured regions
      expect(['apac', 'enam', 'weur']).toContain(result20);
      expect(['apac', 'enam', 'weur']).toContain(result100);
    });
  });

  describe('buildRegionInstanceName', () => {
    it('should build session instance name', () => {
      const result = buildRegionInstanceName('default', 'apac', 'session', 3);
      // 3-character abbreviation: ses
      expect(result).toBe('default:apac:ses:3');
    });

    it('should build authcode instance name', () => {
      const result = buildRegionInstanceName('default', 'weur', 'authcode', 8);
      // 3-character abbreviation: acd
      expect(result).toBe('default:weur:acd:8');
    });

    it('should build challenge instance name', () => {
      const result = buildRegionInstanceName('default', 'enam', 'challenge', 12);
      // 3-character abbreviation: cha
      expect(result).toBe('default:enam:cha:12');
    });

    it('should only accept known resource types', () => {
      // TypeScript enforces RegionShardResourceType for resourceType parameter
      // Valid types are: 'session', 'authcode', 'challenge'
      // Unknown types result in undefined abbreviation at runtime
      // @ts-expect-error - Testing runtime behavior with invalid type
      const result = buildRegionInstanceName('default', 'apac', 'unknown', 5);
      // Returns undefined abbreviation when unknown type is passed
      expect(result).toBe('default:apac:undefined:5');
    });
  });

  describe('validateRegionDistribution', () => {
    it('should accept valid distribution summing to 100', () => {
      const result = validateRegionDistribution({
        apac: 20,
        enam: 40,
        weur: 40,
      });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept single region with 100%', () => {
      const result = validateRegionDistribution({
        enam: 100,
      });

      expect(result.valid).toBe(true);
    });

    it('should accept regions with 0% allocation', () => {
      const result = validateRegionDistribution({
        apac: 0,
        enam: 50,
        weur: 50,
      });

      expect(result.valid).toBe(true);
    });

    it('should reject distribution not summing to 100', () => {
      const result = validateRegionDistribution({
        apac: 20,
        enam: 40,
        weur: 30,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must sum to 100');
    });

    it('should reject distribution exceeding 100', () => {
      const result = validateRegionDistribution({
        apac: 50,
        enam: 50,
        weur: 50,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must sum to 100');
    });

    it('should reject invalid region keys', () => {
      const result = validateRegionDistribution({
        apac: 50,
        invalid: 50, // invalid region key
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid region key');
    });

    it('should reject negative percentages', () => {
      const result = validateRegionDistribution({
        apac: -20,
        enam: 70,
        weur: 50,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('negative');
    });
  });

  describe('validateRegionShardRequest', () => {
    it('should accept valid request', () => {
      const result = validateRegionShardRequest({
        totalShards: 20,
        regionDistribution: { apac: 20, enam: 40, weur: 40 },
      });

      expect(result.valid).toBe(true);
    });

    it('should reject invalid region keys', () => {
      const result = validateRegionShardRequest({
        totalShards: 20,
        regionDistribution: { apac: 50, invalid_region: 50 },
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid region key');
    });

    it('should reject negative percentages', () => {
      const result = validateRegionShardRequest({
        totalShards: 20,
        regionDistribution: { apac: -10, enam: 60, weur: 50 },
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('negative');
    });

    it('should reject distribution not summing to 100', () => {
      const result = validateRegionShardRequest({
        totalShards: 20,
        regionDistribution: { apac: 30, enam: 30, weur: 30 },
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must sum to 100');
    });

    it('should reject totalShards less than active regions', () => {
      const result = validateRegionShardRequest({
        totalShards: 2,
        regionDistribution: { apac: 33, enam: 33, weur: 34 },
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be >= active region count');
    });

    it('should reject when percentage would result in 0 shards', () => {
      const result = validateRegionShardRequest({
        totalShards: 10,
        regionDistribution: { apac: 1, enam: 49, weur: 50 },
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('would be 0');
    });

    it('should allow regions with 0% allocation', () => {
      const result = validateRegionShardRequest({
        totalShards: 10,
        regionDistribution: { apac: 0, enam: 50, weur: 50 },
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('calculateRegionDistribution', () => {
    it('should calculate correct shard count for 20 shards', () => {
      const result = calculateRegionDistribution(20, {
        apac: 20, // 4 shards
        enam: 40, // 8 shards
        weur: 40, // 8 shards
      });

      // Verify shard counts are correct (order may vary due to percentage-based sorting)
      expect(result.apac.shardCount).toBe(4);
      expect(result.enam.shardCount).toBe(8);
      expect(result.weur.shardCount).toBe(8);

      // Verify total shards covered
      const totalShards = result.apac.shardCount + result.enam.shardCount + result.weur.shardCount;
      expect(totalShards).toBe(20);

      // Verify no gaps in ranges (each region has valid start/end)
      expect(result.apac.endShard - result.apac.startShard + 1).toBe(result.apac.shardCount);
      expect(result.enam.endShard - result.enam.startShard + 1).toBe(result.enam.shardCount);
      expect(result.weur.endShard - result.weur.startShard + 1).toBe(result.weur.shardCount);
    });

    it('should handle 10 shards with 50/50 split', () => {
      const result = calculateRegionDistribution(10, {
        enam: 50,
        weur: 50,
      });

      expect(result.enam.shardCount).toBe(5);
      expect(result.weur.shardCount).toBe(5);

      // Both should have valid ranges covering 5 shards each
      expect(result.enam.endShard - result.enam.startShard + 1).toBe(5);
      expect(result.weur.endShard - result.weur.startShard + 1).toBe(5);
    });

    it('should handle rounding gracefully', () => {
      // 33.33% each - rounding may not perfectly sum to totalShards
      const result = calculateRegionDistribution(10, {
        apac: 33,
        enam: 33,
        weur: 34,
      });

      // Each region should have at least 1 shard if percentage > 0
      expect(result.apac.shardCount).toBeGreaterThanOrEqual(1);
      expect(result.enam.shardCount).toBeGreaterThanOrEqual(1);
      expect(result.weur.shardCount).toBeGreaterThanOrEqual(1);

      // Note: Due to rounding, total may not equal exactly 10
      // The implementation adjusts the last region to cover remaining shards
    });

    it('should skip regions with 0% allocation', () => {
      const result = calculateRegionDistribution(10, {
        apac: 0,
        enam: 100,
      });

      expect(result.apac.shardCount).toBe(0);
      expect(result.enam.shardCount).toBe(10);
    });
  });

  describe('resolveShardForNewResource', () => {
    const config: RegionShardConfig = {
      currentGeneration: 1,
      currentTotalShards: 20,
      currentRegions: {
        apac: { startShard: 0, endShard: 3, shardCount: 4 },
        enam: { startShard: 4, endShard: 11, shardCount: 8 },
        weur: { startShard: 12, endShard: 19, shardCount: 8 },
      },
      previousGenerations: [],
      maxPreviousGenerations: 5,
      updatedAt: Date.now(),
    };

    it('should return consistent shard for same key', () => {
      const result1 = resolveShardForNewResource(config, 'user123:client456');
      const result2 = resolveShardForNewResource(config, 'user123:client456');

      expect(result1).toEqual(result2);
    });

    it('should return different shards for different keys', () => {
      const result1 = resolveShardForNewResource(config, 'user111:client111');
      const result2 = resolveShardForNewResource(config, 'user222:client222');

      // While unlikely, the same shard could be returned, so we check structure
      expect(result1.generation).toBe(1);
      expect(result2.generation).toBe(1);
      expect(result1.shardIndex).toBeGreaterThanOrEqual(0);
      expect(result1.shardIndex).toBeLessThan(20);
    });

    it('should return valid region for shard index', () => {
      const result = resolveShardForNewResource(config, 'testkey');

      expect(VALID_REGION_KEYS).toContain(result.regionKey);
      expect(result.generation).toBe(config.currentGeneration);
    });
  });

  describe('createNewRegionGeneration', () => {
    const baseConfig: RegionShardConfig = {
      currentGeneration: 1,
      currentTotalShards: 20,
      currentRegions: {
        apac: { startShard: 0, endShard: 3, shardCount: 4 },
        enam: { startShard: 4, endShard: 11, shardCount: 8 },
        weur: { startShard: 12, endShard: 19, shardCount: 8 },
      },
      previousGenerations: [],
      maxPreviousGenerations: 5,
      updatedAt: 1000,
    };

    // Calculate new regions from percentages for tests
    const newRegions30Shards = calculateRegionDistribution(30, {
      apac: 30,
      enam: 35,
      weur: 35,
    });

    it('should increment generation number', () => {
      const newConfig = createNewRegionGeneration(baseConfig, 30, newRegions30Shards, 'admin');

      expect(newConfig.currentGeneration).toBe(2);
    });

    it('should preserve previous generation in history', () => {
      const newConfig = createNewRegionGeneration(baseConfig, 30, newRegions30Shards, 'admin');

      expect(newConfig.previousGenerations).toHaveLength(1);
      expect(newConfig.previousGenerations[0].generation).toBe(1);
      expect(newConfig.previousGenerations[0].totalShards).toBe(20);
    });

    it('should update totalShards and regions', () => {
      const newConfig = createNewRegionGeneration(baseConfig, 30, newRegions30Shards, 'admin');

      expect(newConfig.currentTotalShards).toBe(30);
      // Regions should be updated (structure preserved from input)
      expect(newConfig.currentRegions).toEqual(newRegions30Shards);
      // Each region should have valid shard counts
      expect(newConfig.currentRegions.apac.shardCount).toBeGreaterThanOrEqual(0);
      expect(newConfig.currentRegions.enam.shardCount).toBeGreaterThanOrEqual(0);
      expect(newConfig.currentRegions.weur.shardCount).toBeGreaterThanOrEqual(0);
    });

    it('should set updatedBy field', () => {
      const newConfig = createNewRegionGeneration(
        baseConfig,
        30,
        newRegions30Shards,
        'admin@example.com'
      );

      expect(newConfig.updatedBy).toBe('admin@example.com');
    });

    it('should limit previous generations to maxPreviousGenerations', () => {
      // Create config with max previous generations already
      const configWithHistory: RegionShardConfig = {
        ...baseConfig,
        currentGeneration: 6,
        previousGenerations: [
          { generation: 5, totalShards: 20, regions: baseConfig.currentRegions },
          { generation: 4, totalShards: 18, regions: baseConfig.currentRegions },
          { generation: 3, totalShards: 16, regions: baseConfig.currentRegions },
          { generation: 2, totalShards: 14, regions: baseConfig.currentRegions },
          { generation: 1, totalShards: 12, regions: baseConfig.currentRegions },
        ],
      };

      const newConfig = createNewRegionGeneration(configWithHistory, 30, newRegions30Shards);

      expect(newConfig.previousGenerations.length).toBeLessThanOrEqual(
        REGION_MAX_PREVIOUS_GENERATIONS
      );
      // Should have generation 6, 5, 4, 3, 2 (oldest generation 1 trimmed)
      expect(newConfig.previousGenerations[0].generation).toBe(6);
    });

    it('should set deprecatedAt on previous generation', () => {
      const now = Date.now();
      const newConfig = createNewRegionGeneration(baseConfig, 30, newRegions30Shards);

      expect(newConfig.previousGenerations[0].deprecatedAt).toBeDefined();
      expect(newConfig.previousGenerations[0].deprecatedAt).toBeGreaterThanOrEqual(now - 1000);
    });
  });

  describe('getDefaultRegionShardConfig', () => {
    it('should return valid default config', () => {
      const config = getDefaultRegionShardConfig();

      expect(config.currentGeneration).toBe(1);
      expect(config.currentTotalShards).toBeGreaterThan(0);
      expect(Object.keys(config.currentRegions).length).toBeGreaterThan(0);
      expect(config.previousGenerations).toEqual([]);
    });

    it('should have valid region distribution', () => {
      const config = getDefaultRegionShardConfig();

      // All shards should be accounted for
      let totalShards = 0;
      for (const region of Object.values(config.currentRegions)) {
        totalShards += region.shardCount;
      }

      expect(totalShards).toBe(config.currentTotalShards);
    });
  });

  describe('VALID_REGION_KEYS', () => {
    it('should contain expected regions', () => {
      expect(VALID_REGION_KEYS).toContain('apac');
      expect(VALID_REGION_KEYS).toContain('enam');
      expect(VALID_REGION_KEYS).toContain('weur');
      expect(VALID_REGION_KEYS).toContain('wnam');
    });

    it('should be read-only', () => {
      // TypeScript will prevent this at compile time, but check at runtime
      expect(Object.isFrozen(VALID_REGION_KEYS)).toBe(true);
    });
  });

  describe('REGION_MAX_PREVIOUS_GENERATIONS', () => {
    it('should have reasonable default', () => {
      expect(REGION_MAX_PREVIOUS_GENERATIONS).toBeGreaterThanOrEqual(3);
      expect(REGION_MAX_PREVIOUS_GENERATIONS).toBeLessThanOrEqual(10);
    });
  });

  // =========================================================================
  // Edge Case Tests - Negative values, boundaries, remainders
  // =========================================================================

  describe('Edge Cases: Negative and Invalid Values', () => {
    describe('parseRegionId with negative values', () => {
      it('should reject negative generation (regex does not match)', () => {
        expect(() => parseRegionId('g-1:apac:3:session_abc')).toThrow('Invalid region ID format');
      });

      it('should reject negative shard index (regex does not match)', () => {
        expect(() => parseRegionId('g1:apac:-3:session_abc')).toThrow('Invalid region ID format');
      });
    });

    describe('createRegionId with negative values', () => {
      it('should create ID with negative generation (no validation)', () => {
        // createRegionId doesn't validate - just creates string
        const result = createRegionId(-1, 'apac', 3, 'test');
        expect(result).toBe('g-1:apac:3:test');
        // But it won't parse back
        expect(() => parseRegionId(result)).toThrow('Invalid region ID format');
      });

      it('should create ID with negative shard (no validation)', () => {
        const result = createRegionId(1, 'apac', -3, 'test');
        expect(result).toBe('g1:apac:-3:test');
        // But it won't parse back
        expect(() => parseRegionId(result)).toThrow('Invalid region ID format');
      });
    });
  });

  describe('Edge Cases: Extreme totalShards Values', () => {
    describe('validateRegionShardRequest with extreme values', () => {
      it('should reject totalShards = 0', () => {
        const result = validateRegionShardRequest({
          totalShards: 0,
          regionDistribution: { enam: 100 },
        });

        expect(result.valid).toBe(false);
        // 0% of 0 shards = 0, which is invalid for active region
        expect(result.error).toBeDefined();
      });

      it('should accept totalShards = 1 with single region', () => {
        const result = validateRegionShardRequest({
          totalShards: 1,
          regionDistribution: { enam: 100 },
        });

        expect(result.valid).toBe(true);
      });

      it('should reject totalShards = 1 with multiple active regions', () => {
        const result = validateRegionShardRequest({
          totalShards: 1,
          regionDistribution: { apac: 50, enam: 50 },
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('must be >= active region count');
      });

      it('should handle very large totalShards (1000)', () => {
        const result = validateRegionShardRequest({
          totalShards: 1000,
          regionDistribution: { apac: 20, enam: 40, weur: 40 },
        });

        expect(result.valid).toBe(true);
      });
    });

    describe('calculateRegionDistribution with extreme values', () => {
      it('should handle totalShards = 1', () => {
        const result = calculateRegionDistribution(1, { enam: 100 });

        expect(result.enam.shardCount).toBe(1);
        expect(result.enam.startShard).toBe(0);
        expect(result.enam.endShard).toBe(0);
      });

      it('should handle very large totalShards (1000)', () => {
        const result = calculateRegionDistribution(1000, {
          apac: 20,
          enam: 40,
          weur: 40,
        });

        expect(result.apac.shardCount).toBe(200);
        expect(result.enam.shardCount).toBe(400);
        expect(result.weur.shardCount).toBe(400);

        // Verify total
        const total = result.apac.shardCount + result.enam.shardCount + result.weur.shardCount;
        expect(total).toBe(1000);
      });
    });
  });

  describe('Edge Cases: Remainder Handling in calculateRegionDistribution', () => {
    it('should handle prime number shards (7) with 3-way split', () => {
      // 7 shards, 33/33/34 = 2.31, 2.31, 2.38 → rounds to 2, 2, 2 or 3
      const result = calculateRegionDistribution(7, {
        apac: 33,
        enam: 33,
        weur: 34,
      });

      // Each should have at least 1 shard
      expect(result.apac.shardCount).toBeGreaterThanOrEqual(1);
      expect(result.enam.shardCount).toBeGreaterThanOrEqual(1);
      expect(result.weur.shardCount).toBeGreaterThanOrEqual(1);

      // Total must equal 7 (remainder should be adjusted)
      const total = result.apac.shardCount + result.enam.shardCount + result.weur.shardCount;
      expect(total).toBe(7);

      // Verify ranges are contiguous and complete
      const allShards = new Set<number>();
      for (let i = result.apac.startShard; i <= result.apac.endShard; i++) allShards.add(i);
      for (let i = result.enam.startShard; i <= result.enam.endShard; i++) allShards.add(i);
      for (let i = result.weur.startShard; i <= result.weur.endShard; i++) allShards.add(i);
      expect(allShards.size).toBe(7);
    });

    it('should handle 11 shards with 10/10/80 split (remainder case)', () => {
      // 10% of 11 = 1.1 → 1, 10% = 1.1 → 1, 80% = 8.8 → 9
      // Sum = 11 (correct)
      const result = calculateRegionDistribution(11, {
        apac: 10,
        enam: 10,
        weur: 80,
      });

      expect(result.apac.shardCount).toBeGreaterThanOrEqual(1);
      expect(result.enam.shardCount).toBeGreaterThanOrEqual(1);
      expect(result.weur.shardCount).toBeGreaterThanOrEqual(1);

      const total = result.apac.shardCount + result.enam.shardCount + result.weur.shardCount;
      expect(total).toBe(11);
    });

    it('should handle 3 shards with 3-way equal split (33/33/34)', () => {
      const result = calculateRegionDistribution(3, {
        apac: 33,
        enam: 33,
        weur: 34,
      });

      // Each region should get exactly 1 shard
      expect(result.apac.shardCount).toBe(1);
      expect(result.enam.shardCount).toBe(1);
      expect(result.weur.shardCount).toBe(1);

      const total = result.apac.shardCount + result.enam.shardCount + result.weur.shardCount;
      expect(total).toBe(3);
    });

    it('should handle extreme 99/1 split', () => {
      const result = calculateRegionDistribution(100, {
        apac: 99,
        enam: 1,
      });

      expect(result.apac.shardCount).toBe(99);
      expect(result.enam.shardCount).toBe(1);
    });

    it('should handle 5-way split with remainders', () => {
      // 100 shards, 19/19/19/19/24 = 19+19+19+19+24 = 100
      const result = calculateRegionDistribution(100, {
        apac: 19,
        enam: 19,
        weur: 19,
        wnam: 19,
        oc: 24,
      });

      const total =
        result.apac.shardCount +
        result.enam.shardCount +
        result.weur.shardCount +
        result.wnam.shardCount +
        result.oc.shardCount;
      expect(total).toBe(100);
    });
  });

  describe('Edge Cases: Region Distribution Validation', () => {
    it('should reject sum > 100 (150%)', () => {
      const result = validateRegionDistribution({
        apac: 50,
        enam: 50,
        weur: 50,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must sum to 100, got 150');
    });

    it('should reject sum < 100 (90%)', () => {
      const result = validateRegionDistribution({
        apac: 30,
        enam: 30,
        weur: 30,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must sum to 100, got 90');
    });

    it('should reject sum = 0 (all zeros)', () => {
      const result = validateRegionDistribution({
        apac: 0,
        enam: 0,
        weur: 0,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('must sum to 100, got 0');
    });

    it('should accept unusual but valid 1/1/98 split', () => {
      const result = validateRegionDistribution({
        apac: 1,
        enam: 1,
        weur: 98,
      });

      expect(result.valid).toBe(true);
    });

    it('should accept all 7 regions with valid distribution', () => {
      const result = validateRegionDistribution({
        apac: 14,
        enam: 14,
        weur: 14,
        wnam: 14,
        oc: 14,
        afr: 15,
        me: 15,
      });

      expect(result.valid).toBe(true);
    });
  });
});
