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

import { refreshExpiringTokensForScheduledTenants } from '../services/token-refresh';
import { resolveInternalTokenRefreshTenantId } from '../internal-token-refresh';

const TOKEN_REFRESH_CONFIG_KEY = 'external_idp_token_refresh';
const TOKEN_REFRESH_TENANT_CURSOR_KEY = 'external_idp_token_refresh:tenant_cursor';
const VALID_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createSettingsKv(values: Record<string, string | null> = {}) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    put: vi.fn(async () => undefined),
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
      [TOKEN_REFRESH_CONFIG_KEY]: JSON.stringify({ scheduledTenantBatchSize: 2 }),
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

  it('uses production-safe default batch sizes for scheduled tenant scanning', async () => {
    const settings = createSettingsKv();
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
      100,
    ]);
  });

  it('falls back to the deployment default tenant when SETTINGS is unavailable', async () => {
    mockEnsureAdminDatabaseAdapter.mockReturnValue(null);

    const result = await refreshExpiringTokensForScheduledTenants({
      DB: {},
      RP_TOKEN_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    } as never);

    expect(mockResolveAuthCorePersistenceAdapterFromEnv).not.toHaveBeenCalled();
    expect(mockResolveUserStoreRuntimeSourcesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'default'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Token refresh tenant cursor unavailable; falling back to default tenant'
    );
    expect(result.selectedTenants).toEqual(['default']);
  });

  it('keeps scheduled refresh working when run storage is unavailable', async () => {
    mockEnsureAdminDatabaseAdapter.mockReturnValue(null);
    mockCoreAdapter.query.mockResolvedValue([{ id: 'tenant-a' }]);

    const result = await refreshExpiringTokensForScheduledTenants(createEnv());

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
