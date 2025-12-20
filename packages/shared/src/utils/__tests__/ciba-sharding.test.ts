/**
 * CIBA Sharding Helper Tests
 *
 * Tests for region-based CIBA (Client-Initiated Backchannel Authentication) sharding.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCIBARequestId,
  CIBA_DEFAULT_TTL_SECONDS,
  CIBA_DEFAULT_INTERVAL_SECONDS,
} from '../ciba-sharding';
import { createRegionId, ID_PREFIX } from '../region-sharding';

describe('CIBA Sharding Utilities', () => {
  describe('Constants', () => {
    it('should have correct default TTL (5 minutes)', () => {
      expect(CIBA_DEFAULT_TTL_SECONDS).toBe(300);
    });

    it('should have correct default polling interval (5 seconds)', () => {
      expect(CIBA_DEFAULT_INTERVAL_SECONDS).toBe(5);
    });

    it('should have correct ID prefix (cba)', () => {
      expect(ID_PREFIX.ciba).toBe('cba');
    });
  });

  describe('parseCIBARequestId', () => {
    it('should parse valid CIBA request ID', () => {
      const id = 'g1:apac:3:cba_auth-req-12345-abcde';
      const result = parseCIBARequestId(id);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(1);
      expect(result!.regionKey).toBe('apac');
      expect(result!.shardIndex).toBe(3);
      expect(result!.authReqId).toBe('auth-req-12345-abcde');
    });

    it('should return null for non-CIBA ID', () => {
      // Device code ID format
      const id = 'g1:apac:3:dev_abc123';
      const result = parseCIBARequestId(id);

      expect(result).toBeNull();
    });

    it('should return null for invalid format', () => {
      expect(parseCIBARequestId('invalid-format')).toBeNull();
      expect(parseCIBARequestId('')).toBeNull();
      expect(parseCIBARequestId('g1:apac:cba_test')).toBeNull();
    });

    it('should handle different regions', () => {
      const testCases = [
        { id: 'g1:apac:0:cba_req1', region: 'apac', shard: 0, reqId: 'req1' },
        { id: 'g2:weur:15:cba_req2', region: 'weur', shard: 15, reqId: 'req2' },
        { id: 'g3:enam:31:cba_req3', region: 'enam', shard: 31, reqId: 'req3' },
        // Edge cases: double-digit generation and 3-digit shard
        { id: 'g10:apac:100:cba_req4', region: 'apac', shard: 100, reqId: 'req4' },
        { id: 'g999:weur:999:cba_req5', region: 'weur', shard: 999, reqId: 'req5' },
      ];

      for (const tc of testCases) {
        const result = parseCIBARequestId(tc.id);
        expect(result).not.toBeNull();
        expect(result!.regionKey).toBe(tc.region);
        expect(result!.shardIndex).toBe(tc.shard);
        expect(result!.authReqId).toBe(tc.reqId);
      }
    });

    it('should handle auth_req_id with special characters', () => {
      const authReqId = 'abc-123_XYZ.456';
      const id = `g1:weur:5:cba_${authReqId}`;
      const result = parseCIBARequestId(id);

      expect(result).not.toBeNull();
      expect(result!.authReqId).toBe(authReqId);
    });
  });

  describe('CIBA request ID format validation', () => {
    it('should create parseable IDs', () => {
      const generation = 1;
      const regionKey = 'enam';
      const shardIndex = 12;
      const authReqId = 'ciba-auth-req-uuid';

      const id = createRegionId(generation, regionKey, shardIndex, `cba_${authReqId}`);

      const parsed = parseCIBARequestId(id);

      expect(parsed).not.toBeNull();
      expect(parsed!.generation).toBe(generation);
      expect(parsed!.regionKey).toBe(regionKey);
      expect(parsed!.shardIndex).toBe(shardIndex);
      expect(parsed!.authReqId).toBe(authReqId);
    });

    it('should roundtrip correctly', () => {
      const testCases = [
        { gen: 1, region: 'apac', shard: 0, reqId: 'simple' },
        { gen: 5, region: 'enam', shard: 31, reqId: 'with-dashes-and_underscores' },
        { gen: 10, region: 'weur', shard: 15, reqId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      ];

      for (const tc of testCases) {
        const id = createRegionId(tc.gen, tc.region, tc.shard, `cba_${tc.reqId}`);
        const parsed = parseCIBARequestId(id);

        expect(parsed!.generation).toBe(tc.gen);
        expect(parsed!.regionKey).toBe(tc.region);
        expect(parsed!.shardIndex).toBe(tc.shard);
        expect(parsed!.authReqId).toBe(tc.reqId);
      }
    });
  });

  describe('ID prefix consistency', () => {
    it('should use 3-character prefix consistently', () => {
      // Verify the prefix is exactly 3 characters
      expect(ID_PREFIX.ciba.length).toBe(3);
      expect(ID_PREFIX.ciba).toBe('cba');
    });

    it('should distinguish from other sharding prefixes', () => {
      // All prefixes should be unique
      const prefixes = [ID_PREFIX.dpop, ID_PREFIX.par, ID_PREFIX.device, ID_PREFIX.ciba];

      const uniquePrefixes = new Set(prefixes);
      expect(uniquePrefixes.size).toBe(prefixes.length);
    });
  });
});
