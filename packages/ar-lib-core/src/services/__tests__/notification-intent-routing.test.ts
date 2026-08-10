import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveTenant: vi.fn() }));

vi.mock('../tenant-database-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-database-resolver')>()),
  resolveTenantDatabaseSourceFromRegistry: mocks.resolveTenant,
}));

import {
  PLATFORM_NOTIFICATION_NAMESPACE,
  resolveNotificationIntentTarget,
} from '../notification-intent-routing';

function database(): D1Database {
  return {
    prepare: vi.fn(),
    withSession: vi.fn(),
  } as unknown as D1Database;
}

describe('notification intent routing', () => {
  beforeEach(() => {
    mocks.resolveTenant.mockReset();
  });

  it('routes the reserved platform owner to the platform notification database', async () => {
    const platform = database();
    await expect(
      resolveNotificationIntentTarget({ PLATFORM_NOTIFICATION_DB: platform } as never, {
        owner: 'platform',
      })
    ).resolves.toEqual({
      tenantId: PLATFORM_NOTIFICATION_NAMESPACE,
      db: platform,
      bindingRef: 'PLATFORM_NOTIFICATION_DB',
    });
    expect(mocks.resolveTenant).not.toHaveBeenCalled();
  });

  it('fails closed when the platform notification binding is absent', async () => {
    await expect(
      resolveNotificationIntentTarget({} as never, { owner: 'platform' })
    ).rejects.toThrow('notification_intent_platform_database_unavailable');
    expect(mocks.resolveTenant).not.toHaveBeenCalled();
  });

  it('routes a tenant through its signed default assignment', async () => {
    const tenantDb = database();
    mocks.resolveTenant.mockResolvedValue({
      source: tenantDb,
      bindingRef: 'TEST_TDB_TENANT_A_DEFAULT',
    });

    await expect(
      resolveNotificationIntentTarget({ AUTHRIM_DEPLOYMENT_TARGET: 'edge-a' } as never, {
        owner: 'tenant',
        tenantId: 'tenant-a',
      })
    ).resolves.toEqual({
      tenantId: 'tenant-a',
      db: tenantDb,
      bindingRef: 'TEST_TDB_TENANT_A_DEFAULT',
    });
    expect(mocks.resolveTenant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        deploymentTarget: 'edge-a',
      })
    );
  });

  it('rejects reserved or malformed tenant IDs before route resolution', async () => {
    for (const tenantId of [PLATFORM_NOTIFICATION_NAMESPACE, '../tenant']) {
      await expect(
        resolveNotificationIntentTarget({} as never, { owner: 'tenant', tenantId })
      ).rejects.toThrow('notification_intent_tenant_invalid');
    }
    expect(mocks.resolveTenant).not.toHaveBeenCalled();
  });

  it('fails closed for an unsafe binding or non-D1 source', async () => {
    mocks.resolveTenant.mockResolvedValueOnce({ source: database(), bindingRef: 'DB' });
    await expect(
      resolveNotificationIntentTarget({} as never, { owner: 'tenant', tenantId: 'tenant-a' })
    ).rejects.toThrow('notification_intent_binding_invalid');

    mocks.resolveTenant.mockResolvedValueOnce({
      source: { query: vi.fn() },
      bindingRef: 'TEST_TDB_TENANT_A_DEFAULT',
    });
    await expect(
      resolveNotificationIntentTarget({} as never, { owner: 'tenant', tenantId: 'tenant-a' })
    ).rejects.toThrow('notification_intent_tenant_database_unavailable');
  });
});
