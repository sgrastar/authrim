import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  createAuthContextFromHono: vi.fn(),
  getTenantIdFromContext: vi.fn(),
  getLogger: vi.fn(),
  getTenantMetadataContextFromHono: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    createAuthContextFromHono: mocked.createAuthContextFromHono,
    getTenantIdFromContext: mocked.getTenantIdFromContext,
    getLogger: mocked.getLogger,
    getTenantMetadataContextFromHono: mocked.getTenantMetadataContextFromHono,
  };
});

import { rotateCheckApiKey } from '../routes/settings/check-api-keys';

function createMockAdapter(
  options: {
    queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
    execute?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
  } = {}
): DatabaseAdapter {
  const queryOneImpl: DatabaseAdapter['queryOne'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> => ((await options.queryOne?.(sql, params)) ?? null) as T | null;

  const executeImpl: DatabaseAdapter['execute'] = async (sql: string, params: unknown[] = []) =>
    ((await options.execute?.(sql, params)) ?? {
      success: true,
      rowsAffected: 0,
      insertId: undefined,
    }) as {
      success: boolean;
      rowsAffected: number;
      insertId?: string | number | bigint | undefined;
    };

  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn(queryOneImpl) as unknown as DatabaseAdapter['queryOne'],
    execute: vi.fn(executeImpl) as unknown as DatabaseAdapter['execute'],
    transaction: vi.fn().mockImplementation(async (fn) => fn({} as DatabaseAdapter)),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(options: {
  params?: Record<string, string>;
  env?: Partial<Env>;
  tenantId?: string;
  adminUserId?: string;
}) {
  const store = new Map<string, unknown>([
    ['tenant_id', options.tenantId ?? 'tenant-a'],
    ['admin_user_id', options.adminUserId ?? 'admin-user-1'],
  ]);

  return {
    req: {
      param: vi.fn((name: string) => options.params?.[name]),
    },
    env: {
      DB: {},
      ...options.env,
    } as Env,
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
  } as any;
}

describe('check-api-keys rotate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getTenantIdFromContext.mockReturnValue('tenant-a');
    mocked.getLogger.mockReturnValue({
      module: () => ({
        info: vi.fn(),
        error: vi.fn(),
      }),
    });
    mocked.getTenantMetadataContextFromHono.mockReturnValue({
      tenantId: 'tenant-a',
      coreDb: {},
    });
  });

  it('rotates an active key without using adapter transactions', async () => {
    const adapter = createMockAdapter({
      queryOne: (sql, params) => {
        expect(sql).toContain('FROM check_api_keys');
        expect(params).toEqual(['key-1', 'tenant-a']);
        return {
          id: 'key-1',
          client_id: 'client-123',
          name: 'Primary key',
          allowed_operations: '["check","batch"]',
          rate_limit_tier: 'moderate',
          expires_at: null,
        };
      },
      execute: (sql, params) => {
        if (sql.startsWith('INSERT INTO check_api_keys')) {
          expect(params[1]).toBe('tenant-a');
          expect(params[2]).toBe('client-123');
          expect(params[3]).toBe('Primary key (rotated)');
          return { rowsAffected: 1 };
        }

        if (sql.startsWith('UPDATE check_api_keys')) {
          expect(params[1]).toBe('key-1');
          expect(params[2]).toBe('tenant-a');
          return { rowsAffected: 1 };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter: adapter });

    const c = createMockContext({ params: { id: 'key-1' } });
    const res = await rotateCheckApiKey(c);

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      api_key: string;
      name: string;
      client_id: string;
      allowed_operations: string[];
      rate_limit_tier: string;
    };

    expect(body.api_key).toMatch(/^chk_/);
    expect(body.name).toBe('Primary key (rotated)');
    expect(body.client_id).toBe('client-123');
    expect(body.allowed_operations).toEqual(['check', 'batch']);
    expect(body.rate_limit_tier).toBe('moderate');

    expect(adapter.execute).toHaveBeenCalledTimes(2);
    expect(adapter.transaction).not.toHaveBeenCalled();
  });

  it('cleans up the inserted replacement key when the old key was concurrently deactivated', async () => {
    const adapter = createMockAdapter({
      queryOne: () => ({
        id: 'key-1',
        client_id: 'client-123',
        name: 'Primary key',
        allowed_operations: '["check"]',
        rate_limit_tier: 'moderate',
        expires_at: null,
      }),
      execute: (sql) => {
        if (sql.startsWith('INSERT INTO check_api_keys')) {
          return { rowsAffected: 1 };
        }

        if (sql.startsWith('UPDATE check_api_keys')) {
          return { rowsAffected: 0 };
        }

        if (sql.startsWith('DELETE FROM check_api_keys')) {
          return { rowsAffected: 1 };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter: adapter });

    const c = createMockContext({ params: { id: 'key-1' } });
    const res = await rotateCheckApiKey(c);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');

    expect(adapter.execute).toHaveBeenCalledTimes(3);
    expect((adapter.execute as ReturnType<typeof vi.fn>).mock.calls[2]?.[0]).toContain(
      'DELETE FROM check_api_keys'
    );
    expect(adapter.transaction).not.toHaveBeenCalled();
  });
});
