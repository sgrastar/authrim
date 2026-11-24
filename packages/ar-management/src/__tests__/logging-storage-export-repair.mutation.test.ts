/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- SQL parameter arrays and vi fakes are untyped in these maintenance job tests */
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
  return adapter;
});

const store = vi.hoisted(() => ({
  listExpiredQueuedJobs: vi.fn(),
  listStuckClaimJobs: vi.fn(),
  claimDueJob: vi.fn(),
  markRunning: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  markRetrying: vi.fn(),
  markBlocked: vi.fn(),
  markCancelled: vi.fn(),
  markExpired: vi.fn(),
  repairStuckLeaseToDlq: vi.fn(),
  repairStuckLeaseForRetry: vi.fn(),
  recordRepairFinding: vi.fn(),
}));
const payloadRead = vi.hoisted(() => vi.fn());
const parsePayload = vi.hoisted(() => vi.fn());
const enqueueDelivery = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter) };
});
vi.mock('@authrim/ar-lib-logging/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-logging/messaging')>();
  return {
    ...actual,
    SqlLoggingMessageJobStore: class {
      constructor() {
        return store;
      }
    },
    parseLoggingMessageQueuePayload: parsePayload,
  };
});
vi.mock('@authrim/ar-lib-logging/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-logging/delivery')>();
  return { ...actual, enqueueLoggingDeliveryPayload: enqueueDelivery };
});
vi.mock('../logging-message-payload-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging-message-payload-storage')>();
  return { ...actual, readEncryptedLoggingMessagePayload: payloadRead };
});

import { processLoggingStorageMaintenanceJobs } from '../logging-storage-maintenance-jobs';
import { createNotificationEventsFake } from './helpers/notification-events-fake';
import { must } from './helpers/must';

const NOW = 1_800_000_000_000;

