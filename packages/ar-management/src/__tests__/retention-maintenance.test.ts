import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnsureDatabaseAdapter,
  mockResolvePlatformSettingsWithSources,
  mockResolveTenantAssignedDatabaseSourcesFromRegistry,
  mockCleanupResolvedAuditPrimaries,
  mockTombstone,
} = vi.hoisted(() => ({
  mockTombstone: vi.fn(),
  mockEnsureDatabaseAdapter: vi.fn(),
  mockResolvePlatformSettingsWithSources: vi.fn(),
  mockResolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(),
  mockCleanupResolvedAuditPrimaries: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    resolvePlatformSettingsWithSources: mockResolvePlatformSettingsWithSources,
    resolveTenantAssignedDatabaseSourcesFromRegistry:
      mockResolveTenantAssignedDatabaseSourcesFromRegistry,
    tombstoneObjectCatalogEntryForTenant: mockTombstone,
  };
});

vi.mock('../audit-maintenance', () => ({
  cleanupResolvedAuditPrimaries: mockCleanupResolvedAuditPrimaries,
}));

import { runRetentionMaintenance } from '../retention-maintenance';
import { readTenantRetentionRuns } from '../retention-tenant-runs';
import { getScheduledMaintenanceTaskView } from '../r2-storage-maintenance';

function createKv() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function createAdapter(rowsAffected = 0) {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected }),
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
  };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
  module: vi.fn(),
  startTimer: vi.fn(),
} as never;

