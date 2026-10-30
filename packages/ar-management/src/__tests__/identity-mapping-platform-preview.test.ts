import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminAuthMiddleware,
  generateVersion,
  PLATFORM_MAPPING_TENANT_ID,
  resolveAuthCorePersistenceAdapterFromEnv,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { TEST_CORE: unknown }) => env.TEST_CORE
    ),
  };
});

import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import { readPlatformIdentityMappingRelations } from '../identity-mapping-platform-followers';
import { adminPlatformIdentityMappingPreviewDefaultHandler } from '../identity-mapping-platform-preview';
import { countClientIdentityMappingChoices } from '../identity-mapping-app-choices';
import {
  GLOBAL_SUPER_ADMIN,
  TENANT_SUPER_ADMIN,
  setupApp,
  signIn,
  sqliteAdapter,
  type AdapterHooks,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';
import {
  seedDestinationProfile,
  seedMapping,
  seedMappingVersion,
} from './helpers/identity-mapping-seed';
import type { SQLiteDatabase } from './test-sqlite';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';

const KEY = 'identity_mapping.oidc_default_set_id';
const PATH = '/api/admin/platform/identity-mapping/preview-default';
const PLATFORM_DOC = 'settings:platform:identity-mapping';
const tenantDoc = (id: string) => `settings:tenant:${id}:identity-mapping`;
const databases: SQLiteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.clearAllMocks();
});

interface Preview {
  tenants: { following: number; own_default: number; opted_out: number };
  apps_affected: number;
  expected_version: string;
  by_tenant: Array<{
    tenant_id: string;
    relation: string;
    apps_following_default: number;
    claim_changes: { added: number; removed: number; renamed: number } | null;
    before_unavailable?: string;
  }>;
}

function setup(options: { agent?: boolean; single?: boolean } = {}) {
  const store = new Map<string, string>();
  const namespace = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  };
  const core = openCoreDatabase();
  const coreHooks: AdapterHooks = {};
  databases.push(core);
  for (const id of ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d', 'tenant-gone']) {
    insertTenant(core, id);
    insertOAuthClient(core, { tenantId: id, clientId: `app-${id}` });
  }
  core.exec("UPDATE tenants SET lifecycle_state='deleted' WHERE id='tenant-gone'");
  core.exec("UPDATE tenants SET lifecycle_state='suspended' WHERE id='tenant-d'");
  insertOAuthClient(core, {
    tenantId: 'tenant-a',
    clientId: 'app-own',
    identityMapping: { fieldMappingSetId: 'set-own' },
  });
  insertOAuthClient(core, {
    tenantId: 'tenant-a',
    clientId: 'app-none',
    identityMapping: { mode: 'none' },
  });
  const coreAdapter = sqliteAdapter(core, coreHooks);
  const env: Record<string, unknown> = {
    DB: coreAdapter,
    TEST_CORE: coreAdapter,
    SETTINGS: namespace,
    AUTHRIM_CONFIG: namespace,
    ...(options.single ? { DEFAULT_TENANT_ID: 'tenant-a' } : { BASE_DOMAIN: 'example.com' }),
    ISSUER_URL: 'https://id.example.com',
  };
  const context = setupApp((app) => {
    app.use(
      '/api/admin/*',
      adminAuthMiddleware({ plane: 'tenant' }),
      async (c, next) => {
        if (options.agent) {
          const auth = c as unknown as {
            get(key: 'adminAuth'): AdminAuthContext;
            set(key: 'adminAuth', value: AdminAuthContext): void;
          };
          auth.set('adminAuth', { ...auth.get('adminAuth'), actorType: 'agent' });
        }
        await next();
      },
      enforceDeclaredAdminRouteAccess()
    );
    app.post(PATH, adminPlatformIdentityMappingPreviewDefaultHandler);
  }, env);
  env.DB_ADMIN = context.adapter;
  databases.push(context.db);
  for (const id of ['old', 'new']) {
    seedMapping(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id });
    seedDestinationProfile(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id: `profile-${id}` });
  }
  store.set(PLATFORM_DOC, JSON.stringify({ [KEY]: 'set-old' }));
  store.set(tenantDoc('tenant-b'), JSON.stringify({ [KEY]: 'set-old' }));
  store.set(tenantDoc('tenant-c'), JSON.stringify({ [KEY]: 'none' }));
  const cookie = (assignments: Assignment[] = GLOBAL_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const preview = async (body: unknown = { set_id: 'set-new' }, who = cookie()) => {
    const response = await context.call(who, 'POST', PATH, body);
    return { status: response.status, json: response.json as unknown as Preview };
  };
  return {
    ...context,
    env: env as unknown as Env,
    core,
    coreAdapter,
    coreHooks,
    store,
    namespace,
    cookie,
    preview,
  };
}

