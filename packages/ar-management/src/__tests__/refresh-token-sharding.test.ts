import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const {
  mockLogger,
  mockGetRefreshTokenShardConfig,
  mockCreateNewGeneration,
  mockSaveRefreshTokenShardConfig,
  mockClearShardConfigCache,
  mockGetTenantIdFromContext,
  mockListFamilies,
  mockRevokeFamiliesIndex,
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
    mockListFamilies: vi.fn(),
    mockRevokeFamiliesIndex: vi.fn(),
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
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    listRefreshTokenFamiliesByUser: mockListFamilies,
    revokeRefreshTokenFamiliesByUser: mockRevokeFamiliesIndex,
    parseRefreshTokenJti: (jti: string) => ({
      generation: 1,
      shardIndex: Number(jti.split(':')[1]),
      randomPart: jti,
    }),
    buildRefreshTokenRotatorInstanceName: (
      clientId: string,
      generation: number,
      shardIndex: number,
      tenantId: string
    ) => `${tenantId}:${clientId}:${generation}:${shardIndex}`,
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

describe('revoking all of a user’s refresh tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.module.mockReturnValue(mockLogger);
    mockGetTenantIdFromContext.mockReturnValue('tenant-a');
  });

  it('revokes the user’s family once in each rotator, by user, then marks the index', async () => {
    // Indexed by the families' first JWT IDs; two of them in the same rotator (shard 0).
    mockListFamilies.mockResolvedValue([
      { jti: 'rt:0:first-a', client_id: 'client-1', generation: 1 },
      { jti: 'rt:0:first-b', client_id: 'client-1', generation: 1 },
      { jti: 'rt:1:first-c', client_id: 'client-1', generation: 1 },
    ]);
    const revokeFamilyRpc = vi.fn().mockResolvedValue(undefined);
    const c = {
      env: {
        REFRESH_TOKEN_ROTATOR: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ revokeFamilyRpc })),
        },
      },
      req: {
        param: vi.fn(() => 'user-1'),
        query: vi.fn(() => undefined),
      },
      json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    } as any;

    const response = await revokeAllUserRefreshTokens(c);

    expect(response.status).toBe(200);
    expect(
      c.env.REFRESH_TOKEN_ROTATOR.idFromName.mock.calls.map(([name]: [string]) => name)
    ).toEqual(['tenant-a:client-1:1:0', 'tenant-a:client-1:1:1']);
    expect(revokeFamilyRpc).toHaveBeenCalledTimes(2);
    expect(revokeFamilyRpc).toHaveBeenCalledWith('user-1', 'user_wide_revocation');
    expect(mockRevokeFamiliesIndex).toHaveBeenCalledWith(
      {},
      { tenantId: 'tenant-a', userId: 'user-1', clientId: null }
    );
  });

  it('leaves the index as it was when a rotator cannot revoke', async () => {
    mockListFamilies.mockResolvedValue([
      { jti: 'rt:0:first-a', client_id: 'client-1', generation: 1 },
    ]);
    const c = {
      env: {
        REFRESH_TOKEN_ROTATOR: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ revokeFamilyRpc: vi.fn().mockRejectedValue(new Error('down')) })),
        },
      },
      req: { param: vi.fn(() => 'user-1'), query: vi.fn(() => undefined) },
      json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    } as any;

    const response = await revokeAllUserRefreshTokens(c);

    expect(response.status).toBe(500);
    expect(mockRevokeFamiliesIndex).not.toHaveBeenCalled();
  });
});
