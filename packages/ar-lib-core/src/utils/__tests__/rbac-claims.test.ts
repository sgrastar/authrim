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
    const db = adapter();
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

  it('resolves tenant-scoped roles and organization data with stable mappings', async () => {
    const db = adapter((sql) => {
      if (sql.includes('SELECT DISTINCT r.name')) return [{ name: 'admin' }, { name: 'viewer' }];
      if (sql.includes('o.id as org_id'))
        return { org_id: 'org-1', plan: 'professional', org_type: 'enterprise' };
      if (sql.includes('SELECT o.name')) return { name: 'Acme' };
      if (sql.includes('SELECT o.id, o.name'))
        return [
          { id: 'org-1', name: 'Acme', org_type: 'enterprise', is_primary: 1 },
          { id: 'org-2', name: 'Lab', org_type: 'community', is_primary: 0 },
        ];
      return null;
    });
    await expect(resolveEffectiveRoles(db, 'user-1', 'tenant-a')).resolves.toEqual([
      'admin',
      'viewer',
    ]);
    await expect(resolveOrganizationInfo(db, 'user-1', 'tenant-a')).resolves.toEqual({
      org_id: 'org-1',
      plan: 'professional',
      org_type: 'enterprise',
    });
    await expect(resolveOrganizationName(db, 'user-1', 'tenant-a')).resolves.toBe('Acme');
    await expect(resolveAllOrganizations(db, 'user-1', 'tenant-a')).resolves.toEqual([
      { id: 'org-1', name: 'Acme', type: 'enterprise', is_primary: true },
      { id: 'org-2', name: 'Lab', type: 'community', is_primary: false },
    ]);
    for (const call of vi.mocked(db.query).mock.calls) expect(call[1]).toContain('tenant-a');
    for (const call of vi.mocked(db.queryOne).mock.calls) expect(call[1]).toContain('tenant-a');
  });

  it('returns null organization values when no primary organization exists', async () => {
    const db = adapter();
    await expect(resolveOrganizationInfo(db, 'user-1', 'tenant-a')).resolves.toBeNull();
    await expect(resolveOrganizationName(db, 'user-1', 'tenant-a')).resolves.toBeNull();
  });

  it.each([
    ['admin', 'system_admin'],
    ['service_account', 'end_user'],
    ['anonymous', 'anonymous'],
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

  it('maps scoped roles, relationships, and sorted de-duplicated permissions', async () => {
    const db = adapter((sql) => {
      if (sql.includes('scope_type'))
        return [
          { name: 'global-admin', scope_type: 'global', scope_target: '' },
          { name: 'org-editor', scope_type: 'organization', scope_target: 'org-1' },
        ];
      if (sql.includes('FROM relationships'))
        return [
          { relationship_type: 'parent_child', from_id: 'user-1', to_id: 'child-1' },
          { relationship_type: 'parent_child', from_id: 'parent-1', to_id: 'user-1' },
        ];
      if (sql.includes('permissions_json'))
        return [
          { permissions_json: '["users:write","users:read"]' },
          { permissions_json: '["users:read"]' },
          { permissions_json: '{' },
        ];
      return null;
    });
    await expect(resolveScopedRoles(db, 'user-1', 'tenant-a')).resolves.toEqual([
      { name: 'global-admin', scope: 'global' },
      { name: 'org-editor', scope: 'organization', scopeTarget: 'org-1' },
    ]);
    await expect(resolveRelationshipsSummary(db, 'user-1', 'tenant-a')).resolves.toEqual({
      children_ids: ['child-1'],
      parent_ids: ['parent-1'],
    });
    await expect(resolvePermissions(db, 'user-1', 'tenant-a')).resolves.toEqual([
      'users:read',
      'users:write',
    ]);
  });

  it('builds full user claims but omits absent roles and organization', async () => {
    const populated = adapter((sql) => {
      if (sql.includes('SELECT DISTINCT r.name')) return [{ name: 'admin' }];
      if (sql.includes('o.id as org_id'))
        return { org_id: 'org-1', plan: 'free', org_type: 'enterprise' };
      if (sql.includes('identity_accounts')) return { account_type: 'admin' };
      return null;
    });
    await expect(getUserRBACClaims(populated, 'user-1', 'tenant-a')).resolves.toEqual({
      authrim_roles: ['admin'],
      authrim_user_type: 'system_admin',
      authrim_org_id: 'org-1',
      authrim_plan: 'free',
      authrim_org_type: 'enterprise',
    });
    await expect(getUserRBACClaims(adapter(), 'user-1', 'tenant-a')).resolves.toEqual({
      authrim_user_type: 'end_user',
    });
  });

  it('honors configurable ID-token claims and skips all queries for none', async () => {
    const noneDb = adapter(() => {
      throw new Error('query must not run');
    });
    await expect(
      getIDTokenRBACClaimsConfigurable(noneDb, 'user-1', 'none', 'tenant-a')
    ).resolves.toEqual({});

    const db = adapter((sql) => {
      if (sql.includes('SELECT DISTINCT r.name')) return [{ name: 'admin' }];
      if (sql.includes('scope_type'))
        return [{ name: 'editor', scope_type: 'organization', scope_target: 'org-1' }];
      if (sql.includes('identity_accounts')) return { account_type: 'anonymous' };
      if (sql.includes('o.id as org_id'))
        return { org_id: 'org-1', plan: 'free', org_type: 'enterprise' };
      if (sql.includes('SELECT o.name')) return { name: 'Acme' };
      if (sql.includes('SELECT o.id, o.name'))
        return [{ id: 'org-1', name: 'Acme', org_type: 'enterprise', is_primary: 1 }];
      if (sql.includes('FROM relationships'))
        return [{ relationship_type: 'parent_child', from_id: 'user-1', to_id: 'child-1' }];
      return null;
    });
    await expect(
      getIDTokenRBACClaimsConfigurable(
        db,
        'user-1',
        'roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary',
        'tenant-a'
      )
    ).resolves.toMatchObject({
      authrim_roles: ['admin'],
      authrim_user_type: 'anonymous',
      authrim_org_id: 'org-1',
      authrim_org_name: 'Acme',
      authrim_relationships_summary: { children_ids: ['child-1'], parent_ids: [] },
    });
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
      getIDTokenRBACClaims(db, 'user-1', { cache, tenantId: 'tenant-a' } as never)
    ).resolves.toEqual({ authrim_roles: ['cached'] });
    await expect(
      getAccessTokenRBACClaims(db, 'user-1', { cache, tenantId: 'tenant-a' } as never)
    ).resolves.toEqual({ authrim_org_id: 'o' });
    expect(cache.get.mock.calls.map(([key]) => key)).toEqual([
      expect.stringContaining('rbac:tenant-a:id:user-1:'),
      expect.stringContaining('rbac:tenant-a:access:user-1:'),
    ]);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('recovers from cache read errors and stores tenant-scoped computed claims', async () => {
    const db = adapter((sql) => {
      if (sql.includes('SELECT DISTINCT r.name')) return [{ name: 'admin' }];
      if (sql.includes('permissions_json')) return [{ permissions_json: '["users:read"]' }];
      return null;
    });
    const cache = { get: vi.fn().mockRejectedValue(new Error('KV down')), put: vi.fn() };
    await expect(
      getAccessTokenRBACClaims(db, 'user-1', {
        cache,
        tenantId: 'tenant-a',
        claimsConfig: 'roles,permissions',
      } as never)
    ).resolves.toEqual({ authrim_roles: ['admin'], authrim_permissions: ['users:read'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.put).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledWith(
      expect.stringContaining('rbac:tenant-a:access:user-1:'),
      JSON.stringify({ authrim_roles: ['admin'], authrim_permissions: ['users:read'] }),
      { expirationTtl: 600 }
    );
  });

  it('uses and refreshes versioned composite caches', async () => {
    const valid = cacheFixture();
    const validCache = { get: vi.fn().mockResolvedValue(JSON.stringify(valid)), put: vi.fn() };
    await expect(
      getCompositeRBACCache(adapter(), 'user-1', {
        cache: validCache,
        tenantId: 'tenant-a',
      })
    ).resolves.toEqual(valid);
    expect(validCache.put).not.toHaveBeenCalled();

    const db = adapter((sql) => {
      if (sql.includes('SELECT DISTINCT r.name')) return [{ name: 'admin' }];
      if (sql.includes('identity_accounts')) return { account_type: 'admin' };
      return null;
    });
    const staleCache = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ ...valid, version: 99 })),
      put: vi.fn(),
    };
    const refreshed = await getCompositeRBACCache(db, 'user-1', {
      cache: staleCache,
      tenantId: 'tenant-a',
    });
    expect(refreshed).toMatchObject({ version: 1, roles: ['admin'], user_type: 'system_admin' });
    await vi.advanceTimersByTimeAsync(0);
    expect(staleCache.put).toHaveBeenCalledOnce();
  });
});
