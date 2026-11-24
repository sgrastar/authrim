/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- SQL parameter arrays and vi fakes are untyped in these maintenance job tests */
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

describe('scheduled logging message jobs', () => {
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

  describe('expired queued jobs', () => {
    it('expires them, records a finding, notifies for critical ones and drops the payload', async () => {
      store.listExpiredQueuedJobs.mockResolvedValue([
        job({ id: 'e1', status: 'retrying', criticality: 'critical', expiresAt: 5 }),
        job({ id: 'e2', status: 'queued', expiresAt: 6, payloadObjectRef: 'p2' }),
      ]);
      const result = await run();
      expect(store.listExpiredQueuedJobs).toHaveBeenCalledWith({ now: NOW, limit: 50 });
      expect(store.markExpired).toHaveBeenCalledWith({
        id: 'e1',
        now: NOW,
        lastError: 'Message job expired before it could be completed.',
      });
      expect(store.recordRepairFinding).toHaveBeenCalledWith({
        messageJobId: 'e1',
        findingType: 'expired_retrying',
        severity: 'critical',
        status: 'safe_repaired',
        safeAction: 'mark_expired',
        impact: { previous_status: 'retrying', expires_at: 5 },
        now: NOW,
      });
      expect(store.recordRepairFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          messageJobId: 'e2',
          findingType: 'expired_queued',
          severity: 'warning',
        })
      );
      expect(result.messageJobs).toMatchObject({ repaired: 2, expired: 2 });
      expect(archiveDelete).toHaveBeenCalledWith('message-jobs/job_1.json');
      expect(archiveDelete).toHaveBeenCalledWith('p2');
      const sent = notifications();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('logging_message_job_dlq:e1:message_job_expired');
      expect(sent[0]).toContain('logging.message_job.dlq');
    });

    it('skips a job another worker already moved on', async () => {
      store.listExpiredQueuedJobs.mockResolvedValue([job({ id: 'e1' })]);
      store.markExpired.mockResolvedValue(false);
      const result = await run();
      expect(result.messageJobs).toMatchObject({ repaired: 0, expired: 0 });
      expect(store.recordRepairFinding).not.toHaveBeenCalled();
      expect(archiveDelete).not.toHaveBeenCalled();
    });
  });

  describe('stuck claims', () => {
    it('expires one past its TTL', async () => {
      store.listStuckClaimJobs.mockResolvedValue([
        job({ id: 's1', expiresAt: NOW, lane: 'critical', claimedUntil: 77 }),
      ]);
      const result = await run();
      expect(store.listStuckClaimJobs).toHaveBeenCalledWith({ now: NOW, limit: 50 });
      expect(store.markExpired).toHaveBeenCalledWith({
        id: 's1',
        now: NOW,
        lastError: 'Claim lease expired after message job TTL.',
      });
      expect(store.recordRepairFinding).toHaveBeenCalledWith({
        messageJobId: 's1',
        findingType: 'stuck_claim',
        severity: 'warning',
        status: 'safe_repaired',
        safeAction: 'mark_expired',
        impact: { previous_status: 'running', claimed_until: 77, expires_at: NOW },
        now: NOW,
      });
      expect(result.messageJobs).toMatchObject({ repaired: 1, expired: 1, dlq: 0 });
      expect(notifications()[0]).toContain('logging_message_job_dlq:s1:message_job_expired');
      expect(archiveDelete).toHaveBeenCalledWith('message-jobs/job_1.json');
      expect(store.repairStuckLeaseToDlq).not.toHaveBeenCalled();
    });

    it('does not expire one whose TTL is still ahead and does not count a lost race', async () => {
      store.listStuckClaimJobs.mockResolvedValue([
        job({ id: 's1', expiresAt: NOW + 1, attemptCount: 1, maxAttempts: 5 }),
        job({ id: 's2', expiresAt: NOW - 1 }),
      ]);
      store.markExpired.mockResolvedValue(false);
      store.repairStuckLeaseForRetry.mockResolvedValue(false);
      const result = await run();
      expect(store.markExpired).toHaveBeenCalledTimes(1);
      expect(store.markExpired).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
      expect(store.repairStuckLeaseForRetry).toHaveBeenCalledTimes(1);
      expect(result.messageJobs).toMatchObject({ repaired: 0, expired: 0, retrying: 0 });
    });

    it('moves one that used up its attempts to the DLQ', async () => {
      store.listStuckClaimJobs.mockResolvedValue([
        job({
          id: 's1',
          attemptCount: 5,
          maxAttempts: 5,
          criticality: 'critical',
          claimedUntil: 9,
        }),
      ]);
      const result = await run();
      expect(store.repairStuckLeaseToDlq).toHaveBeenCalledWith({
        id: 's1',
        now: NOW,
        errorClass: 'claim_lease_timeout',
        lastError: 'Claim lease expired and max attempts were reached.',
      });
      expect(store.recordRepairFinding).toHaveBeenCalledWith({
        messageJobId: 's1',
        findingType: 'stuck_claim',
        severity: 'critical',
        status: 'safe_repaired',
        safeAction: 'mark_dlq',
        impact: { previous_status: 'running', claimed_until: 9, attempt_count: 5, max_attempts: 5 },
        now: NOW,
      });
      expect(result.messageJobs).toMatchObject({ repaired: 1, dlq: 1, retrying: 0 });
      expect(notifications()[0]).toContain('logging_message_job_dlq:s1:claim_lease_timeout');
      expect(store.repairStuckLeaseForRetry).not.toHaveBeenCalled();
    });

    it('does not count a DLQ move another worker already made', async () => {
      store.listStuckClaimJobs.mockResolvedValue([job({ attemptCount: 5, maxAttempts: 5 })]);
      store.repairStuckLeaseToDlq.mockResolvedValue(false);
      const result = await run();
      expect(result.messageJobs).toMatchObject({ repaired: 0, dlq: 0 });
      expect(store.recordRepairFinding).not.toHaveBeenCalled();
    });

    it('requeues one with attempts left after the lane backoff', async () => {
      store.listStuckClaimJobs.mockResolvedValue([
        job({ id: 'a', lane: 'critical', attemptCount: 2, claimedUntil: 3 }),
        job({ id: 'b', lane: 'bulk' }),
        job({ id: 'c', lane: 'default' }),
      ]);
      const result = await run();
      const retries = store.repairStuckLeaseForRetry.mock.calls.map(([arg]) => arg);
      expect(retries).toEqual([
        {
          id: 'a',
          now: NOW,
          notBefore: NOW + 30_000,
          errorClass: 'claim_lease_timeout',
          lastError: 'Claim lease expired before completion.',
        },
        {
          id: 'b',
          now: NOW,
          notBefore: NOW + 15 * 60_000,
          errorClass: 'claim_lease_timeout',
          lastError: 'Claim lease expired before completion.',
        },
        {
          id: 'c',
          now: NOW,
          notBefore: NOW + 5 * 60_000,
          errorClass: 'claim_lease_timeout',
          lastError: 'Claim lease expired before completion.',
        },
      ]);
      expect(store.recordRepairFinding).toHaveBeenCalledWith({
        messageJobId: 'a',
        findingType: 'stuck_claim',
        severity: 'warning',
        status: 'safe_repaired',
        safeAction: 'retry_after_lease_timeout',
        impact: { previous_status: 'running', claimed_until: 3, attempt_count: 2, max_attempts: 5 },
        now: NOW,
      });
      expect(result.messageJobs).toMatchObject({ repaired: 3, retrying: 3 });
    });

    it('prefers the per-error-class backoff, then the policy backoff, ignoring non-positive values', async () => {
      store.listStuckClaimJobs.mockResolvedValue([
        job({
          id: 'a',
          errorClass: 'slow',
          attemptPolicy: { backoffMs: 1000, errorClassBackoffMs: { slow: 7000 } },
        }),
        job({
          id: 'b',
          errorClass: 'other',
          attemptPolicy: { backoffMs: 1000, errorClassBackoffMs: { slow: 7000 } },
        }),
        job({
          id: 'c',
          errorClass: 'slow',
          attemptPolicy: { backoffMs: 0, errorClassBackoffMs: { slow: 0 } },
          lane: 'critical',
        }),
        job({
          id: 'd',
          errorClass: null,
          attemptPolicy: { backoffMs: 2000, errorClassBackoffMs: { slow: 7000 } },
        }),
      ]);
      await run();
      const notBefore = Object.fromEntries(
        store.repairStuckLeaseForRetry.mock.calls.map(([arg]) => [arg.id, arg.notBefore - NOW])
      );
      expect(notBefore).toEqual({ a: 7000, b: 1000, c: 30_000, d: 2000 });
    });
  });

  describe('claimed jobs', () => {
    it('claims with the lease and marks the job running', async () => {
      claimQueue = [job()];
      payloadRead.mockResolvedValue({ ok: false, reason: 'not_found' });
      const result = await run();
      expect(store.claimDueJob).toHaveBeenCalledWith({
        now: NOW,
        leaseMs: 5 * 60 * 1000,
        claimToken: TOKEN,
        limit: 1,
      });
      expect(store.markRunning).toHaveBeenCalledWith('job_1', TOKEN, NOW);
      expect(result.messageJobs.claimed).toBe(1);
    });

    it('stops after 25 jobs per run', async () => {
      claimQueue = Array.from({ length: 30 }, (_, i) => job({ id: `j${i}` }));
      payloadRead.mockResolvedValue({ ok: false, reason: 'not_found' });
      const result = await run();
      expect(result.messageJobs.claimed).toBe(25);
      expect(store.claimDueJob).toHaveBeenCalledTimes(25);
    });

    it('honours a cancellation request by cancelling and dropping the payload', async () => {
      claimQueue = [job({ cancelRequestedAt: NOW - 5 })];
      const result = await run();
      expect(store.markCancelled).toHaveBeenCalledWith('job_1', NOW);
      expect(result.messageJobs).toMatchObject({ claimed: 1, blocked: 1 });
      expect(archiveDelete).toHaveBeenCalledWith('message-jobs/job_1.json');
      expect(payloadRead).not.toHaveBeenCalled();
    });

    it('does not count a cancellation another worker already applied', async () => {
      claimQueue = [job({ cancelRequestedAt: NOW - 5 })];
      store.markCancelled.mockResolvedValue(false);
      const result = await run();
      expect(result.messageJobs.blocked).toBe(0);
      expect(archiveDelete).not.toHaveBeenCalled();
    });

    describe('unreadable payload storage', () => {
      it.each([
        ['bucket_unavailable', 'message_payload_bucket_unavailable'],
        ['encryption_key_unavailable', 'message_payload_encryption_key_unavailable'],
      ])('retries a job with attempts left when %s', async (reason, errorClass) => {
        claimQueue = [job({ attemptCount: 4, maxAttempts: 5, lane: 'bulk' })];
        payloadRead.mockResolvedValue({ ok: false, reason });
        const result = await run();
        expect(store.markRetrying).toHaveBeenCalledWith({
          id: 'job_1',
          claimToken: TOKEN,
          now: NOW,
          notBefore: NOW + 15 * 60_000,
          errorClass,
          lastError: 'Logging message payload storage is unavailable.',
        });
        expect(result.messageJobs).toMatchObject({ retrying: 1, dlq: 0 });
        expect(store.markFailed).not.toHaveBeenCalled();
      });

      it.each([
        ['bucket_unavailable', 'message_payload_bucket_unavailable'],
        ['encryption_key_unavailable', 'message_payload_encryption_key_unavailable'],
      ])('moves a job without attempts left to the DLQ when %s', async (reason, errorClass) => {
        claimQueue = [job({ attemptCount: 5, maxAttempts: 5, criticality: 'critical' })];
        payloadRead.mockResolvedValue({ ok: false, reason });
        const result = await run();
        expect(store.markFailed).toHaveBeenCalledWith({
          id: 'job_1',
          claimToken: TOKEN,
          now: NOW,
          status: 'dlq',
          errorClass,
          lastError: 'Logging message payload storage is unavailable.',
        });
        expect(result.messageJobs).toMatchObject({ dlq: 1, retrying: 0 });
        expect(notifications()[0]).toContain(`logging_message_job_dlq:job_1:${errorClass}`);
        expect(store.markRetrying).not.toHaveBeenCalled();
      });

      it('does not count a state change another worker already made', async () => {
        claimQueue = [job({ attemptCount: 5 }), job({ id: 'j2', attemptCount: 1 })];
        payloadRead.mockResolvedValue({ ok: false, reason: 'bucket_unavailable' });
        store.markFailed.mockResolvedValue(false);
        store.markRetrying.mockResolvedValue(false);
        const result = await run();
        expect(result.messageJobs).toMatchObject({ dlq: 0, retrying: 0, claimed: 2 });
        expect(notifications()).toHaveLength(0);
      });

      it.each([
        ['not_found', 'missing_payload_object'],
        ['too_large', 'payload_object_too_large'],
        ['unencrypted_payload', 'malformed_payload_json'],
        ['integrity_mismatch', 'malformed_payload_json'],
        ['malformed_payload', 'malformed_payload_json'],
      ])('blocks the job when the payload is %s', async (reason, blockedReason) => {
        claimQueue = [job({ criticality: 'critical' })];
        payloadRead.mockResolvedValue({ ok: false, reason });
        const result = await run();
        expect(store.markBlocked).toHaveBeenCalledWith({
          id: 'job_1',
          now: NOW,
          blockedReason,
          errorClass: reason,
        });
        expect(store.recordRepairFinding).toHaveBeenCalledWith({
          messageJobId: 'job_1',
          findingType: 'missing_payload_object',
          severity: 'critical',
          safeAction: 'mark_blocked',
          impact: { payload_object_ref: 'message-jobs/job_1.json', read_reason: reason },
          now: NOW,
        });
        expect(notifications()[0]).toContain(`logging_message_job_dlq:job_1:${reason}`);
        expect(result.messageJobs.blocked).toBe(1);
      });

      it('records a warning (not critical) finding for a standard job', async () => {
        claimQueue = [job()];
        payloadRead.mockResolvedValue({ ok: false, reason: 'not_found' });
        await run();
        expect(store.recordRepairFinding).toHaveBeenCalledWith(
          expect.objectContaining({ severity: 'warning' })
        );
        expect(notifications()).toHaveLength(0);
      });
    });
  });
});
