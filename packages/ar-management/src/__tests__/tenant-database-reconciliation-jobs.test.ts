import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnsureDatabaseAdapter,
  mockNotificationRepository,
  mockRegistryRepository,
  MockInternalNotificationEventRepository,
  MockTenantDatabaseRegistryRepository,
} = vi.hoisted(() => {
  const registryRepository = {
    listActiveRegistryRowsForRole: vi.fn(),
    listActiveRegistryRowsForTenantRole: vi.fn(),
  };
  const notificationRepository = {
    enqueue: vi.fn(),
    suppressResolvedByDeduplicationKeys: vi.fn(),
  };
  return {
    mockEnsureDatabaseAdapter: vi.fn((source: unknown) => source),
    mockNotificationRepository: notificationRepository,
    mockRegistryRepository: registryRepository,
    MockInternalNotificationEventRepository: vi.fn(function MockRepositoryConstructor() {
      return notificationRepository;
    }),
    MockTenantDatabaseRegistryRepository: vi.fn(function MockRepositoryConstructor() {
      return registryRepository;
    }),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    InternalNotificationEventRepository: MockInternalNotificationEventRepository,
    TenantDatabaseRegistryRepository: MockTenantDatabaseRegistryRepository,
  };
});

import {
  fetchCloudflareD1DatabaseIds,
  processPendingTenantDatabaseReconciliationJobs,
  refreshTenantDatabaseReconciliation,
} from '../tenant-database-reconciliation-jobs';

function createRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    generation: 1,
    shard_group: 'default',
    shard_index: 0,
    provider: 'd1',
    database_id: 'db-id',
    database_name: 'authrim-dev-tenant-a-core',
    binding_ref: 'TDB_TENANT_A_CORE',
    connection_ref: null,
    schema_version: 1,
    status: 'active',
    shard_count: 1,
    shard_key_strategy: 'hash_user_id',
    worker_shard: 'primary',
    deployment_target: 'edge-a',
    region_hint: null,
    jurisdiction: null,
    signature: null,
    signature_key_id: null,
    metadata_json: null,
    created_at: '2026-05-15T00:00:00.000Z',
    updated_at: '2026-05-15T00:00:00.000Z',
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

