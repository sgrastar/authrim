import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const {
  mockLogger,
  mockGetRefreshTokenShardConfig,
  mockCreateNewGeneration,
  mockSaveRefreshTokenShardConfig,
  mockClearShardConfigCache,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCreateAccountAuthContextFromHono,
  mockResolveAccountDataContextFromHono,
} = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    module: vi.fn().mockReturnThis(),
  };

  return {
    mockLogger: logger,
    mockGetRefreshTokenShardConfig: vi.fn(),
    mockCreateNewGeneration: vi.fn(),
    mockSaveRefreshTokenShardConfig: vi.fn(),
    mockClearShardConfigCache: vi.fn(),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('tenant-a'),
    mockCreateAuthContextFromHono: vi.fn(),
    mockCreateAccountAuthContextFromHono: vi.fn(),
    mockResolveAccountDataContextFromHono: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: vi.fn().mockReturnValue(mockLogger),
    getRefreshTokenShardConfig: mockGetRefreshTokenShardConfig,
    createNewGeneration: mockCreateNewGeneration,
    saveRefreshTokenShardConfig: mockSaveRefreshTokenShardConfig,
    clearShardConfigCache: mockClearShardConfigCache,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createAccountAuthContextFromHono: mockCreateAccountAuthContextFromHono,
    resolveAccountDataContextFromHono: mockResolveAccountDataContextFromHono,
  };
});

import {
  revokeAllUserRefreshTokens,
  updateRefreshTokenShardingConfig,
} from '../routes/settings/refresh-token-sharding';

function createMockKV() {
  return {
    get: vi.fn(async () => null),
  } as unknown as KVNamespace;
}

function createMockContext(options: {
  body: Record<string, unknown>;
  env?: Partial<Env>;
  runtimeCoreDb?: DatabaseAdapter | null;
}) {
  return {
    env: {
      AUTHRIM_CONFIG: createMockKV(),
      AUTHRIM_CODE_SHARDS: '4',
      ...options.env,
    } as Env,
    req: {
      json: vi.fn().mockResolvedValue(options.body),
    },
    get(key: string) {
      if (key === 'tenantId') {
        return 'tenant-a';
      }
      if (key === 'tenantMetadataContext') {
        return options.runtimeCoreDb
          ? {
              tenantId: 'tenant-a',
              coreDb: options.runtimeCoreDb,
              route: {},
            }
          : undefined;
      }
      return undefined;
    },
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
  } as any;
}

function createMockAdapter() {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  } as DatabaseAdapter;
}

describe('refresh-token sharding settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.module.mockReturnValue(mockLogger);
    mockGetTenantIdFromContext.mockReturnValue('tenant-a');
  });

  it('records generation changes through the resolved core adapter even without env.DB', async () => {
    const coreAdapter = createMockAdapter();
    mockGetRefreshTokenShardConfig.mockResolvedValue({
      currentGeneration: 1,
      currentShardCount: 4,
      previousGenerations: [],
      updatedAt: 1000,
    });
    mockCreateNewGeneration.mockReturnValue({
      currentGeneration: 2,
      currentShardCount: 8,
      previousGenerations: [{ generation: 1, shardCount: 4, deprecatedAt: 2000 }],
      updatedAt: 3000,
      updatedBy: 'admin',
    });

    const c = createMockContext({
      body: {
        clientId: 'client-1',
        shardCount: 8,
      },
      runtimeCoreDb: coreAdapter,
      env: {
        DB: undefined,
      },
    });

    const response = await updateRefreshTokenShardingConfig(c);

    expect(response.status).toBe(200);
    expect(coreAdapter.execute).toHaveBeenCalledTimes(2);
    expect((coreAdapter.execute as any).mock.calls[0][0]).toContain(
      'INSERT INTO refresh_token_shard_configs'
    );
    expect((coreAdapter.execute as any).mock.calls[1][0]).toContain(
      'UPDATE refresh_token_shard_configs'
    );
  });

  it('skips relational bookkeeping when no resolved core adapter is available', async () => {
    mockGetRefreshTokenShardConfig.mockResolvedValue({
      currentGeneration: 0,
      currentShardCount: 4,
      previousGenerations: [],
      updatedAt: 1000,
    });
    mockCreateNewGeneration.mockReturnValue({
      currentGeneration: 1,
      currentShardCount: 8,
      previousGenerations: [],
      updatedAt: 2000,
      updatedBy: 'admin',
    });

    const c = createMockContext({
      body: {
        clientId: 'client-1',
        shardCount: 8,
      },
      env: {
        DB: undefined,
      },
    });

    const response = await updateRefreshTokenShardingConfig(c);

    expect(response.status).toBe(200);
    expect(mockSaveRefreshTokenShardConfig).toHaveBeenCalledTimes(1);
    expect(mockClearShardConfigCache).toHaveBeenCalledTimes(1);
  });
});

type FamilyRow = { jti: string; user_id: string; client_id: string; is_revoked: number };

