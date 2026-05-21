import { describe, expect, it, vi } from 'vitest';
import {
  classifyLoggingRewrapPriority,
  SqlLoggingRewrapJobQueue,
  shouldSkipLoggingRewrapForRetention,
} from '../rewrap-policy';

describe('logging rewrap policy', () => {
  it('prioritizes compromised and sensitive scopes ahead of default archive work', () => {
    expect(
      classifyLoggingRewrapPriority({
        logType: 'audit',
        plane: 'archive',
        compromised: true,
      })
    ).toEqual({ priority: 0, reason: 'compromised' });

    expect(
      classifyLoggingRewrapPriority({
        logType: 'webhook',
        plane: 'sensitive_detail',
      })
    ).toEqual({ priority: 10, reason: 'sensitive_detail' });

    expect(
      classifyLoggingRewrapPriority({
        logType: 'operational',
        plane: 'archive',
      })
    ).toEqual({ priority: 20, reason: 'critical_archive' });
  });

  it('skips chunks that are near retention expiry', () => {
    expect(
      shouldSkipLoggingRewrapForRetention({
        now: 1_000,
        expiresAt: 1_500,
        skipThresholdMs: 1_000,
      })
    ).toBe(true);
    expect(
      shouldSkipLoggingRewrapForRetention({
        now: 1_000,
        expiresAt: 5_000,
        skipThresholdMs: 1_000,
      })
    ).toBe(false);
  });

  it('enqueues, claims, and completes rewrap jobs through the SQL queue', async () => {
    const executor = {
      queryOne: vi.fn().mockResolvedValueOnce({
        id: 'lrw_1',
        key_registry_id: 'lkey_1',
        from_version: 1,
        to_version: 2,
        priority: 10,
        status: 'queued',
        created_at: 1_000,
        started_at: null,
        completed_at: null,
        metadata: '{"reason":"sensitive_detail"}',
      }),
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    };
    const queue = new SqlLoggingRewrapJobQueue(executor);

    const enqueued = await queue.enqueue({
      keyRegistryId: 'lkey_1',
      fromVersion: 1,
      toVersion: 2,
      priority: 10,
      metadata: { reason: 'sensitive_detail' },
      now: 1_000,
    });
    const claimed = await queue.claimNext(2_000);
    await queue.complete({
      id: 'lrw_1',
      status: 'succeeded',
      metadata: { rewrapped: 42 },
      now: 3_000,
    });

    expect(enqueued.id).toMatch(/^lrw_/);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_rewrap_jobs'),
      expect.arrayContaining(['lkey_1', 1, 2, 10, 'queued', 1_000, null, null])
    );
    expect(executor.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM logging_rewrap_jobs'),
      ['queued']
    );
    expect(claimed).toMatchObject({
      id: 'lrw_1',
      status: 'running',
      startedAt: 2_000,
      metadata: { reason: 'sensitive_detail' },
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET status = ?, completed_at = ?, metadata = ?'),
      ['succeeded', 3_000, JSON.stringify({ rewrapped: 42 }), 'lrw_1', 'running']
    );
  });
});
