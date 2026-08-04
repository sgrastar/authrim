import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';

const resolverMocks = vi.hoisted(() => ({
  resolveAlias: vi.fn(),
  resolveTenantStore: vi.fn(),
}));

vi.mock('../lookup-directory/resolver', () => ({
  LookupRouteResolver: class {
    resolveAlias = resolverMocks.resolveAlias;
  },
}));

vi.mock('../lookup-directory/shard-registry', () => ({
  loadVerifiedLookupBucketAssignmentProvider: vi.fn(async () => ({
    resolveActiveAssignment: vi.fn(),
  })),
}));

vi.mock('../tenant-database-resolver', () => ({
  resolveTenantDatabaseSourceFromRegistry: resolverMocks.resolveTenantStore,
}));

import {
  getPrimaryTenantVanityDomain,
  resolveTenantFromVanityHost,
} from '../tenant-vanity-domain-resolver';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

function createMockKV(): KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [] }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

describe('tenant-vanity-domain-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves and destination-revalidates a signed custom-domain alias', async () => {
    const adapter = createMockAdapter();
    const kv = createMockKV();

    resolverMocks.resolveAlias.mockResolvedValueOnce({
      tenantId: 'tenant-123',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 3,
        residencyPolicyId: 'policy-1',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'global',
          shardId: 'core-1',
          bindingRef: 'TDB_CORE_001',
          requiredBindingRouteGeneration: 3,
        },
      },
    });
    resolverMocks.resolveTenantStore.mockResolvedValueOnce({
      source: adapter,
      residencyPolicyId: 'policy-1',
      residencyPartition: 'global',
      shardId: 'core-1',
      bindingRef: 'TDB_CORE_001',
      bindingRouteGeneration: 3,
    });

    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      tenant_id: 'tenant-123',
      status: 'active',
      is_active: 1,
    });

    const result = await resolveTenantFromVanityHost(
      {
        AUTHRIM_CONFIG: kv,
        AUTHRIM_ENVIRONMENT_NAME: 'test',
        TENANT_RUNTIME_REGISTRY: {} as never,
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
      },
      'Login.Example.com'
    );

    expect(result).toBe('tenant-123');
    expect(adapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining("tenants.lifecycle_state = 'active'"),
      ['login.example.com', 'tenant-123']
    );
    expect(kv.put).toHaveBeenCalledOnce();
  });

  it('rejects an alias route ahead of the signed Registry route', async () => {
    const adapter = createMockAdapter();
    resolverMocks.resolveAlias.mockResolvedValueOnce({
      tenantId: 'tenant-123',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 4,
        residencyPolicyId: 'policy-1',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'global',
          shardId: 'core-1',
          bindingRef: 'TDB_CORE_001',
          requiredBindingRouteGeneration: 4,
        },
      },
    });
    resolverMocks.resolveTenantStore.mockResolvedValueOnce({
      source: adapter,
      residencyPolicyId: 'policy-1',
      residencyPartition: 'global',
      shardId: 'core-1',
      bindingRef: 'TDB_CORE_001',
      bindingRouteGeneration: 3,
    });

    await expect(
      resolveTenantFromVanityHost(
        {
          AUTHRIM_ENVIRONMENT_NAME: 'test',
          TENANT_RUNTIME_REGISTRY: {} as never,
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
        },
        'login.example.com'
      )
    ).resolves.toBeNull();
    expect(adapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects a Lookup owner that is not active at the exact destination', async () => {
    const adapter = createMockAdapter();
    resolverMocks.resolveAlias.mockResolvedValueOnce({
      tenantId: 'tenant-123',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 3,
        residencyPolicyId: 'policy-1',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'global',
          shardId: 'core-1',
          bindingRef: 'TDB_CORE_001',
          requiredBindingRouteGeneration: 3,
        },
      },
    });
    resolverMocks.resolveTenantStore.mockResolvedValueOnce({
      source: adapter,
      residencyPolicyId: 'policy-1',
      residencyPartition: 'global',
      shardId: 'core-1',
      bindingRef: 'TDB_CORE_001',
      bindingRouteGeneration: 3,
    });
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(null);

    await expect(
      resolveTenantFromVanityHost(
        {
          AUTHRIM_ENVIRONMENT_NAME: 'test',
          TENANT_RUNTIME_REGISTRY: {} as never,
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
        },
        'login.example.com'
      )
    ).resolves.toBeNull();
  });

  it('treats a cached tenant as a hint and falls back after exact revalidation fails', async () => {
    const cachedAdapter = createMockAdapter();
    const resolvedAdapter = createMockAdapter();
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValueOnce('tenant-stale');
    resolverMocks.resolveTenantStore
      .mockResolvedValueOnce({ source: cachedAdapter })
      .mockResolvedValueOnce({
        source: resolvedAdapter,
        residencyPolicyId: 'policy-1',
        residencyPartition: 'global',
        shardId: 'core-1',
        bindingRef: 'TDB_CORE_001',
        bindingRouteGeneration: 3,
      });
    vi.mocked(cachedAdapter.queryOne).mockResolvedValueOnce(null);
    resolverMocks.resolveAlias.mockResolvedValueOnce({
      tenantId: 'tenant-123',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 3,
        residencyPolicyId: 'policy-1',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'global',
          shardId: 'core-1',
          bindingRef: 'TDB_CORE_001',
          requiredBindingRouteGeneration: 3,
        },
      },
    });
    vi.mocked(resolvedAdapter.queryOne).mockResolvedValueOnce({
      tenant_id: 'tenant-123',
      status: 'active',
      is_active: 1,
    });

    await expect(
      resolveTenantFromVanityHost(
        {
          AUTHRIM_CONFIG: kv,
          AUTHRIM_ENVIRONMENT_NAME: 'test',
          TENANT_RUNTIME_REGISTRY: {} as never,
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
        },
        'login.example.com'
      )
    ).resolves.toBe('tenant-123');
    expect(kv.delete).toHaveBeenCalledWith('v1:tenant-vanity-domain:login.example.com');
  });

  it('loads the primary vanity domain through the portable adapter helper', async () => {
    const adapter = createMockAdapter();
    const kv = createMockKV();

    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      id: 'vanity-1',
      tenant_id: 'tenant-123',
      hostname: 'login.example.com',
      is_active: 1,
      is_primary: 1,
      status: 'active',
      cloudflare_zone_id: null,
      cloudflare_custom_hostname_id: null,
      ssl_status: null,
      ownership_status: null,
      validation_method: null,
      validation_records_json: null,
      last_sync_at: null,
      created_by: null,
      created_at: 100,
      updated_at: 200,
    });

    const result = await getPrimaryTenantVanityDomain(
      { tenantCoreDb: adapter, AUTHRIM_CONFIG: kv } as never,
      'tenant-123'
    );

    expect(result).toEqual(
      expect.objectContaining({
        tenant_id: 'tenant-123',
        hostname: 'login.example.com',
        is_primary: true,
        is_active: true,
      })
    );
    expect(adapter.queryOne).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledOnce();
  });

  it('uses a cached primary vanity domain without querying the database', async () => {
    const adapter = createMockAdapter();
    const kv = createMockKV();

    vi.mocked(kv.get).mockResolvedValueOnce(
      JSON.stringify({
        id: 'vanity-1',
        tenant_id: 'tenant-123',
        hostname: 'login.example.com',
        is_active: true,
        is_primary: true,
        status: 'active',
        cloudflare_zone_id: null,
        cloudflare_custom_hostname_id: null,
        ssl_status: null,
        ownership_status: null,
        validation_method: null,
        validation_records_json: null,
        last_sync_at: null,
        created_by: null,
        created_at: 100,
        updated_at: 200,
      })
    );

    const result = await getPrimaryTenantVanityDomain(
      { tenantCoreDb: adapter, AUTHRIM_CONFIG: kv } as never,
      'tenant-123'
    );

    expect(result).toEqual(
      expect.objectContaining({
        tenant_id: 'tenant-123',
        hostname: 'login.example.com',
        is_primary: true,
        is_active: true,
      })
    );
    expect(adapter.queryOne).not.toHaveBeenCalled();
  });

  it('negative-caches a missing primary vanity domain', async () => {
    const adapter = createMockAdapter();
    const kv = createMockKV();

    vi.mocked(adapter.queryOne).mockResolvedValueOnce(null);

    const result = await getPrimaryTenantVanityDomain(
      { tenantCoreDb: adapter, AUTHRIM_CONFIG: kv } as never,
      'tenant-123'
    );

    expect(result).toBeNull();
    expect(adapter.queryOne).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledWith(
      'v1:tenant-primary-vanity-domain:tenant-123',
      expect.any(String),
      { expirationTtl: 60 }
    );
  });
});
