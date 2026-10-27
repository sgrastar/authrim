import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import type { DatabaseAdapter } from '../../db/adapter';
import type { RuntimeDataPorts } from '../../types/runtime-data-ports';
import {
  getRegistryTenantMetadataRoute,
  resolveTenantMetadataContext,
  resolveAccountDataContext,
  resolveAccountDataContextByIdentifier,
  resolveAccountCoreDataContext,
  resolveAccountPiiSourceForAudit,
  type AccountDataContext,
} from '../runtime-data-context';

const { resolveCloudflare } = vi.hoisted(() => ({ resolveCloudflare: vi.fn() }));
vi.mock('../tenant-database-resolver', () => ({
  resolveTenantDatabaseSourceFromRegistry: resolveCloudflare,
}));

const database = {} as DatabaseAdapter;
function account(tenantId = 'tenant-a', accountId = 'account:user-a'): AccountDataContext {
  return {
    tenantId,
    accountId,
    legacyUserId: 'user-a',
    membership: { tenantId, accountId },
    coreDb: database,
    piiDb: database,
  } as AccountDataContext;
}

function ports() {
  return {
    resolveTenant: vi.fn(async (tenantId: string) => ({
      runtimeKind: 'portable' as const,
      tenantId,
      coreDb: database,
      route: { allocationScope: 'shared_pool' as const },
    })),
    resolveAccount: vi.fn(async () => account()),
    resolveAccountCore: vi.fn(async () => account()),
    resolveAccountPiiForAudit: vi.fn(async () => database),
  } satisfies RuntimeDataPorts;
}

describe('deployment-owned runtime data ports', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps Cloudflare registry resolution when no port is installed', async () => {
    const route = { source: database };
    resolveCloudflare.mockResolvedValueOnce(route);
    const env = {} as Env;
    const result = await resolveTenantMetadataContext(env, 'tenant-a');
    expect(result).toEqual({ tenantId: 'tenant-a', coreDb: database, route });
    expect(resolveCloudflare).toHaveBeenCalledExactlyOnceWith(
      env,
      expect.objectContaining({ tenantId: 'tenant-a', role: 'tenant_core' })
    );
  });

  it('uses explicit ports without contacting the Cloudflare registry', async () => {
    const runtime = ports();
    const env = { RUNTIME_DATA_PORTS: runtime } as Env;
    expect((await resolveTenantMetadataContext(env, 'tenant-a')).coreDb).toBe(database);
    expect(
      (await resolveAccountDataContext(env, { tenantId: 'tenant-a', accountId: 'user-a' }))
        .accountId
    ).toBe('account:user-a');
    expect(runtime.resolveAccount).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'account:user-a', expectedAccountId: 'account:user-a' })
    );
    expect(resolveCloudflare).not.toHaveBeenCalled();
  });

  it('rejects portable metadata at a registry-only caller but preserves Cloudflare routes', () => {
    const portable = {
      runtimeKind: 'portable' as const,
      tenantId: 'tenant-a',
      coreDb: database,
      route: { allocationScope: 'shared_pool' as const },
    };
    expect(() => getRegistryTenantMetadataRoute(portable)).toThrow(
      'tenant_metadata_registry_route_required'
    );
    const cloudflareRoute = { bindingRef: 'DB_TENANT', allocationScope: 'shared_pool' };
    expect(
      getRegistryTenantMetadataRoute({
        tenantId: 'tenant-a',
        coreDb: database,
        route: cloudflareRoute as never,
      })
    ).toBe(cloudflareRoute);
  });

  it('rejects a provider resolving a different tenant', async () => {
    const runtime = ports();
    vi.mocked(runtime.resolveTenant).mockResolvedValueOnce({
      runtimeKind: 'portable',
      tenantId: 'tenant-b',
      coreDb: database,
      route: { allocationScope: 'shared_pool' },
    });
    await expect(
      resolveTenantMetadataContext({ RUNTIME_DATA_PORTS: runtime } as Env, 'tenant-a')
    ).rejects.toThrow('tenant_metadata_context_conflict');
  });

  it('rejects a portable provider that omits its runtime discriminator', async () => {
    const runtime = ports();
    runtime.resolveTenant.mockResolvedValueOnce({
      tenantId: 'tenant-a',
      coreDb: database,
      route: { allocationScope: 'shared_pool' },
    } as never);
    await expect(
      resolveTenantMetadataContext({ RUNTIME_DATA_PORTS: runtime } as Env, 'tenant-a')
    ).rejects.toThrow('tenant_metadata_context_conflict');
  });

  it.each([
    ['different tenant', () => account('tenant-b')],
    ['different account', () => account('tenant-a', 'account:user-b')],
    [
      'different membership',
      () => ({ ...account(), membership: { ...account().membership, tenantId: 'tenant-b' } }),
    ],
  ])('rejects %s from an account provider', async (_label, result) => {
    const runtime = ports();
    vi.mocked(runtime.resolveAccount).mockResolvedValueOnce(result());
    await expect(
      resolveAccountDataContextByIdentifier({ RUNTIME_DATA_PORTS: runtime } as Env, {
        tenantId: 'tenant-a',
        indexKind: 'account_id',
        identifier: 'account:user-a',
      })
    ).rejects.toThrow('account_data_context_conflict');
  });

  it('normalizes account IDs for core and inactive-account audit resolution', async () => {
    const runtime = ports();
    const env = { RUNTIME_DATA_PORTS: runtime } as Env;
    await resolveAccountCoreDataContext(env, { tenantId: 'tenant-a', accountId: 'user-a' });
    await resolveAccountPiiSourceForAudit(env, { tenantId: 'tenant-a', accountId: 'user-a' });
    expect(runtime.resolveAccountCore).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    });
    expect(runtime.resolveAccountPiiForAudit).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    });
  });

  it('propagates provider failure without falling back to another database', async () => {
    const runtime = ports();
    vi.mocked(runtime.resolveTenant).mockRejectedValueOnce(new Error('snapshot_unavailable'));
    await expect(
      resolveTenantMetadataContext({ RUNTIME_DATA_PORTS: runtime } as Env, 'tenant-a')
    ).rejects.toThrow('snapshot_unavailable');
    expect(resolveCloudflare).not.toHaveBeenCalled();
  });
});
