import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveAuthCorePersistenceSourceFromEnv,
} from '../auth-core-persistence-context';

function createMockAdapter(name: string): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue(name),
    close: vi.fn(),
  };
}

describe('auth-core-persistence-context', () => {
  it('resolves the control-plane source directly from the admin binding', async () => {
    const admin = createMockAdapter('admin');
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_ADMIN: admin,
    };

    await expect(resolveAuthCorePersistenceSourceFromEnv(env)).resolves.toBe(admin);
  });

  it('returns a database adapter for the control-plane source', async () => {
    const admin = createMockAdapter('admin');
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_ADMIN: admin,
    };

    await expect(resolveAuthCorePersistenceAdapterFromEnv(env)).resolves.toBe(admin);
  });

  it('requires the control-plane binding for non-tenant data', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
    };

    await expect(resolveAuthCorePersistenceSourceFromEnv(env)).rejects.toThrow(
      'auth_core_admin_database_required'
    );
  });

  it('uses the portable tenant metadata port without requiring a Cloudflare registry', async () => {
    const core = createMockAdapter('postgres');
    const resolveTenant = vi.fn(async (tenantId: string) => ({
      runtimeKind: 'portable' as const,
      tenantId,
      coreDb: core,
      route: { allocationScope: 'shared_pool' as const },
    }));
    const env = {
      RUNTIME_DATA_PORTS: { resolveTenant },
    } as unknown as Parameters<typeof resolveAuthCorePersistenceAdapterFromEnv>[0];
    await expect(
      resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-providers', { tenantId: 'tenant-a' })
    ).resolves.toBe(core);
    expect(resolveTenant).toHaveBeenCalledExactlyOnceWith('tenant-a');
  });

  it('rejects a portable metadata provider that returns a different tenant', async () => {
    const core = createMockAdapter('postgres');
    const env = {
      RUNTIME_DATA_PORTS: {
        resolveTenant: vi.fn(async () => ({
          runtimeKind: 'portable',
          tenantId: 'tenant-b',
          coreDb: core,
          route: { allocationScope: 'shared_pool' },
        })),
      },
    } as unknown as Parameters<typeof resolveAuthCorePersistenceAdapterFromEnv>[0];
    await expect(
      resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-providers', { tenantId: 'tenant-a' })
    ).rejects.toThrow('tenant_metadata_context_conflict');
  });
});
