import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit-service';
import type { AuditQueueMessage } from '../types';
import type { AuditProfile } from '../../../types/runtime-profile';
import type { IAuditStorageAdapter } from '../storage';
import type { DatabaseAdapter } from '../../../db';

function createMockD1(firstResults: unknown[] = [null]): D1Database {
  const firstQueue = [...firstResults];
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi
      .fn()
      .mockImplementation(async () =>
        firstQueue.length > 0 ? (firstQueue.shift() ?? null) : null
      ),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };

  return {
    prepare: vi.fn().mockReturnValue(statement),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

function createMockQueue() {
  return {
    send: vi.fn<[AuditQueueMessage], Promise<void>>().mockResolvedValue(undefined),
  } as unknown as Queue<AuditQueueMessage>;
}

function createMockStorageAdapter(): IAuditStorageAdapter {
  return {
    getBackendType: vi.fn().mockReturnValue('HYPERDRIVE'),
    getIdentifier: vi.fn().mockReturnValue('audit-pg'),
    writeEventLog: vi.fn().mockResolvedValue({
      success: true,
      entriesWritten: 1,
      backend: 'audit-pg',
      durationMs: 1,
    }),
    writeEventLogBatch: vi.fn(),
    writePIILog: vi.fn().mockResolvedValue({
      success: true,
      entriesWritten: 1,
      backend: 'audit-pg',
      durationMs: 1,
    }),
    writePIILogBatch: vi.fn(),
    query: vi.fn(),
    count: vi.fn(),
    listTenantRetentionCandidates: vi.fn().mockResolvedValue([]),
    listGlobalRetentionCandidates: vi.fn().mockResolvedValue([]),
    deleteTenantByRetention: vi.fn(),
    deleteGlobalByRetention: vi.fn(),
    isHealthy: vi.fn(),
    close: vi.fn(),
  };
}

function createMockDatabaseAdapter(name: string): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      rowsAffected: 1,
      success: true,
    }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 1,
      type: name,
    }),
    getType: vi.fn().mockReturnValue(name),
    close: vi.fn(),
  };
}

