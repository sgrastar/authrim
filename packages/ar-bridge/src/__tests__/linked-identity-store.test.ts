import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQueryOne, mockQuery, mockExecute, MockD1Adapter, sqlTracker } = vi.hoisted(() => {
  const tracker = {
    calls: [] as { method: string; sql: string; params: unknown[] }[],
    reset() {
      this.calls.length = 0;
    },
  };

  const queryOne = vi.fn().mockResolvedValue(null);
  const query = vi.fn().mockResolvedValue([]);
  const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });

  class D1AdapterClass {
    constructor(_options: { db: unknown }) {}

    queryOne = (sql: string, params?: unknown[]) => {
      tracker.calls.push({ method: 'queryOne', sql, params: params || [] });
      return queryOne(sql, params);
    };

    query = (sql: string, params?: unknown[]) => {
      tracker.calls.push({ method: 'query', sql, params: params || [] });
      return query(sql, params);
    };

    execute = (sql: string, params?: unknown[]) => {
      tracker.calls.push({ method: 'execute', sql, params: params || [] });
      return execute(sql, params);
    };
  }

  return {
    mockQueryOne: queryOne,
    mockQuery: query,
    mockExecute: execute,
    MockD1Adapter: D1AdapterClass,
    sqlTracker: tracker,
  };
});

vi.mock('@authrim/ar-lib-core', () => ({
  D1Adapter: MockD1Adapter,
  getDefaultTenantId: vi.fn(() => 'default'),
}));

import {
  createLinkedIdentity,
  findLinkedIdentity,
  findLinkedIdentitiesAcrossTenantsByProviderSub,
  findLinkedIdentitiesByProviderSub,
  getLinkedIdentityForUserAndProvider,
} from '../services/linked-identity-store';

describe('linked-identity-store', () => {
  const env = {
    DB: {},
    RP_TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlTracker.reset();
    mockQueryOne.mockReset().mockResolvedValue(null);
    mockQuery.mockReset().mockResolvedValue([]);
    mockExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  });

  it('uses tenant-scoped lookup for provider user resolution', async () => {
    await findLinkedIdentity(env, 'tenant-a', 'google', 'sub-123');

    expect(sqlTracker.calls[0]?.sql).toContain('tenant_id = ?');
    expect(sqlTracker.calls[0]?.params).toEqual(['tenant-a', 'google', 'sub-123']);
  });

  it('uses tenant-scoped lookup for user and provider resolution', async () => {
    await getLinkedIdentityForUserAndProvider(env, 'tenant-a', 'user-1', 'google');

    expect(sqlTracker.calls[0]?.sql).toContain('tenant_id = ?');
    expect(sqlTracker.calls[0]?.params).toEqual(['tenant-a', 'user-1', 'google']);
  });

  it('keeps explicit cross-tenant provider-sub lookup separate', async () => {
    await findLinkedIdentitiesAcrossTenantsByProviderSub(env, 'google', 'sub-123');

    expect(sqlTracker.calls[0]?.sql).not.toContain('tenant_id = ?');
    expect(sqlTracker.calls[0]?.params).toEqual(['google', 'sub-123']);
  });

  it('uses tenant-scoped provider-sub lookup for backchannel logout paths', async () => {
    await findLinkedIdentitiesByProviderSub(env, 'tenant-a', 'google', 'sub-123');

    expect(sqlTracker.calls[0]?.sql).toContain('tenant_id = ?');
    expect(sqlTracker.calls[0]?.params).toEqual(['tenant-a', 'google', 'sub-123']);
  });

  it('persists tenant_id when creating a linked identity', async () => {
    await createLinkedIdentity(env, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      providerId: 'google',
      providerUserId: 'sub-123',
      tokens: {
        access_token: 'access-token',
        token_type: 'Bearer',
      },
    });

    expect(sqlTracker.calls[0]?.sql).toContain('tenant_id');
    expect(sqlTracker.calls[0]?.params?.[1]).toBe('tenant-a');
  });
});
