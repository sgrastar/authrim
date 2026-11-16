import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ coreAdapter: undefined as DatabaseAdapter | undefined }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveOptionalCoreAdapterFromHono: vi.fn(() => mocks.coreAdapter),
    createAuditLogFromContext: vi.fn(async () => undefined),
    // Tenant routing is not set up here: each tenant's Core database is the one the test gives it.
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (
        env: { TEST_CORES?: Record<string, unknown> },
        _partition: string,
        options?: { tenantId?: string }
      ) => {
        const adapter = env.TEST_CORES?.[options?.tenantId ?? ''];
        if (!adapter) throw new Error('tenant_database_unavailable');
        return adapter;
      }
    ),
  };
});

import {
  createTenantDomainMappingHandler,
  deleteTenantDomainMappingHandler,
  getTenantDomainMappingHandler,
  initiateTenantDomainVerificationHandler,
  listTenantDomainMappingsHandler,
  updateTenantDomainMappingHandler,
} from '../admin-tenant-domain-mappings';
import { adminPlatformIdentityMappingTenantsHandler } from '../identity-mapping-tenants';
import {
  cleanupPlatformTombstones,
  deletePlatformTombstone,
  getPlatformTombstone,
  listPlatformTombstones,
} from '../routes/settings/tombstones';
import { setupApp, sqliteAdapter } from './helpers/admin-authority-fixture';
import { insertTenant, openCoreDatabase } from './helpers/core-database';

/**
 * Handlers that take their target tenant from somewhere other than the request tenant and the
 * path (a query value, a body field, a stored row, a cross-tenant list) call the shared helper
 * themselves. They run here WITHOUT the authentication middleware's own check (a stand-in only
 * sets the caller), so it is the handler that decides.
 */

const PROTECTED = 'tenant-b';

const MACHINE = {
  userId: 'amp_auto',
  actorId: 'amp_auto',
  actorType: 'machine',
  authMethod: 'machine_access_token',
  principalType: 'automation',
  clientId: 'auto-client',
  roles: [],
  permissions: ['*'],
  globalPermissions: ['*'],
  tenantScope: ['*'],
  tenantScopeExplicit: [] as string[],
  tenantId: 'tenant-a',
};
const caller = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...MACHINE, ...overrides });
const PLATFORM_TOOL = {
  principalType: 'setup_tool',
  actorId: 'amp_authrim_setup',
  userId: 'amp_authrim_setup',
};
const HUMAN = {
  authMethod: 'session',
  actorType: 'human',
  principalType: undefined,
  actorId: undefined,
};

function build(
  mount: (app: import('hono').Hono<{ Bindings: never }>) => void,
  env: Record<string, unknown>
) {
  const core = openCoreDatabase();
  for (const id of ['tenant-a', PROTECTED, 'tenant-c', 'tenant-d']) insertTenant(core, id);

  for (const [id, tenant] of [
    ['m-a', 'tenant-a'],
    ['m-b', PROTECTED],
    ['m-c', 'tenant-c'],
  ]) {
    core
      .prepare(
        `INSERT INTO tenant_domain_mappings (id, domain_hash, hash_version, tenant_id, priority, is_active, verified, created_at, updated_at)
         VALUES (?, ?, 2, ?, 10, 1, 0, 1, 1)`
      )
      .run(id, `hash-${id}`, tenant);
  }
  mocks.coreAdapter = sqliteAdapter(core);
  const context = setupApp(
    (app) => {
      app.use('*', async (c, next) => {
        const raw = c.req.header('x-test-caller');
        if (raw)
          (c as unknown as { set(k: string, v: unknown): void }).set('adminAuth', JSON.parse(raw));
        await next();
      });
      mount(app as never);
    },
    { DB: sqliteAdapter(core), ...env }
  );
  return { ...context, core };
}

const json = { 'content-type': 'application/json' };
const protect = { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: PROTECTED };

