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
});
