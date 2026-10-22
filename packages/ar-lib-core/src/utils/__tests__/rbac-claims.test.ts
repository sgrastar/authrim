import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import type { CompositeRBACCache } from '../rbac-claims';
import {
  extractAccessTokenClaimsFromCache,
  extractIDTokenClaimsFromCache,
  getAccessTokenRBACClaims,
  getCompositeRBACCache,
  getIDTokenRBACClaims,
  getIDTokenRBACClaimsConfigurable,
  getRBACCacheTTL,
  getRBACCacheVersion,
  getUserRBACClaims,
  resolveAllOrganizations,
  resolveEffectiveRoles,
  resolveOrganizationInfo,
  resolveOrganizationName,
  resolvePermissions,
  resolveRelationshipsSummary,
  resolveScopedRoles,
  resolveUserType,
} from '../rbac-claims';

type QueryRouter = (sql: string, params?: unknown[]) => unknown;

function adapter(router: QueryRouter = () => null): DatabaseAdapter {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => router(sql, params) ?? []),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => router(sql, params) ?? null),
    execute: vi.fn(),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn(async () => ({ healthy: true, latencyMs: 0, type: 'test' })),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(async () => undefined),
  } as unknown as DatabaseAdapter;
}

function cacheFixture(overrides: Partial<CompositeRBACCache> = {}): CompositeRBACCache {
  return {
    version: 1,
    roles: ['admin'],
    scoped_roles: [{ name: 'editor', scope: 'organization', scopeTarget: 'org-1' }],
    permissions: ['users:read'],
    organizations: [{ id: 'org-1', name: 'Acme', type: 'enterprise', is_primary: true }],
    user_type: 'system_admin',
    plan: 'professional',
    org_id: 'org-1',
    org_name: 'Acme',
    org_type: 'enterprise',
    relationships_summary: { children_ids: ['child-1'], parent_ids: ['parent-1'] },
    cached_at: 100,
    ...overrides,
  };
}

