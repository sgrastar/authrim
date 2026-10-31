import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminAuthMiddleware,
  PLATFORM_MAPPING_TENANT_ID,
  resolveAuthCorePersistenceAdapterFromEnv,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // Tenant routing is not set up here: each tenant's Core database is the one the test gives it.
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { TEST_CORES?: Record<string, unknown> }, _partition: string, options) => {
        const adapter = env.TEST_CORES?.[options?.tenantId ?? ''];
        if (!adapter) throw new Error('tenant_database_unavailable');
        return adapter;
      }
    ),
  };
});

import { enforceDeclaredAdminRouteAccess, findAdminRouteAccessRule } from '../admin-route-access';
import { adminIdentityMappingEffectiveHandler } from '../identity-mapping-effective';
import { adminPlatformIdentityMappingTenantsHandler } from '../identity-mapping-tenants';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  setupApp,
  signIn,
  sqliteAdapter,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';
import { seedDestinationProfile, seedMapping } from './helpers/identity-mapping-seed';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';

/**
 * The operator's list of every tenant's Mapping Set source and app counts, over the real admin
 * authentication and route access, the real effective-settings reader (a KV double), the real
 * Admin schema, and the real Core `tenants` directory and `oauth_clients` on SQLite.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const TENANTS = '/api/admin/platform/identity-mapping/tenants';
const EFFECTIVE = '/api/admin/identity-mapping/effective';
const PLATFORM_DOC = 'settings:platform:identity-mapping';
const tenantDoc = (tenantId: string) => `settings:tenant:${tenantId}:identity-mapping`;

/** Tenants in the directory, each with a Core database unless the test says otherwise. */
const ALL = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d', 'tenant-e'];