describe('retention maintenance', () => {
  let kv: ReturnType<typeof createKv>;
  let leaseAdapter: ReturnType<typeof createAdapter>;
  let piiAdapter: ReturnType<typeof createAdapter>;
  let coreAdapter: ReturnType<typeof createAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    kv = createKv();
    leaseAdapter = createAdapter(1);
    piiAdapter = createAdapter(2);
    coreAdapter = createAdapter(3);
    mockEnsureDatabaseAdapter.mockImplementation((_source: unknown, label: string) =>
      label.startsWith('tombstone-retention:') ? piiAdapter : leaseAdapter
    );
    mockResolvePlatformSettingsWithSources.mockResolvedValue({
      values: { 'audit.check_api_retention_days': 30 },
      sources: {},
    });
    mockResolveTenantAssignedDatabaseSourcesFromRegistry.mockResolvedValue([
      { source: {}, bindingRef: 'DB_PII' },
    ]);
    mockCleanupResolvedAuditPrimaries.mockResolvedValue({
      tenantCount: 1,
      processedTenants: 1,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 4,
      piiDeleted: 1,
      failedTenants: 0,
      tenantOutcomes: { 'tenant-a': 'cleaned' },
    });
  });

  function env() {
    return { AUTHRIM_CONFIG: kv, DB_ADMIN: {}, SETTINGS: {} } as never;
  }

  const targets = () => [
    { tenantId: 'tenant-a', adapters: [{ adapter: coreAdapter as never, bindingRef: 'DB' }] },
  ];

  it('deletes each kind of data past its retention, for the tenant only', async () => {
    const before = Date.now();
    await runRetentionMaintenance(env(), targets(), log);

    expect(mockCleanupResolvedAuditPrimaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantIds: ['tenant-a'] })
    );

    const [checkSql, checkParams] = coreAdapter.execute.mock.calls[0]!;
    expect(checkSql).toBe(
      'DELETE FROM permission_check_audit WHERE id IN (SELECT id FROM permission_check_audit WHERE tenant_id = ? AND checked_at < ? LIMIT ?)'
    );
    const cutoff = checkParams[1] as number;
    expect(checkParams[0]).toBe('tenant-a');
    expect(Math.floor(before / 1000) - 30 * 86400 - cutoff).toBeLessThanOrEqual(0);
    expect(cutoff).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 30 * 86400);

    const [tombstoneSql, tombstoneParams] = piiAdapter.execute.mock.calls[0]!;
    expect(tombstoneSql).toBe(
      'DELETE FROM users_pii_tombstone WHERE id IN (SELECT id FROM users_pii_tombstone WHERE tenant_id = ? AND retention_until < ? LIMIT ?)'
    );
    expect(tombstoneParams[0]).toBe('tenant-a');
    expect(mockResolveTenantAssignedDatabaseSourcesFromRegistry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-a', role: 'tenant_pii' })
    );
  });

  it('records, per tenant and per task, when it last ran and how it ended', async () => {
    mockCleanupResolvedAuditPrimaries.mockResolvedValueOnce({
      tenantCount: 1,
      processedTenants: 0,
      archiveOnlyTenants: 1,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 0,
      piiDeleted: 0,
      failedTenants: 0,
      tenantOutcomes: { 'tenant-a': 'archive_only' },
    });
    await runRetentionMaintenance(env(), targets(), log);

    const runs = await readTenantRetentionRuns(env(), 'tenant-a');
    expect(runs).toEqual({
      audit_retention: { at: expect.any(Number), outcome: 'archive_only' },
      check_api_audit_retention: { at: expect.any(Number), outcome: 'cleaned' },
      user_tombstone_retention: { at: expect.any(Number), outcome: 'cleaned' },
      compliance_report_retention: { at: expect.any(Number), outcome: 'cleaned' },
    });
    expect(await readTenantRetentionRuns(env(), 'tenant-b')).toEqual({});

    const view = await getScheduledMaintenanceTaskView(env(), 'check_api_audit_retention');
    expect(view).toMatchObject({ enabled: true, status: 'succeeded' });
    expect(view.lastResult).toMatchObject({ retentionDays: 30, deleted: 3 });
  });

  it('deletes no Check API decisions when their retention cannot be read', async () => {
    mockResolvePlatformSettingsWithSources.mockRejectedValueOnce(new Error('settings_unavailable'));
    await runRetentionMaintenance(env(), targets(), log);

    expect(coreAdapter.execute).not.toHaveBeenCalled();
    const view = await getScheduledMaintenanceTaskView(env(), 'check_api_audit_retention');
    expect(view.status).toBe('failed');
    expect((await readTenantRetentionRuns(env(), 'tenant-a')).check_api_audit_retention).toBe(
      undefined
    );
  });

  it('keeps deleting in batches while full ones come back, up to the per-run limit', async () => {
    coreAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1000 });
    await runRetentionMaintenance(env(), targets(), log);
    expect(coreAdapter.execute).toHaveBeenCalledTimes(10);

    coreAdapter.execute.mockReset();
    coreAdapter.execute
      .mockResolvedValueOnce({ success: true, rowsAffected: 1000 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 12 });
    await runRetentionMaintenance(env(), targets(), log);
    expect(coreAdapter.execute).toHaveBeenCalledTimes(2);
  });

  it('marks a tenant whose tombstone stores cannot be reached as failed', async () => {
    mockResolveTenantAssignedDatabaseSourcesFromRegistry.mockRejectedValueOnce(
      new Error('registry_unavailable')
    );
    await runRetentionMaintenance(env(), targets(), log);

    expect(piiAdapter.execute).not.toHaveBeenCalled();
    expect((await readTenantRetentionRuns(env(), 'tenant-a')).user_tombstone_retention).toEqual({
      at: expect.any(Number),
      outcome: 'failed',
    });
    const view = await getScheduledMaintenanceTaskView(env(), 'user_tombstone_retention');
    expect(view.status).toBe('failed');
  });

  it('keeps each task and tenant in its own record, so tasks never overwrite each other', async () => {
    await runRetentionMaintenance(env(), targets(), log);
    expect(
      [...kv.values.keys()].filter((key) => key.startsWith('jobs:retention-tenant-run:'))
    ).toEqual([
      'jobs:retention-tenant-run:v1:audit_retention:tenant-a',
      'jobs:retention-tenant-run:v1:check_api_audit_retention:tenant-a',
      'jobs:retention-tenant-run:v1:user_tombstone_retention:tenant-a',
      'jobs:retention-tenant-run:v1:compliance_report_retention:tenant-a',
    ]);
    for (const stored of [
      '{broken',
      '{"at":1e309,"outcome":"cleaned"}',
      '{"at":-1,"outcome":"cleaned"}',
      '{"at":1.5,"outcome":"cleaned"}',
      '{"at":1,"outcome":"bogus"}',
      'null',
    ]) {
      kv.values.set('jobs:retention-tenant-run:v1:audit_retention:tenant-a', stored);
      const runs = await readTenantRetentionRuns(env(), 'tenant-a');
      expect(runs).not.toHaveProperty('audit_retention');
      // Only the malformed record is skipped.
      expect(runs).toHaveProperty('check_api_audit_retention');
    }
  });

  it('deletes no Check API decisions without the settings store (it would read the default)', async () => {
    await runRetentionMaintenance({ AUTHRIM_CONFIG: kv, DB_ADMIN: {} } as never, targets(), log);
    expect(mockResolvePlatformSettingsWithSources).not.toHaveBeenCalled();
    expect(coreAdapter.execute).not.toHaveBeenCalled();
    const view = await getScheduledMaintenanceTaskView(env(), 'check_api_audit_retention');
    expect(view).toMatchObject({
      status: 'failed',
      lastErrorCode: 'check_api_audit_retention_settings_unavailable',
    });
  });

  it('still cleans the other tombstone stores when one fails', async () => {
    const failing = createAdapter();
    failing.execute.mockRejectedValue(new Error('store_down'));
    mockResolveTenantAssignedDatabaseSourcesFromRegistry.mockResolvedValueOnce([
      { source: { id: 'a' }, bindingRef: 'DB_PII_A' },
      { source: { id: 'b' }, bindingRef: 'DB_PII_B' },
    ]);
    mockEnsureDatabaseAdapter.mockImplementation((_source: unknown, label: string) =>
      label === 'tombstone-retention:DB_PII_A'
        ? failing
        : label.startsWith('tombstone-retention:')
          ? piiAdapter
          : leaseAdapter
    );
    await runRetentionMaintenance(env(), targets(), log);

    expect(failing.execute).toHaveBeenCalled();
    expect(piiAdapter.execute).toHaveBeenCalled();
    expect(
      (await readTenantRetentionRuns(env(), 'tenant-a')).user_tombstone_retention
    ).toMatchObject({
      outcome: 'failed',
    });
  });

  it('records a tenant whose audit cleanup failed and fails the task', async () => {
    mockCleanupResolvedAuditPrimaries.mockResolvedValueOnce({
      tenantCount: 1,
      processedTenants: 0,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 0,
      piiDeleted: 0,
      failedTenants: 1,
      tenantOutcomes: { 'tenant-a': 'failed' },
    });
    await runRetentionMaintenance(env(), targets(), log);
    expect((await readTenantRetentionRuns(env(), 'tenant-a')).audit_retention).toMatchObject({
      outcome: 'failed',
    });
    const view = await getScheduledMaintenanceTaskView(env(), 'audit_retention');
    expect(view).toMatchObject({
      status: 'failed',
      lastErrorCode: 'audit_retention_partial_failure',
    });
  });

  it('runs every task and records them within KV write limits (one write per key per second)', async () => {
    const lastWrite = new Map<string, number>();
    kv.put.mockImplementation(async (key: string, value: string) => {
      const now = Date.now();
      if (now - (lastWrite.get(key) ?? -Infinity) < 1000) {
        throw new Error('KV PUT failed: 429 Too Many Requests');
      }
      lastWrite.set(key, now);
      kv.values.set(key, value);
    });
    await runRetentionMaintenance(env(), targets(), log);

    expect(coreAdapter.execute).toHaveBeenCalled();
    expect(piiAdapter.execute).toHaveBeenCalled();
    for (const task of [
      'audit_retention',
      'check_api_audit_retention',
      'user_tombstone_retention',
    ] as const) {
      expect((await getScheduledMaintenanceTaskView(env(), task)).status).toBe('succeeded');
    }
  });

  it('keeps going when the task state cannot be recorded at all', async () => {
    kv.put.mockRejectedValue(new Error('KV unavailable'));
    await runRetentionMaintenance(env(), targets(), log);
    expect(mockCleanupResolvedAuditPrimaries).toHaveBeenCalled();
    expect(coreAdapter.execute).toHaveBeenCalled();
    expect(piiAdapter.execute).toHaveBeenCalled();
  });

  it('records a tenant named like an Object member', async () => {
    mockCleanupResolvedAuditPrimaries.mockResolvedValueOnce({
      tenantCount: 1,
      processedTenants: 1,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 0,
      piiDeleted: 0,
      failedTenants: 0,
      tenantOutcomes: Object.assign(Object.create(null), { constructor: 'cleaned' }),
    });
    await runRetentionMaintenance(
      env(),
      [
        {
          tenantId: 'constructor',
          adapters: [{ adapter: coreAdapter as never, bindingRef: 'DB' }],
        },
      ],
      log
    );
    expect((await readTenantRetentionRuns(env(), 'constructor')).audit_retention).toMatchObject({
      outcome: 'cleaned',
    });
  });

  it('expires reports past their download period: their file first, then the report', async () => {
    mockTombstone.mockResolvedValue(undefined);
    coreAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM compliance_reports')
        ? [{ id: 'report-1', object_catalog_id: 'catalog-1', object_key_base: 'key' }]
        : []
    );
    await runRetentionMaintenance(env(), targets(), log);
    const [selectSql, selectParams] = coreAdapter.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM compliance_reports')
    )!;
    // Completed ones past their download period, and files of ones that never completed.
    expect(selectSql).toContain("status IN ('completed', 'generating', 'failed')");
    expect(selectParams[0]).toBe('tenant-a');
    // In the admin catalog, which the artifact cleanup deletes from.
    expect(mockTombstone).toHaveBeenCalledWith(
      leaseAdapter,
      'tenant-a',
      'catalog-1',
      expect.any(Number)
    );
    const update = coreAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes("ELSE 'expired' END")
    )!;
    expect(update[1]).toEqual(['tenant-a', 'report-1']);
    expect(mockTombstone.mock.invocationCallOrder[0]).toBeLessThan(
      coreAdapter.execute.mock.invocationCallOrder[coreAdapter.execute.mock.calls.indexOf(update)]!
    );
    expect(
      (await readTenantRetentionRuns(env(), 'tenant-a')).compliance_report_retention?.outcome
    ).toBe('cleaned');

    // A report whose file cannot be deleted stays as it is, and the tenant's run failed.
    mockTombstone.mockRejectedValueOnce(new Error('admin_unavailable'));
    coreAdapter.execute.mockClear();
    await runRetentionMaintenance(env(), targets(), log);
    expect(
      coreAdapter.execute.mock.calls.some(([sql]) => String(sql).includes("ELSE 'expired' END"))
    ).toBe(false);
    expect(
      (await readTenantRetentionRuns(env(), 'tenant-a')).compliance_report_retention?.outcome
    ).toBe('failed');
  });

  it('deletes the stored file of a report that never completed, from where it was stored', async () => {
    const bucket = {
      list: vi.fn(async () => ({
        objects: [{ key: 'compliance-reports/tenant-a/r-1.csv' }],
        truncated: false,
      })),
      delete: vi.fn(async () => undefined),
    };
    coreAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM compliance_reports')
        ? [
            {
              id: 'r-1',
              object_catalog_id: null,
              object_key_base: 'compliance-reports/tenant-a/r-1',
            },
          ]
        : []
    );
    await runRetentionMaintenance(
      { AUTHRIM_CONFIG: kv, DB_ADMIN: {}, SETTINGS: {}, EXPORT_ARTIFACTS: bucket } as never,
      targets(),
      log
    );
    expect(bucket.list).toHaveBeenCalledWith({
      prefix: 'compliance-reports/tenant-a/r-1.',
      cursor: undefined,
    });
    expect(bucket.delete).toHaveBeenCalledWith(['compliance-reports/tenant-a/r-1.csv']);
    expect(mockTombstone).not.toHaveBeenCalled();
  });
});
