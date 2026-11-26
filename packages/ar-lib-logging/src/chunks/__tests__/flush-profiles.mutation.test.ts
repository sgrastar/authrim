import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_CHUNK_FLUSH_PROFILES,
  resolveLogChunkFlushProfile,
  shouldFlushLogChunk,
} from '../flush-profiles';

const MIB = 1024 * 1024;
const MIN = 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe('the flush profiles', () => {
  it('give each profile its limits', () => {
    expect(LOG_CHUNK_FLUSH_PROFILES).toStrictEqual({
      critical: {
        name: 'critical',
        maxRecords: 1000,
        maxBytes: 4 * MIB,
        maxIntervalMs: MIN,
        compression: 'gzip_block',
      },
      default: {
        name: 'default',
        maxRecords: 5000,
        maxBytes: 16 * MIB,
        maxIntervalMs: 5 * MIN,
        compression: 'gzip_block',
      },
      low_volume: {
        name: 'low_volume',
        maxRecords: 1000,
        maxBytes: 4 * MIB,
        maxIntervalMs: 15 * MIN,
        compression: 'gzip_block',
      },
      bulk: {
        name: 'bulk',
        maxRecords: 10000,
        maxBytes: 32 * MIB,
        maxIntervalMs: 15 * MIN,
        compression: 'gzip_block',
      },
      high_volume: {
        name: 'high_volume',
        maxRecords: 5000,
        maxBytes: 16 * MIB,
        maxIntervalMs: MIN,
        compression: 'gzip_block',
      },
    });
  });
});

describe('resolveLogChunkFlushProfile', () => {
  const name = (input: Parameters<typeof resolveLogChunkFlushProfile>[0]) =>
    resolveLogChunkFlushProfile(input).name;

  it('picks the high volume profile from 5000 records a minute, whatever the type', () => {
    expect(name({ logType: 'normal', plane: 'archive', estimatedRecordsPerMinute: 5000 })).toBe(
      'high_volume'
    );
    expect(name({ logType: 'audit', plane: 'archive', estimatedRecordsPerMinute: 99_999 })).toBe(
      'high_volume'
    );
    expect(name({ logType: 'normal', plane: 'archive', estimatedRecordsPerMinute: 4999 })).toBe(
      'default'
    );
    expect(name({ logType: 'audit', plane: 'archive', estimatedRecordsPerMinute: 4999 })).toBe(
      'critical'
    );
  });

  it('treats audit, admin audit, security and pii logs and sensitive details as critical', () => {
    for (const logType of ['audit', 'admin_audit', 'security', 'pii'] as const) {
      expect(name({ logType, plane: 'archive' })).toBe('critical');
      expect(name({ logType, plane: 'archive', estimatedRecordsPerMinute: 1 })).toBe('critical');
    }
    expect(name({ logType: 'normal', plane: 'sensitive_detail' })).toBe('critical');
    expect(name({ logType: 'diagnostic', plane: 'sensitive_detail' })).toBe('critical');
  });

  it('treats diagnostic logs and diagnostic details as bulk', () => {
    expect(name({ logType: 'diagnostic', plane: 'archive' })).toBe('bulk');
    expect(name({ logType: 'normal', plane: 'diagnostic_detail' })).toBe('bulk');
    expect(name({ logType: 'diagnostic', plane: 'archive', estimatedRecordsPerMinute: 1 })).toBe(
      'bulk'
    );
  });

  it('is low volume at 10 records a minute or fewer, and the default otherwise or when unknown', () => {
    expect(name({ logType: 'job', plane: 'archive', estimatedRecordsPerMinute: 0 })).toBe(
      'low_volume'
    );
    expect(name({ logType: 'job', plane: 'archive', estimatedRecordsPerMinute: 10 })).toBe(
      'low_volume'
    );
    expect(name({ logType: 'job', plane: 'archive', estimatedRecordsPerMinute: 11 })).toBe(
      'default'
    );
    expect(name({ logType: 'job', plane: 'archive' })).toBe('default');
    expect(
      name({ logType: 'webhook', plane: 'primary', estimatedRecordsPerMinute: undefined })
    ).toBe('default');
  });
});

describe('shouldFlushLogChunk', () => {
  const profile = {
    name: 'default',
    maxRecords: 10,
    maxBytes: 100,
    maxIntervalMs: 1000,
    compression: 'none',
  } as const;
  const flush = (input: Partial<Parameters<typeof shouldFlushLogChunk>[0]>) =>
    shouldFlushLogChunk({
      profile,
      pendingRecords: 1,
      pendingBytes: 1,
      oldestPendingAt: 0,
      now: 0,
      ...input,
    });

  it('never flushes nothing', () => {
    expect(flush({ pendingRecords: 0, pendingBytes: 1e9, oldestPendingAt: 0, now: 1e9 })).toBe(
      false
    );
    expect(flush({ pendingRecords: -1, pendingBytes: 1e9, now: 1e9 })).toBe(false);
  });

  it('flushes at the record limit, the byte limit or the age limit, exactly', () => {
    expect(flush({ pendingRecords: 9 })).toBe(false);
    expect(flush({ pendingRecords: 10 })).toBe(true);
    expect(flush({ pendingBytes: 99 })).toBe(false);
    expect(flush({ pendingBytes: 100 })).toBe(true);
    expect(flush({ now: 999 })).toBe(false);
    expect(flush({ now: 1000 })).toBe(true);
    expect(flush({ oldestPendingAt: 500, now: 1499 })).toBe(false);
    expect(flush({ oldestPendingAt: 500, now: 1500 })).toBe(true);
  });

  it('cannot judge age without an oldest record', () => {
    expect(flush({ oldestPendingAt: null, now: 1e9 })).toBe(false);
    expect(flush({ oldestPendingAt: null, pendingRecords: 10 })).toBe(true);
    expect(flush({ oldestPendingAt: 0, now: 1000 })).toBe(true);
  });

  it('reads the clock when no time is given', () => {
    const clock = Date.UTC(2025, 0, 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    expect(flush({ oldestPendingAt: clock - 5000, now: undefined })).toBe(true);
    expect(flush({ oldestPendingAt: clock + 60_000, now: undefined })).toBe(false);
  });
});
