/**
 * DPoP JTI Sharding Helper Tests
 *
 * Tests for region-based DPoP JTI sharding with locationHint support.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateDPoPJTITTL,
  parseDPoPJTIId,
  DPOP_JTI_SKEW_SECONDS,
  DPOP_JTI_HARD_CAP_SECONDS,
  DPOP_JTI_DEFAULT_TTL_SECONDS,
} from '../dpop-jti-sharding';
import { createRegionId, ID_PREFIX } from '../region-sharding';

describe('DPoP JTI Sharding Utilities', () => {
  describe('calculateDPoPJTITTL', () => {
    it('should add skew to token expiration', () => {
      const tokenExp = 300; // 5 minutes
      const result = calculateDPoPJTITTL(tokenExp);

      expect(result).toBe(tokenExp + DPOP_JTI_SKEW_SECONDS);
    });

    it('should cap at hard cap (1 hour)', () => {
      const tokenExp = 7200; // 2 hours
      const result = calculateDPoPJTITTL(tokenExp);

      expect(result).toBe(DPOP_JTI_HARD_CAP_SECONDS);
    });

    it('should respect server max TTL', () => {
      const tokenExp = 3600; // 1 hour
      const serverMax = 1800; // 30 minutes
      const result = calculateDPoPJTITTL(tokenExp, serverMax);

      expect(result).toBe(serverMax + DPOP_JTI_SKEW_SECONDS);
    });

    it('should use default TTL for very short expirations', () => {
      const tokenExp = 60; // 1 minute
      const result = calculateDPoPJTITTL(tokenExp);

      expect(result).toBe(tokenExp + DPOP_JTI_SKEW_SECONDS);
    });

    it('should handle edge case: token exp exactly at hard cap minus skew', () => {
      const tokenExp = DPOP_JTI_HARD_CAP_SECONDS - DPOP_JTI_SKEW_SECONDS;
      const result = calculateDPoPJTITTL(tokenExp);

      expect(result).toBe(DPOP_JTI_HARD_CAP_SECONDS);
    });
  });

  describe('Constants', () => {
    it('should have correct TTL constants', () => {
      expect(DPOP_JTI_SKEW_SECONDS).toBe(5 * 60); // 5 minutes
      expect(DPOP_JTI_HARD_CAP_SECONDS).toBe(60 * 60); // 1 hour
      expect(DPOP_JTI_DEFAULT_TTL_SECONDS).toBe(5 * 60); // 5 minutes
    });

    it('should have skew less than hard cap', () => {
      expect(DPOP_JTI_SKEW_SECONDS).toBeLessThan(DPOP_JTI_HARD_CAP_SECONDS);
    });

    it('should have correct ID prefix (dpp)', () => {
      expect(ID_PREFIX.dpop).toBe('dpp');
    });
  });

  describe('parseDPoPJTIId', () => {
    it('should parse valid JTI ID', () => {
      const id = 'g1:apac:3:dpp_test-jti-12345';
      const result = parseDPoPJTIId(id);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(1);
      expect(result!.regionKey).toBe('apac');
      expect(result!.shardIndex).toBe(3);
      expect(result!.jti).toBe('test-jti-12345');
    });

    it('should return null for non-DPoP ID', () => {
      // Session ID format
      const result = parseDPoPJTIId('g1:apac:3:ses_abc123');

      expect(result).toBeNull();
    });

    it('should return null for invalid format', () => {
      expect(parseDPoPJTIId('invalid-format')).toBeNull();
      expect(parseDPoPJTIId('')).toBeNull();
      expect(parseDPoPJTIId('g1:apac:dpp_test')).toBeNull();
    });

    it('should handle different regions', () => {
      const testCases = [
        { id: 'g1:apac:0:dpp_jti1', region: 'apac', shard: 0, jti: 'jti1' },
        { id: 'g2:weur:15:dpp_jti2', region: 'weur', shard: 15, jti: 'jti2' },
        { id: 'g3:enam:31:dpp_jti3', region: 'enam', shard: 31, jti: 'jti3' },
        // Edge cases: double-digit generation and 3-digit shard
        { id: 'g10:apac:100:dpp_jti4', region: 'apac', shard: 100, jti: 'jti4' },
        { id: 'g999:weur:999:dpp_jti5', region: 'weur', shard: 999, jti: 'jti5' },
      ];

      for (const tc of testCases) {
        const result = parseDPoPJTIId(tc.id);
        expect(result).not.toBeNull();
        expect(result!.regionKey).toBe(tc.region);
        expect(result!.shardIndex).toBe(tc.shard);
        expect(result!.jti).toBe(tc.jti);
      }
    });

    it('should handle JTI with special characters', () => {
      const jti = 'abc-123_XYZ.456';
      const id = `g1:weur:5:dpp_${jti}`;
      const result = parseDPoPJTIId(id);

      expect(result).not.toBeNull();
      expect(result!.jti).toBe(jti);
    });

    it('should handle JTI containing colons', () => {
      // Colons in JTI should be preserved (regex uses .+ which matches colons)
      const jti = 'abc:def:ghi:123';
      const id = `g1:apac:5:dpp_${jti}`;
      const result = parseDPoPJTIId(id);

      expect(result).not.toBeNull();
      expect(result!.jti).toBe(jti);
      expect(result!.generation).toBe(1);
      expect(result!.shardIndex).toBe(5);
    });
  });

  describe('DPoP JTI ID format validation', () => {
    it('should create parseable IDs', () => {
      const generation = 1;
      const regionKey = 'enam';
      const shardIndex = 12;
      const jti = 'unique-jti-value';

      const id = createRegionId(generation, regionKey, shardIndex, `dpp_${jti}`);

      const parsed = parseDPoPJTIId(id);

      expect(parsed).not.toBeNull();
      expect(parsed!.generation).toBe(generation);
      expect(parsed!.regionKey).toBe(regionKey);
      expect(parsed!.shardIndex).toBe(shardIndex);
      expect(parsed!.jti).toBe(jti);
    });

    it('should roundtrip correctly', () => {
      const testCases = [
        { gen: 1, region: 'apac', shard: 0, jti: 'simple' },
        { gen: 5, region: 'enam', shard: 31, jti: 'with-dashes-and_underscores' },
        { gen: 10, region: 'weur', shard: 15, jti: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      ];

      for (const tc of testCases) {
        const id = createRegionId(tc.gen, tc.region, tc.shard, `dpp_${tc.jti}`);
        const parsed = parseDPoPJTIId(id);

        expect(parsed!.generation).toBe(tc.gen);
        expect(parsed!.regionKey).toBe(tc.region);
        expect(parsed!.shardIndex).toBe(tc.shard);
        expect(parsed!.jti).toBe(tc.jti);
      }
    });
  });

  describe('ID prefix consistency', () => {
    it('should use 3-character prefix consistently', () => {
      // Verify the prefix is exactly 3 characters
      expect(ID_PREFIX.dpop.length).toBe(3);
      expect(ID_PREFIX.dpop).toBe('dpp');
    });

    it('should distinguish from other sharding prefixes', () => {
      // All prefixes should be unique
      const prefixes = [ID_PREFIX.dpop, ID_PREFIX.par, ID_PREFIX.device, ID_PREFIX.ciba];

      const uniquePrefixes = new Set(prefixes);
      expect(uniquePrefixes.size).toBe(prefixes.length);
    });
  });
});