describe('AuditService routing', () => {
  let coreSource: D1Database;
  let piiSource: D1Database;
  let r2Bucket: R2Bucket;

  beforeEach(() => {
    coreSource = createMockD1();
    piiSource = createMockD1();
    r2Bucket = {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
  });

  it('writes the primary store synchronously and sends archive/logpush fanout to the queue', async () => {
    const auditProfile: AuditProfile = {
      id: 'audit-profile-1',
      kind: 'audit',
      label: 'Primary + Fanout',
      primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
      archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
      sinks: [{ type: 'logpush', destinationRef: 'workers-logpush', dataset: 'authrim_audit' }],
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'retry_until_ttl',
      retention: { primaryDays: 3, archiveDays: 30 },
    };
    const queue = createMockQueue();
    const service = new AuditService({
      coreSource,
      piiSource,
      r2Bucket,
      auditQueue: queue,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile),
    });

    await service.logEvent('tenant-a', {
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
    });

    expect(coreSource.prepare).toHaveBeenCalledOnce();
    expect(queue.send).toHaveBeenCalledOnce();
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_log',
        tenantId: 'tenant-a',
        fanout: {
          auditProfileId: 'audit-profile-1',
          archives: [{ type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' }],
          sinks: [
            {
              type: 'logpush',
              destinationRef: 'workers-logpush',
              dataset: 'authrim_audit',
            },
          ],
          archiveFailureMode: 'gate_cleanup',
          sinkFailureMode: 'retry_until_ttl',
        },
      })
    );
  });

  it('supports archive-only audit profiles by skipping the primary write and queueing fanout', async () => {
    const auditProfile: AuditProfile = {
      id: 'archive-only',
      kind: 'audit',
      label: 'Archive Only',
      primary: null,
      archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
      sinks: [{ type: 'logpush', destinationRef: 'workers-logpush' }],
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'best_effort',
    };
    const queue = createMockQueue();
    const service = new AuditService({
      coreSource,
      piiSource,
      r2Bucket,
      auditQueue: queue,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile),
    });

    await service.logEvent('tenant-a', {
      eventType: 'auth.logout',
      eventCategory: 'auth',
      result: 'success',
    });

    expect(coreSource.prepare).not.toHaveBeenCalled();
    expect(queue.send).toHaveBeenCalledOnce();
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        fanout: expect.objectContaining({
          archives: [{ type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' }],
        }),
      })
    );
  });

  it('applies runtime delivery-plan overrides for routing fanout and retention', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const auditProfile: AuditProfile = {
      id: 'audit-profile-1',
      kind: 'audit',
      label: 'Profile Base',
      primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
      archive: null,
      sinks: [],
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'retry_until_ttl',
    };
    const queue = createMockQueue();
    const service = new AuditService({
      coreSource,
      piiSource,
      r2Bucket,
      auditQueue: queue,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile),
      resolveDeliveryPlan: vi.fn().mockResolvedValue({
        auditProfileId: 'audit-profile-1',
        primary: null,
        archives: [
          { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
          { type: 'r2', bucketRef: 'SECONDARY_BUCKET', prefix: 'secondary/' },
        ],
        sinks: [{ type: 'logpush', destinationRef: 'workers-logpush' }],
        retentionDays: 30,
        archiveFailureMode: 'gate_cleanup',
        sinkFailureMode: 'retry_until_ttl',
        matchedRuleNames: ['tenant-archive'],
      }),
    });

    await service.logEvent('tenant-a', {
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
    });

    expect(coreSource.prepare).not.toHaveBeenCalled();
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        fanout: expect.objectContaining({
          archives: [
            { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
            { type: 'r2', bucketRef: 'SECONDARY_BUCKET', prefix: 'secondary/' },
          ],
          matchedRuleNames: ['tenant-archive'],
        }),
        entries: [
          expect.objectContaining({
            retentionUntil: expect.any(Number),
          }),
        ],
      })
    );
    const sentMessage = (queue.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentMessage.entries[0].retentionUntil).toBeGreaterThanOrEqual(
      now + 29 * 24 * 60 * 60 * 1000
    );
  });

  it('writes external postgres primary synchronously through the resolved adapter', async () => {
    const auditProfile: AuditProfile = {
      id: 'audit-postgres',
      kind: 'audit',
      label: 'Postgres Primary',
      primary: { type: 'postgres', connectionRef: 'audit-primary', dataset: 'event_log' },
      archive: null,
      sinks: [],
      archiveFailureMode: 'best_effort',
      sinkFailureMode: 'best_effort',
    };
    const primaryAdapter = createMockStorageAdapter();
    const service = new AuditService({
      coreSource,
      piiSource,
      r2Bucket,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile),
      resolvePrimaryAdapter: vi.fn().mockResolvedValue(primaryAdapter),
    });

    await service.logEvent('tenant-a', {
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
    });

    expect(coreSource.prepare).not.toHaveBeenCalled();
    expect(primaryAdapter.writeEventLog).toHaveBeenCalledOnce();
  });

  it('writes external mysql primary synchronously through the resolved adapter', async () => {
    const auditProfile: AuditProfile = {
      id: 'audit-mysql',
      kind: 'audit',
      label: 'MySQL Primary',
      primary: { type: 'mysql', connectionRef: 'audit-primary-mysql', dataset: 'event_log' },
      archive: null,
      sinks: [],
      archiveFailureMode: 'best_effort',
      sinkFailureMode: 'best_effort',
    };
    const primaryAdapter = createMockStorageAdapter();
    const service = new AuditService({
      coreSource,
      piiSource,
      r2Bucket,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile),
      resolvePrimaryAdapter: vi.fn().mockResolvedValue(primaryAdapter),
    });

    await service.logEvent('tenant-a', {
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
    });

    expect(coreSource.prepare).not.toHaveBeenCalled();
    expect(primaryAdapter.writeEventLog).toHaveBeenCalledOnce();
  });

  it('writes pii audit entries to external postgres primary through the resolved adapter', async () => {
    const auditProfile: AuditProfile = {
      id: 'audit-postgres',
      kind: 'audit',
      label: 'Postgres Primary',
      primary: { type: 'postgres', connectionRef: 'audit-primary', dataset: 'pii_log' },
      archive: null,
      sinks: [],
      archiveFailureMode: 'best_effort',
      sinkFailureMode: 'best_effort',
    };
    const primaryAdapter = createMockStorageAdapter();
    const piiSourceForTest = createMockD1([null, { anonymized_user_id: 'anon-1' }]);
    const service = new AuditService({
      coreSource,
      piiSource: piiSourceForTest,
      r2Bucket,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile),
      resolvePrimaryAdapter: vi.fn().mockResolvedValue(primaryAdapter),
    });

    await service.logPIIChange('tenant-a', {
      userId: 'user-1',
      changeType: 'update',
      affectedFields: ['email'],
      newValues: { email: 'u@example.com' },
      actorType: 'admin',
    });

    expect(piiSourceForTest.prepare).toHaveBeenCalled();
    expect(primaryAdapter.writePIILog).toHaveBeenCalledOnce();
  });

  it('accepts pre-resolved database adapters for transitional audit paths', async () => {
    const auditProfile: AuditProfile = {
      id: 'audit-d1-primary',
      kind: 'audit',
      label: 'D1 Primary',
      primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
      archive: null,
      sinks: [],
      archiveFailureMode: 'best_effort',
      sinkFailureMode: 'best_effort',
    };
    const coreAdapter = createMockDatabaseAdapter('core-adapter');
    const piiAdapter = createMockDatabaseAdapter('pii-adapter');
    const service = new AuditService({
      coreSource: coreAdapter,
      piiSource: piiAdapter,
      r2Bucket,
      resolveAuditProfile: vi.fn().mockResolvedValue(auditProfile),
    });

    await service.logEvent('tenant-a', {
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
    });

    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO event_log'),
      expect.any(Array)
    );
  });
});
