import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    resolveTenantAssignedDatabaseSourcesFromRegistry:
      mocked.resolveTenantAssignedDatabaseSourcesFromRegistry,
  };
});

import { listTombstones } from '../routes/settings/tombstones';

function createMockAdapter(
  options: {
    queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
    query?: (sql: string, params: unknown[]) => unknown[] | Promise<unknown[]>;
  } = {}
): DatabaseAdapter {
  const queryImpl: DatabaseAdapter['query'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> => ((await options.query?.(sql, params)) ?? []) as T[];

  const queryOneImpl: DatabaseAdapter['queryOne'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> => ((await options.queryOne?.(sql, params)) ?? null) as T | null;

  return {
    query: vi.fn(queryImpl) as unknown as DatabaseAdapter['query'],
    queryOne: vi.fn(queryOneImpl) as unknown as DatabaseAdapter['queryOne'],
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(async (fn: any) => fn()),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(envOverrides: Partial<Env> = {}) {
  const contextStore = new Map<string, unknown>([['tenantId', 'acme']]);
  return {
    req: {
      query: vi.fn((_name: string) => undefined),
      param: vi.fn(),
      json: vi.fn(),
    },
    env: {
      DB: {},
      SETTINGS: undefined,
      AUTHRIM_CONFIG: undefined,
      ...envOverrides,
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;
}

describe('tombstones routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists tombstones from the runtime-resolved pii store for the current tenant', async () => {
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT COUNT(*) as count FROM users_pii_tombstone')) {
          expect(params).toEqual(['acme']);
          return { count: 1 };
        }
        if (
          sql.includes(
            'SELECT COUNT(*) as count FROM users_pii_tombstone WHERE tenant_id = ? AND retention_until < ?'
          )
        ) {
          return { count: 0 };
        }
        if (
          sql.includes(
            'SELECT COUNT(*) as count FROM users_pii_tombstone WHERE tenant_id = ? AND deleted_at >= ?'
          )
        ) {
          return { count: 1 };
        }
        return null;
      },
      query: (sql, params) => {
        if (sql.includes('SELECT * FROM users_pii_tombstone')) {
          expect(params[0]).toBe('acme');
          return [
            {
              id: 'user-1',
              tenant_id: 'acme',
              email_blind_index: 'blind',
              deleted_at: Date.now() - 1_000,
              deleted_by: 'admin-1',
              deletion_reason: 'user_request',
              retention_until: Date.now() + 86_400_000,
              deletion_metadata: '{"source":"test"}',
            },
          ];
        }
        if (sql.includes('GROUP BY deletion_reason')) {
          return [{ deletion_reason: 'user_request', count: 1 }];
        }
        return [];
      },
    });

    mocked.resolveTenantAssignedDatabaseSourcesFromRegistry.mockResolvedValue([
      { source: piiAdapter },
    ]);

    const c = createMockContext();
    const res = await listTombstones(c);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ id: string; tenant_id: string }>;
      filters: { tenant_id: string };
    };
    expect(body.filters.tenant_id).toBe('acme');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'user-1', tenant_id: 'acme' });
    expect(mocked.resolveTenantAssignedDatabaseSourcesFromRegistry).toHaveBeenCalledWith(
      c.env,
      expect.objectContaining({ tenantId: 'acme', role: 'tenant_pii' })
    );
  });
});
