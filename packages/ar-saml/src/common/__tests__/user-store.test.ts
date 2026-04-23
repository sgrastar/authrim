import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  resolveUserStoreRuntimeSourcesFromEnv: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    resolveUserStoreRuntimeSourcesFromEnv: mocked.resolveUserStoreRuntimeSourcesFromEnv,
  };
});

import {
  findActiveSamlUserByEmail,
  getSamlUserInfoById,
  getSamlUserNameIdById,
} from '../user-store';

function createMockAdapter(options: {
  queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
} = {}): DatabaseAdapter {
  const queryOneImpl: DatabaseAdapter['queryOne'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> => (((await options.queryOne?.(sql, params)) ?? null) as T | null);
  return {
    query: vi.fn(async <T>() => [] as T[]) as unknown as DatabaseAdapter['query'],
    queryOne: vi.fn(queryOneImpl) as unknown as DatabaseAdapter['queryOne'],
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(async (fn: any) => fn()),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SAML user-store helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds active users by email from the runtime-resolved pii store', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1')) {
          expect(params).toEqual(['user-1', 'tenant-a']);
          return { id: 'user-1' };
        }
        return null;
      },
    });
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM users_pii WHERE tenant_id = ? AND email = ?')) {
          expect(params).toEqual(['tenant-a', 'user@example.com']);
          return { id: 'user-1' };
        }
        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      coreDb: coreAdapter,
      piiDb: piiAdapter,
    });

    await expect(
      findActiveSamlUserByEmail({ DB: {} } as Env, 'tenant-a', 'user@example.com')
    ).resolves.toEqual({ id: 'user-1' });
  });

  it('reads NameID email from the runtime-resolved pii store', async () => {
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT email FROM users_pii WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-2', 'tenant-b']);
          return { email: 'nameid@example.com' };
        }
        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      coreDb: createMockAdapter(),
      piiDb: piiAdapter,
    });

    await expect(getSamlUserNameIdById({ DB: {} } as Env, 'tenant-b', 'user-2')).resolves.toBe(
      'nameid@example.com'
    );
  });

  it('returns complete SAML user info from runtime-resolved core and pii stores', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1')) {
          expect(params).toEqual(['user-3', 'tenant-c']);
          return { id: 'user-3' };
        }
        return null;
      },
    });
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT email, name FROM users_pii WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-3', 'tenant-c']);
          return { email: 'full@example.com', name: 'Full User' };
        }
        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      coreDb: coreAdapter,
      piiDb: piiAdapter,
    });

    await expect(getSamlUserInfoById({ DB: {} } as Env, 'tenant-c', 'user-3')).resolves.toEqual({
      id: 'user-3',
      email: 'full@example.com',
      name: 'Full User',
    });
  });
});
