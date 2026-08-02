import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCoreAdapter,
  mockIdentityAdapter,
  mockAdminAdapter,
  mockEnsureDatabaseAdapter,
  mockEnsureAdminDatabaseAdapter,
  mockCreateObjectCatalogEntry,
  mockResolveAuthCorePersistenceAdapterFromEnv,
  mockResolveUserStoreRuntimeSourcesFromEnv,
  mockGetDefaultTenantId,
  mockIsMultiTenantEnabled,
  mockLogger,
} = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockCoreAdapter: {
      query: vi.fn(),
    },
    mockIdentityAdapter: {
      query: vi.fn(),
    },
    mockAdminAdapter: {
      query: vi.fn(),
      execute: vi.fn(),
    },
    mockEnsureDatabaseAdapter: vi.fn(),
    mockEnsureAdminDatabaseAdapter: vi.fn(),
    mockCreateObjectCatalogEntry: vi.fn(),
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn(),
    mockResolveUserStoreRuntimeSourcesFromEnv: vi.fn(),
    mockGetDefaultTenantId: vi.fn(),
    mockIsMultiTenantEnabled: vi.fn(),
    mockLogger: logger,
  };
});

vi.mock('@authrim/ar-lib-core', () => ({
  createObjectCatalogEntry: mockCreateObjectCatalogEntry,
  createLogger: () => ({
    module: () => mockLogger,
  }),
  ensureAdminDatabaseAdapter: mockEnsureAdminDatabaseAdapter,
  ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
  getDefaultTenantId: mockGetDefaultTenantId,
  isMultiTenantEnabled: mockIsMultiTenantEnabled,
  isValidTenantIdentifier: (value: string) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value),
  resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
  resolveUserStoreRuntimeSourcesFromEnv: mockResolveUserStoreRuntimeSourcesFromEnv,
}));

import {
  refreshExpiringTokensForScheduledTenants,
  refreshExpiringTokensForTenant,
  refreshExpiringTokensForTenantManual,
} from '../services/token-refresh';
import { resolveInternalTokenRefreshTenantId } from '../internal-token-refresh';

const TOKEN_REFRESH_CONFIG_KEY = 'external_idp_token_refresh';
const TOKEN_REFRESH_TENANT_CURSOR_KEY = 'external_idp_token_refresh:tenant_cursor';
const TOKEN_REFRESH_PII_SHARD_CURSOR_KEY = 'external_idp_token_refresh:pii_shard_cursor:tenant-a';
const VALID_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createSettingsKv(values: Record<string, string | null> = {}) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function createEnv(settings = createSettingsKv()) {
  return {
    SETTINGS: settings,
    DB: {},
    RP_TOKEN_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
  } as never;
}