describe('tenant database reconciliation jobs', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistryRepository.listActiveRegistryRowsForRole.mockResolvedValue([]);
    mockRegistryRepository.listActiveRegistryRowsForTenantRole.mockResolvedValue([]);
    mockNotificationRepository.enqueue.mockResolvedValue(undefined);
    mockNotificationRepository.suppressResolvedByDeduplicationKeys.mockResolvedValue(0);
  });

  it('skips reconciliation when DB_ADMIN is not configured', async () => {
    const summary = await refreshTenantDatabaseReconciliation({} as never, logger);

    expect(summary).toEqual({
      checked: 0,
      findings: 0,
      critical: 0,
      warning: 0,
      resolved: 0,
      skippedCloudflareApi: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Tenant database reconciliation skipped because DB_ADMIN is not configured'
    );
  });

  it('checks active registry bindings and enqueues critical drift notifications', async () => {
    mockRegistryRepository.listActiveRegistryRowsForRole
      .mockResolvedValueOnce([
        createRow({
          tenant_id: 'tenant-a',
          binding_ref: 'TDB_TENANT_A_CORE',
          database_id: 'existing-db-id',
        }),
      ])
      .mockResolvedValueOnce([
        createRow({
          tenant_id: 'tenant-b',
          role: 'tenant_pii',
          binding_ref: 'TDB_TENANT_B_PII',
          database_id: 'missing-db-id',
        }),
      ]);

    const summary = await refreshTenantDatabaseReconciliation(
      {
        DB_ADMIN: 'control-db',
        TDB_TENANT_A_CORE: { prepare: vi.fn(), batch: vi.fn() },
      } as never,
      logger,
      {
        now: new Date('2026-05-16T00:00:00.000Z'),
        cloudflareDatabaseIds: new Set(['existing-db-id']),
      }
    );

    expect(summary).toEqual({
      checked: 2,
      findings: 2,
      critical: 2,
      warning: 0,
      resolved: 0,
      skippedCloudflareApi: false,
    });
    expect(mockNotificationRepository.enqueue).toHaveBeenCalledTimes(2);
    expect(mockNotificationRepository.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'storage_registry_health',
        eventType: 'tenant_database.reconciliation.missing_binding',
        severity: 'critical',
        tenantId: 'tenant-b',
      })
    );
    expect(mockNotificationRepository.suppressResolvedByDeduplicationKeys).toHaveBeenCalledWith(
      expect.arrayContaining([
        'tenant_database_reconciliation:missing_binding:tenant-a:tenant_core:1:default:0:TDB_TENANT_A_CORE:existing-db-id',
        'tenant_database_resolver:missing_binding:tenant-a:tenant_core:1:default:0:TDB_TENANT_A_CORE:',
        'tenant_database_reconciliation:database_id_not_found:tenant-a:tenant_core:1:default:0:TDB_TENANT_A_CORE:existing-db-id',
      ]),
      new Date('2026-05-16T00:00:00.000Z')
    );
    expect(mockNotificationRepository.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tenant_database.reconciliation.database_id_not_found',
        tenantId: 'tenant-b',
      })
    );
  });

  it('does not resolve database existence alerts when the Cloudflare inventory is unavailable', async () => {
    mockRegistryRepository.listActiveRegistryRowsForRole
      .mockResolvedValueOnce([createRow()])
      .mockResolvedValueOnce([]);

    await refreshTenantDatabaseReconciliation(
      {
        DB_ADMIN: 'control-db',
        TDB_TENANT_A_CORE: { prepare: vi.fn(), batch: vi.fn() },
      } as never,
      logger,
      { now: new Date('2026-05-16T00:00:00.000Z') }
    );

    const keys = mockNotificationRepository.suppressResolvedByDeduplicationKeys.mock
      .calls[0][0] as string[];
    expect(keys).toContain(
      'tenant_database_reconciliation:missing_binding:tenant-a:tenant_core:1:default:0:TDB_TENANT_A_CORE:db-id'
    );
    expect(keys.some((key) => key.includes('database_id_not_found'))).toBe(false);
  });

  it('does not alert on a missing binding during the provisioning grace period', async () => {
    mockRegistryRepository.listActiveRegistryRowsForRole
      .mockResolvedValueOnce([
        createRow({
          created_at: '2026-05-16T00:05:00.000Z',
          binding_ref: 'TDB_TENANT_A_CORE',
        }),
      ])
      .mockResolvedValueOnce([]);

    const summary = await refreshTenantDatabaseReconciliation(
      { DB_ADMIN: 'control-db' } as never,
      logger,
      {
        now: new Date('2026-05-16T00:10:00.000Z'),
        cloudflareDatabaseIds: new Set(['db-id']),
      }
    );

    expect(summary).toEqual({
      checked: 1,
      findings: 0,
      critical: 0,
      warning: 0,
      resolved: 0,
      skippedCloudflareApi: false,
    });
    expect(mockNotificationRepository.enqueue).not.toHaveBeenCalled();
  });

  it('fetches Cloudflare D1 database ids when account credentials are configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ uuid: 'db-a' }, { id: 'db-b' }],
          result_info: { page: 1, total_pages: 1 },
        })
      )
    );

    try {
      const ids = await fetchCloudflareD1DatabaseIds({
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_D1_API_TOKEN: 'token',
      } as never);

      expect(Array.from(ids ?? []).sort()).toEqual(['db-a', 'db-b']);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/account-id/d1/database?per_page=100&page=1',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        })
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('processes pending reconciliation request jobs', async () => {
    const adapter = {
      query: vi.fn().mockResolvedValueOnce([
        {
          id: 'tenant-db-reconciliation:tenant-b:tenant_core:1:default:0:missing-binding',
          tenant_id: 'tenant-b',
          status: 'pending',
          config: JSON.stringify({ reason: 'missing_binding' }),
        },
      ]),
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    };
    mockRegistryRepository.listActiveRegistryRowsForRole.mockResolvedValue([]);

    const summary = await processPendingTenantDatabaseReconciliationJobs(
      { DB_ADMIN: adapter } as never,
      logger,
      { now: 1_779_000_000 }
    );

    expect(summary).toEqual({ scanned: 1, completed: 1, failed: 0 });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE admin_jobs SET status = 'processing'"),
      expect.arrayContaining([
        expect.any(Number),
        expect.any(Number),
        'tenant-db-reconciliation:tenant-b:tenant_core:1:default:0:missing-binding',
        'tenant-b',
      ])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE admin_jobs SET status = 'completed'"),
      expect.arrayContaining([
        expect.stringContaining('"stage":"completed"'),
        expect.stringContaining('"checked":0'),
        expect.any(Number),
        expect.any(Number),
        'tenant-db-reconciliation:tenant-b:tenant_core:1:default:0:missing-binding',
        'tenant-b',
      ])
    );
  });
});
