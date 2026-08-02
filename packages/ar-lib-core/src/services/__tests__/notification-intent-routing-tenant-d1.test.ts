import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  resolveTenant: vi.fn(),
}));

vi.mock('../auth-core-persistence-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth-core-persistence-context')>()),
  getCachedAuthCorePersistenceContextFromEnv: mocks.context,
}));

vi.mock('../tenant-database-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-database-resolver')>()),
  resolveTenantDatabaseSourceForTarget: mocks.resolveTenant,
}));

import { resolveNotificationIntentTarget } from '../notification-intent-routing';

function database(): D1Database {
  return {
    prepare: vi.fn(),
    withSession: vi.fn(),
  } as unknown as D1Database;
}

describe('tenant-D1 notification intent routing', () => {
  beforeEach(() => {
    mocks.context.mockReset().mockResolvedValue({
      storageProfile: { id: 'builtin:storage:tenant-d1' },
      coreTarget: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
      },
    });
    mocks.resolveTenant.mockReset();
  });

  it('preserves the signed tenant resolver binding and D1 source', async () => {
    const tenantDb = database();
    mocks.resolveTenant.mockResolvedValue({
      source: tenantDb,
      bindingRef: 'TDB_TENANT_A_123456_CORE',
    });

    await expect(
      resolveNotificationIntentTarget(
        {
          DB: database(),
          TENANT_RUNTIME_REGISTRY: { get: vi.fn() },
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        } as never,
        { owner: 'tenant', tenantId: 'tenant-a' }
      )
    ).resolves.toEqual({
      tenantId: 'tenant-a',
      db: tenantDb,
      bindingRef: 'TDB_TENANT_A_123456_CORE',
    });
    expect(mocks.resolveTenant).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      expect.objectContaining({ resolverRef: 'tenant-database-registry' }),
      expect.objectContaining({ deploymentTarget: 'edge-a', runtimeSnapshotMode: 'required' })
    );
  });

  it('fails closed for an unsafe binding or a non-D1 resolved source', async () => {
    mocks.resolveTenant.mockResolvedValueOnce({
      source: database(),
      bindingRef: 'DB',
    });
    await expect(
      resolveNotificationIntentTarget({ DB: database() } as never, {
        owner: 'tenant',
        tenantId: 'tenant-a',
      })
    ).rejects.toThrow('notification_intent_binding_invalid');

    mocks.resolveTenant.mockResolvedValueOnce({
      source: { query: vi.fn() },
      bindingRef: 'TDB_TENANT_A_123456_CORE',
    });
    await expect(
      resolveNotificationIntentTarget({ DB: database() } as never, {
        owner: 'tenant',
        tenantId: 'tenant-a',
      })
    ).rejects.toThrow('notification_intent_tenant_d1_unavailable');
  });
});