describe('tenant domain mappings', () => {
  const mount = (app: import('hono').Hono<{ Bindings: never }>) => {
    const h = app as unknown as import('hono').Hono;
    h.get('/m', listTenantDomainMappingsHandler as never);
    h.post('/m', createTenantDomainMappingHandler as never);
    h.get('/m/:id', getTenantDomainMappingHandler as never);
    h.put('/m/:id', updateTenantDomainMappingHandler as never);
    h.delete('/m/:id', deleteTenantDomainMappingHandler as never);
    h.post('/m-verify', initiateTenantDomainVerificationHandler as never);
  };

  beforeEach(() => vi.clearAllMocks());

  it('creates nothing for a protected tenant named in the body', async () => {
    const t = build(mount, protect);
    const response = await t.callWithToken(
      'x',
      'POST',
      '/m',
      { domain: 'example.com', tenant_id: PROTECTED },
      {
        ...json,
        'x-test-caller': caller(),
      }
    );
    expect(response.status).toBe(403);
    expect(response.json.error).toBe('access_denied');
    expect(t.core.prepare('SELECT COUNT(*) AS n FROM tenant_domain_mappings').get()).toEqual({
      n: 3,
    });
  });

  it('judges a stored row by the tenant it belongs to: read, change, delete, verify', async () => {
    const t = build(mount, protect);
    const headers = { ...json, 'x-test-caller': caller() };
    for (const [method, path, body] of [
      ['GET', '/m/m-b', undefined],
      ['PUT', '/m/m-b', { priority: 1 }],
      ['DELETE', '/m/m-b', undefined],
      ['POST', '/m-verify', { id: 'm-b', domain: 'example.com' }],
    ] as const) {
      const response = await t.callWithToken('x', method, path, body, headers);
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(
      t.core.prepare("SELECT COUNT(*) AS n FROM tenant_domain_mappings WHERE id = 'm-b'").get()
    ).toEqual({ n: 1 });
    // An unprotected row is as before.
    expect((await t.callWithToken('x', 'GET', '/m/m-a', undefined, headers)).status).toBe(200);
  });

  it('filters a list to what the caller reaches, the total with it', async () => {
    const t = build(mount, protect);
    const list = await t.callWithToken('x', 'GET', '/m', undefined, {
      ...json,
      'x-test-caller': caller(),
    });
    expect(list.status).toBe(200);
    expect(
      (list.json.mappings as Array<{ tenant_id: string }>).map((row) => row.tenant_id).sort()
    ).toEqual(['tenant-a', 'tenant-c']);
    expect(list.json.total).toBe(2);
  });

  it('keeps the total and the pages right: the exclusion is in the query, for the count and the page', async () => {
    const t = build(mount, protect);
    const headers = { ...json, 'x-test-caller': caller() };
    const page = async (query: string) =>
      (await t.callWithToken('x', 'GET', `/m${query}`, undefined, headers)).json as {
        mappings: Array<{ tenant_id: string }>;
        total: number;
      };
    const first = await page('?limit=1&offset=0');
    const second = await page('?limit=1&offset=1');
    const past = await page('?limit=1&offset=5');
    const filtered = await page('?verified=false&limit=50');
    expect([first, second].map((p) => p.mappings.map((row) => row.tenant_id))).toEqual([
      ['tenant-a'],
      ['tenant-c'],
    ]);
    // The total is the same on every page, and an offset past the end does not reveal a larger one.
    expect([first.total, second.total, past.total, filtered.total]).toEqual([2, 2, 2, 2]);
    expect(past.mappings).toEqual([]);
    // A page that would have been only hidden rows is not empty: tenant-b sits between a and c.
    expect((await page('?limit=2')).mappings).toHaveLength(2);
  });

  it.each([
    ['the setup principal', PLATFORM_TOOL],
    ['a human', HUMAN],
    ['a token that names the tenant', { tenantScopeExplicit: [PROTECTED] }],
  ])('is not limited for %s', async (_name, overrides) => {
    const t = build(mount, protect);
    const list = await t.callWithToken('x', 'GET', '/m', undefined, {
      ...json,
      'x-test-caller': caller(overrides),
    });
    expect(list.json.mappings).toHaveLength(3);
    expect(
      (
        await t.callWithToken('x', 'GET', '/m/m-b', undefined, {
          ...json,
          'x-test-caller': caller(overrides),
        })
      ).status
    ).toBe(200);
  });
});

describe('tombstones across tenants', () => {
  const mount = (app: import('hono').Hono<{ Bindings: never }>) => {
    const h = app as unknown as import('hono').Hono;
    h.get('/t', listPlatformTombstones as never);
    h.get('/t/:id', getPlatformTombstone as never);
    h.delete('/t/:id', deletePlatformTombstone as never);
    h.post('/t-cleanup', cleanupPlatformTombstones as never);
  };

  it.each([
    ['list by query', 'GET', `/t?tenant_id=${PROTECTED}`, undefined],
    ['get by query', 'GET', `/t/x?tenant_id=${PROTECTED}`, undefined],
    ['delete by query', 'DELETE', `/t/x?tenant_id=${PROTECTED}`, undefined],
    ['cleanup by body', 'POST', '/t-cleanup', { tenant_id: PROTECTED }],
  ])('refuses %s of a protected tenant', async (_name, method, path, body) => {
    const t = build(mount, protect);
    const response = await t.callWithToken('x', method, path, body, {
      ...json,
      'x-test-caller': caller(),
      'content-type': 'application/json',
    });
    expect(response.status).toBe(403);
    expect(response.json.error).toBe('access_denied');
  });

  it('does not refuse an unprotected tenant, or the setup principal on a protected one', async () => {
    const t = build(mount, protect);
    const other = await t.callWithToken('x', 'GET', '/t?tenant_id=tenant-c', undefined, {
      'x-test-caller': caller(),
    });
    expect(other.status).not.toBe(403);
    const tool = await t.callWithToken('x', 'GET', `/t?tenant_id=${PROTECTED}`, undefined, {
      'x-test-caller': caller(PLATFORM_TOOL),
    });
    expect(tool.status).not.toBe(403);
  });
});

describe('the list of every tenant’s mapping settings', () => {
  const PATH = '/platform/identity-mapping/tenants';
  const mount = (app: import('hono').Hono<{ Bindings: never }>) => {
    (app as unknown as import('hono').Hono).get(
      PATH,
      adminPlatformIdentityMappingTenantsHandler as never
    );
  };
  const env = (extra: Record<string, unknown> = {}) => {
    const cores = Object.fromEntries(
      ['tenant-a', PROTECTED, 'tenant-c', 'tenant-d'].map((id) => {
        const db = openCoreDatabase();
        insertTenant(db, id);
        return [id, sqliteAdapter(db)];
      })
    );
    return {
      TEST_CORES: cores,
      SETTINGS: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
        list: async () => ({ keys: [], list_complete: true }),
      },
      BASE_DOMAIN: 'example.com',
      ...extra,
    };
  };
  const ids = (json: Record<string, unknown>) =>
    (json.tenants as Array<{ tenant_id: string }>).map((row) => row.tenant_id);
  const headers = (overrides: Record<string, unknown> = {}) => ({
    'x-test-caller': caller({
      permissions: ['admin:settings:read'],
      globalPermissions: ['admin:settings:read'],
      ...overrides,
    }),
  });

  it('leaves a protected tenant out and keeps the pages and the cursor right', async () => {
    const t = build(mount, env(protect));
    const first = await t.callWithToken('x', 'GET', `${PATH}?limit=1`, undefined, headers());
    expect(first.status).toBe(200);
    expect(ids(first.json)).toEqual(['tenant-a']);
    const second = await t.callWithToken(
      'x',
      'GET',
      `${PATH}?limit=1&cursor=${first.json.next_cursor as string}`,
      undefined,
      headers()
    );
    expect(ids(second.json)).toEqual(['tenant-c']);
    const rest = await t.callWithToken(
      'x',
      'GET',
      `${PATH}?limit=5&cursor=${second.json.next_cursor as string}`,
      undefined,
      headers()
    );
    expect(ids(rest.json)).toEqual(['tenant-d']);
    expect(rest.json.next_cursor).toBeNull();
  });

  it('lists every tenant for the setup principal, a human and a token that names the tenant', async () => {
    const t = build(mount, env(protect));
    for (const overrides of [PLATFORM_TOOL, HUMAN, { tenantScopeExplicit: [PROTECTED] }]) {
      const all = await t.callWithToken(
        'x',
        'GET',
        `${PATH}?limit=10`,
        undefined,
        headers(overrides)
      );
      expect(ids(all.json)).toEqual(['tenant-a', PROTECTED, 'tenant-c', 'tenant-d']);
    }
  });

  it('lists nothing but the named tenants while the setting is not valid', async () => {
    const t = build(mount, env({ MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: 'NOT VALID' }));
    const none = await t.callWithToken('x', 'GET', `${PATH}?limit=10`, undefined, headers());
    expect(ids(none.json)).toEqual([]);
    const named = await t.callWithToken(
      'x',
      'GET',
      `${PATH}?limit=10`,
      undefined,
      headers({ tenantScopeExplicit: ['tenant-c'] })
    );
    expect(ids(named.json)).toEqual(['tenant-c']);
  });
});

export type _Unused = DatabaseAdapter;
