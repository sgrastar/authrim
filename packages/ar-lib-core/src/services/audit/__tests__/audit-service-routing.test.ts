import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types/env';
import type { AuditProfile } from '../../../types/runtime-profile';
import { AuditService } from '../audit-service';
import { emitLogIcebergRow } from '../../log-iceberg-emitter';
import { eraseLogIcebergSubject } from '../../log-iceberg-subject-erasure';

const mapping = vi.hoisted(() => ({
  current: vi.fn(),
  prepare: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('../anonymization', () => ({
  AnonymizationService: class {
    getAnonymizedUserIdUnlessErased = mapping.current;
    preparePIILogPurge = mapping.prepare;
    completePIILogPurge = mapping.complete;
  },
}));
vi.mock('../../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn() }));
vi.mock('../../log-iceberg-subject-erasure', () => ({ eraseLogIcebergSubject: vi.fn() }));

const ANON = '3a28112c-6276-46d4-8845-021e88617d27';
const baseProfile = {
  kind: 'audit',
  id: 'profile',
  primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
  archive: { type: 'r2', bucketBinding: 'AUDIT_ARCHIVE', prefix: 'old' },
  sinks: [],
} as AuditProfile;
const event = {
  id: 'event-1',
  eventType: 'auth.login',
  eventCategory: 'auth' as const,
  result: 'success' as const,
  createdAt: 1_800_000_000_000,
};
const pii = {
  userId: 'account-1',
  anonymizedUserId: ANON,
  changeType: 'update' as const,
  affectedFields: ['email'],
  actorType: 'user' as const,
  oldValues: { email: 'old@example.test' },
  newValues: { email: 'new@example.test' },
};
const purgeContext = {
  actorType: 'admin' as const,
  deletionReason: 'user_request',
  legalBasis: 'consent_withdrawal',
};

function fixture(mode: 'pipeline' | 'scheduled' = 'scheduled', profile = baseProfile) {
  const forbidden = vi.fn(() => {
    throw new Error('old log storage must not be called');
  });
  const queue = { send: vi.fn().mockResolvedValue(undefined) };
  const env = {
    AUTHRIM_LOG_ARCHIVE_MODE: mode,
    CONTROL: {
      acquireTenantBackupMutationPermit: vi.fn().mockResolvedValue({ admitted: true }),
      completeTenantBackupMutationPermit: vi.fn().mockResolvedValue(undefined),
    },
    LOG_ARCHIVE_WRITER: { registerPiiPurgeScope: vi.fn(async () => {}) },
    AUDIT_QUEUE: queue,
    DB: { prepare: forbidden },
    DB_PII: { prepare: forbidden },
    AUDIT_ARCHIVE: { put: forbidden },
    SENSITIVE_DETAILS: { put: forbidden },
  } as unknown as Env;
  const service = new AuditService({
    env,
    piiSource: {} as never,
    resolveAuditProfile: async () => profile,
  });
  return { service, env, queue, forbidden };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(emitLogIcebergRow).mockResolvedValue(undefined as never);
  vi.mocked(eraseLogIcebergSubject).mockResolvedValue({ complete: true, removed: 2 });
  mapping.current.mockResolvedValue(ANON);
  mapping.prepare.mockResolvedValue({ id: 'purge-op', old_anonymized_user_id: ANON });
  mapping.complete.mockResolvedValue(undefined);
});

describe('AuditService canonical storage', () => {
  it.each(['pipeline', 'scheduled'] as const)(
    'emits exactly one event in %s and never writes the old primary/archive',
    async (mode) => {
      const { service, env, forbidden, queue } = fixture(mode);
      await service.logEvent('tenant-1', event);
      expect(emitLogIcebergRow).toHaveBeenCalledExactlyOnceWith(
        env,
        expect.objectContaining({
          tenantId: 'tenant-1',
          sourceDataset: 'core.event_log',
          logType: 'audit',
          eventAt: event.createdAt,
          expiresAt: event.createdAt + 90 * 86_400_000,
          row: expect.objectContaining({ id: event.id, created_at: event.createdAt }),
        })
      );
      expect(forbidden).not.toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled();
    }
  );

  it('uses the delivery retention override and keeps the original timestamp', async () => {
    const { env } = fixture();
    const service = new AuditService({
      env,
      resolveAuditProfile: async () => baseProfile,
      resolveDeliveryPlan: async () => ({
        auditProfileId: 'profile',
        primary: null,
        archives: [],
        sinks: [],
        retentionDays: 7,
      }),
    });
    await service.logEvent('tenant-1', event);
    expect(emitLogIcebergRow).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        eventAt: event.createdAt,
        expiresAt: event.createdAt + 7 * 86_400_000,
      })
    );
  });

  it('keeps PII values in nested protected detail with the anonymous subject and 365-day retention', async () => {
    const { service, env, forbidden } = fixture('pipeline');
    const now = Date.now();
    await service.logPIIChange('tenant-1', pii);
    const input = vi.mocked(emitLogIcebergRow).mock.calls[0][1];
    expect(input).toMatchObject({
      sourceDataset: 'pii.pii_log',
      overview: { subject_id: ANON },
      protectedDetail: { values: { old: pii.oldValues, new: pii.newValues } },
      row: { values_encrypted: null, values_r2_key: null },
    });
    expect(input.expiresAt! - input.eventAt).toBe(365 * 86_400_000);
    expect(input.eventAt).toBeGreaterThanOrEqual(now);
    expect(JSON.stringify(input.row)).not.toContain('old@example.test');
    expect(forbidden).not.toHaveBeenCalled();
    expect(env.PII_ENCRYPTION_KEY).toBeUndefined();
  });

  it('rejects an invalid anonymous subject before emitting PII', async () => {
    mapping.current.mockResolvedValue('raw-user');
    await expect(fixture().service.logPIIChange('tenant-1', pii)).rejects.toThrow(
      'audit_pii_subject_invalid'
    );
    expect(emitLogIcebergRow).not.toHaveBeenCalled();
  });

  it('preserves only configured HTTP external sinks and never queues archive duplication', async () => {
    const http = { type: 'http', destinationId: 'https-sink' };
    const { service, queue } = fixture('scheduled', {
      ...baseProfile,
      sinks: [http, { type: 'logpush', dataset: 'old-logpush' }],
    } as AuditProfile);
    await service.logEvent('tenant-1', event);
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_log',
        fanout: expect.objectContaining({ archives: [], sinks: [http] }),
      })
    );
    expect(emitLogIcebergRow).toHaveBeenCalledOnce();
  });

  it('fails a required durable HTTP fanout when the queue refuses acceptance', async () => {
    const { service, queue } = fixture('scheduled', {
      ...baseProfile,
      sinks: [{ type: 'http', destinationId: 'https-sink' }],
      sinkFailureMode: 'retry_until_ttl',
    } as AuditProfile);
    queue.send.mockRejectedValue(new Error('queue_down'));
    await expect(
      service.logEvent('tenant-1', { ...event, requireDurableFanout: true })
    ).rejects.toThrow('audit_fanout_queue_failed');
    expect(emitLogIcebergRow).toHaveBeenCalledOnce();
  });

  it('propagates canonical storage failure instead of falling back to old tables', async () => {
    const { service, forbidden } = fixture();
    vi.mocked(emitLogIcebergRow).mockRejectedValue(new Error('archive_unavailable'));
    await expect(service.logEvent('tenant-1', event)).rejects.toThrow('archive_unavailable');
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('retains the purge operation and reports pending until physical PII deletion finishes', async () => {
    const { service, env } = fixture();
    vi.mocked(eraseLogIcebergSubject).mockResolvedValue({ complete: false, removed: 1 });
    await expect(
      service.purgeUserPII('tenant-1', 'account-1', purgeContext)
    ).resolves.toMatchObject({
      success: false,
      pending: true,
      piiLogsDeleted: 1,
      errorMessage: 'pii_purge_pending',
    });
    expect(eraseLogIcebergSubject).toHaveBeenCalledWith(env, {
      tenantId: 'tenant-1',
      sourceDataset: 'pii.pii_log',
      subjectId: ANON,
    });
    expect(mapping.complete).not.toHaveBeenCalled();
    expect(vi.mocked(emitLogIcebergRow).mock.calls.map(([, row]) => row.row.event_type)).toEqual([
      'user.pii_purge_started',
    ]);
  });

  it('clears the purge operation and emits completion only after physical deletion succeeds', async () => {
    const { service } = fixture();
    await expect(
      service.purgeUserPII('tenant-1', 'account-1', purgeContext)
    ).resolves.toMatchObject({ success: true, piiLogsDeleted: 2 });
    expect(mapping.complete).toHaveBeenCalledWith('tenant-1', 'account-1', 'purge-op');
    expect(vi.mocked(emitLogIcebergRow).mock.calls.map(([, row]) => row.row.event_type)).toEqual([
      'user.pii_purge_started',
      'user.pii_purge_completed',
    ]);
  });

  it('retains the old subject operation if completion logging fails', async () => {
    const { service } = fixture();
    vi.mocked(emitLogIcebergRow).mockImplementation(async (_env, row) => {
      if (row.row.event_type === 'user.pii_purge_completed') throw new Error('archive_unavailable');
      return undefined as never;
    });
    await expect(
      service.purgeUserPII('tenant-1', 'account-1', purgeContext)
    ).resolves.toMatchObject({ success: false });
    expect(mapping.complete).not.toHaveBeenCalled();
  });

  it('does not rotate a PII mapping when Control cannot admit its business mutation', async () => {
    const { service, env } = fixture();
    vi.mocked(env.CONTROL!.acquireTenantBackupMutationPermit).mockResolvedValue({
      admitted: false,
    } as never);
    await expect(
      service.purgeUserPII('tenant-1', 'account-1', purgeContext)
    ).resolves.toMatchObject({
      success: false,
      errorMessage: expect.stringContaining('backup_mutation_unavailable'),
    });
    expect(mapping.prepare).not.toHaveBeenCalled();
    expect(emitLogIcebergRow).not.toHaveBeenCalled();
  });

  it('does not create a replacement mapping or claim success when purge cannot find the original subject', async () => {
    mapping.prepare.mockRejectedValue(new Error('pii_purge_subject_mapping_missing'));
    await expect(
      fixture().service.purgeUserPII('tenant-1', 'account-1', purgeContext)
    ).resolves.toMatchObject({
      success: false,
      errorMessage: expect.stringContaining('mapping_missing'),
    });
    expect(mapping.current).not.toHaveBeenCalled();
    expect(eraseLogIcebergSubject).not.toHaveBeenCalled();
  });

  it('does not substitute a random ID after an account tombstone denies mapping creation', async () => {
    mapping.current.mockResolvedValue(null);
    await expect(fixture().service.getAnonymizedUserId('tenant-1', 'account-1')).rejects.toThrow(
      'audit_subject_erased'
    );
  });
});
