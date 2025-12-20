/**
 * PAR Sharding Helper Tests
 *
 * Tests for region-based PAR (Pushed Authorization Request) sharding.
 */

import { describe, it, expect } from 'vitest';
import {
  parsePARRequestUri,
  PAR_REQUEST_URI_PREFIX,
  PAR_DEFAULT_TTL_SECONDS,
} from '../par-sharding';
import { createRegionId, ID_PREFIX } from '../region-sharding';

describe('PAR Sharding Utilities', () => {
  describe('Constants', () => {
    it('should have correct RFC 9126 URI prefix', () => {
      expect(PAR_REQUEST_URI_PREFIX).toBe('urn:ietf:params:oauth:request_uri:');
    });

    it('should have correct default TTL (60 seconds per RFC 9126)', () => {
      expect(PAR_DEFAULT_TTL_SECONDS).toBe(60);
    });

    it('should have correct ID prefix (par)', () => {
      expect(ID_PREFIX.par).toBe('par');
    });
  });

  describe('parsePARRequestUri', () => {
    it('should parse valid PAR request URI with prefix', () => {
      const uri = 'urn:ietf:params:oauth:request_uri:g1:apac:3:par_abc123-def456';
      const result = parsePARRequestUri(uri);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(1);
      expect(result!.regionKey).toBe('apac');
      expect(result!.shardIndex).toBe(3);
      expect(result!.uuid).toBe('abc123-def456');
    });

    it('should parse PAR request URI without prefix', () => {
      const uri = 'g1:apac:3:par_abc123-def456';
      const result = parsePARRequestUri(uri);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(1);
      expect(result!.regionKey).toBe('apac');
      expect(result!.shardIndex).toBe(3);
      expect(result!.uuid).toBe('abc123-def456');
    });

    it('should return null for non-PAR ID', () => {
      // DPoP JTI format
      const uri = 'urn:ietf:params:oauth:request_uri:g1:apac:3:dpp_test';
      const result = parsePARRequestUri(uri);

      expect(result).toBeNull();
    });

    it('should return null for invalid format', () => {
      expect(parsePARRequestUri('invalid-format')).toBeNull();
      expect(parsePARRequestUri('')).toBeNull();
      expect(parsePARRequestUri('urn:ietf:params:oauth:request_uri:')).toBeNull();
    });

    it('should handle different regions', () => {
      const testCases = [
        { uri: 'g1:apac:0:par_uuid1', region: 'apac', shard: 0 },
        { uri: 'g2:weur:15:par_uuid2', region: 'weur', shard: 15 },
        { uri: 'g3:enam:31:par_uuid3', region: 'enam', shard: 31 },
        // Edge cases: double-digit generation and 3-digit shard
        { uri: 'g10:apac:100:par_uuid4', region: 'apac', shard: 100 },
        { uri: 'g999:weur:999:par_uuid5', region: 'weur', shard: 999 },
      ];

      for (const tc of testCases) {
        const result = parsePARRequestUri(tc.uri);
        expect(result).not.toBeNull();
        expect(result!.regionKey).toBe(tc.region);
        expect(result!.shardIndex).toBe(tc.shard);
      }
    });

    it('should handle UUID with hyphens', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const uri = `${PAR_REQUEST_URI_PREFIX}g1:apac:5:par_${uuid}`;
      const result = parsePARRequestUri(uri);

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(uuid);
    });
  });

  describe('PAR request URI format validation', () => {
    it('should create parseable URIs', () => {
      // Simulate what generatePARRequestUri would create
      const generation = 1;
      const regionKey = 'weur';
      const shardIndex = 7;
      const uuid = 'test-uuid-12345';

      const internalId = createRegionId(generation, regionKey, shardIndex, `par_${uuid}`);
      const requestUri = `${PAR_REQUEST_URI_PREFIX}${internalId}`;

      const parsed = parsePARRequestUri(requestUri);

      expect(parsed).not.toBeNull();
      expect(parsed!.generation).toBe(generation);
      expect(parsed!.regionKey).toBe(regionKey);
      expect(parsed!.shardIndex).toBe(shardIndex);
      expect(parsed!.uuid).toBe(uuid);
    });

    it('should roundtrip correctly', () => {
      const testCases = [
        { gen: 1, region: 'apac', shard: 0, uuid: 'uuid1' },
        { gen: 5, region: 'enam', shard: 31, uuid: 'uuid-with-dashes' },
        { gen: 10, region: 'weur', shard: 15, uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      ];

      for (const tc of testCases) {
        const internalId = createRegionId(tc.gen, tc.region, tc.shard, `par_${tc.uuid}`);
        const requestUri = `${PAR_REQUEST_URI_PREFIX}${internalId}`;
        const parsed = parsePARRequestUri(requestUri);

        expect(parsed!.generation).toBe(tc.gen);
        expect(parsed!.regionKey).toBe(tc.region);
        expect(parsed!.shardIndex).toBe(tc.shard);
        expect(parsed!.uuid).toBe(tc.uuid);
      }
    });
  });
});