describe('scheduled bridge token refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCoreAdapter.query.mockReset();
    mockIdentityAdapter.query.mockReset().mockResolvedValue([]);
    mockAdminAdapter.query.mockReset().mockResolvedValue([]);
    mockAdminAdapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
    mockEnsureDatabaseAdapter.mockReset().mockReturnValue(mockIdentityAdapter);
    mockEnsureAdminDatabaseAdapter.mockReset().mockReturnValue(mockAdminAdapter);
    mockCreateObjectCatalogEntry.mockReset().mockResolvedValue({
      catalogId: 'catalog-1',
      publicArtifactId: 'oa_test',
    });
    mockResolveAuthCorePersistenceAdapterFromEnv.mockReset().mockResolvedValue(mockCoreAdapter);
    mockResolveUserStoreRuntimeSourcesFromEnv
      .mockReset()
      .mockResolvedValue({ coreDb: {}, piiDb: {} });
    mockGetDefaultTenantId.mockReset().mockReturnValue('default');
    mockIsMultiTenantEnabled.mockReset().mockImplementation((env) => !!env.BASE_DOMAIN);
  });

  it('processes the next active tenant batch after the stored cursor', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({
        enabled: true,
        scheduledTenantBatchSize: 2,
        batchSize: 7,
      }),
      [TOKEN_REFRESH_TENANT_CURSOR_KEY]: 'tenant-a',
    });
    mockCoreAdapter.query.mockResolvedValue([{ id: 'tenant-b' }, { id: 'tenant-c' }]);

    const result = await refreshExpiringTokensForScheduledTenants(createEnv(settings));

    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      "SELECT id FROM tenants WHERE lifecycle_state = 'active' AND id > ? ORDER BY id ASC LIMIT ?",
      ['tenant-a', 2]
    );
    expect(mockResolveUserStoreRuntimeSourcesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-b'
    );
    expect(mockResolveUserStoreRuntimeSourcesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-c'
    );
    expect(mockIdentityAdapter.query).toHaveBeenCalledWith(expect.any(String), [
      'tenant-b',
      expect.any(Number),
      expect.any(Number),
      7,
    ]);
    expect(settings.put).toHaveBeenCalledWith(TOKEN_REFRESH_TENANT_CURSOR_KEY, 'tenant-c');
    expect(result).toMatchObject({
      runId: expect.any(String),
      selectedTenants: ['tenant-b', 'tenant-c'],
      processedTenants: 2,
      failedTenants: 0,
      tokensRefreshed: 0,
      cursorBefore: 'tenant-a',
      cursor: 'tenant-c',
    });
    expect(mockAdminAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_external_token_refresh_runs'),
      expect.arrayContaining(['scheduled'])
    );
  });

  it('wraps to the first active tenant when the cursor reached the end', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({
        enabled: true,
        scheduledTenantBatchSize: 2,
      }),
      [TOKEN_REFRESH_TENANT_CURSOR_KEY]: 'tenant-z',
    });
    mockCoreAdapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'tenant-a' }]);

    const result = await refreshExpiringTokensForScheduledTenants(createEnv(settings));

    expect(mockCoreAdapter.query).toHaveBeenNthCalledWith(
      1,
      "SELECT id FROM tenants WHERE lifecycle_state = 'active' AND id > ? ORDER BY id ASC LIMIT ?",
      ['tenant-z', 2]
    );
    expect(mockCoreAdapter.query).toHaveBeenNthCalledWith(
      2,
      "SELECT id FROM tenants WHERE lifecycle_state = 'active' ORDER BY id ASC LIMIT ?",
      [2]
    );
    expect(settings.put).toHaveBeenCalledWith(TOKEN_REFRESH_TENANT_CURSOR_KEY, 'tenant-a');
    expect(result.selectedTenants).toEqual(['tenant-a']);
  });

  it('does not scan tenants when token refresh is disabled', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ enabled: false }),
    });

    const result = await refreshExpiringTokensForScheduledTenants(createEnv(settings));

    expect(mockResolveAuthCorePersistenceAdapterFromEnv).not.toHaveBeenCalled();
    expect(mockResolveUserStoreRuntimeSourcesFromEnv).not.toHaveBeenCalled();
    expect(settings.put).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      runId: null,
      selectedTenants: [],
      processedTenants: 0,
      failedTenants: 0,
      tokensRefreshed: 0,
      cursorBefore: null,
      cursor: null,
      tenantResults: [],
    });
  });

  it('keeps proactive scheduled scanning disabled by default', async () => {
    const settings = createSettingsKv();

    const result = await refreshExpiringTokensForScheduledTenants(createEnv(settings));

    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
    expect(mockIdentityAdapter.query).not.toHaveBeenCalled();
    expect(result.selectedTenants).toEqual([]);
  });

  it('allows an explicit manual tenant run while scheduled scanning is disabled', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ enabled: false }),
    });

    const result = await refreshExpiringTokensForTenantManual(createEnv(settings), 'tenant-a');

    expect(mockResolveUserStoreRuntimeSourcesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a'
    );
    expect(result).toMatchObject({
      tenantId: 'tenant-a',
      tokensRefreshed: 0,
      status: 'completed',
    });
  });

  it('keeps scheduled refresh working when run storage is unavailable', async () => {
    mockEnsureAdminDatabaseAdapter.mockReturnValue(null);
    mockCoreAdapter.query.mockResolvedValue([{ id: 'tenant-a' }]);

    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ enabled: true }),
    });
    const result = await refreshExpiringTokensForScheduledTenants(createEnv(settings));

    expect(result.runId).toBeNull();
    expect(result.selectedTenants).toEqual(['tenant-a']);
    expect(mockResolveUserStoreRuntimeSourcesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a'
    );
  });

  it('caps configured tenant and token refresh batch sizes', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({
        enabled: true,
        scheduledTenantBatchSize: 9999,
        batchSize: 9999,
      }),
    });
    mockCoreAdapter.query.mockResolvedValue([{ id: 'tenant-a' }]);

    await refreshExpiringTokensForScheduledTenants(createEnv(settings));

    expect(mockCoreAdapter.query).toHaveBeenCalledWith(
      "SELECT id FROM tenants WHERE lifecycle_state = 'active' ORDER BY id ASC LIMIT ?",
      [100]
    );
    expect(mockIdentityAdapter.query).toHaveBeenCalledWith(expect.any(String), [
      'tenant-a',
      expect.any(Number),
      expect.any(Number),
      1000,
    ]);
  });

  it('walks tenant-D1 PII shards through the narrow Management inventory RPC', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ enabled: true }),
      [TOKEN_REFRESH_PII_SHARD_CURSOR_KEY]: 'pii-000',
    });
    const shards = Array.from({ length: 4 }, (_, index) => ({
      shardId: `pii-00${index + 1}`,
      bindingRef: `TDB_PII_00${index + 1}`,
      residencyPartition: 'default',
      routeGeneration: 1,
    }));
    const listExternalIdpPiiSourceShards = vi.fn().mockResolvedValue(shards);
    mockResolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: { id: 'builtin:storage:tenant-d1' },
      coreDb: {},
      piiDb: {},
    });
    mockIdentityAdapter.query.mockResolvedValue([]);
    const env = {
      SETTINGS: settings,
      DB: {},
      RP_TOKEN_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
      EXTERNAL_IDP_ACCOUNT_PROVISIONER: { listExternalIdpPiiSourceShards },
      TDB_PII_001: {},
      TDB_PII_002: {},
      TDB_PII_003: {},
      TDB_PII_004: {},
    } as never;

    await expect(refreshExpiringTokensForTenant(env, 'tenant-a')).resolves.toBe(0);

    expect(listExternalIdpPiiSourceShards).toHaveBeenCalledWith({
      schemaVersion: 1,
      afterShardId: 'pii-000',
      limit: 4,
    });
    expect(mockIdentityAdapter.query).toHaveBeenCalledTimes(4);
    expect(mockIdentityAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining("provisioning_state = 'active'"),
      ['tenant-a', expect.any(Number), expect.any(Number), 100]
    );
    expect(settings.put).toHaveBeenCalledWith(TOKEN_REFRESH_PII_SHARD_CURSOR_KEY, 'pii-004');
  });

  it('allows a larger bounded PII shard page and caps it at 32', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ enabled: true, piiShardPageSize: 999 }),
    });
    const listExternalIdpPiiSourceShards = vi.fn().mockResolvedValue([]);
    mockResolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: { id: 'builtin:storage:tenant-d1' },
      coreDb: {},
      piiDb: {},
    });
    const env = {
      SETTINGS: settings,
      DB: {},
      RP_TOKEN_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
      EXTERNAL_IDP_ACCOUNT_PROVISIONER: { listExternalIdpPiiSourceShards },
    } as never;

    await expect(refreshExpiringTokensForTenant(env, 'tenant-a')).rejects.toThrow(
      'external_idp_token_refresh_shard_inventory_empty'
    );
    expect(listExternalIdpPiiSourceShards).toHaveBeenCalledWith({
      schemaVersion: 1,
      afterShardId: null,
      limit: 32,
    });
  });

  it('fails closed when a tenant-D1 PII shard binding is unavailable', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ enabled: true }),
    });
    mockResolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: { id: 'builtin:storage:tenant-d1' },
      coreDb: {},
      piiDb: {},
    });
    const env = {
      SETTINGS: settings,
      DB: {},
      RP_TOKEN_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
      EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
        listExternalIdpPiiSourceShards: vi.fn().mockResolvedValue([
          {
            shardId: 'pii-001',
            bindingRef: 'TDB_PII_MISSING',
            residencyPartition: 'default',
            routeGeneration: 1,
          },
        ]),
      },
    } as never;
    mockEnsureDatabaseAdapter.mockImplementation((source) => {
      if (!source) throw new Error('database source missing');
      return mockIdentityAdapter;
    });

    await expect(refreshExpiringTokensForTenant(env, 'tenant-a')).rejects.toThrow(
      'database source missing'
    );
    expect(settings.delete).not.toHaveBeenCalled();
  });

  it('does not advance the tenant-D1 shard cursor when a shard query fails', async () => {
    const settings = createSettingsKv({
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ enabled: true }),
      [TOKEN_REFRESH_PII_SHARD_CURSOR_KEY]: 'pii-000',
    });
    mockResolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: { id: 'builtin:storage:tenant-d1' },
      coreDb: {},
      piiDb: {},
    });
    mockIdentityAdapter.query.mockRejectedValueOnce(new Error('d1 unavailable'));
    const env = {
      SETTINGS: settings,
      DB: {},
      RP_TOKEN_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
      EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
        listExternalIdpPiiSourceShards: vi.fn().mockResolvedValue([
          {
            shardId: 'pii-001',
            bindingRef: 'TDB_PII_001',
            residencyPartition: 'default',
            routeGeneration: 1,
          },
        ]),
      },
      TDB_PII_001: {},
    } as never;

    await expect(refreshExpiringTokensForTenant(env, 'tenant-a')).rejects.toThrow('d1 unavailable');
    expect(settings.put).not.toHaveBeenCalledWith(
      TOKEN_REFRESH_PII_SHARD_CURSOR_KEY,
      expect.any(String)
    );
    expect(settings.delete).not.toHaveBeenCalled();
  });
});