/** A database holding refresh-token family index rows, answering the index statements. */
function createFamilyIndexAdapter(rows: FamilyRow[] = []) {
  const adapter = createMockAdapter();
  (adapter.query as ReturnType<typeof vi.fn>).mockImplementation(
    async (sql: string, params: unknown[]) => {
      if (!sql.includes('FROM user_token_families')) return [];
      const [, userId, clientId] = params as string[];
      return rows.filter(
        (row) =>
          row.user_id === userId &&
          row.is_revoked === 0 &&
          (!sql.includes('client_id = ?') || row.client_id === clientId)
      );
    }
  );
  (adapter.execute as ReturnType<typeof vi.fn>).mockImplementation(
    async (sql: string, params: unknown[]) => {
      if (!sql.includes('UPDATE user_token_families')) return { rowsAffected: 0 };
      // Marked by JWT ID: exactly the families revoked.
      const jtis = (params as string[]).slice(1);
      const matched = rows.filter((row) => jtis.includes(row.jti));
      for (const row of matched) row.is_revoked = 1;
      return { rowsAffected: matched.length };
    }
  );
  return { adapter, rows };
}

function createRevokeContext(options: {
  revokeFamilyRpc: ReturnType<typeof vi.fn>;
  clientId?: string;
}) {
  return {
    env: {
      REFRESH_TOKEN_ROTATOR: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ revokeFamilyRpc: options.revokeFamilyRpc })),
      },
    },
    req: {
      param: vi.fn(() => 'user-1'),
      query: vi.fn((name: string) => (name === 'clientId' ? options.clientId : undefined)),
    },
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
  } as any;
}

describe('revoking all of a user’s refresh tokens', () => {
  const family = (jti: string, clientId = 'client-1'): FamilyRow => ({
    jti,
    user_id: 'user-1',
    client_id: clientId,
    is_revoked: 0,
  });

  let metadata: ReturnType<typeof createFamilyIndexAdapter>;
  let account: ReturnType<typeof createFamilyIndexAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.module.mockReturnValue(mockLogger);
    mockGetTenantIdFromContext.mockReturnValue('tenant-a');
    // ar-token indexes families in the user's account database; tenant metadata holds none.
    metadata = createFamilyIndexAdapter();
    account = createFamilyIndexAdapter();
    mockCreateAuthContextFromHono.mockReturnValue({ coreAdapter: metadata.adapter });
    mockCreateAccountAuthContextFromHono.mockReturnValue({ coreAdapter: account.adapter });
    mockResolveAccountDataContextFromHono.mockResolvedValue({ tenantId: 'tenant-a' });
  });

  it('revokes the user’s family once in each rotator, by user, from the account database index', async () => {
    // Indexed by the families' first JWT IDs; two of them in the same rotator (shard 0).
    account.rows.push(
      family('g1:wnam:0:rt_first-a'),
      family('g1:wnam:0:rt_first-b'),
      family('g1:wnam:1:rt_first-c')
    );
    const revokeFamilyRpc = vi.fn().mockResolvedValue(undefined);
    const c = createRevokeContext({ revokeFamilyRpc });

    const response = await revokeAllUserRefreshTokens(c);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revoked: 3 });
    expect(mockResolveAccountDataContextFromHono).toHaveBeenCalledWith(c, 'user-1');
    expect(
      c.env.REFRESH_TOKEN_ROTATOR.idFromName.mock.calls.map(([name]: [string]) => name)
    ).toEqual([
      'tenant:tenant-a:refresh-rotator:client-1:v1:shard-0',
      'tenant:tenant-a:refresh-rotator:client-1:v1:shard-0',
      'tenant:tenant-a:refresh-rotator:client-1:v1:shard-1',
    ]);
    expect(revokeFamilyRpc).toHaveBeenCalledTimes(2);
    expect(revokeFamilyRpc).toHaveBeenCalledWith('user-1', 'user_wide_revocation');
    expect(account.rows.every((row) => row.is_revoked === 1)).toBe(true);
    expect(metadata.adapter.query).not.toHaveBeenCalled();
    expect(metadata.adapter.execute).not.toHaveBeenCalled();
  });

  it('limits the revocation to one client when asked', async () => {
    account.rows.push(family('g1:wnam:0:rt_a', 'client-1'), family('g1:wnam:0:rt_b', 'client-2'));
    const revokeFamilyRpc = vi.fn().mockResolvedValue(undefined);

    const response = await revokeAllUserRefreshTokens(
      createRevokeContext({ revokeFamilyRpc, clientId: 'client-2' })
    );

    expect(response.status).toBe(200);
    expect(revokeFamilyRpc).toHaveBeenCalledTimes(1);
    expect(account.rows.map((row) => [row.client_id, row.is_revoked])).toEqual([
      ['client-1', 0],
      ['client-2', 1],
    ]);
  });

  it('reports nothing to revoke for a user without an account route', async () => {
    mockResolveAccountDataContextFromHono.mockRejectedValue(
      new Error('account_data_route_not_found')
    );
    const revokeFamilyRpc = vi.fn();

    const response = await revokeAllUserRefreshTokens(createRevokeContext({ revokeFamilyRpc }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revoked: 0 });
    expect(revokeFamilyRpc).not.toHaveBeenCalled();
  });

  it('leaves the index as it was when a rotator cannot revoke', async () => {
    account.rows.push(family('g1:wnam:0:rt_first-a'));
    const revokeFamilyRpc = vi.fn().mockRejectedValue(new Error('down'));

    const response = await revokeAllUserRefreshTokens(createRevokeContext({ revokeFamilyRpc }));

    expect(response.status).toBe(500);
    expect(account.rows[0].is_revoked).toBe(0);
  });
});
