import { describe, expect, it } from 'vitest';

import {
  LOGGING_TIME_UNITS,
  LOG_CHUNK_COMPRESSION,
  LOG_PLANES,
  LOG_TYPES,
  assertLogPlane,
  assertLogType,
  createLoggingId,
  createOpaqueTenantKey,
  createUuidV7,
  deriveTenantKeyFromTenantId,
  floorTimeBucket,
  formatUtcPartition,
  nowEpochMs,
} from '@authrim/ar-lib-logging/contract';
import * as publicContract from '@authrim/ar-lib-logging/contract';

describe('public logging contract', () => {
  it('exposes only contract values through the public contract entrypoint', () => {
    expect(Object.keys(publicContract).sort()).toEqual([
      'LOGGING_TIME_UNITS',
      'LOG_CHUNK_COMPRESSION',
      'LOG_PLANES',
      'LOG_TYPES',
      'assertLogPlane',
      'assertLogType',
      'createLoggingId',
      'createOpaqueTenantKey',
      'createUuidV7',
      'deriveTenantKeyFromTenantId',
      'floorTimeBucket',
      'formatUtcPartition',
      'nowEpochMs',
    ]);
  });

  it('preserves the UUIDv7 byte layout and logging id prefix', () => {
    expect(createUuidV7(1_700_000_000_000, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(
      '018bcfe5-6800-7001-8203-040506070809'
    );
    expect(createLoggingId('lmj', 1_700_000_000_000)).toMatch(
      /^lmj_018bcfe5-6800-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  });

  it('preserves tenant key normalization, salting, and digest encoding', async () => {
    await expect(deriveTenantKeyFromTenantId(' tenant-authrim ', 'salt-v1')).resolves.toBe(
      't_41c5k7NT6OSUT4-t37XNQM1Mw03HP7uU'
    );
    await expect(deriveTenantKeyFromTenantId('tenant-authrim')).resolves.toBe(
      't_9rJrnhrk4nZmXwpiIFA9TqiLH3XPHvfB'
    );
    await expect(deriveTenantKeyFromTenantId('   ')).rejects.toThrow('tenant_id_required');
  });

  it('preserves UTC partitions, bucket flooring, and registry validation', () => {
    const epochMs = Date.parse('2026-05-19T23:59:58.765Z');

    expect(LOGGING_TIME_UNITS).toBe('epoch_ms');
    expect(floorTimeBucket(epochMs, 5 * 60 * 1000)).toBe(Date.parse('2026-05-19T23:55:00.000Z'));
    expect(formatUtcPartition(epochMs)).toEqual({
      year: '2026',
      month: '05',
      day: '19',
      hour: '23',
    });
    expect(() => assertLogType('audit')).not.toThrow();
    expect(() => assertLogPlane('archive')).not.toThrow();
    expect(() => assertLogType('unknown')).toThrow('unsupported_log_type:unknown');
    expect(() => assertLogPlane('unknown')).toThrow('unsupported_log_plane:unknown');
  });
});
