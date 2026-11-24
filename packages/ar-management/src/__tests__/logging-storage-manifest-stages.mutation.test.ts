/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- SQL parameter arrays and vi fakes are untyped in these maintenance job tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mockAdapter = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
  };
  adapter.transaction.mockImplementation(async (callback) => callback(adapter));
  adapter.batch.mockImplementation(async (statements: { sql: string; params?: unknown[] }[]) => {
    const results: unknown[] = [];
    for (const statement of statements) {
      results.push(await adapter.execute(statement.sql, statement.params));
    }
    return results;
  });
  return adapter;
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter) };
});

import {
  processLoggingStorageMaintenanceJobs,
  runScheduledRetiredR2GenerationCleanup,
} from '../logging-storage-maintenance-jobs';
import { must } from './helpers/must';

const HOUR = 60 * 60 * 1000;
// 2026-05-21T14:20:00Z: the 12:00-13:00 bucket ended more than five minutes ago, 13:00 did not.
const NOW = Date.UTC(2026, 4, 21, 14, 20);
const BUCKET_START = Date.UTC(2026, 4, 21, 12);

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chk_1',
    tenant_key: 't_a',
    log_type: 'audit',
    plane: 'archive',
    object_key: 'logs/t_a/chunk-1.jsonl',
    record_count: 2,
    byte_count: 200,
    checksum_sha256: 'sha256:chunk',
    committed_at: BUCKET_START + 10 * 60 * 1000,
    ...overrides,
  };
}