describe('internal bridge token refresh tenant resolution', () => {
  function createContext(
    headers: Record<string, string | undefined>,
    env: Record<string, unknown>
  ) {
    return {
      env,
      req: {
        header: (name: string) => headers[name],
      },
    } as never;
  }

  beforeEach(() => {
    mockGetDefaultTenantId.mockReset().mockReturnValue('default');
    mockIsMultiTenantEnabled.mockReset().mockImplementation((env) => !!env.BASE_DOMAIN);
  });

  it('requires an explicit tenant header for multi-tenant internal refresh', () => {
    const result = resolveInternalTokenRefreshTenantId(
      createContext({}, { BASE_DOMAIN: 'example.com' })
    );

    expect(result).toEqual({
      ok: false,
      error: 'X-Tenant-Id header is required for internal token refresh in multi-tenant mode',
    });
  });

  it('accepts a valid explicit tenant header for multi-tenant internal refresh', () => {
    const result = resolveInternalTokenRefreshTenantId(
      createContext({ 'X-Tenant-Id': 'tenant-a' }, { BASE_DOMAIN: 'example.com' })
    );

    expect(result).toEqual({ ok: true, tenantId: 'tenant-a' });
  });

  it('uses deployment default only for single-tenant internal refresh', () => {
    const result = resolveInternalTokenRefreshTenantId(createContext({}, {}));

    expect(result).toEqual({ ok: true, tenantId: 'default' });
  });
});
