import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateDiagnosticLogR2Adapter,
  mockDeleteByRetentionPage,
  mockCreateSettingsManager,
  mockListEnvironmentTenantDefaultStores,
  mockCleanupOrphanedUserImportUploads,
  mockEnsureDatabaseAdapter,
  mockResolveTenantUserStoreSourcesFromEnv,
} = vi.hoisted(() => ({
  mockCreateDiagnosticLogR2Adapter: vi.fn(),
  mockDeleteByRetentionPage: vi.fn(),
  mockCreateSettingsManager: vi.fn(),
  mockListEnvironmentTenantDefaultStores: vi.fn(),
  mockCleanupOrphanedUserImportUploads: vi.fn(),
  mockEnsureDatabaseAdapter: vi.fn(),
  mockResolveTenantUserStoreSourcesFromEnv: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createDiagnosticLogR2Adapter: mockCreateDiagnosticLogR2Adapter,
    createSettingsManager: mockCreateSettingsManager,
    listEnvironmentTenantDefaultStores: mockListEnvironmentTenantDefaultStores,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    resolveTenantUserStoreSourcesFromEnv: mockResolveTenantUserStoreSourcesFromEnv,
  };
});

vi.mock('../user-import-jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../user-import-jobs')>();
  return {
    ...actual,
    cleanupOrphanedUserImportUploads: mockCleanupOrphanedUserImportUploads,
  };
});

import { readTenantRetentionRuns } from '../retention-tenant-runs';
import {
  cleanupDiagnosticLogs,
  cleanupOrphanedAuditTransientPayloads,
  cleanupOrphanedPublicAssets,
  deleteTenantPublicAssets,
  getR2MaintenanceDashboard,
  processR2StorageMaintenance,
  scanR2Metrics,
} from '../r2-storage-maintenance';

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

function emptyList() {
  return { objects: [], truncated: false, delimitedPrefixes: [] };
}

function createBucket(
  list: (options?: Record<string, unknown>) => Promise<Record<string, unknown>> = async () =>
    emptyList()
) {
  return {
    list: vi.fn(list),
    delete: vi.fn(async () => undefined),
  };
}

