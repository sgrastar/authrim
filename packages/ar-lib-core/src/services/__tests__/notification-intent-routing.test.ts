import { describe, expect, it, vi } from 'vitest';
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
  it('routes the reserved platform owner to the stable shared-core alias', async () => {
    const shared = database();
    await expect(
      resolveNotificationIntentTarget({ DB: database(), TDB_SHARED_CORE: shared } as never, {
        owner: 'platform',
      })
    ).resolves.toEqual({
      tenantId: PLATFORM_NOTIFICATION_NAMESPACE,
      db: shared,
      bindingRef: 'TDB_SHARED_CORE',
    });
  });

  it('routes a tenant in the shared profile through the same stable alias', async () => {
    const shared = database();
    await expect(
      resolveNotificationIntentTarget(
        {
          DB: database(),
          TDB_SHARED_CORE: shared,
          DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:shared-d1',
        } as never,
        { owner: 'tenant', tenantId: 'tenant-a' }
      )
    ).resolves.toEqual({
      tenantId: 'tenant-a',
      db: shared,
      bindingRef: 'TDB_SHARED_CORE',
    });
  });

  it('rejects the platform namespace and a missing shared binding for tenant input', async () => {
    await expect(
      resolveNotificationIntentTarget({ DB: database() } as never, {
        owner: 'tenant',
        tenantId: PLATFORM_NOTIFICATION_NAMESPACE,
      })
    ).rejects.toThrow('notification_intent_tenant_invalid');
    await expect(
      resolveNotificationIntentTarget(
        {
          DB: database(),
          DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:shared-d1',
        } as never,
        { owner: 'tenant', tenantId: 'tenant-a' }
      )
    ).rejects.toThrow('notification_intent_shared_d1_unavailable');
  });
});
