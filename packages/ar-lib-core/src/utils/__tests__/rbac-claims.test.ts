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
    scoped_roles: [{ name: 'editor', scope: 'group', scopeTarget: 'group:g-1' }],
    permissions: ['users:read'],
    groups: [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }],
    user_type: 'admin',
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
      'roles, groups, permissions, scoped_roles, user_type, org_id, org_name, plan, org_type, orgs, relationships_summary'
    );
    // The organisation claim names are not claims any more: they give nothing.
    expect(all).toEqual({
      authrim_roles: ['admin'],
      authrim_groups: [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }],
      authrim_permissions: ['users:read'],
      authrim_scoped_roles: [{ name: 'editor', scope: 'group', scopeTarget: 'group:g-1' }],
      authrim_user_type: 'admin',
      authrim_relationships_summary: {
        children_ids: ['child-1'],
        parent_ids: ['parent-1'],
      },
    });
    expect(extractIDTokenClaimsFromCache(cacheFixture(), 'none')).toEqual({});
    // The defaults: roles, groups, permissions and the user type; no organisation claim.
    expect(extractIDTokenClaimsFromCache(cacheFixture())).toEqual({
      authrim_roles: ['admin'],
      authrim_groups: [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }],
      authrim_permissions: ['users:read'],
      authrim_user_type: 'admin',
    });
  });

  it('omits empty optional ID-token data while retaining requested user type', () => {
    const empty = cacheFixture({
      roles: [],
      groups: [],
      permissions: [],
      scoped_roles: [],
      relationships_summary: { children_ids: [], parent_ids: [] },
    });
    expect(
      extractIDTokenClaimsFromCache(
        empty,
        'roles,groups,permissions,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary'
      )
    ).toEqual({ authrim_user_type: 'admin' });
  });

  it('extracts configured access-token authorization data and omits empty data', () => {
    expect(
      extractAccessTokenClaimsFromCache(
        cacheFixture(),
        'roles,groups,scoped_roles,org_id,org_type,permissions,org_context'
      )
    ).toEqual({
      authrim_roles: ['admin'],
      authrim_groups: [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }],
      authrim_scoped_roles: [{ name: 'editor', scope: 'group', scopeTarget: 'group:g-1' }],
      authrim_permissions: ['users:read'],
    });
    expect(extractAccessTokenClaimsFromCache(cacheFixture(), 'none')).toEqual({});
    // The defaults: roles and groups only.
    expect(extractAccessTokenClaimsFromCache(cacheFixture())).toEqual({
      authrim_roles: ['admin'],
      authrim_groups: [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }],
    });
    expect(
      extractAccessTokenClaimsFromCache(
        cacheFixture({
          roles: [],
          groups: [],
          scoped_roles: [],
          permissions: [],
        }),
        'roles,groups,scoped_roles,permissions'
      )
    ).toEqual({});
  });

  it.each([
    ['admin', 'admin'],
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
        key.includes('-version:')
          ? null
          : JSON.stringify({
              generation: '1:0:0',
              validUntil: Math.floor(Date.now() / 1000) + 100,
              claims: key.includes(':id:')
                ? { authrim_roles: ['cached'] }
                : { authrim_groups: [{ id: 'g', key: 'g', name: 'G', kind: 'static' }] },
            })
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
    ).resolves.toEqual({ authrim_groups: [{ id: 'g', key: 'g', name: 'G', kind: 'static' }] });
    expect(cache.get.mock.calls.map(([key]) => key)).toEqual([
      'rbac:v2:tenant-version:tenant-a',
      'rbac:v2:subject-version:tenant-a:user-1',
      expect.stringContaining('rbac:v4:tenant-a:id:user-1:'),
      'rbac:v2:tenant-version:tenant-a',
      'rbac:v2:subject-version:tenant-a:user-1',
      expect.stringContaining('rbac:v4:tenant-a:access:user-1:'),
    ]);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('does not read claims cached under the earlier key generation', async () => {
    const one = adapter(() => []);
    const cache = {
      get: vi.fn(async (key: string) =>
        key.startsWith('rbac:v4:')
          ? null
          : JSON.stringify({ authrim_permissions: ['reports:write'] })
      ),
      put: vi.fn(),
    };
    await expect(
      getAccessTokenRBACClaims({ metadata: one, account: one }, 'user-1', {
        cache,
        tenantId: 'tenant-a',
        claimsConfig: 'permissions',
      } as never)
    ).resolves.toEqual({});
    expect(cache.get).toHaveBeenCalledWith(expect.stringMatching(/^rbac:v4:tenant-a:access:/));
  });

  it('uses a versioned composite cache entry without database access', async () => {
    const valid = cacheFixture();
    const validCache = {
      get: vi.fn(async (key: string) =>
        key.includes('tenant-version:')
          ? 'gen-a'
          : key.includes('subject-version:')
            ? 'gen-s'
            : JSON.stringify({
                generation: '1:gen-a:gen-s',
                validUntil: Math.floor(Date.now() / 1000) + 100,
                claims: valid,
              })
      ),
      put: vi.fn(),
    };
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