describe('R2 scheduled storage maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteByRetentionPage.mockResolvedValue({ deleted: 3, scanned: 3 });
    mockCreateDiagnosticLogR2Adapter.mockReturnValue({
      deleteByRetentionPage: mockDeleteByRetentionPage,
    });
    mockListEnvironmentTenantDefaultStores
      .mockResolvedValueOnce([{ tenantId: 'tenant-a', store: {} }])
      .mockResolvedValue([]);
    mockEnsureDatabaseAdapter.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue(null),
    });
    mockResolveTenantUserStoreSourcesFromEnv.mockResolvedValue({ coreDb: {}, piiDb: {} });
    mockCreateSettingsManager.mockReturnValue({
      registerCategory: vi.fn(),
      getAll: vi.fn(async (category: string) => ({
        values:
          category === 'diagnostic-logging'
            ? {
                'diagnostic-logging.retention_days': 7,
                'diagnostic-logging.r2_path_prefix': 'diagnostic-logs',
              }
            : {},
      })),
    });
    mockCleanupOrphanedUserImportUploads.mockResolvedValue({
      scanned: 1,
      deleted: 1,
      retainedActive: 0,
      retainedYoung: 0,
      failures: 0,
      cursor: null,
    });
  });

  it('persists enabled, previous execution, next execution, and bucket metrics', async () => {
    const kv = createKv();
    const oldObject = {
      key: 'public/tenant-a/login-ui/logo/orphan.png',
      size: 10,
      uploaded: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      etag: 'etag',
      version: 'version',
    };
    const publicAssets = createBucket(async (options) =>
      options?.prefix === 'public/'
        ? { objects: [oldObject], truncated: false, delimitedPrefixes: [] }
        : { objects: [oldObject], truncated: false, delimitedPrefixes: [] }
    );
    const diagnosticLogs = createBucket();
    const env = {
      AUTHRIM_CONFIG: kv,
      AUTHRIM_R2_MAINTENANCE_CRON_ENABLED: 'true',
      DB_ADMIN: {},
      SETTINGS: kv,
      PUBLIC_ASSETS: publicAssets,
      DIAGNOSTIC_LOGS: diagnosticLogs,
      AUDIT_ARCHIVE: createBucket(),
      IMPORT_ARTIFACTS: createBucket(),
      EXPORT_ARTIFACTS: createBucket(),
      SENSITIVE_DETAILS: createBucket(),
    } as never;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await processR2StorageMaintenance(env, log);
    const dashboard = await getR2MaintenanceDashboard(env);

    expect(dashboard.schedules).toHaveLength(11);
    expect(dashboard.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'r2_diagnostic_log_retention',
          enabled: true,
          status: 'succeeded',
          lastCompletedAt: expect.any(Number),
          nextRunAt: expect.any(Number),
        }),
      ])
    );
    expect(mockDeleteByRetentionPage).toHaveBeenCalledOnce();
    expect(publicAssets.delete).toHaveBeenCalledWith(oldObject.key);
    expect(dashboard.storageMetrics).toHaveLength(8);
    expect(dashboard.storageMetrics).toContainEqual(
      expect.objectContaining({
        binding: 'PUBLIC_ASSETS',
        objectCount: 1,
        totalBytes: 10,
        encryptionMethods: { 'public-object': 1 },
        scanComplete: true,
      })
    );
  });

  it('reports bounded partial cleanup failures without losing the saved progress evidence', async () => {
    const kv = createKv();
    mockDeleteByRetentionPage.mockRejectedValueOnce(new Error('r2_unavailable'));
    const env = {
      AUTHRIM_CONFIG: kv,
      AUTHRIM_R2_MAINTENANCE_CRON_ENABLED: 'true',
      DB_ADMIN: {},
      SETTINGS: kv,
      PUBLIC_ASSETS: createBucket(),
      DIAGNOSTIC_LOGS: createBucket(),
      AUDIT_ARCHIVE: createBucket(),
      IMPORT_ARTIFACTS: createBucket(),
      EXPORT_ARTIFACTS: createBucket(),
      SENSITIVE_DETAILS: createBucket(),
    } as never;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await processR2StorageMaintenance(env, log);
    const dashboard = await getR2MaintenanceDashboard(env);
    const diagnostic = dashboard.schedules.find(
      (schedule) => schedule.id === 'r2_diagnostic_log_retention'
    );

    expect(diagnostic).toMatchObject({
      status: 'failed',
      lastErrorCode: 'diagnostic_log_retention_partial_failure',
      lastResult: expect.objectContaining({ failures: 1, tenantsScanned: 1 }),
    });
    expect(log.error).toHaveBeenCalledWith(
      'R2 scheduled maintenance task failed',
      expect.objectContaining({
        taskId: 'r2_diagnostic_log_retention',
        errorCode: 'diagnostic_log_retention_partial_failure',
      }),
      expect.any(Error)
    );
  });

  it('records a tenant cleaned once all its diagnostic logs were scanned, not before', async () => {
    const kv = createKv();
    const env = { AUTHRIM_CONFIG: kv, SETTINGS: kv, DIAGNOSTIC_LOGS: createBucket() } as never;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tenants: Record<string, string | undefined> = {
      '': 'tenant-a',
      'tenant-a': 'tenant-b',
      'tenant-b': 'tenant-c',
    };
    mockListEnvironmentTenantDefaultStores.mockReset();
    mockListEnvironmentTenantDefaultStores.mockImplementation(
      async (_env: unknown, options: { afterTenantId?: string }) => {
        const next = tenants[options.afterTenantId ?? ''];
        return next ? [{ tenantId: next, store: {} }] : [];
      }
    );
    // tenant-a has two pages of objects, tenant-b one whose cleanup fails, tenant-c one.
    mockDeleteByRetentionPage.mockReset();
    mockDeleteByRetentionPage
      .mockResolvedValueOnce({ deleted: 500, scanned: 500, cursor: 'page-2' })
      .mockResolvedValueOnce({ deleted: 1, scanned: 1 })
      .mockRejectedValueOnce(new Error('r2_unavailable'))
      .mockResolvedValueOnce({ deleted: 0, scanned: 0 });

    // The first run ends in tenant-a's first page: no tenant has finished.
    await cleanupDiagnosticLogs(env, log);
    expect(await readTenantRetentionRuns(env, 'tenant-a')).toEqual({});

    // The next run finishes tenant-a, fails tenant-b and cleans tenant-c.
    await expect(cleanupDiagnosticLogs(env, log)).rejects.toThrow(
      'diagnostic_log_retention_partial_failure'
    );
    expect(mockDeleteByRetentionPage).toHaveBeenNthCalledWith(2, expect.any(Number), 500, 'page-2');
    expect((await readTenantRetentionRuns(env, 'tenant-a')).r2_diagnostic_log_retention).toEqual({
      at: expect.any(Number),
      outcome: 'cleaned',
    });
    expect(
      (await readTenantRetentionRuns(env, 'tenant-b')).r2_diagnostic_log_retention?.outcome
    ).toBe('failed');
    expect(
      (await readTenantRetentionRuns(env, 'tenant-c')).r2_diagnostic_log_retention?.outcome
    ).toBe('cleaned');
  });

  it('cleans the bucket the tenant writes to, and fails a tenant whose settings cannot be read', async () => {
    const kv = createKv();
    const custom = createBucket();
    const env = {
      AUTHRIM_CONFIG: kv,
      SETTINGS: kv,
      DIAGNOSTIC_LOGS: createBucket(),
      CUSTOM_DIAGNOSTICS: custom,
    } as never;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tenants: Record<string, string | undefined> = {
      '': 'tenant-a',
      'tenant-a': 'tenant-b',
      'tenant-b': 'tenant-c',
    };
    mockListEnvironmentTenantDefaultStores.mockReset();
    mockListEnvironmentTenantDefaultStores.mockImplementation(
      async (_env: unknown, options: { afterTenantId?: string }) => {
        const next = tenants[options.afterTenantId ?? ''];
        return next ? [{ tenantId: next, store: {} }] : [];
      }
    );
    const settings: Record<string, () => Promise<Record<string, unknown>>> = {
      // Writes to another bucket, under its own prefix.
      'tenant-a': async () => ({
        'diagnostic-logging.retention_days': 7,
        'diagnostic-logging.r2_bucket_binding': 'CUSTOM_DIAGNOSTICS',
        'diagnostic-logging.r2_path_prefix': 'custom-diagnostic',
      }),
      // Its settings cannot be read: not the default prefix instead.
      'tenant-b': async () => {
        throw new Error('settings_read_failed');
      },
      // A bucket this worker does not have.
      'tenant-c': async () => ({ 'diagnostic-logging.r2_bucket_binding': 'MISSING' }),
    };
    mockCreateSettingsManager.mockImplementation((options: { strictReads?: boolean }) => {
      expect(options.strictReads).toBe(true);
      return {
        registerCategory: vi.fn(),
        getAll: vi.fn(async (_category: string, scope: { id: string }) => ({
          values: await settings[scope.id]!(),
        })),
      };
    });
    mockDeleteByRetentionPage.mockReset();
    mockDeleteByRetentionPage.mockResolvedValue({ deleted: 0, scanned: 0 });

    await expect(cleanupDiagnosticLogs(env, log)).rejects.toThrow(
      'diagnostic_log_retention_partial_failure'
    );
    expect(mockCreateDiagnosticLogR2Adapter).toHaveBeenCalledOnce();
    expect(mockCreateDiagnosticLogR2Adapter).toHaveBeenCalledWith(
      custom,
      expect.objectContaining({ pathPrefix: 'custom-diagnostic', tenantId: 'tenant-a' })
    );
    const outcome = async (tenantId: string) =>
      (await readTenantRetentionRuns(env, tenantId)).r2_diagnostic_log_retention?.outcome;
    expect(await outcome('tenant-a')).toBe('cleaned');
    expect(await outcome('tenant-b')).toBe('failed');
    expect(await outcome('tenant-c')).toBe('failed');
  });

  it('continues a saved position only in the listing it came from', async () => {
    const kv = createKv();
    const env = { AUTHRIM_CONFIG: kv, SETTINGS: kv, DIAGNOSTIC_LOGS: createBucket() } as never;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    mockListEnvironmentTenantDefaultStores.mockReset();
    mockListEnvironmentTenantDefaultStores
      .mockResolvedValueOnce([{ tenantId: 'tenant-a', store: {} }])
      .mockResolvedValue([]);
    mockDeleteByRetentionPage.mockReset();
    mockDeleteByRetentionPage.mockResolvedValue({ deleted: 0, scanned: 0 });
    // Saved before positions named their listing (or for another bucket): it starts over.
    kv.values.set(
      'jobs:r2-maintenance:diagnostic-tenant-cursor',
      JSON.stringify({ afterTenantId: null, objectCursor: 'old-bucket-key' })
    );
    await cleanupDiagnosticLogs(env, log);
    expect(mockDeleteByRetentionPage).toHaveBeenCalledWith(expect.any(Number), 500, undefined);
  });

  it('removes only expired audit delivery payload orphans and persists scan progress', async () => {
    const kv = createKv();
    const now = Date.now();
    const objects = [
      {
        key: 'logging-delivery-payloads/v1/tk/old.json',
        size: 1,
        uploaded: new Date(now - 31 * 24 * 60 * 60 * 1000),
      },
      {
        key: 'logging-delivery-payloads/v1/tk/recent.json',
        size: 1,
        uploaded: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
    ];
    const bucket = createBucket(async () => ({
      objects,
      truncated: true,
      cursor: 'next-page',
      delimitedPrefixes: [],
    }));

    await expect(
      cleanupOrphanedAuditTransientPayloads({
        AUTHRIM_CONFIG: kv,
        AUDIT_ARCHIVE: bucket,
        DB_ADMIN: {},
      } as never)
    ).resolves.toMatchObject({
      scanned: 2,
      deleted: 1,
      retained: 1,
      retainedActive: 0,
      cursor: { prefixIndex: 0, objectCursor: 'next-page' },
    });

    expect(bucket.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'logging-delivery-payloads/v1/' })
    );
    expect(bucket.delete).toHaveBeenCalledWith(['logging-delivery-payloads/v1/tk/old.json']);
    expect(kv.values.get('jobs:r2-maintenance:audit-transient-cursor')).toBe(
      JSON.stringify({ prefixIndex: 0, objectCursor: 'next-page' })
    );
  });

  it('retains expired message payloads while their jobs are non-terminal', async () => {
    const kv = createKv();
    kv.values.set(
      'jobs:r2-maintenance:audit-transient-cursor',
      JSON.stringify({ prefixIndex: 1, objectCursor: null })
    );
    const now = Date.now();
    const activeKey = 'message-jobs/active.json';
    const terminalKey = 'message-jobs/terminal.json';
    const bucket = createBucket(async () => ({
      objects: [
        { key: activeKey, size: 1, uploaded: new Date(now - 31 * 24 * 60 * 60 * 1000) },
        { key: terminalKey, size: 1, uploaded: new Date(now - 31 * 24 * 60 * 60 * 1000) },
      ],
      truncated: false,
      delimitedPrefixes: [],
    }));
    mockEnsureDatabaseAdapter.mockReturnValueOnce({
      query: vi.fn().mockResolvedValue([{ payload_object_ref: activeKey }]),
      queryOne: vi.fn().mockResolvedValue(null),
    });

    await expect(
      cleanupOrphanedAuditTransientPayloads({
        AUTHRIM_CONFIG: kv,
        AUDIT_ARCHIVE: bucket,
        DB_ADMIN: {},
      } as never)
    ).resolves.toMatchObject({
      scanned: 2,
      deleted: 1,
      retained: 1,
      retainedActive: 1,
      cursor: null,
    });

    expect(bucket.delete).toHaveBeenCalledWith([terminalKey]);
    expect(bucket.delete).not.toHaveBeenCalledWith(expect.arrayContaining([activeKey]));
  });

  it('does not scan or delete transient audit payloads during snapshot capture', async () => {
    const kv = createKv();
    const bucket = createBucket();
    mockEnsureDatabaseAdapter.mockReturnValueOnce({
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue({ id: 'snapshot-a' }),
    });

    await expect(
      cleanupOrphanedAuditTransientPayloads({
        AUTHRIM_CONFIG: kv,
        AUDIT_ARCHIVE: bucket,
        DB_ADMIN: {},
      } as never)
    ).resolves.toMatchObject({ scanned: 0, deleted: 0, retained: 0, retainedActive: 0 });
    expect(bucket.list).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('deletes only old unreferenced Login UI objects within the same tenant scope', async () => {
    const kv = createKv();
    const now = Date.now();
    const objects = [
      {
        key: 'public/tenant-a/login-ui/logo/referenced.png',
        size: 1,
        uploaded: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
      {
        key: 'public/tenant-a/login-ui/logo/orphan.png',
        size: 1,
        uploaded: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
      {
        key: 'public/tenant-b/login-ui/logo/fresh.png',
        size: 1,
        uploaded: new Date(now - 60 * 60 * 1000),
      },
    ];
    const bucket = createBucket(async () => ({ objects, truncated: false, delimitedPrefixes: [] }));
    mockCreateSettingsManager.mockReturnValue({
      registerCategory: vi.fn(),
      getAll: vi.fn(async (_category: string, scope: { id: string }) => ({
        values:
          scope.id === 'tenant-a'
            ? { 'login-ui.logo_url': '/api/assets/tenant-a/login-ui/logo/referenced.png' }
            : {},
      })),
    });

    const result = await cleanupOrphanedPublicAssets({
      AUTHRIM_CONFIG: kv,
      SETTINGS: kv,
      PUBLIC_ASSETS: bucket,
    } as never);

    expect(result).toMatchObject({ scanned: 3, deleted: 1, referenced: 1, young: 1 });
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith('public/tenant-a/login-ui/logo/orphan.png');
  });

  it('removes both Login UI and avatar prefixes when a tenant is deleted', async () => {
    const bucket = createBucket(async (options) => ({
      objects: [
        {
          key: `${String(options?.prefix)}object.png`,
          size: 1,
          uploaded: new Date(),
        },
      ],
      truncated: false,
      delimitedPrefixes: [],
    }));

    await expect(
      deleteTenantPublicAssets({ PUBLIC_ASSETS: bucket } as never, 'tenant-a')
    ).resolves.toBe(2);
    expect(bucket.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ prefix: 'public/tenant-a/' })
    );
    expect(bucket.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prefix: 'avatars/tenant-a/' })
    );
    expect(bucket.delete).toHaveBeenCalledTimes(2);
  });

  it('removes old unreferenced avatars and retains active picture references', async () => {
    const kv = createKv();
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const bucket = createBucket(async () => ({
      objects: [
        { key: 'avatars/tenant-a/users/referenced.png', uploaded: old, size: 1 },
        { key: 'avatars/tenant-a/users/orphan.png', uploaded: old, size: 1 },
      ],
      truncated: false,
      delimitedPrefixes: [],
    }));
    mockEnsureDatabaseAdapter.mockReturnValue({
      query: vi
        .fn()
        .mockResolvedValue([
          { value_json: JSON.stringify('https://tenant.example/api/avatars/referenced.png') },
        ]),
    });

    await expect(
      cleanupOrphanedPublicAssets({ AUTHRIM_CONFIG: kv, PUBLIC_ASSETS: bucket } as never)
    ).resolves.toMatchObject({ scanned: 2, deleted: 1, referenced: 1, failures: 0 });
    expect(bucket.delete).toHaveBeenCalledWith('avatars/tenant-a/users/orphan.png');
  });

  it('classifies encrypted and overdue objects without reading payload bodies', async () => {
    const kv = createKv();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const bucket = createBucket(async () => ({
      objects: [
        {
          key: 'diagnostic-logs/old.ndjson',
          size: 42,
          uploaded: old,
          customMetadata: { encryption: 'authrim-object-envelope-v1' },
        },
      ],
      truncated: false,
      delimitedPrefixes: [],
    }));

    await scanR2Metrics({ AUTHRIM_CONFIG: kv, DIAGNOSTIC_LOGS: bucket } as never);
    const dashboard = await getR2MaintenanceDashboard({
      AUTHRIM_CONFIG: kv,
      DIAGNOSTIC_LOGS: bucket,
    } as never);

    expect(
      dashboard.storageMetrics.find((metric) => metric.binding === 'DIAGNOSTIC_LOGS')
    ).toMatchObject({
      binding: 'DIAGNOSTIC_LOGS',
      objectCount: 1,
      totalBytes: 42,
      encryptionMethods: { 'authrim-object-envelope-v1': 1 },
      retentionOverdueObjects: null,
    });
    expect(bucket).not.toHaveProperty('get');
  });

  it('reports owner-scoped metrics to Control and uses the fleet aggregate for Admin', async () => {
    const kv = createKv();
    const bucket = createBucket(async () => ({
      objects: [{ key: 'public/tenant-a/logo.png', size: 64, uploaded: new Date() }],
      truncated: false,
      delimitedPrefixes: [],
    }));
    const reportR2BucketMetrics = vi.fn(async () => ({ metrics: [], generatedAt: Date.now() }));
    const fleetMetric = {
      binding: 'PLUGIN_BUNDLES' as const,
      ownerWorker: 'ar-plugin-runner' as const,
      availability: 'current' as const,
      unavailableReason: null,
      reportedAt: Date.now(),
      objectCount: 2,
      totalBytes: 128,
      oldestObjectAt: null,
      encryptionMethods: { 'plugin-bundle': 2 },
      retentionOverdueObjects: null,
      retentionPolicy: 'Referenced signed bundles retained',
      scanComplete: true,
      measuredAt: Date.now(),
    };
    const getR2BucketMetrics = vi.fn(async () => ({
      metrics: [fleetMetric],
      generatedAt: Date.now(),
    }));
    const env = {
      AUTHRIM_CONFIG: kv,
      PUBLIC_ASSETS: bucket,
      CONTROL: { reportR2BucketMetrics, getR2BucketMetrics },
    } as never;

    await scanR2Metrics(env);
    const dashboard = await getR2MaintenanceDashboard(env);

    expect(reportR2BucketMetrics).toHaveBeenCalledWith({
      metrics: [expect.objectContaining({ binding: 'PUBLIC_ASSETS', objectCount: 1 })],
    });
    expect(dashboard.storageMetrics).toEqual([fleetMetric]);
  });
});