function setup(options: { unreadableDocs?: string[]; withoutCore?: string[] } = {}) {
  const store = new Map<string, string>();
  const namespace = {
    get: vi.fn(async (key: string) => {
      if (options.unreadableDocs?.includes(key)) throw new Error('KV is down');
      return store.get(key) ?? null;
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
  const directory = openCoreDatabase();
  for (const id of [...ALL, 'tenant-gone']) insertTenant(directory, id);
  directory.exec("UPDATE tenants SET lifecycle_state = 'deleted' WHERE id = 'tenant-gone'");
  directory.exec("UPDATE tenants SET lifecycle_state = 'suspended' WHERE id = 'tenant-e'");
  const cores = Object.fromEntries(ALL.map((id) => [id, openCoreDatabase()]));
  const adapters = Object.fromEntries(
    Object.entries(cores)
      .filter(([id]) => !options.withoutCore?.includes(id))
      .map(([id, db]) => [id, sqliteAdapter(db)])
  );

  const envExtras: Record<string, unknown> = {
    DB: sqliteAdapter(directory),
    SETTINGS: namespace,
    AUTHRIM_CONFIG: namespace,
    TEST_CORES: adapters,
    BASE_DOMAIN: 'example.com',
    ISSUER_URL: 'https://id.example.com',
  };
  const context = setupApp((app) => {
    app.use(
      '/api/admin/*',
      adminAuthMiddleware({ plane: 'tenant' }),
      enforceDeclaredAdminRouteAccess()
    );
    // A test can make the caller an Agent after the real authentication.
    app.use(TENANTS, async (c, next) => {
      const get = c as unknown as { get(k: string): any; set(k: string, v: unknown): void };
      if (c.req.header('x-test-agent')) {
        get.set('adminAuth', { ...get.get('adminAuth'), actorType: 'agent' });
      }
      await next();
    });
    app.get(TENANTS, adminPlatformIdentityMappingTenantsHandler);
    // The tenant's own view of the same tenant (the request's tenant), to compare with.
    app.get(EFFECTIVE, adminIdentityMappingEffectiveHandler);
  }, envExtras);
  // The Admin database as D1 takes it: a statement binds at most 100 parameters.
  envExtras.DB_ADMIN = bindLimited(context.adapter);
  for (const [owner, id] of [
    ['tenant-a', 'a'],
    ['tenant-b', 'b'],
    [PLATFORM_MAPPING_TENANT_ID, 'plat'],
  ] as const) {
    seedMapping(context.db, { owner, id });
    seedDestinationProfile(context.db, { owner, id: `profile-${id}` });
  }

  const save = (document: string, values: Record<string, unknown>) =>
    store.set(document, JSON.stringify(values));
  const cookie = (assignments: Assignment[] = GLOBAL_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const list = (query = '', who = cookie(), headers: Record<string, string> = {}) =>
    context.call(who, 'GET', `${TENANTS}${query}`, undefined, headers);
  const effectiveOf = (tenantId: string) =>
    context.call(cookie(), 'GET', EFFECTIVE, undefined, { 'X-Tenant-Id': tenantId });
  const app = (tenantId: string, clientId: string, identityMapping?: unknown) =>
    insertOAuthClient(cores[tenantId], { tenantId, clientId, identityMapping });
  return { ...context, directory, cores, store, save, cookie, list, effectiveOf, app };
}

/** Refuses a statement with more bound parameters than D1 allows, as D1 does. */
function bindLimited(adapter: DatabaseAdapter): DatabaseAdapter {
  const check = (params?: unknown[]) => {
    if ((params?.length ?? 0) > 100) throw new Error('D1_ERROR: too many SQL variables');
  };
  return {
    ...adapter,
    query: async (sql: string, params?: unknown[]) => (check(params), adapter.query(sql, params)),
    queryOne: async (sql: string, params?: unknown[]) => (
      check(params),
      adapter.queryOne(sql, params)
    ),
  } as DatabaseAdapter;
}

const rowOf = (json: Record<string, any>, tenantId: string) =>
  (json.tenants as Array<Record<string, any>>).find((row) => row.tenant_id === tenantId)!;

beforeEach(() => {
  vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mockClear();
});

describe('the source of each tenant', () => {
  it('is what the effective endpoint says for the tenant, for every state of its level', async () => {
    const t = setup();
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });
    // tenant-a: its own set; tenant-b: the platform's set named as its own default; tenant-c:
    // nothing (follows the platform); tenant-d: opted out; tenant-e: a value that is not a choice.
    t.save(tenantDoc('tenant-a'), { [KEY]: 'set-a' });
    t.save(tenantDoc('tenant-b'), { [KEY]: 'set-plat' });
    t.save(tenantDoc('tenant-d'), { [KEY]: 'none' });
    t.save(tenantDoc('tenant-e'), { [KEY]: '' });

    const { status, json } = await t.list();

    expect(status).toBe(200);
    for (const tenantId of ALL) {
      const effective = (await t.effectiveOf(tenantId)).json;
      const row = rowOf(json, tenantId);
      expect(row.effective, tenantId).toEqual(effective.selection);
      expect(row.tenant_default, tenantId).toEqual(effective.chain[1]);
    }
    expect(rowOf(json, 'tenant-a').effective).toMatchObject({
      kind: 'bound',
      tier: 'tenant_default',
      setId: 'set-a',
      setOwner: 'tenant',
    });
    // Named by the tenant, so it is the tenant's default, not a reference to the platform's.
    expect(rowOf(json, 'tenant-b').effective).toMatchObject({
      tier: 'tenant_default',
      setId: 'set-plat',
      setOwner: 'platform',
    });
    expect(rowOf(json, 'tenant-c').tenant_default).toEqual({
      tier: 'tenant_default',
      state: 'unset',
    });
    expect(rowOf(json, 'tenant-c').effective).toMatchObject({
      tier: 'platform_default',
      setId: 'set-plat',
    });
    expect(rowOf(json, 'tenant-d').effective).toEqual({ kind: 'none', reason: 'tenant_opt_out' });
    expect(rowOf(json, 'tenant-e').effective).toEqual({
      kind: 'failed',
      code: 'default_setting_invalid',
      tier: 'tenant_default',
    });
    expect(json.platform_default).toEqual({
      tier: 'platform_default',
      state: 'set',
      setId: 'set-plat',
      source: 'platform',
      setFound: true,
      setName: 'Set plat',
      setOwner: 'platform',
      setLifecycleState: 'active',
    });
  });

  it('tells a new tenant with no platform default apart from one that follows it', async () => {
    const t = setup();
    const before = await t.list();
    expect(rowOf(before.json, 'tenant-c').effective).toEqual({
      kind: 'none',
      reason: 'no_default',
    });
    expect(before.json.platform_default).toEqual({ tier: 'platform_default', state: 'unset' });

    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });
    const after = await t.list();
    expect(rowOf(after.json, 'tenant-c').effective).toMatchObject({
      kind: 'bound',
      tier: 'platform_default',
    });
  });

  it('reads a set another tenant owns as not found for this tenant', async () => {
    const t = setup();
    t.save(tenantDoc('tenant-c'), { [KEY]: 'set-a' });

    const { json } = await t.list();

    expect(rowOf(json, 'tenant-c').tenant_default).toEqual({
      tier: 'tenant_default',
      state: 'set',
      setId: 'set-a',
      source: 'kv',
      setFound: false,
    });
    expect(rowOf(json, 'tenant-a').tenant_default).toEqual({
      tier: 'tenant_default',
      state: 'unset',
    });
    expect(JSON.stringify(rowOf(json, 'tenant-c'))).not.toContain('Set a');
  });

  it('keeps a tenant whose settings cannot be read, with a failed selection', async () => {
    const t = setup({ unreadableDocs: [tenantDoc('tenant-b')] });
    t.save(tenantDoc('tenant-a'), { [KEY]: 'set-a' });

    const { status, json } = await t.list();

    expect(status).toBe(200);
    expect(rowOf(json, 'tenant-b')).toMatchObject({
      tenant_default: null,
      effective: { kind: 'failed', code: 'settings_unreadable' },
    });
    expect(rowOf(json, 'tenant-a').effective).toMatchObject({ setId: 'set-a' });
  });

  it('is 503 when the platform settings cannot be read', async () => {
    const t = setup({ unreadableDocs: [PLATFORM_DOC] });
    expect((await t.list()).status).toBe(503);
  });
});