describe('scheduled chunk manifest publishing', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  let chunks: unknown[];
  let existingManifest: boolean;
  let updateRowsAffected: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    chunks = [];
    existingManifest = false;
    updateRowsAffected = 1;
    mockAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes("object_kind = 'chunk'") ? chunks : []
    );
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM log_chunk_manifests'))
        return existingManifest ? { id: 'man_1' } : null;
      if (sql.includes('FROM internal_notification_events')) return null;
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string) =>
      String(sql).includes('UPDATE log_chunk_manifests')
        ? { rowsAffected: updateRowsAffected }
        : { rowsAffected: 1 }
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const buckets = () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bucket = { put };
    return { put, env: { AUDIT_ARCHIVE: bucket } as unknown as Env };
  };
  const notifications = () =>
    mockAdapter.execute.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO internal_notification_events'))
      .map(([, params]) => params as unknown[]);

  it('selects committed, checksummed chunks at least five minutes old, oldest first', async () => {
    await processLoggingStorageMaintenanceJobs({} as Env, log);
    const call = must(
      mockAdapter.query.mock.calls.find(([sql]) => String(sql).includes("object_kind = 'chunk'"))
    );
    expect(call[1]).toEqual([NOW - 5 * 60 * 1000, 500]);
    expect(String(call[0])).toContain('ORDER BY committed_at ASC, id ASC');
  });

  it('publishes one manifest per hour bucket and records it in the catalog', async () => {
    chunks = [
      chunk(),
      chunk({
        id: 'chk_2',
        object_key: 'logs/t_a/chunk-2.jsonl',
        committed_at: BUCKET_START + HOUR - 1,
      }),
    ];
    const { put, env } = buckets();
    const result = await processLoggingStorageMaintenanceJobs(env, log);
    expect(result.manifests).toEqual({ published: 1, skipped: 0 });
    expect(put).toHaveBeenCalledTimes(1);
    const update = must(
      mockAdapter.execute.mock.calls.find(([sql]) =>
        String(sql).includes('UPDATE log_chunk_manifests')
      )
    );
    const params = update[1] as unknown[];
    // chunk_count, record_count, status, then the natural key of the manifest row.
    expect(params.slice(1, 2)).toEqual([BUCKET_START + HOUR]);
    expect(params.slice(3, 5)).toEqual([2, 4]);
    expect(params[6]).toBe('committed');
    expect(params.slice(8, 12)).toEqual(['t_a', 'audit', 'archive', BUCKET_START]);
    expect(
      mockAdapter.execute.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO log_chunk_manifests')
      )
    ).toBe(false);
  });

  it('inserts the manifest row when there is nothing to update', async () => {
    chunks = [chunk()];
    updateRowsAffected = 0;
    const { env } = buckets();
    await processLoggingStorageMaintenanceJobs(env, log);
    const insert = must(
      mockAdapter.execute.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO log_chunk_manifests')
      )
    );
    const params = insert[1] as unknown[];
    expect(params.slice(1, 4)).toEqual(['t_a', 'audit', 'archive']);
    expect(params.slice(4, 6)).toEqual([BUCKET_START, BUCKET_START + HOUR]);
    expect(params.slice(8, 10)).toEqual([1, 2]);
    expect(params[11]).toBe('committed');
    expect(params.slice(12, 14)).toEqual([NOW, NOW]);
  });

  it('keeps separate manifests per tenant, log type and plane', async () => {
    chunks = [
      chunk(),
      chunk({ id: 'chk_2', tenant_key: 't_b' }),
      chunk({ id: 'chk_3', log_type: 'security' }),
      chunk({ id: 'chk_4', plane: 'diagnostic_detail' }),
    ];
    const archive = vi.fn().mockResolvedValue(undefined);
    const diagnostic = vi.fn().mockResolvedValue(undefined);
    const result = await processLoggingStorageMaintenanceJobs(
      {
        AUDIT_ARCHIVE: { put: archive },
        DIAGNOSTIC_LOGS: { put: diagnostic },
      } as unknown as Env,
      log
    );
    expect(result.manifests).toEqual({ published: 4, skipped: 0 });
    expect(archive).toHaveBeenCalledTimes(3);
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });

  it('writes sensitive-detail manifests to the sensitive-detail bucket', async () => {
    chunks = [chunk({ plane: 'sensitive_detail' })];
    const sensitive = vi.fn().mockResolvedValue(undefined);
    const archive = vi.fn().mockResolvedValue(undefined);
    await processLoggingStorageMaintenanceJobs(
      { SENSITIVE_DETAILS: { put: sensitive }, AUDIT_ARCHIVE: { put: archive } } as unknown as Env,
      log
    );
    expect(sensitive).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
  });

  it('leaves a bucket that is not yet closed for a later run', async () => {
    chunks = [chunk({ committed_at: Date.UTC(2026, 4, 21, 14, 10) })];
    const { put, env } = buckets();
    const result = await processLoggingStorageMaintenanceJobs(env, log);
    expect(result.manifests).toEqual({ published: 0, skipped: 0 });
    expect(put).not.toHaveBeenCalled();
  });

  it('publishes a bucket that has closed, but not the one still open', async () => {
    // Bucket 13:00-14:00 closed before now - 5 min (14:15); 14:00-15:00 is still open.
    chunks = [
      chunk({ committed_at: Date.UTC(2026, 4, 21, 13, 59, 59) }),
      chunk({ id: 'chk_late', committed_at: Date.UTC(2026, 4, 21, 14, 0, 1) }),
    ];
    const { put, env } = buckets();
    const result = await processLoggingStorageMaintenanceJobs(env, log);
    expect(result.manifests).toEqual({ published: 1, skipped: 0 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('skips a bucket that already has a committed manifest', async () => {
    chunks = [chunk()];
    existingManifest = true;
    const { put, env } = buckets();
    const result = await processLoggingStorageMaintenanceJobs(env, log);
    expect(result.manifests).toEqual({ published: 0, skipped: 1 });
    expect(put).not.toHaveBeenCalled();
    expect(notifications()).toHaveLength(0);
    const lookup = must(
      mockAdapter.queryOne.mock.calls.find(([sql]) =>
        String(sql).includes('FROM log_chunk_manifests')
      )
    );
    expect((lookup[1] as unknown[]).slice(0, 4)).toEqual(['t_a', 'audit', 'archive', BUCKET_START]);
  });

  it('notifies and warns when the bucket is missing and the notification cannot be queued', async () => {
    chunks = [chunk()];
    mockAdapter.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO internal_notification_events'))
        throw new Error('queue down');
      return { rowsAffected: 1 };
    });
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(result.manifests).toEqual({ published: 0, skipped: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      'Logging manifest publish failure notification enqueue failed',
      { tenantKey: 't_a', logType: 'audit', plane: 'archive', error: 'queue down' }
    );
  });

  it('reports a failed upload with its message and keeps going', async () => {
    chunks = [chunk(), chunk({ id: 'chk_b', tenant_key: 't_b' })];
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error('r2 exploded'))
      .mockResolvedValue(undefined);
    const result = await processLoggingStorageMaintenanceJobs(
      { AUDIT_ARCHIVE: { put } } as unknown as Env,
      log
    );
    expect(result.manifests).toEqual({ published: 1, skipped: 1 });
    const sent = notifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('t_a');
    expect(sent[0]).toContain('logging.manifest.publish.failed');
    const payload = JSON.parse(
      sent[0].find(
        (p) => typeof p === 'string' && p.startsWith('{') && p.includes('manifest_publish_failed')
      ) as string
    );
    expect(payload).toMatchObject({
      tenant_key: 't_a',
      log_type: 'audit',
      plane: 'archive',
      bucket_start_at: BUCKET_START,
      bucket_end_at: BUCKET_START + HOUR,
      error_class: 'manifest_publish_failed',
      message: 'r2 exploded',
    });
  });

  it('warns when a failed upload cannot even be reported', async () => {
    chunks = [chunk()];
    const put = vi.fn().mockRejectedValue('not an error object');
    mockAdapter.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO internal_notification_events')) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- covers non-Error rejections
        throw 'string failure';
      }
      return { rowsAffected: 1 };
    });
    const result = await processLoggingStorageMaintenanceJobs(
      { AUDIT_ARCHIVE: { put } } as unknown as Env,
      log
    );
    expect(result.manifests).toEqual({ published: 0, skipped: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      'Logging manifest publish failure notification enqueue failed',
      { tenantKey: 't_a', logType: 'audit', plane: 'archive', error: 'unknown_error' }
    );
  });
});

