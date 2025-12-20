/**
 * Device Code Sharding Helper Tests
 *
 * Tests for region-based Device Code (RFC 8628) sharding.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDeviceCodeId,
  DEVICE_CODE_DEFAULT_TTL_SECONDS,
  DEVICE_CODE_DEFAULT_INTERVAL_SECONDS,
} from '../device-code-sharding';
import { createRegionId, ID_PREFIX } from '../region-sharding';

describe('Device Code Sharding Utilities', () => {
  describe('Constants', () => {
    it('should have correct RFC 8628 TTL (10 minutes)', () => {
      expect(DEVICE_CODE_DEFAULT_TTL_SECONDS).toBe(600);
    });

    it('should have correct RFC 8628 polling interval (5 seconds)', () => {
      expect(DEVICE_CODE_DEFAULT_INTERVAL_SECONDS).toBe(5);
    });

    it('should have correct ID prefix (dev)', () => {
      expect(ID_PREFIX.device).toBe('dev');
    });
  });

  describe('parseDeviceCodeId', () => {
    it('should parse valid device code ID', () => {
      const id = 'g1:apac:3:dev_GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIyS';
      const result = parseDeviceCodeId(id);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(1);
      expect(result!.regionKey).toBe('apac');
      expect(result!.shardIndex).toBe(3);
      expect(result!.deviceCode).toBe('GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIyS');
    });

    it('should return null for non-device-code ID', () => {
      // PAR ID format
      const id = 'g1:apac:3:par_abc123';
      const result = parseDeviceCodeId(id);

      expect(result).toBeNull();
    });

    it('should return null for invalid format', () => {
      expect(parseDeviceCodeId('invalid-format')).toBeNull();
      expect(parseDeviceCodeId('')).toBeNull();
      expect(parseDeviceCodeId('g1:apac:dev_test')).toBeNull();
    });

    it('should handle different regions', () => {
      const testCases = [
        { id: 'g1:apac:0:dev_code1', region: 'apac', shard: 0, code: 'code1' },
        { id: 'g2:weur:15:dev_code2', region: 'weur', shard: 15, code: 'code2' },
        { id: 'g3:enam:31:dev_code3', region: 'enam', shard: 31, code: 'code3' },
        // Edge cases: double-digit generation and 3-digit shard
        { id: 'g10:apac:100:dev_code4', region: 'apac', shard: 100, code: 'code4' },
        { id: 'g999:weur:999:dev_code5', region: 'weur', shard: 999, code: 'code5' },
      ];

      for (const tc of testCases) {
        const result = parseDeviceCodeId(tc.id);
        expect(result).not.toBeNull();
        expect(result!.regionKey).toBe(tc.region);
        expect(result!.shardIndex).toBe(tc.shard);
        expect(result!.deviceCode).toBe(tc.code);
      }
    });

    it('should handle device code with special characters', () => {
      const deviceCode = 'Abc123_XYZ-789.test';
      const id = `g1:weur:5:dev_${deviceCode}`;
      const result = parseDeviceCodeId(id);

      expect(result).not.toBeNull();
      expect(result!.deviceCode).toBe(deviceCode);
    });
  });

  describe('Device code ID format validation', () => {
    it('should create parseable IDs', () => {
      const generation = 1;
      const regionKey = 'enam';
      const shardIndex = 12;
      const deviceCode = 'ABCD-1234-EFGH-5678';

      const id = createRegionId(generation, regionKey, shardIndex, `dev_${deviceCode}`);

      const parsed = parseDeviceCodeId(id);

      expect(parsed).not.toBeNull();
      expect(parsed!.generation).toBe(generation);
      expect(parsed!.regionKey).toBe(regionKey);
      expect(parsed!.shardIndex).toBe(shardIndex);
      expect(parsed!.deviceCode).toBe(deviceCode);
    });

    it('should roundtrip correctly', () => {
      const testCases = [
        { gen: 1, region: 'apac', shard: 0, code: 'simple' },
        { gen: 5, region: 'enam', shard: 31, code: 'with-dashes-and_underscores' },
        { gen: 10, region: 'weur', shard: 15, code: 'GmRhmhcxhwAzkoEqiMEg' },
      ];

      for (const tc of testCases) {
        const id = createRegionId(tc.gen, tc.region, tc.shard, `dev_${tc.code}`);
        const parsed = parseDeviceCodeId(id);

        expect(parsed!.generation).toBe(tc.gen);
        expect(parsed!.regionKey).toBe(tc.region);
        expect(parsed!.shardIndex).toBe(tc.shard);
        expect(parsed!.deviceCode).toBe(tc.code);
      }
    });
  });
});