describe('the apps of each tenant', () => {
  it('counts each way of choosing with the selection’s reading of the stored value', async () => {
    const t = setup();
    t.app('tenant-a', 'no-row-value');
    t.app('tenant-a', 'empty-object', {});
    t.app('tenant-a', 'blank', '  ');
    t.app('tenant-a', 'own-set', { fieldMappingSetId: 'set-a' });
    t.app('tenant-a', 'older-spelling', { policySetId: 'set-a' });
    t.app('tenant-a', 'opted-out', { mode: 'none' });
    t.app('tenant-a', 'legacy', { destinationProfileId: 'profile-a' });
    t.app('tenant-a', 'unknown-mode', { mode: 'all' });
    t.app('tenant-a', 'mode-and-set', { mode: 'none', fieldMappingSetId: 'set-a' });
    t.app('tenant-a', 'not-json', '{"fieldMappingSetId":');
    t.app('tenant-a', 'padded-id', { fieldMappingSetId: ' set-a' });
    // Another tenant's row in the same database is not this tenant's app.
    t.app('tenant-a', 'stray', { fieldMappingSetId: 'set-b' });
    t.cores['tenant-a'].exec(
      "UPDATE oauth_clients SET tenant_id = 'tenant-b' WHERE client_id = 'stray'"
    );
    t.app('tenant-b', 'b-1');

    const { json } = await t.list();

    expect(rowOf(json, 'tenant-a').apps).toEqual({
      total: 11,
      following_default: 3,
      own_set: 2,
      opted_out: 1,
      unusable: 5,
    });
    expect(rowOf(json, 'tenant-b').apps).toEqual({
      total: 1,
      following_default: 1,
      own_set: 0,
      opted_out: 0,
      unusable: 0,
    });
    expect(rowOf(json, 'tenant-c').apps).toEqual({
      total: 0,
      following_default: 0,
      own_set: 0,
      opted_out: 0,
      unusable: 0,
    });
  });

  it('keeps a tenant whose apps cannot be counted, saying why', async () => {
    const t = setup({ withoutCore: ['tenant-c'] });
    t.save(tenantDoc('tenant-c'), { [KEY]: 'none' });

    const { status, json } = await t.list();

    expect(status).toBe(200);
    expect(rowOf(json, 'tenant-c')).toMatchObject({
      apps: null,
      apps_unavailable: 'core_database_unavailable',
      effective: { kind: 'none', reason: 'tenant_opt_out' },
    });
    expect(rowOf(json, 'tenant-b').apps).toMatchObject({ total: 0 });
  });

  it('says the query failed when the Core database cannot be read', async () => {
    const t = setup();
    t.cores['tenant-d'].exec('DROP TABLE oauth_clients');

    const { json } = await t.list();

    expect(rowOf(json, 'tenant-d')).toMatchObject({ apps: null, apps_unavailable: 'query_failed' });
  });

  it('looks at a tenant without leaving a trace', async () => {
    const t = setup();
    await t.list();
    for (const call of vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mock.calls) {
      expect(call[2]).toMatchObject({ sideEffects: 'none' });
    }
  });
});