describe('scheduler stage isolation and cleanup guards', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs every failing stage separately and returns zeroed results', async () => {
    mockAdapter.query.mockRejectedValue(new Error('db down'));
    mockAdapter.queryOne.mockRejectedValue(new Error('db down'));
    mockAdapter.execute.mockRejectedValue(new Error('db down'));
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    const messages = log.error.mock.calls.map(([message]) => message);
    expect(messages).toEqual([
      'Logging destination scheduled health checks failed',
      'Logging chunk manifest scheduled publish failed',
      'Logging catalog scheduled safe repair failed',
      'Logging key rewrap dispatch failed',
      'Logging message job scheduled processing failed',
      'Logging usage/quota scheduled maintenance failed',
      'Logging delivery event retention failed',
      'Retired R2 generation cleanup failed',
    ]);
    for (const [, context, error] of log.error.mock.calls) {
      expect(context).toEqual({});
      expect((error as Error).message).toBe('db down');
    }
    expect(result).toEqual({
      healthChecks: { checked: 0, failed: 0 },
      manifests: { published: 0, skipped: 0 },
      catalogRepair: { findings: 0, applied: 0, skipped: 0 },
      rewrap: { candidates: 0, jobsCreated: 0, dispatched: 0, queueUnavailable: 0, skipped: 0 },
      messageJobs: {
        repaired: 0,
        repairFindings: 0,
        expired: 0,
        claimed: 0,
        completed: 0,
        retrying: 0,
        dlq: 0,
        blocked: 0,
      },
      retention: { deliveryEventsDeleted: 0, deliveryAggregatesDeleted: 0, dlqItemsPurged: 0 },
      usage: {
        windowsRefreshed: 0,
        aggregatesRefreshed: 0,
        quotaPoliciesEvaluated: 0,
        quotaWarnings: 0,
        quotaActions: 0,
      },
    });
    expect(log.info).toHaveBeenCalledWith(
      'Logging/storage maintenance completed',
      expect.objectContaining({ healthChecks: { checked: 0, failed: 0 } })
    );
  });

  it('fails retention when closed DLQ payloads exist but no archive bucket is bound', async () => {
    mockAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes("WHERE status IN ('deleted', 'purged', 'replayed')")
        ? [{ id: 'dlq_1', payload_object_ref: 'dlq/1.json' }]
        : []
    );
    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);
    expect(result.retention).toEqual({
      deliveryEventsDeleted: 0,
      deliveryAggregatesDeleted: 0,
      dlqItemsPurged: 0,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Logging delivery event retention failed',
      {},
      expect.objectContaining({ message: 'logging_dlq_payload_bucket_unavailable' })
    );
    expect(
      mockAdapter.execute.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM logging_dlq_items')
      )
    ).toBe(false);
  });

  describe('retired R2 generation cleanup', () => {
    const retired = (over: Record<string, unknown> = {}) => ({
      id: 'retired-1',
      tenant_key: 'tenant',
      bucket_binding: 'AUDIT_ARCHIVE',
      object_catalog_id: 'object',
      object_key: 'logs/tenant/source.bin',
      replacement_object_key: 'logs-rewrapped/tenant/object/v2.bin',
      reason: 'rewrap',
      created_at: 1234,
      ...over,
    });
    const serve = (rows: unknown[], current: unknown) => {
      mockAdapter.query.mockImplementation(async (sql: string) =>
        sql.includes('tenant_backup_r2_retired_generations') ? rows : []
      );
      mockAdapter.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('FROM log_object_catalog') ? current : null
      );
    };

    it('fails when the bucket of a retired generation is no longer bound', async () => {
      serve([retired({ bucket_binding: 'GONE' })], null);
      await expect(
        runScheduledRetiredR2GenerationCleanup({} as Env, mockAdapter as any, log)
      ).rejects.toThrow('retired_r2_generation_bucket_unavailable');
      await expect(
        runScheduledRetiredR2GenerationCleanup(
          { GONE: {} } as unknown as Env,
          mockAdapter as any,
          log
        )
      ).rejects.toThrow('retired_r2_generation_bucket_unavailable');
      await expect(
        runScheduledRetiredR2GenerationCleanup(
          { GONE: 'bucket' } as unknown as Env,
          mockAdapter as any,
          log
        )
      ).rejects.toThrow('retired_r2_generation_bucket_unavailable');
    });

    it('keeps a generation whose replacement is not the served object yet', async () => {
      const del = vi.fn();
      serve([retired()], { object_key: 'other.bin', status: 'committed' });
      await runScheduledRetiredR2GenerationCleanup(
        { AUDIT_ARCHIVE: { delete: del } } as unknown as Env,
        mockAdapter as any,
        log
      );
      expect(del).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith('Retired R2 generation cleanup completed', {
        deleted: 0,
        skipped: 1,
      });
    });

    it('keeps a rewrapped generation whose catalog row still serves the old key', async () => {
      const del = vi.fn();
      serve([retired()], { object_key: 'logs/tenant/source.bin', status: 'deleted' });
      await runScheduledRetiredR2GenerationCleanup(
        { AUDIT_ARCHIVE: { delete: del } } as unknown as Env,
        mockAdapter as any,
        log
      );
      expect(del).not.toHaveBeenCalled();
    });

    it('keeps a catalog-delete generation whose row is not deleted', async () => {
      const del = vi.fn();
      serve([retired({ reason: 'catalog_delete' })], {
        object_key: 'logs/tenant/source.bin',
        status: 'committed',
      });
      await runScheduledRetiredR2GenerationCleanup(
        { AUDIT_ARCHIVE: { delete: del } } as unknown as Env,
        mockAdapter as any,
        log
      );
      expect(del).not.toHaveBeenCalled();
    });

    it('deletes a generation whose catalog row is gone and counts it', async () => {
      const del = vi.fn().mockResolvedValue(undefined);
      serve([retired(), retired({ id: 'retired-2', object_key: 'logs/tenant/second.bin' })], null);
      await runScheduledRetiredR2GenerationCleanup(
        { AUDIT_ARCHIVE: { delete: del } } as unknown as Env,
        mockAdapter as any,
        log
      );
      expect(del.mock.calls.map(([key]) => key)).toEqual([
        'logs/tenant/source.bin',
        'logs/tenant/second.bin',
      ]);
      expect(log.debug).toHaveBeenCalledWith('Retired R2 generation cleanup completed', {
        deleted: 2,
        skipped: 0,
      });
    });

    it('does nothing when no generation is retired', async () => {
      serve([], null);
      await runScheduledRetiredR2GenerationCleanup({} as Env, mockAdapter as any, log);
      expect(log.debug).not.toHaveBeenCalled();
    });
  });
});
