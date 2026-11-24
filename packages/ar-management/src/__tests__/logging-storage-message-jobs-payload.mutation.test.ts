/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- SQL parameter arrays and vi fakes are untyped in these maintenance job tests */
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

const NOW = 1_800_000_000_000;
const TOKEN = expect.stringMatching(/^qpl/);

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job_1',
    kind: 'retry_delivery',
    status: 'running',
    lane: 'default',
    criticality: 'standard',
    tenantKey: 't_a',
    sourceType: 'dlq_item',
    sourceId: 'dlq_1',
    payloadObjectRef: 'message-jobs/job_1.json',
    attemptCount: 1,
    maxAttempts: 5,
    attemptPolicy: null,
    errorClass: null,
    cancelRequestedAt: null,
    claimedUntil: NOW + 1000,
    expiresAt: null,
    ...overrides,
  };
}

describe('scheduled logging message jobs (payload handling)', () => {
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

  describe('claimed jobs', () => {
    describe('payload parsing', () => {
      beforeEach(() => {
        payloadRead.mockResolvedValue({ ok: true, value: { raw: true } });
      });

      it('dead-letters an unsupported schema', async () => {
        claimQueue = [job({ lane: 'critical' })];
        parsePayload.mockReturnValue({ ok: false, reason: 'unsupported_schema' });
        const result = await run();
        expect(parsePayload).toHaveBeenCalledWith({ raw: true });
        expect(store.markFailed).toHaveBeenCalledWith({
          id: 'job_1',
          claimToken: TOKEN,
          now: NOW,
          status: 'dlq',
          errorClass: 'unsupported_schema',
          lastError: 'Unsupported logging message payload schema.',
        });
        expect(result.messageJobs).toMatchObject({ dlq: 1, blocked: 0 });
        expect(notifications()[0]).toContain('logging_message_job_dlq:job_1:unsupported_schema');
        expect(store.markBlocked).not.toHaveBeenCalled();
      });

      it('does not count an unsupported-schema move another worker made', async () => {
        claimQueue = [job()];
        parsePayload.mockReturnValue({ ok: false, reason: 'unsupported_schema' });
        store.markFailed.mockResolvedValue(false);
        const result = await run();
        expect(result.messageJobs.dlq).toBe(0);
      });

      it('blocks a malformed payload and records why', async () => {
        claimQueue = [job({ criticality: 'critical' })];
        parsePayload.mockReturnValue({ ok: false, reason: 'invalid_shape' });
        const result = await run();
        expect(store.markBlocked).toHaveBeenCalledWith({
          id: 'job_1',
          now: NOW,
          blockedReason: 'malformed_payload',
          errorClass: 'invalid_shape',
        });
        expect(store.recordRepairFinding).toHaveBeenCalledWith({
          messageJobId: 'job_1',
          findingType: 'missing_payload_object',
          severity: 'critical',
          safeAction: 'mark_blocked',
          impact: { payload_object_ref: 'message-jobs/job_1.json', parse_reason: 'invalid_shape' },
          now: NOW,
        });
        expect(result.messageJobs.blocked).toBe(1);
        expect(store.markFailed).not.toHaveBeenCalled();
      });

      it('blocks a payload that belongs to another job', async () => {
        claimQueue = [job({ criticality: 'critical' })];
        parsePayload.mockReturnValue({
          ok: true,
          payload: { message_job_id: 'someone_else', payload_type: 'retry_delivery' },
        });
        const result = await run();
        expect(store.markBlocked).toHaveBeenCalledWith({
          id: 'job_1',
          now: NOW,
          blockedReason: 'message_job_id_mismatch',
          errorClass: 'event_job_mismatch',
        });
        expect(store.recordRepairFinding).toHaveBeenCalledWith({
          messageJobId: 'job_1',
          findingType: 'event_job_mismatch',
          severity: 'critical',
          safeAction: 'mark_blocked',
          impact: { payload_message_job_id: 'someone_else', claimed_message_job_id: 'job_1' },
          now: NOW,
        });
        expect(notifications()[0]).toContain(
          'logging_message_job_dlq:job_1:message_job_id_mismatch'
        );
        expect(result.messageJobs.blocked).toBe(1);
      });
    });

    describe('retry_delivery replay', () => {
      const replay = { replay: 'me' };
      beforeEach(() => {
        payloadRead.mockResolvedValue({ ok: true, value: {} });
        parsePayload.mockReturnValue({
          ok: true,
          payload: {
            message_job_id: 'job_1',
            payload_type: 'retry_delivery',
            replay_payload: replay,
          },
        });
      });

      it('completes the job and drops the payload once the delivery is queued', async () => {
        claimQueue = [job()];
        enqueueDelivery.mockResolvedValue({ queued: true });
        const result = await run();
        expect(enqueueDelivery).toHaveBeenCalledWith(replay, env);
        expect(store.markCompleted).toHaveBeenCalledWith('job_1', TOKEN, NOW);
        expect(result.messageJobs).toMatchObject({ completed: 1, retrying: 0, dlq: 0 });
        expect(archiveDelete).toHaveBeenCalledWith('message-jobs/job_1.json');
      });

      it('does not count a completion another worker already recorded', async () => {
        claimQueue = [job()];
        enqueueDelivery.mockResolvedValue({ queued: true });
        store.markCompleted.mockResolvedValue(false);
        const result = await run();
        expect(result.messageJobs.completed).toBe(0);
        expect(archiveDelete).not.toHaveBeenCalled();
      });

      it('retries when no delivery queue is bound and attempts remain', async () => {
        claimQueue = [job({ attemptCount: 2, maxAttempts: 3 })];
        enqueueDelivery.mockResolvedValue({ queued: false });
        const result = await run();
        expect(store.markRetrying).toHaveBeenCalledWith({
          id: 'job_1',
          claimToken: TOKEN,
          now: NOW,
          notBefore: NOW + 5 * 60_000,
          errorClass: 'logging_delivery_queue_unavailable',
          lastError: 'No logging delivery queue binding is available for retry delivery.',
        });
        expect(result.messageJobs).toMatchObject({ retrying: 1, dlq: 0, completed: 0 });
      });

      it('dead-letters when no delivery queue is bound and attempts are used up', async () => {
        claimQueue = [job({ attemptCount: 3, maxAttempts: 3, criticality: 'critical' })];
        enqueueDelivery.mockResolvedValue({ queued: false });
        const result = await run();
        expect(store.markFailed).toHaveBeenCalledWith({
          id: 'job_1',
          claimToken: TOKEN,
          now: NOW,
          status: 'dlq',
          errorClass: 'logging_delivery_queue_unavailable',
          lastError: 'No logging delivery queue binding is available for retry delivery.',
        });
        expect(result.messageJobs).toMatchObject({ dlq: 1, retrying: 0 });
        expect(notifications()[0]).toContain(
          'logging_message_job_dlq:job_1:logging_delivery_queue_unavailable'
        );
      });

      it('does not count unavailable-queue state changes another worker made', async () => {
        claimQueue = [job({ attemptCount: 3, maxAttempts: 3 }), job({ id: 'j2', attemptCount: 1 })];
        enqueueDelivery.mockResolvedValue({ queued: false });
        store.markFailed.mockResolvedValue(false);
        store.markRetrying.mockResolvedValue(false);
        const result = await run();
        expect(result.messageJobs).toMatchObject({ dlq: 0, retrying: 0 });
      });
    });

    describe('export_build failures', () => {
      beforeEach(() => {
        payloadRead.mockResolvedValue({ ok: true, value: { filters: null } });
        parsePayload.mockReturnValue({
          ok: true,
          payload: {
            message_job_id: 'job_1',
            payload_type: 'export_build',
            export_job_id: 'exp_1',
            phase: 'plan',
          },
        });
      });

      const withoutExportBucket = () => {
        env = { AUDIT_ARCHIVE: { delete: archiveDelete } } as unknown as Env;
      };

      it('blocks (without retry) when the export job is gone', async () => {
        claimQueue = [job({ criticality: 'critical', kind: 'export_build' })];
        const result = await run();
        expect(store.markBlocked).toHaveBeenCalledWith({
          id: 'job_1',
          now: NOW,
          blockedReason: 'export_job_not_found',
          errorClass: 'export_build_configuration',
          lastError: 'export_job_not_found',
        });
        expect(store.recordRepairFinding).toHaveBeenCalledWith({
          messageJobId: 'job_1',
          findingType: 'blocked_configuration',
          severity: 'critical',
          safeAction: 'mark_blocked',
          impact: { payload_object_ref: 'message-jobs/job_1.json', error: 'export_job_not_found' },
          now: NOW,
        });
        expect(notifications()[0]).toContain('logging_message_job_dlq:job_1:export_job_not_found');
        expect(result.messageJobs).toMatchObject({ blocked: 1, retrying: 0, dlq: 0 });
        expect(store.markRetrying).not.toHaveBeenCalled();
      });

      it('blocks when the stored filters are invalid', async () => {
        claimQueue = [job()];
        mockAdapter.queryOne.mockImplementation(async (sql: string) =>
          sql.includes('FROM logging_export_jobs')
            ? { id: 'exp_1', format: 'jsonl', status: 'queued' }
            : null
        );
        const result = await run();
        expect(store.markBlocked).toHaveBeenCalledWith(
          expect.objectContaining({
            blockedReason: 'invalid_export_build_filters',
            lastError: 'invalid_export_build_filters',
          })
        );
        expect(result.messageJobs.blocked).toBe(1);
      });

      it('blocks an unknown phase', async () => {
        claimQueue = [job()];
        parsePayload.mockReturnValue({
          ok: true,
          payload: {
            message_job_id: 'job_1',
            payload_type: 'export_build',
            export_job_id: 'exp_1',
            phase: 'mystery',
          },
        });
        payloadRead.mockResolvedValue({ ok: true, value: { filters: { source: 'catalog' } } });
        mockAdapter.queryOne.mockImplementation(async (sql: string) =>
          sql.includes('FROM logging_export_jobs')
            ? { id: 'exp_1', format: 'jsonl', status: 'queued' }
            : null
        );
        const result = await run();
        expect(store.markBlocked).toHaveBeenCalledWith(
          expect.objectContaining({ blockedReason: 'unsupported_export_build_phase:mystery' })
        );
        expect(result.messageJobs.blocked).toBe(1);
      });

      it('retries a transient failure and marks the export retrying', async () => {
        claimQueue = [job({ attemptCount: 1, maxAttempts: 3, lane: 'critical' })];
        withoutExportBucket();
        const result = await run();
        expect(store.markRetrying).toHaveBeenCalledWith({
          id: 'job_1',
          claimToken: TOKEN,
          now: NOW,
          notBefore: NOW + 30_000,
          errorClass: 'export_build_failed',
          lastError: 'export_artifact_bucket_unavailable',
        });
        expect(mockAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE logging_export_jobs'),
          ['retrying', 'export_artifact_bucket_unavailable', NOW, 'exp_1']
        );
        expect(result.messageJobs).toMatchObject({ retrying: 1, dlq: 0, blocked: 0 });
      });

      it('does not touch the export when the retry was not recorded', async () => {
        withoutExportBucket();
        claimQueue = [job({ attemptCount: 1, maxAttempts: 3 })];
        store.markRetrying.mockResolvedValue(false);
        const result = await run();
        expect(result.messageJobs.retrying).toBe(0);
        expect(mockAdapter.execute).not.toHaveBeenCalledWith(
          expect.stringContaining('UPDATE logging_export_jobs'),
          expect.anything()
        );
      });

      it('dead-letters a failure on the last attempt and fails the export', async () => {
        withoutExportBucket();
        claimQueue = [job({ attemptCount: 3, maxAttempts: 3, criticality: 'critical' })];
        const result = await run();
        expect(store.markFailed).toHaveBeenCalledWith({
          id: 'job_1',
          claimToken: TOKEN,
          now: NOW,
          status: 'dlq',
          errorClass: 'export_build_failed',
          lastError: 'export_artifact_bucket_unavailable',
        });
        expect(mockAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE logging_export_jobs'),
          ['failed', 'export_artifact_bucket_unavailable', NOW, NOW, 'exp_1']
        );
        expect(notifications()[0]).toContain(
          'logging_message_job_dlq:job_1:export_artifact_bucket_unavailable'
        );
        expect(result.messageJobs).toMatchObject({ dlq: 1, retrying: 0 });
      });

      it('leaves the export alone when the dead-letter move was not recorded', async () => {
        withoutExportBucket();
        claimQueue = [job({ attemptCount: 3, maxAttempts: 3 })];
        store.markFailed.mockResolvedValue(false);
        const result = await run();
        expect(result.messageJobs.dlq).toBe(0);
        expect(mockAdapter.execute).not.toHaveBeenCalledWith(
          expect.stringContaining('UPDATE logging_export_jobs'),
          expect.anything()
        );
      });
    });
  });
});