describe('what an answer holds', () => {
  it('has only the listed keys, and nothing of an app', async () => {
    const t = setup();
    t.save(tenantDoc('tenant-a'), { [KEY]: 'set-a' });
    t.app('tenant-a', 'secret-client-name', { fieldMappingSetId: 'set-a' });

    const { json } = await t.list();

    expect(Object.keys(json).sort()).toEqual([
      'generated_at',
      'next_cursor',
      'platform_default',
      'tenants',
    ]);
    for (const row of json.tenants as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual([
        'apps',
        'display_name',
        'effective',
        'lifecycle_state',
        'tenant_default',
        'tenant_id',
      ]);
    }
    expect(rowOf(json, 'tenant-a')).toMatchObject({
      display_name: 'Tenant tenant-a',
      lifecycle_state: 'active',
    });
    expect(rowOf(json, 'tenant-e').lifecycle_state).toBe('suspended');
    expect(JSON.stringify(json)).not.toContain('secret-client-name');
    expect(new Date(json.generated_at).toString()).not.toBe('Invalid Date');
  });

  it('is the documented shape, for every kind of row', async () => {
    const t = setup({ unreadableDocs: [tenantDoc('tenant-b')], withoutCore: ['tenant-d'] });
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });
    t.save(tenantDoc('tenant-a'), { [KEY]: 'set-a' });
    t.save(tenantDoc('tenant-c'), { [KEY]: 'none' });
    t.save(tenantDoc('tenant-e'), { [KEY]: '' });
    t.app('tenant-a', 'app-1');
    const schemas = adminOpenApiSchemas();
    const schema = schemas.IdentityMappingPlatformTenantsResponse;

    const { json } = await t.list('?limit=4');

    expect(schema).toBeDefined();
    expect(json.next_cursor).toEqual(expect.any(String));
    // Bound, settings unreadable, opted out, apps not counted.
    expect(shapeErrors(schemas, schema, json)).toEqual([]);
    const last = await t.list(`?cursor=${json.next_cursor}`);
    // A default that is not a choice, and the last page.
    expect(rowOf(last.json, 'tenant-e').effective.kind).toBe('failed');
    expect(shapeErrors(schemas, schema, last.json)).toEqual([]);
    // The check itself catches an undocumented key and an unknown code.
    const broken = structuredClone(json);
    broken.tenants[0].secret = 'x';
    broken.tenants[1].effective.code = 'boom';
    expect(shapeErrors(schemas, schema, broken)).toHaveLength(2);
  });

  it('leaves out a deleted tenant', async () => {
    const t = setup();
    const { json } = await t.list();
    expect(json.tenants.map((row: { tenant_id: string }) => row.tenant_id)).toEqual(ALL);
  });
});