describe('platform default preview with real Admin and Core SQL', () => {
  it('counts fresh following/own/none, includes suspended and excludes deleted; leaves no trace', async () => {
    const t = setup();
    const before = t.db.prepare('SELECT * FROM platform_settings_documents').all();
    const result = await t.preview();
    expect(result.status).toBe(200);
    const schemas = adminOpenApiSchemas();
    expect(schemas.IdentityMappingPlatformDefaultPreview).toBeDefined();
    expect(
      shapeErrors(schemas, schemas.IdentityMappingPlatformDefaultPreview, result.json)
    ).toEqual([]);
    expect(result.json.tenants).toEqual({ following: 2, own_default: 1, opted_out: 1 });
    expect(result.json.apps_affected).toBe(2);
    expect(result.json.by_tenant.map((r) => [r.tenant_id, r.relation])).toEqual([
      ['tenant-a', 'following'],
      ['tenant-b', 'own_default'],
      ['tenant-c', 'opted_out'],
      ['tenant-d', 'following'],
    ]);
    expect(result.json.by_tenant[0]).toMatchObject({
      apps_following_default: 1,
      claim_changes: { added: 0, removed: 0, renamed: 0 },
    });
    expect(result.json.by_tenant[1].claim_changes).toEqual({ added: 0, removed: 0, renamed: 0 });
    expect(result.json.expected_version).toBe(generateVersion({ [KEY]: 'set-old' }));
    expect(t.db.prepare('SELECT * FROM platform_settings_documents').all()).toEqual(before);
    expect(t.namespace.put).not.toHaveBeenCalled();
    expect(t.namespace.delete).not.toHaveBeenCalled();
    for (const [, , options] of vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mock.calls)
      expect(options).toMatchObject({ sideEffects: 'none' });
    expect(
      vi
        .mocked(resolveAuthCorePersistenceAdapterFromEnv)
        .mock.calls.map(([, , options]) => options?.tenantId)
        .sort()
    ).toEqual(['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d']);
    t.store.set(tenantDoc('tenant-a'), JSON.stringify({ [KEY]: 'none' }));
    expect((await t.preview()).json.tenants.following).toBe(1);
  });

  it('same effective choice affects no apps; null clear uses inherited no-default', async () => {
    const t = setup();
    const queries = vi.spyOn(t.adapter, 'query');
    const same = await t.preview({ set_id: 'set-old' });
    expect(same.status).toBe(200);
    expect(same.json.apps_affected).toBe(0);
    expect(same.json.by_tenant[0].claim_changes).toEqual({ added: 0, removed: 0, renamed: 0 });
    expect(
      queries.mock.calls.filter(([sql]) => sql.includes('aliases_json, value_type, cardinality'))
    ).toHaveLength(1);
    const clear = await t.preview({ set_id: null });
    expect(clear.status).toBe(200);
    expect(clear.json.apps_affected).toBe(2);
    expect(clear.json.by_tenant[0].claim_changes).toEqual({ added: 0, removed: 1, renamed: 0 });
  });

  it('honors single-tenant inventory and classifies a tenant explicit same set as own', async () => {
    const t = setup({ single: true });
    t.store.set(tenantDoc('tenant-a'), JSON.stringify({ [KEY]: 'set-old' }));
    const result = await t.preview();
    expect(result.status).toBe(200);
    expect(result.json.tenants).toEqual({ following: 0, own_default: 1, opted_out: 0 });
    expect(result.json.apps_affected).toBe(0);
  });

  it('shares a failed same-choice snapshot instead of accepting a later repaired reread', async () => {
    const t = setup();
    const match = /SELECT tenant_id, lifecycle_state FROM field_mapping_sets/;
    // Reference validation succeeds; the binding becomes unavailable before the content read.
    t.hooks.beforeQuery = {
      match,
      run: async () => {
        t.hooks.beforeQuery = {
          match,
          run: async () => {
            t.db.exec("UPDATE field_mapping_sets SET lifecycle_state='draft' WHERE id='set-old'");
            t.hooks.beforeQuery = {
              match,
              run: async () => {
                t.db.exec(
                  "UPDATE field_mapping_sets SET lifecycle_state='active' WHERE id='set-old'"
                );
              },
            };
          },
        };
      },
    };
    expect((await t.preview({ set_id: 'set-old' })).status).toBe(503);
    expect(
      t.db.prepare("SELECT lifecycle_state FROM field_mapping_sets WHERE id='set-old'").get()
    ).toEqual({ lifecycle_state: 'draft' });
  });

  it.each([
    'set_missing',
    'set_inactive',
    'destination_profile_invalid',
    'default_setting_invalid',
  ] as const)('allows repairing known broken before %s, with unknown differences', async (code) => {
    const t = setup();
    if (code === 'set_missing') t.store.set(PLATFORM_DOC, JSON.stringify({ [KEY]: 'set-gone' }));
    if (code === 'set_inactive')
      t.db.exec("UPDATE field_mapping_sets SET lifecycle_state='draft' WHERE id='set-old'");
    if (code === 'destination_profile_invalid')
      t.db.exec("UPDATE destination_profiles SET lifecycle_state='draft' WHERE id='profile-old'");
    if (code === 'default_setting_invalid')
      t.store.set(PLATFORM_DOC, JSON.stringify({ [KEY]: { bad: true } }));
    const result = await t.preview();
    expect(result.status).toBe(200);
    expect(result.json.by_tenant[0]).toMatchObject({
      claim_changes: null,
      before_unavailable: code,
    });
    const schemas = adminOpenApiSchemas();
    expect(
      shapeErrors(schemas, schemas.IdentityMappingPlatformDefaultPreview, result.json)
    ).toEqual([]);
    expect(result.json.by_tenant[1].claim_changes).toEqual({ added: 0, removed: 0, renamed: 0 });
  });

  it('pins runtime active version/catalog and namespace, ignoring later draft content', async () => {
    const t = setup();
    seedMappingVersion(t.db, { owner: PLATFORM_MAPPING_TENANT_ID, setSeed: 'old', id: 'draft' });
    t.db.exec(
      "UPDATE field_mapping_versions SET lifecycle_state='draft',created_at=999999 WHERE id='ver-draft'"
    );
    t.db.prepare('UPDATE mapping_rule_edges SET target_ref_json=? WHERE id=?').run(
      JSON.stringify({
        side: 'destination',
        profileId: 'profile-old',
        namespace: 'oidc.claim',
        path: 'draft_claim',
      }),
      'edge-draft-0'
    );
    // The active snapshot, not this later draft compile, supplies the catalog identity.
    t.db
      .exec(`INSERT INTO compiled_mapping_snapshots (id,tenant_id,field_mapping_version_id,catalog_version_id,snapshot_hash,lifecycle_state,compiled_at)
      VALUES ('draft-compile','platform','ver-old','catalog-new','draft-compile','draft',999999)`);
    t.db
      .prepare(
        `INSERT INTO mapping_rule_edges (id,tenant_id,rule_id,source_ref_json,target_ref_json,edge_kind,display_order,created_at,updated_at)
      VALUES ('outside','platform','rule-old',?,?,'direct',1,1,1)`
      )
      .run(
        JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'email' }),
        JSON.stringify({
          side: 'destination',
          profileId: 'profile-old',
          namespace: 'other.claim',
          path: 'hidden',
        })
      );
    const result = await t.preview({ set_id: null });
    expect(result.status).toBe(200);
    expect(result.json.by_tenant[0].claim_changes).toEqual({ added: 0, removed: 1, renamed: 0 });
  });

  it('counts a rename from the active catalog source identity and shared runtime profile', async () => {
    const t = setup();
    t.db.exec(
      "UPDATE compiled_mapping_snapshots SET catalog_version_id='catalog-old' WHERE id='snap-new'"
    );
    t.db.prepare('UPDATE mapping_rule_edges SET target_ref_json=? WHERE id=?').run(
      JSON.stringify({
        side: 'destination',
        profileId: 'profile-old',
        namespace: 'oidc.claim',
        path: 'phone',
      }),
      'edge-new-0'
    );
    t.db.prepare('UPDATE destination_profile_versions SET schema_json=? WHERE id=?').run(
      JSON.stringify({
        destinationType: 'oidc',
        claims: ['email', 'phone'].map((claimName) => ({
          claimName,
          surfaces: ['id_token', 'userinfo'],
          requiredScopes: ['email'],
          classification: 'pii',
        })),
      }),
      'profile-old-v1'
    );
    const queries = vi.spyOn(t.adapter, 'query');
    const result = await t.preview();
    expect(result.status).toBe(200);
    expect(result.json.by_tenant[0].claim_changes).toEqual({ added: 0, removed: 0, renamed: 1 });
    const catalogReads = queries.mock.calls.filter(([sql]) =>
      sql.includes('aliases_json, value_type, cardinality')
    );
    expect(catalogReads.map(([, params]) => params)).toEqual([
      ['platform', 'catalog-old'],
      ['platform', 'catalog-old'],
    ]);
  });

  it.each(['old', 'new'])('refuses a non-global active scope on %s', async (id) => {
    const t = setup();
    t.db
      .prepare('UPDATE field_mapping_activations SET activation_scope_json=? WHERE id=?')
      .run(JSON.stringify({ clientIds: ['some-app'] }), `act-${id}`);
    expect((await t.preview()).status).toBe(503);
  });

  it('refuses projection lag without repairing the KV or canonical document', async () => {
    const t = setup();
    const data = { [KEY]: 'set-new' };
    t.db
      .prepare(
        `INSERT INTO platform_settings_documents (category,document_json,version,revision,projection_state,updated_at)
      VALUES ('identity-mapping',?,?,1,'pending',1)`
      )
      .run(JSON.stringify(data), generateVersion(data));
    expect((await t.preview()).status).toBe(503);
    expect(t.namespace.put).not.toHaveBeenCalled();
    expect(t.db.prepare('SELECT projection_state FROM platform_settings_documents').get()).toEqual({
      projection_state: 'pending',
    });
  });

  it.each([null, [], {}, { set_id: 1 }, { set_id: 'none' }, { set_id: 'set-new', other: 1 }])(
    'strictly rejects malformed proposal %j',
    async (body) => {
      const t = setup();
      expect((await t.preview(body)).status).toBe(400);
      expect(resolveAuthCorePersistenceAdapterFromEnv).not.toHaveBeenCalled();
    }
  );

  it('rejects foreign and inactive proposed sets', async () => {
    const t = setup();
    seedMapping(t.db, { owner: 'tenant-a', id: 'foreign' });
    expect((await t.preview({ set_id: 'set-foreign' })).status).toBe(400);
    t.db.exec("UPDATE field_mapping_sets SET lifecycle_state='draft' WHERE id='set-new'");
    expect((await t.preview()).status).toBe(400);
  });

  it('denies tenant authority, unauthenticated requests and Agents', async () => {
    const t = setup();
    expect((await t.preview(undefined, '')).status).toBe(401);
    expect((await t.preview(undefined, t.cookie(TENANT_SUPER_ADMIN))).status).toBe(403);
    const agent = setup({ agent: true });
    expect((await agent.preview()).status).toBe(403);
  });

  it('fails closed on 101 tenants and on unreadable/invalid tenant settings', async () => {
    const t = setup();
    t.store.set(tenantDoc('tenant-a'), JSON.stringify({ [KEY]: { broken: true } }));
    expect((await t.preview()).status).toBe(503);
    t.store.delete(tenantDoc('tenant-a'));
    for (let i = 0; i < 97; i++) insertTenant(t.core, `extra-${i}`);
    expect((await t.preview()).status).toBe(503);
    expect(t.namespace.put).not.toHaveBeenCalled();
  });

  it('fails closed on Core query errors, excessive groups and oversized selector bytes', async () => {
    const t = setup();
    t.coreHooks.beforeQuery = {
      match: /GROUP BY/,
      run: async () => {
        throw new Error('read failure');
      },
    };
    expect((await t.preview()).status).toBe(503);
    insertOAuthClient(t.core, {
      tenantId: 'tenant-a',
      clientId: 'large',
      identityMapping: { fieldMappingSetId: 'x'.repeat(4096) },
    });
    expect((await t.preview()).status).toBe(503);
    t.core.prepare('DELETE FROM oauth_clients WHERE client_id=?').run('large');
    for (let i = 0; i < 101; i++)
      insertOAuthClient(t.core, {
        tenantId: 'tenant-a',
        clientId: `group-${i}`,
        identityMapping: { fieldMappingSetId: `set-${i}` },
      });
    expect((await t.preview()).status).toBe(503);
  });

  it('never treats an Admin read failure as a known broken before mapping', async () => {
    const t = setup();
    t.hooks.beforeQuery = {
      match: /SELECT tenant_id, lifecycle_state FROM field_mapping_sets/,
      run: async () => {
        throw new Error('Admin unavailable');
      },
    };
    expect((await t.preview()).status).toBe(503);
  });

  it('accepts exact group and UTF-8 byte budgets but never a partial group result', async () => {
    const t = setup();
    // Three existing groups plus 97 distinct raw selectors reaches exactly 100.
    for (let i = 0; i < 97; i++)
      insertOAuthClient(t.core, {
        tenantId: 'tenant-a',
        clientId: `bounded-${i}`,
        identityMapping: i === 0 ? 'é'.repeat(2048) : { fieldMappingSetId: `set-bounded-${i}` },
      });
    expect((await t.preview()).status).toBe(200);
    insertOAuthClient(t.core, {
      tenantId: 'tenant-a',
      clientId: 'one-over',
      identityMapping: { fieldMappingSetId: 'set-over' },
    });
    expect((await t.preview()).status).toBe(503);
  });

  it('accepts exactly 100 directory tenants before refusing a 101st', async () => {
    const t = setup();
    for (let i = 0; i < 96; i++) insertTenant(t.core, `bounded-${i}`);
    expect(await readPlatformIdentityMappingRelations(t.env)).toHaveLength(100);
    insertTenant(t.core, 'one-over');
    await expect(readPlatformIdentityMappingRelations(t.env)).rejects.toThrow('inventory_limit');
  });

  it('bounds UTF-8 bytes before returning raw selectors, and preserves the unbounded B1 behavior', async () => {
    const t = setup();
    insertOAuthClient(t.core, {
      tenantId: 'tenant-a',
      clientId: 'utf8',
      identityMapping: 'é'.repeat(3000),
    });
    await expect(
      countClientIdentityMappingChoices(t.coreAdapter, 'tenant-a', {
        maxGroups: 100,
        maxSelectorBytes: 4096,
      })
    ).rejects.toThrow('budget');
    expect((await countClientIdentityMappingChoices(t.coreAdapter, 'tenant-a')).total).toBe(4);
  });

  it('relationship recount never routes an app database, and fails on directory/tenant read errors', async () => {
    const t = setup();
    expect(await readPlatformIdentityMappingRelations(t.env)).toHaveLength(4);
    expect(resolveAuthCorePersistenceAdapterFromEnv).not.toHaveBeenCalled();
    t.coreHooks.beforeQuery = {
      match: /SELECT id FROM tenants/,
      run: async () => {
        throw new Error('unavailable');
      },
    };
    await expect(readPlatformIdentityMappingRelations(t.env)).rejects.toThrow();
    vi.mocked(t.namespace.get).mockRejectedValueOnce(new Error('KV read unavailable'));
    await expect(readPlatformIdentityMappingRelations(t.env)).rejects.toThrow();
  });
});