describe('scheduled logging export repair', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  let claimQueue: unknown[];
  let archiveDelete: ReturnType<typeof vi.fn>;
  let env: Env;
  const notificationEvents = createNotificationEventsFake();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    claimQueue = [];
    notificationEvents.reset();
    archiveDelete = vi.fn();
    env = {
      AUDIT_ARCHIVE: { delete: archiveDelete },
      EXPORT_ARTIFACTS: {},
    } as unknown as Env;
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
      const notification = notificationEvents.queryOne(sql, params);
      if (notification !== undefined) return notification;
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params?: unknown[]) =>
      notificationEvents.executeAny(sql, params)
    );
    for (const fn of Object.values(store)) fn.mockReset();
    store.listExpiredQueuedJobs.mockResolvedValue([]);
    store.listStuckClaimJobs.mockResolvedValue([]);
    store.claimDueJob.mockImplementation(async () => claimQueue.shift() ?? null);
    for (const name of [
      'markCompleted',
      'markFailed',
      'markRetrying',
      'markBlocked',
      'markCancelled',
      'markExpired',
      'repairStuckLeaseToDlq',
      'repairStuckLeaseForRetry',
    ] as const) {
      store[name].mockResolvedValue(true);
    }
    payloadRead.mockReset();
    parsePayload.mockReset();
    enqueueDelivery.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  const run = () => processLoggingStorageMaintenanceJobs(env, log);
  const notifications = () =>
    mockAdapter.execute.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO internal_notification_events'))
      .map(([, params]) => params as unknown[]);

  describe('missing export parts', () => {
    const buildRow = (over: Record<string, unknown> = {}) => ({
      message_job_id: 'mj_1',
      export_job_id: 'exp_1',
      part_object_ref: 'exports/exp_1/part-0.jsonl',
      phase: 'build_partition',
      tenant_key: 't_a',
      kind: 'export_build',
      status: 'completed',
      criticality: 'standard',
      lane: 'default',
      ...over,
    });
    const serveBuilds = (rows: unknown[]) => {
      mockAdapter.query.mockImplementation(async (sql: string) =>
        sql.includes('FROM logging_message_export_builds') &&
        sql.includes('eb.part_object_ref IS NOT NULL')
          ? rows
          : []
      );
    };

    it('does nothing without an export bucket that can head objects', async () => {
      serveBuilds([buildRow()]);
      await run();
      env = { EXPORT_ARTIFACTS: {} } as unknown as Env;
      await run();
      expect(store.recordRepairFinding).not.toHaveBeenCalled();
    });

    it('asks for the recent partition, finalize and verify builds', async () => {
      env = { ...env, EXPORT_ARTIFACTS: { head: vi.fn() } } as unknown as Env;
      await run();
      const call = mockAdapter.query.mock.calls.find(([sql]) =>
        String(sql).includes('eb.part_object_ref IS NOT NULL')
      );
      expect(must(call)[1]).toEqual(['build_partition', 'finalize', 'verify_manifest', 50]);
      expect(String(must(call)[0])).toContain('ORDER BY eb.updated_at DESC');
    });

    it('records a finding, retries the export and notifies when a critical part is gone', async () => {
      const head = vi.fn(async () => null);
      env = { ...env, EXPORT_ARTIFACTS: { head } } as unknown as Env;
      serveBuilds([buildRow({ lane: 'critical' })]);
      const result = await run();
      expect(head).toHaveBeenCalledWith('exports/exp_1/part-0.jsonl');
      expect(store.recordRepairFinding).toHaveBeenCalledWith({
        messageJobId: 'mj_1',
        findingType: 'missing_export_part',
        severity: 'critical',
        safeAction: 'rebuild_export_partition',
        dangerousAction: 'mark_export_failed_and_cleanup_manifest',
        impact: {
          export_job_id: 'exp_1',
          part_object_ref: 'exports/exp_1/part-0.jsonl',
          phase: 'build_partition',
        },
        now: NOW,
      });
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE logging_export_jobs'),
        ['retrying', 'missing_export_part', NOW, 'exp_1', 'queued', 'running', 'completed']
      );
      expect(result.messageJobs.repairFindings).toBe(1);
      const sent = notifications();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('logging.export_part.missing');
      expect(sent[0]).toContain('critical');
      expect(sent[0]).toContain('logging_export_part_missing:exp_1:exports/exp_1/part-0.jsonl');
      expect(sent[0]).toContain('t_a');
    });

    it('treats a critical criticality like a critical lane and a standard one as an error', async () => {
      const head = vi.fn(async () => null);
      env = { ...env, EXPORT_ARTIFACTS: { head } } as unknown as Env;
      serveBuilds([
        buildRow({ message_job_id: 'mj_c', criticality: 'critical', tenant_key: null }),
        buildRow({ message_job_id: 'mj_s', export_job_id: 'exp_2' }),
      ]);
      await run();
      expect(store.recordRepairFinding).toHaveBeenCalledWith(
        expect.objectContaining({ messageJobId: 'mj_c', severity: 'critical' })
      );
      expect(store.recordRepairFinding).toHaveBeenCalledWith(
        expect.objectContaining({ messageJobId: 'mj_s', severity: 'error' })
      );
      const sent = notifications();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('global');
    });

    it('ignores parts that exist and rows without a part or a job', async () => {
      const head = vi.fn(async () => ({ key: 'x' }));
      env = { ...env, EXPORT_ARTIFACTS: { head } } as unknown as Env;
      serveBuilds([
        buildRow(),
        buildRow({ part_object_ref: null }),
        buildRow({ message_job_id: null }),
      ]);
      const result = await run();
      expect(head).toHaveBeenCalledTimes(1);
      expect(store.recordRepairFinding).not.toHaveBeenCalled();
      expect(result.messageJobs.repairFindings).toBe(0);
    });
  });

  describe('export artifact cleanup', () => {
    it('does nothing without a bucket that can delete', async () => {
      env = { EXPORT_ARTIFACTS: { head: vi.fn() } } as unknown as Env;
      await run();
      expect(
        mockAdapter.query.mock.calls.some(([sql]) => String(sql).includes('eb.cleanup_status = ?'))
      ).toBe(false);
    });

    it('deletes part and manifest, marks the cleanup done and clears the export refs', async () => {
      const del = vi.fn();
      env = { EXPORT_ARTIFACTS: { delete: del } } as unknown as Env;
      mockAdapter.query.mockImplementation(async (sql: string) =>
        sql.includes('eb.cleanup_status = ?')
          ? [
              {
                message_job_id: 'm1',
                export_job_id: 'e1',
                part_object_ref: 'p1',
                manifest_object_ref: 'm1.json',
              },
              {
                message_job_id: 'm2',
                export_job_id: 'e2',
                part_object_ref: null,
                manifest_object_ref: 'm2.json',
              },
              {
                message_job_id: 'm3',
                export_job_id: 'e3',
                part_object_ref: 'p3',
                manifest_object_ref: null,
              },
            ]
          : []
      );
      const result = await run();
      const call = mockAdapter.query.mock.calls.find(([sql]) =>
        String(sql).includes('eb.cleanup_status = ?')
      );
      expect(must(call)[1]).toEqual(['queued', 50]);
      expect(del.mock.calls.map(([ref]) => ref)).toEqual(['p1', 'm1.json', 'm2.json', 'p3']);
      for (const exportId of ['e1', 'e2', 'e3']) {
        expect(mockAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE logging_message_export_builds'),
          ['completed', NOW, exportId, 'queued']
        );
        expect(mockAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('artifact_object_ref = NULL, manifest_object_ref = NULL'),
          [NOW, exportId]
        );
      }
      expect(result.messageJobs.repaired).toBe(3);
    });
  });
});