describe('pages', () => {
  it('walks every tenant once, in order, page by page', async () => {
    const t = setup();
    const seen: string[] = [];
    let query = '?limit=2';
    for (let pages = 0; pages < 5; pages += 1) {
      const { status, json } = await t.list(query);
      expect(status).toBe(200);
      seen.push(...json.tenants.map((row: { tenant_id: string }) => row.tenant_id));
      if (!json.next_cursor) break;
      expect(json.tenants).toHaveLength(2);
      query = `?limit=2&cursor=${json.next_cursor}`;
    }
    expect(seen).toEqual(ALL);
  });

  it('names the sets of a full page, more than one statement can bind', async () => {
    const t = setup();
    const many = Array.from(
      { length: 101 },
      (_, index) => `tenant-x${String(index).padStart(3, '0')}`
    );
    for (const id of many) {
      insertTenant(t.directory, id);
      seedMapping(t.db, { owner: id, id: id.replace('tenant-', '') });
      t.save(tenantDoc(id), { [KEY]: `set-${id.replace('tenant-', '')}` });
    }
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });
    // The page after the setup's five tenants: x000 to x099, each with its own set, and the
    // platform's, so 101 set IDs.
    const after = Buffer.from('tenant-e').toString('base64url');

    const { status, json } = await t.list(`?limit=100&cursor=${after}`);

    expect(status).toBe(200);
    expect(json.tenants).toHaveLength(100);
    expect(json.tenants[0].tenant_id).toBe('tenant-x000');
    expect(json.platform_default).toMatchObject({ setFound: true, setName: 'Set plat' });
    for (const row of json.tenants) {
      expect(row.effective, row.tenant_id).toMatchObject({
        setFound: true,
        setOwner: 'tenant',
        setName: `Set ${row.tenant_id.replace('tenant-', '')}`,
      });
    }
  });

  it('gives no next cursor on the last page', async () => {
    const t = setup();
    const { json } = await t.list('?limit=5');
    expect(json.tenants).toHaveLength(5);
    expect(json.next_cursor).toBeNull();
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=abc',
    '?limit=1.5',
    '?cursor=%25%25',
    '?cursor=SGVsbG8gV29ybGQ',
  ])('is 400 for %s', async (query) => {
    const t = setup();
    expect((await t.list(query)).status).toBe(400);
  });
});

describe('who may see every tenant', () => {
  it('is a platform administrator through a global assignment', async () => {
    const t = setup();
    expect((await t.list('', t.cookie(GLOBAL_SUPER_ADMIN))).status).toBe(200);
  });

  it('includes a global viewer, who holds the settings read for every tenant', async () => {
    const t = setup();
    expect((await t.list('', t.cookie(GLOBAL_VIEWER_TENANT_SUPER_ADMIN))).status).toBe(200);
  });

  it.each([
    ['a super admin of one tenant', TENANT_SUPER_ADMIN],
    ['an admin of one tenant', [{ role: 'role_ar_tenant_admin', scope: 'tenant' }] as Assignment[]],
  ])('is not %s', async (_name, assignments) => {
    const t = setup();
    const response = await t.list('', t.cookie(assignments));
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.json)).not.toContain('tenant-b');
  });

  it('is not an Agent, whatever it holds', async () => {
    const t = setup();
    const response = await t.list('', t.cookie(GLOBAL_SUPER_ADMIN), { 'x-test-agent': '1' });
    expect(response.status).toBe(403);
  });

  it('is declared for GET only', () => {
    expect(findAdminRouteAccessRule('GET', TENANTS)).toMatchObject({
      permissions: ['admin:settings:read'],
    });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(findAdminRouteAccessRule(method, TENANTS), method).toBeNull();
    }
  });
});
