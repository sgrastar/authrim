import { describe, expect, it, vi } from 'vitest';
import type {
  AuditProfile,
  AuditTarget,
  EventLogEntry,
  IAuditStorageAdapter,
  AuditLogType,
  PIILogEntry,
} from '@authrim/ar-lib-core';
import { cleanupResolvedAuditPrimaries } from '../audit-maintenance';

function createAuditProfile(id: string, primary: AuditTarget | null): AuditProfile {
  return {
    id,
    kind: 'audit',
    label: id,
    builtin: false,
    primary,
    archive: null,
    sinks: [],
  };
}

function createMockAdapter(deleteCount: number): IAuditStorageAdapter {
  return {
    getBackendType: vi.fn().mockReturnValue('D1'),
    getIdentifier: vi.fn().mockReturnValue('mock'),
    writeEventLog: vi.fn(),
    writeEventLogBatch: vi.fn(),
    writePIILog: vi.fn(),
    writePIILogBatch: vi.fn(),
    query: vi.fn(),
    count: vi.fn(),
    listRetentionCandidates: vi.fn(async () => []),
    deleteByRetention: vi.fn(
      async (
        _logType: AuditLogType,
        _beforeTime: number,
        _tenantId?: string,
        _batchSize?: number
      ) => deleteCount
    ),
    isHealthy: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as IAuditStorageAdapter;
}

function createEventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    eventType: 'auth.login',
    eventCategory: 'auth',
    result: 'success',
    severity: 'info',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createPiiEntry(overrides: Partial<PIILogEntry> = {}): PIILogEntry {
  return {
    id: 'pii-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    anonymizedUserId: 'anon-1',
    changeType: 'update',
    affectedFields: 'email',
    encryptionKeyId: 'key-1',
    encryptionIv: 'iv-1',
    actorType: 'user',
    retentionUntil: 1_690_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('cleanupResolvedAuditPrimaries', () => {
  it('cleans D1 and postgres primaries while skipping archive-only tenants', async () => {
    const d1EventAdapter = createMockAdapter(3);
    const d1PiiAdapter = createMockAdapter(4);
    const postgresEventAdapter = createMockAdapter(5);
    const postgresPiiAdapter = createMockAdapter(6);

    const summary = await cleanupResolvedAuditPrimaries({} as any, {
      tenantIds: ['archive-tenant', 'd1-tenant', 'pg-tenant'],
      resolveAuditProfile: async (tenantId) => {
        if (tenantId === 'archive-tenant') {
          return createAuditProfile('archive-only', null);
        }
        if (tenantId === 'd1-tenant') {
          return createAuditProfile('d1-primary', {
            type: 'd1',
            bindingRef: 'DB',
            dataset: 'event_log',
          });
        }
        return createAuditProfile('pg-primary', {
          type: 'postgres',
          bindingRef: 'HYPERDRIVE_AUDIT_PRIMARY',
          connectionRef: 'audit-primary',
        });
      },
      d1EventAdapter,
      d1PiiAdapter,
      createPrimaryAdapter: async (_target, logType) =>
        logType === 'event' ? postgresEventAdapter : postgresPiiAdapter,
    });

    expect(summary).toEqual({
      tenantCount: 3,
      processedTenants: 2,
      archiveOnlyTenants: 1,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 8,
      piiDeleted: 10,
    });

    expect(d1EventAdapter.deleteByRetention).toHaveBeenCalledWith(
      'event',
      expect.any(Number),
      'd1-tenant',
      1000
    );
    expect(d1PiiAdapter.deleteByRetention).toHaveBeenCalledWith(
      'pii',
      expect.any(Number),
      'd1-tenant',
      1000
    );
    expect(postgresEventAdapter.deleteByRetention).toHaveBeenCalledWith(
      'event',
      expect.any(Number),
      'pg-tenant',
      1000
    );
    expect(postgresPiiAdapter.deleteByRetention).toHaveBeenCalledWith(
      'pii',
      expect.any(Number),
      'pg-tenant',
      1000
    );
  });

  it('marks unsupported external primaries as pending support', async () => {
    const d1EventAdapter = createMockAdapter(0);
    const d1PiiAdapter = createMockAdapter(0);

    const summary = await cleanupResolvedAuditPrimaries({} as any, {
      tenantIds: ['pg-tenant'],
      resolveAuditProfile: async () =>
        createAuditProfile('pg-primary', {
          type: 'postgres',
          bindingRef: 'HYPERDRIVE_AUDIT_PRIMARY',
          connectionRef: 'audit-primary',
        }),
      d1EventAdapter,
      d1PiiAdapter,
      createPrimaryAdapter: async () => null,
    });

    expect(summary).toEqual({
      tenantCount: 1,
      processedTenants: 0,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 1,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 0,
      piiDeleted: 0,
    });
    expect(d1EventAdapter.deleteByRetention).not.toHaveBeenCalled();
    expect(d1PiiAdapter.deleteByRetention).not.toHaveBeenCalled();
  });

  it('cleans mysql primaries through the resolved external adapter hook', async () => {
    const mysqlEventAdapter = createMockAdapter(2);
    const mysqlPiiAdapter = createMockAdapter(3);

    const summary = await cleanupResolvedAuditPrimaries({} as any, {
      tenantIds: ['mysql-tenant'],
      resolveAuditProfile: async () =>
        createAuditProfile('mysql-primary', {
          type: 'mysql',
          bindingRef: 'HYPERDRIVE_AUDIT_PRIMARY_MYSQL',
          connectionRef: 'audit-primary-mysql',
        }),
      createPrimaryAdapter: async (_target, logType) =>
        logType === 'event' ? mysqlEventAdapter : mysqlPiiAdapter,
    });

    expect(summary).toEqual({
      tenantCount: 1,
      processedTenants: 1,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 2,
      piiDeleted: 3,
    });
  });

  it('copies expiring records to archive before deleting when archiveBeforeDelete is enabled', async () => {
    const d1EventAdapter = createMockAdapter(1);
    const d1PiiAdapter = createMockAdapter(1);
    (d1EventAdapter.listRetentionCandidates as any).mockResolvedValue([
      createEventEntry({ tenantId: 'tenant-1', retentionUntil: 1_690_000_000_000 }),
    ]);
    (d1PiiAdapter.listRetentionCandidates as any).mockResolvedValue([
      createPiiEntry({ tenantId: 'tenant-1' }),
    ]);

    const archiveEventAdapter = createMockAdapter(0);
    const archivePiiAdapter = createMockAdapter(0);
    vi.mocked(archiveEventAdapter.writeEventLogBatch).mockResolvedValue({
      success: true,
      entriesWritten: 1,
      backend: 'archive-event',
      durationMs: 1,
    });
    vi.mocked(archivePiiAdapter.writePIILogBatch).mockResolvedValue({
      success: true,
      entriesWritten: 1,
      backend: 'archive-pii',
      durationMs: 1,
    });

    const summary = await cleanupResolvedAuditPrimaries({} as any, {
      tenantIds: ['tenant-1'],
      resolveAuditProfile: async () => ({
        ...createAuditProfile('d1-primary', {
          type: 'd1',
          bindingRef: 'DB',
          dataset: 'event_log',
        }),
        archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
        retention: { archiveBeforeDelete: true },
      }),
      d1EventAdapter,
      d1PiiAdapter,
      createArchiveAdapter: async (_target, logType) =>
        logType === 'event' ? archiveEventAdapter : archivePiiAdapter,
    });

    expect(summary).toEqual({
      tenantCount: 1,
      processedTenants: 1,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 1,
      piiArchived: 1,
      eventDeleted: 1,
      piiDeleted: 1,
    });
    expect(archiveEventAdapter.writeEventLogBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'evt-1' })])
    );
    expect(archivePiiAdapter.writePIILogBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'pii-1' })])
    );
    expect(d1EventAdapter.deleteByRetention).toHaveBeenCalledOnce();
    expect(d1PiiAdapter.deleteByRetention).toHaveBeenCalledOnce();
  });

  it('skips delete for a log type when archive copy fails', async () => {
    const d1EventAdapter = createMockAdapter(1);
    const d1PiiAdapter = createMockAdapter(1);
    (d1EventAdapter.listRetentionCandidates as any).mockResolvedValue([createEventEntry()]);
    (d1PiiAdapter.listRetentionCandidates as any).mockResolvedValue([createPiiEntry()]);

    const archiveEventAdapter = createMockAdapter(0);
    const archivePiiAdapter = createMockAdapter(0);
    vi.mocked(archiveEventAdapter.writeEventLogBatch).mockResolvedValue({
      success: false,
      entriesWritten: 0,
      backend: 'archive-event',
      durationMs: 1,
      errorMessage: 'archive_write_failed',
    });
    vi.mocked(archivePiiAdapter.writePIILogBatch).mockResolvedValue({
      success: true,
      entriesWritten: 1,
      backend: 'archive-pii',
      durationMs: 1,
    });

    const summary = await cleanupResolvedAuditPrimaries({} as any, {
      tenantIds: ['tenant-1'],
      resolveAuditProfile: async () => ({
        ...createAuditProfile('d1-primary', {
          type: 'd1',
          bindingRef: 'DB',
          dataset: 'event_log',
        }),
        archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
        retention: { archiveBeforeDelete: true },
      }),
      d1EventAdapter,
      d1PiiAdapter,
      createArchiveAdapter: async (_target, logType) =>
        logType === 'event' ? archiveEventAdapter : archivePiiAdapter,
    });

    expect(summary).toEqual({
      tenantCount: 1,
      processedTenants: 1,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 0,
      archiveCopyFailures: 1,
      eventArchived: 0,
      piiArchived: 1,
      eventDeleted: 0,
      piiDeleted: 1,
    });
    expect(d1EventAdapter.deleteByRetention).not.toHaveBeenCalled();
    expect(d1PiiAdapter.deleteByRetention).toHaveBeenCalledOnce();
  });
});