describe('RBAC token claims', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires a non-empty tenant for token and composite cache isolation', async () => {
    const one = adapter();
    const db = { metadata: one, account: one };
    await expect(getIDTokenRBACClaims(db, 'user-1', { tenantId: ' ' })).rejects.toThrow(
      'requires tenantId'
    );
    await expect(getAccessTokenRBACClaims(db, 'user-1', { tenantId: '' })).rejects.toThrow(
      'requires tenantId'
    );
    await expect(getCompositeRBACCache(db, 'user-1')).rejects.toThrow('requires tenantId');
  });

  it('uses valid KV TTL/version values and memoizes them briefly', async () => {
    const get = vi.fn(async (key: string) => (key.endsWith('ttl') ? '120' : '4'));
    const env = { AUTHRIM_CONFIG: { get } } as never;
    await expect(getRBACCacheTTL(env)).resolves.toBe(120);
    await expect(getRBACCacheVersion(env)).resolves.toBe(4);
    await expect(getRBACCacheTTL(env)).resolves.toBe(120);
    await expect(getRBACCacheVersion(env)).resolves.toBe(4);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('falls back from invalid KV settings to environment settings and defaults', async () => {
    vi.advanceTimersByTime(61_000);
    const invalidKv = { get: vi.fn().mockResolvedValue('invalid') };
    await expect(
      getRBACCacheTTL({ AUTHRIM_CONFIG: invalidKv, RBAC_CACHE_TTL: '45' } as never)
    ).resolves.toBe(45);
    await expect(
      getRBACCacheVersion({ AUTHRIM_CONFIG: invalidKv, RBAC_CACHE_VERSION: '7' } as never)
    ).resolves.toBe(7);

    vi.advanceTimersByTime(61_000);
    await expect(getRBACCacheTTL({ RBAC_CACHE_TTL: '0' } as never)).resolves.toBe(600);
    await expect(getRBACCacheVersion({ RBAC_CACHE_VERSION: '-1' } as never)).resolves.toBe(1);
  });

  it('extracts only configured ID-token claims from a composite cache', () => {
    const all = extractIDTokenClaimsFromCache(
      cacheFixture(),
      'roles, scoped_roles, user_type, org_id, org_name, plan, org_type, orgs, relationships_summary'
    );
    expect(all).toEqual({
      authrim_roles: ['admin'],
      authrim_scoped_roles: [{ name: 'editor', scope: 'organization', scopeTarget: 'org-1' }],
      authrim_user_type: 'system_admin',
      authrim_org_id: 'org-1',
      authrim_org_name: 'Acme',
      authrim_plan: 'professional',
      authrim_org_type: 'enterprise',
      authrim_orgs: [{ id: 'org-1', name: 'Acme', type: 'enterprise', is_primary: true }],
      authrim_relationships_summary: {
        children_ids: ['child-1'],
        parent_ids: ['parent-1'],
      },
    });
    expect(extractIDTokenClaimsFromCache(cacheFixture(), 'none')).toEqual({});
  });

  it('omits empty optional ID-token data while retaining requested user type', () => {
    const empty = cacheFixture({
      roles: [],
      scoped_roles: [],
      organizations: [],
      org_id: null,
      org_name: null,
      plan: null,
      org_type: null,
      relationships_summary: { children_ids: [], parent_ids: [] },
    });
    expect(
      extractIDTokenClaimsFromCache(
        empty,
        'roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary'
      )
    ).toEqual({ authrim_user_type: 'system_admin' });
  });

  it('extracts configured access-token authorization data and omits empty data', () => {
    expect(
      extractAccessTokenClaimsFromCache(
        cacheFixture(),
        'roles,scoped_roles,org_id,org_type,permissions,org_context'
      )
    ).toEqual({
      authrim_roles: ['admin'],
      authrim_scoped_roles: [{ name: 'editor', scope: 'organization', scopeTarget: 'org-1' }],
      authrim_org_id: 'org-1',
      authrim_org_type: 'enterprise',
      authrim_permissions: ['users:read'],
    });
    expect(extractAccessTokenClaimsFromCache(cacheFixture(), 'none')).toEqual({});
    expect(
      extractAccessTokenClaimsFromCache(
        cacheFixture({
          roles: [],
          scoped_roles: [],
          permissions: [],
          org_id: null,
          org_type: null,
        }),
        'roles,scoped_roles,org_id,org_type,permissions'
      )
    ).toEqual({});
  });

  it.each([
    ['admin', 'system_admin'],
    ['service_account', 'end_user'],
    ['user', 'end_user'],
    [null, 'end_user'],
  ])('maps account type %s to token user type %s', async (accountType, expected) => {
    const db = adapter((sql) =>
      sql.includes('identity_accounts') && accountType ? { account_type: accountType } : null
    );
    await expect(resolveUserType(db, 'user-1', 'tenant-a')).resolves.toBe(expected);
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'user-1',
      'tenant-a',
    ]);
  });

  it('maps parent/child relationships of the subject', async () => {
    const db = adapter((sql) =>
      sql.includes('FROM relationships')
        ? [
            { relationship_type: 'parent_child', from_id: 'user-1', to_id: 'child-1' },
            { relationship_type: 'parent_child', from_id: 'parent-1', to_id: 'user-1' },
          ]
        : null
    );
    await expect(resolveRelationshipsSummary(db, 'user-1', 'tenant-a')).resolves.toEqual({
      children_ids: ['child-1'],
      parent_ids: ['parent-1'],
    });
  });

  it('skips every query when the claims configuration is none', async () => {
    const noneDb = adapter(() => {
      throw new Error('query must not run');
    });
    await expect(
      getIDTokenRBACClaimsConfigurable(
        { metadata: noneDb, account: noneDb },
        'user-1',
        'none',
        'tenant-a'
      )
    ).resolves.toEqual({});
  });

  it('serves valid ID/access token cache entries without database access', async () => {
    const db = adapter(() => {
      throw new Error('database must not be queried');
    });
    const cache = {
      get: vi.fn(async (key: string) =>
        JSON.stringify(
          key.includes(':id:') ? { authrim_roles: ['cached'] } : { authrim_org_id: 'o' }
        )
      ),
      put: vi.fn(),
    };
    await expect(
      getIDTokenRBACClaims({ metadata: db, account: db }, 'user-1', {
        cache,
        tenantId: 'tenant-a',
      } as never)
    ).resolves.toEqual({ authrim_roles: ['cached'] });
    await expect(
      getAccessTokenRBACClaims({ metadata: db, account: db }, 'user-1', {
        cache,
        tenantId: 'tenant-a',
      } as never)
    ).resolves.toEqual({ authrim_org_id: 'o' });
    expect(cache.get.mock.calls.map(([key]) => key)).toEqual([
      expect.stringContaining('rbac:tenant-a:id:user-1:'),
      expect.stringContaining('rbac:tenant-a:access:user-1:'),
    ]);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('uses a versioned composite cache entry without database access', async () => {
    const valid = cacheFixture();
    const validCache = { get: vi.fn().mockResolvedValue(JSON.stringify(valid)), put: vi.fn() };
    const db = adapter(() => {
      throw new Error('database must not be queried');
    });
    await expect(
      getCompositeRBACCache({ metadata: db, account: db }, 'user-1', {
        cache: validCache,
        tenantId: 'tenant-a',
      })
    ).resolves.toEqual(valid);
    expect(validCache.put).not.toHaveBeenCalled();
  });
});
