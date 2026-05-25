import { describe, expect, it } from 'vitest';

import { resolveLogChunkFlushProfile, shouldFlushLogChunk } from '../flush-profiles';

describe('log chunk flush profiles', () => {
  it('uses critical profile for audit, security, PII, and sensitive detail chunks', () => {
    expect(resolveLogChunkFlushProfile({ logType: 'audit', plane: 'archive' }).name).toBe(
      'critical'
    );
    expect(resolveLogChunkFlushProfile({ logType: 'security', plane: 'primary' }).name).toBe(
      'critical'
    );
    expect(resolveLogChunkFlushProfile({ logType: 'normal', plane: 'sensitive_detail' }).name).toBe(
      'critical'
    );
  });

  it('uses bulk and high-volume profiles for diagnostic or high-throughput streams', () => {
    expect(resolveLogChunkFlushProfile({ logType: 'diagnostic', plane: 'archive' }).name).toBe(
      'bulk'
    );
    expect(
      resolveLogChunkFlushProfile({
        logType: 'diagnostic',
        plane: 'archive',
        estimatedRecordsPerMinute: 5000,
      }).name
    ).toBe('high_volume');
  });

  it('uses low-volume profile only when low throughput is explicit', () => {
    expect(resolveLogChunkFlushProfile({ logType: 'normal', plane: 'archive' }).name).toBe(
      'default'
    );
    expect(
      resolveLogChunkFlushProfile({
        logType: 'normal',
        plane: 'archive',
        estimatedRecordsPerMinute: 5,
      }).name
    ).toBe('low_volume');
  });

  it('keeps profile thresholds aligned with the logging storage specification', () => {
    expect(resolveLogChunkFlushProfile({ logType: 'audit', plane: 'archive' })).toMatchObject({
      maxRecords: 1000,
      maxBytes: 4 * 1024 * 1024,
      maxIntervalMs: 60 * 1000,
    });
    expect(resolveLogChunkFlushProfile({ logType: 'normal', plane: 'archive' })).toMatchObject({
      maxRecords: 5000,
      maxBytes: 16 * 1024 * 1024,
      maxIntervalMs: 5 * 60 * 1000,
    });
    expect(resolveLogChunkFlushProfile({ logType: 'diagnostic', plane: 'archive' })).toMatchObject({
      maxRecords: 10000,
      maxBytes: 32 * 1024 * 1024,
      maxIntervalMs: 15 * 60 * 1000,
    });
  });

  it('flushes when record, byte, or age thresholds are reached', () => {
    const profile = resolveLogChunkFlushProfile({ logType: 'audit', plane: 'archive' });

    expect(
      shouldFlushLogChunk({
        profile,
        pendingRecords: profile.maxRecords,
        pendingBytes: 1,
        oldestPendingAt: null,
      })
    ).toBe(true);
    expect(
      shouldFlushLogChunk({
        profile,
        pendingRecords: 1,
        pendingBytes: profile.maxBytes,
        oldestPendingAt: null,
      })
    ).toBe(true);
    expect(
      shouldFlushLogChunk({
        profile,
        pendingRecords: 1,
        pendingBytes: 1,
        oldestPendingAt: 1000,
        now: 1000 + profile.maxIntervalMs,
      })
    ).toBe(true);
  });

  it('does not flush empty or under-threshold chunks', () => {
    const profile = resolveLogChunkFlushProfile({ logType: 'normal', plane: 'archive' });

    expect(
      shouldFlushLogChunk({
        profile,
        pendingRecords: 0,
        pendingBytes: profile.maxBytes,
        oldestPendingAt: 1000,
        now: 1000 + profile.maxIntervalMs,
      })
    ).toBe(false);
    expect(
      shouldFlushLogChunk({
        profile,
        pendingRecords: 1,
        pendingBytes: 1,
        oldestPendingAt: 1000,
        now: 1000 + profile.maxIntervalMs - 1,
      })
    ).toBe(false);
  });
});
