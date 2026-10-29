import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  adminAuthMiddleware,
  applyOIDCIdentityMapping,
  loadMappingBindingBySetId,
  PLATFORM_MAPPING_TENANT_ID,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  adminIdentityMappingDestinationProfileActivateHandler,
  adminIdentityMappingDestinationProfileCreateHandler,
  adminIdentityMappingDestinationProfileDeleteHandler,
  adminIdentityMappingDestinationProfileReviewHandler,
  adminIdentityMappingDestinationProfileUpdateHandler,
  adminIdentityFieldMappingSetCreateHandler,
  adminIdentityFieldMappingSetDeleteHandler,
  adminIdentityFieldMappingSetRollbackHandler,
  adminIdentityFieldMappingSetsListHandler,
  adminIdentityFieldMappingVersionActivateHandler,
  adminIdentityFieldMappingVersionCompileHandler,
  adminIdentityFieldMappingVersionCreateHandler,
  adminIdentityFieldMappingVersionDeactivateHandler,
  adminIdentityFieldMappingVersionPublishHandler,
  adminIdentityFieldMappingVersionsListHandler,
  IdentityMappingControlPlaneRepository,
} from '../identity-mapping-control-plane';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { insertTenant, openCoreDatabase } from './helpers/core-database';

// Tenant routing is not set up in this test: every tenant's Core database is the one of the test.
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async (env: { TEST_CORE?: unknown }) => {
      return env.TEST_CORE as DatabaseAdapter;
    }),
  };
});

/**
 * The platform's Mapping Sets through the Admin API, on the real Admin schema: what a platform
 * admin can build, what a tenant admin can and cannot touch, and that the result is readable from
 * another tenant's context. Mocks that ignore the SQL cannot tell which tenant ID each query runs
 * under, so this runs the control plane's own SQL on SQLite.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const PLATFORM_CATALOG_VERSION = 'platform_default_canonical_catalog_v1';

function openAdminDatabase(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/admin/d1/001_0_4_0_admin_baseline.sql'), 'utf8')
      .replaceAll(
        '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
        "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)"
      )
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  db.exec(
    readFileSync(
      resolve(REPO_ROOT, 'migrations/admin/d1/054_admin_roles_ar_prefix.sql'),
      'utf8'
    ).replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
  );
  // The settings documents the reference search reads (the default Mapping Set lives there).
  for (const file of [
    '028_tenant_settings_documents.sql',
    '038_tenant_settings_reconciled_at.sql',
    '039_platform_settings_documents.sql',
    '040_settings_legacy_import_state.sql',
  ]) {
    db.exec(readFileSync(resolve(REPO_ROOT, `migrations/admin/d1/${file}`), 'utf8'));
  }
  return db;
}

function sqliteAdapter(db: SQLiteDatabase): DatabaseAdapter {
  const bind = (params: unknown[] = []) => params.map((value) => (value ?? null) as SQLInputValue);
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...bind(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...bind(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      const result = db.prepare(sql).run(...bind(params));
      return { rowsAffected: Number(result.changes), success: true };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      db.exec('BEGIN');
      try {
        const result = await fn(adapter);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      return Promise.all(statements.map((item) => adapter.execute(item.sql, item.params)));
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 1, type: 'sqlite' };
    },
    getType: () => 'sqlite',
    async close() {},
  };
  return adapter as unknown as DatabaseAdapter;
}

/** The platform catalog as the migration seeds it. */
function seedPlatformCatalog(db: SQLiteDatabase): void {
  db.exec(
    readFileSync(
      resolve(REPO_ROOT, 'migrations/admin/d1/041_platform_default_canonical_catalog.sql'),
      'utf8'
    ).replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
  );
}

interface Actor {
  tenant: string;
  /** What the admin-auth middleware puts in the context for this caller. */
  auth?: Record<string, unknown>;
  /** Or the session the real admin-auth middleware authenticates (see `signIn`). */
  sessionId?: string;
}

const TENANT_ADMIN_AUTH = { roles: ['ar_tenant_admin'], is_platform_admin: false, tenantScope: [] };
const PLATFORM_ADMIN: Actor = {
  tenant: 'tenant-a',
  auth: { roles: ['ar_super_admin'], globalRoles: ['ar_super_admin'], tenantScope: ['*'] },
};
const TENANT_A_ADMIN: Actor = { tenant: 'tenant-a', auth: TENANT_ADMIN_AUTH };
const TENANT_B_ADMIN: Actor = { tenant: 'tenant-b', auth: TENANT_ADMIN_AUTH };

/** Shared by every app of a test, which may use one database. */
let idempotencyKeys = 0;

function createApp(adapter: DatabaseAdapter, useSessionAuth = false) {
  // The Core database of every tenant here, and the platform's directory of tenants.
  const coreSqlite = openCoreDatabase();
  insertTenant(coreSqlite, 'tenant-a');
  const core = sqliteAdapter(coreSqlite);
  const settingsStore = new Map<string, string>();
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const set = (c as unknown as { set(key: string, value: unknown): void }).set;
    const tenantId = c.req.header('X-Tenant-Id') ?? 'tenant-a';
    set.call(c, 'tenantId', tenantId);
    set.call(c, 'tenantMetadataContext', {
      tenantId,
      // The platform has no custom fields; a tenant's would be read from here.
      coreDb: {
        ...core,
        // Only the apps are read from it; there are no custom claim schemas in this test.
        query: async (sql: string, params?: unknown[]) => {
          if (/oauth_clients|identity_providers/.test(sql)) return core.query(sql, params);
          throw new Error('no custom claim schemas in this test');
        },
      },
      route: {},
    });
    if (!useSessionAuth) set.call(c, 'adminAuth', JSON.parse(c.req.header('X-Admin-Auth') ?? '{}'));
    await next();
  });
  // With `useSessionAuth` the real middleware reads the session and the assignments from the
  // Admin database, and adds the roles of all of them up as it does in production.
  if (useSessionAuth) app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
  const base = '/api/admin/field-mapping/field-mapping-sets';
  app.get(base, adminIdentityFieldMappingSetsListHandler);
  app.post(base, adminIdentityFieldMappingSetCreateHandler);
  app.delete(`${base}/:fieldMappingSetId`, adminIdentityFieldMappingSetDeleteHandler);
  app.post(`${base}/:fieldMappingSetId/versions`, adminIdentityFieldMappingVersionCreateHandler);
  app.get(`${base}/:fieldMappingSetId/versions`, adminIdentityFieldMappingVersionsListHandler);
  app.post(
    `${base}/:fieldMappingSetId/versions/:fieldMappingVersionId/publish`,
    adminIdentityFieldMappingVersionPublishHandler
  );
  app.post(
    `${base}/:fieldMappingSetId/versions/:fieldMappingVersionId/compile`,
    adminIdentityFieldMappingVersionCompileHandler
  );
  app.post(
    `${base}/:fieldMappingSetId/versions/:fieldMappingVersionId/activate`,
    adminIdentityFieldMappingVersionActivateHandler
  );
  app.post(
    `${base}/:fieldMappingSetId/versions/:fieldMappingVersionId/deactivate`,
    adminIdentityFieldMappingVersionDeactivateHandler
  );
  app.post(`${base}/:fieldMappingSetId/rollback`, adminIdentityFieldMappingSetRollbackHandler);

  const profiles = '/api/admin/field-mapping/destination-profiles';
  app.post(profiles, adminIdentityMappingDestinationProfileCreateHandler);
  app.put(`${profiles}/:destinationProfileId`, adminIdentityMappingDestinationProfileUpdateHandler);
  app.delete(
    `${profiles}/:destinationProfileId`,
    adminIdentityMappingDestinationProfileDeleteHandler
  );
  app.post(
    `${profiles}/:destinationProfileId/versions/:destinationProfileVersionId/review`,
    adminIdentityMappingDestinationProfileReviewHandler
  );
  app.post(
    `${profiles}/:destinationProfileId/versions/:destinationProfileVersionId/activate`,
    adminIdentityMappingDestinationProfileActivateHandler
  );

  const call = async (actor: Actor, method: string, path: string, body?: unknown) =>
    callUrl(actor, method, `${base}${path}`, body);
  const callUrl = async (actor: Actor, method: string, url: string, body?: unknown) => {
    idempotencyKeys += 1;
    const response = await app.request(
      url,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': actor.tenant,
          ...(actor.auth ? { 'X-Admin-Auth': JSON.stringify(actor.auth) } : {}),
          ...(actor.sessionId ? { Cookie: `authrim_admin_session=${actor.sessionId}` } : {}),
          'Idempotency-Key': `key-${idempotencyKeys}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      {
        DB_ADMIN: adapter,
        DB: core,
        TEST_CORE: core,
        SETTINGS: {
          get: async (key: string) => settingsStore.get(key) ?? null,
        },
      } as unknown as Env
    );
    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, json, result: json.result as Record<string, any> };
  };
  return { call, callUrl, coreSqlite, settingsStore };
}

const OIDC_PROFILE_SCHEMA = {
  destinationType: 'oidc',
  claims: [
    {
      claimName: 'sub',
      required: true,
      nullable: false,
      surfaces: ['id_token', 'userinfo'],
      classification: 'internal',
    },
    {
      claimName: 'email',
      surfaces: ['id_token', 'userinfo'],
      requiredScopes: ['email'],
      classification: 'pii',
    },
  ],
};

async function createActiveOidcProfile(
  repository: IdentityMappingControlPlaneRepository,
  owner: 'platform' | 'tenant',
  options: { schema?: unknown; profileKey?: string } = {}
): Promise<string> {
  const created = await repository.createDestinationProfile('tenant-a', {
    destinationType: 'oidc',
    profileKey: options.profileKey ?? `oidc_${owner}`,
    displayName: `OIDC ${owner}`,
    ownerScopeType: owner,
    schema: options.schema ?? OIDC_PROFILE_SCHEMA,
  } as never);
  const allowPlatform = owner === 'platform';
  await repository.reviewDestinationProfileVersion(
    created.tenantId,
    created.id,
    created.version.id,
    allowPlatform
  );
  await repository.activateDestinationProfileVersion(
    created.tenantId,
    created.id,
    created.version.id,
    allowPlatform
  );
  return created.id;
}

function emailRule(profileId: string, overrides: Record<string, unknown> = {}) {
  return {
    ruleKey: 'email',
    ruleKind: 'direct',
    action: 'allow',
    edges: [
      {
        sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
        targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email', profileId },
      },
    ],
    ...overrides,
  };
}

async function setup() {
  const db = openAdminDatabase();
  seedPlatformCatalog(db);
  const adapter = sqliteAdapter(db);
  const repository = new IdentityMappingControlPlaneRepository(adapter);
  const api = createApp(adapter);
  const platformProfile = await createActiveOidcProfile(repository, 'platform');
  const createPlatformSet = async (key = 'default') => {
    const created = await api.call(PLATFORM_ADMIN, 'POST', '', {
      fieldMappingKey: key,
      displayName: 'Platform default',
      ownerScopeType: 'platform',
    });
    expect(created.status).toBe(200);
    return created.result.id as string;
  };
  return { db, adapter, repository, api, platformProfile, createPlatformSet };
}

describe('platform-owned Mapping Sets through the Admin API', () => {
  it('builds, compiles and activates a platform set that another tenant resolves', async () => {
    const { adapter, api, platformProfile, createPlatformSet, db } = await setup();
    const setId = await createPlatformSet();

    const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
      versionLabel: 'v1',
      rules: [emailRule(platformProfile)],
    });
    expect(version.status).toBe(200);
    expect(version.result.tenantId).toBe(PLATFORM_MAPPING_TENANT_ID);
    const versionId = version.result.id as string;

    expect(
      (await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions/${versionId}/publish`, {})).status
    ).toBe(200);
    const compiled = await api.call(
      PLATFORM_ADMIN,
      'POST',
      `/${setId}/versions/${versionId}/compile`,
      { catalogVersionId: PLATFORM_CATALOG_VERSION }
    );
    expect(compiled.status).toBe(200);

    // The scope a caller sends for a tenant-wide activation names the tenant `platform`, which no
    // calling tenant is: it is written empty.
    const activated = await api.call(
      PLATFORM_ADMIN,
      'POST',
      `/${setId}/versions/${versionId}/activate`,
      { snapshotId: compiled.result.id, activationScope: { kind: 'tenant', id: 'platform' } }
    );
    expect(activated.status).toBe(200);
    expect(
      db.prepare('SELECT tenant_id, activation_scope_json FROM field_mapping_activations').all()
    ).toEqual([{ tenant_id: 'platform', activation_scope_json: '{}' }]);

    for (const tenantId of ['tenant-a', 'tenant-b']) {
      for (const tier of ['platform_default', 'tenant_default'] as const) {
        const binding = await loadMappingBindingBySetId({
          adapter,
          tenantId,
          setId,
          tier,
          protocol: 'oidc',
          role: 'op',
        });
        expect(binding).toMatchObject({
          tenantId: PLATFORM_MAPPING_TENANT_ID,
          fieldMappingSetId: setId,
          destinationProfileId: platformProfile,
        });
        expect(binding.edges).toHaveLength(1);
        expect(binding.catalog.entries.map((entry) => entry.path)).toContain('email');
      }
    }
  });

  it('refuses a scope of the platform activation that narrows it', async () => {
    const { api, platformProfile, createPlatformSet } = await setup();
    const setId = await createPlatformSet();
    const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
      versionLabel: 'v1',
      rules: [emailRule(platformProfile)],
    });
    const versionId = version.result.id as string;
    const compiled = await api.call(
      PLATFORM_ADMIN,
      'POST',
      `/${setId}/versions/${versionId}/compile`,
      { catalogVersionId: PLATFORM_CATALOG_VERSION }
    );

    const narrowed = await api.call(
      PLATFORM_ADMIN,
      'POST',
      `/${setId}/versions/${versionId}/activate`,
      { snapshotId: compiled.result.id, activationScope: { clientId: 'app-1' } }
    );
    const empty = await api.call(
      PLATFORM_ADMIN,
      'POST',
      `/${setId}/versions/${versionId}/activate`,
      { snapshotId: compiled.result.id, activationScope: {} }
    );

    expect(narrowed.status).toBe(400);
    expect(empty.status).toBe(200);
  });

  it('lets a tenant admin read a platform set and change none of it', async () => {
    const { api, platformProfile, createPlatformSet } = await setup();
    const setId = await createPlatformSet();
    const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
      versionLabel: 'v1',
      rules: [emailRule(platformProfile)],
    });
    const versionId = version.result.id as string;

    const versions = await api.call(TENANT_A_ADMIN, 'GET', `/${setId}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.json.fieldMappingVersions.map((item: any) => item.id)).toEqual([versionId]);

    const attempts = [
      ['POST', `/${setId}/versions`, { versionLabel: 'v2', rules: [] }],
      ['POST', `/${setId}/versions/${versionId}/publish`, {}],
      [
        'POST',
        `/${setId}/versions/${versionId}/compile`,
        { catalogVersionId: PLATFORM_CATALOG_VERSION },
      ],
      [
        'POST',
        `/${setId}/versions/${versionId}/activate`,
        { snapshotId: 'x', activationScope: {} },
      ],
      ['POST', `/${setId}/versions/${versionId}/deactivate`, {}],
      ['POST', `/${setId}/rollback`, {}],
      ['DELETE', `/${setId}`, undefined],
    ] as const;
    for (const [method, path, body] of attempts) {
      const response = await api.call(TENANT_A_ADMIN, method, path, body);
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    const state = await api.call(PLATFORM_ADMIN, 'GET', `/${setId}/versions`);
    expect(state.json.fieldMappingVersions[0].lifecycleState).toBe('draft');
  });

  it('refuses a tenant admin the platform owner scope on creation', async () => {
    const { api, db } = await setup();

    const response = await api.call(TENANT_A_ADMIN, 'POST', '', {
      fieldMappingKey: 'sneaky',
      displayName: 'Sneaky',
      ownerScopeType: 'platform',
    });

    expect(response.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM field_mapping_sets').get()).toEqual({ n: 0 });
  });

  it('keeps the owner scope and the owning tenant ID together', async () => {
    const { api, db, repository } = await setup();

    const platform = await api.call(PLATFORM_ADMIN, 'POST', '', {
      fieldMappingKey: 'p',
      displayName: 'P',
      ownerScopeType: 'platform',
      ownerScopeId: 'ignored',
    });
    const tenant = await api.call(TENANT_A_ADMIN, 'POST', '', {
      fieldMappingKey: 't',
      displayName: 'T',
    });
    // A platform admin who names no owner scope creates a set of the tenant they act in.
    const own = await api.call(PLATFORM_ADMIN, 'POST', '', {
      fieldMappingKey: 'own',
      displayName: 'Own',
    });

    expect(
      db
        .prepare(
          'SELECT tenant_id, owner_scope_type, owner_scope_id FROM field_mapping_sets ORDER BY field_mapping_key'
        )
        .all()
    ).toEqual([
      { tenant_id: 'tenant-a', owner_scope_type: 'tenant', owner_scope_id: null },
      { tenant_id: 'platform', owner_scope_type: 'platform', owner_scope_id: null },
      { tenant_id: 'tenant-a', owner_scope_type: 'tenant', owner_scope_id: null },
    ]);
    expect([platform.result.owner, tenant.result.owner, own.result.owner]).toEqual([
      'platform',
      'tenant',
      'tenant',
    ]);
    // The repository itself refuses the two ways to break the pairing.
    await expect(
      repository.createFieldMappingSet('tenant-a', {
        fieldMappingKey: 'x',
        displayName: 'X',
        ownerScopeType: 'platform',
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.createFieldMappingSet(PLATFORM_MAPPING_TENANT_ID, {
        fieldMappingKey: 'y',
        displayName: 'Y',
        ownerScopeType: 'tenant',
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('lists the tenant’s sets and the platform’s with their owners, and no other tenant’s', async () => {
    const { api, createPlatformSet } = await setup();
    const platformSetId = await createPlatformSet('platform-set');
    const own = await api.call(TENANT_A_ADMIN, 'POST', '', {
      fieldMappingKey: 'own',
      displayName: 'Own',
    });
    const other = await api.call(TENANT_B_ADMIN, 'POST', '', {
      fieldMappingKey: 'other',
      displayName: 'Other',
    });

    const list = await api.call(TENANT_A_ADMIN, 'GET', '');

    const rows = (list.json.fieldMappingSets as any[]).map((row) => [row.id, row.owner]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        [platformSetId, 'platform'],
        [own.result.id, 'tenant'],
      ])
    );
    expect(JSON.stringify(list.json)).not.toContain(other.result.id);
  });

  it('answers another tenant’s set as not found, for every operation', async () => {
    const { api } = await setup();
    const other = await api.call(TENANT_B_ADMIN, 'POST', '', {
      fieldMappingKey: 'other',
      displayName: 'Other',
    });
    const otherId = other.result.id as string;
    const missing = await api.call(TENANT_A_ADMIN, 'GET', '/nothing/versions');

    const attempts = [
      ['GET', `/${otherId}/versions`, undefined],
      ['POST', `/${otherId}/versions`, { versionLabel: 'v1', rules: [] }],
      ['POST', `/${otherId}/versions/v/publish`, {}],
      ['POST', `/${otherId}/versions/v/compile`, { catalogVersionId: 'c' }],
      ['POST', `/${otherId}/versions/v/activate`, { snapshotId: 's', activationScope: {} }],
      ['POST', `/${otherId}/versions/v/deactivate`, {}],
      ['POST', `/${otherId}/rollback`, {}],
      ['DELETE', `/${otherId}`, undefined],
    ] as const;
    for (const actor of [TENANT_A_ADMIN, PLATFORM_ADMIN]) {
      for (const [method, path, body] of attempts) {
        const response = await api.call(actor, method, path, body);
        expect([method, path, response.status, response.json.error_description]).toEqual([
          method,
          path,
          404,
          missing.json.error_description,
        ]);
      }
    }
  });

  describe('what a platform set may not hold', () => {
    const forbiddenSources: Array<[string, Record<string, unknown>]> = [
      ['custom claims', { namespace: 'authrim.custom_claims', path: 'x' }],
      ['custom claims (short)', { namespace: 'custom_claims', path: 'x' }],
      ['custom fields', { namespace: 'authrim.custom_fields', path: 'x' }],
      ['custom fields (short)', { namespace: 'custom_fields', path: 'x' }],
      ['attributes', { namespace: 'authrim.attributes', path: 'x' }],
      ['custom claims by path', { namespace: 'authrim.profile', path: 'custom_claims.x' }],
      [
        'custom fields by the field key',
        { namespace: 'authrim.profile', fieldKey: 'custom_fields.x' },
      ],
    ];

    it.each(forbiddenSources)(
      'rejects a source reading %s when the version is saved',
      async (_name, source) => {
        const { api, platformProfile, createPlatformSet, db } = await setup();
        const setId = await createPlatformSet();

        const response = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
          versionLabel: 'v1',
          rules: [
            emailRule(platformProfile, {
              edges: [
                {
                  sourceRef: { side: 'source', ...source },
                  targetRef: {
                    side: 'destination',
                    namespace: 'oidc.claim',
                    path: 'email',
                    profileId: platformProfile,
                  },
                },
              ],
            }),
          ],
        });

        expect(response.status).toBe(400);
        expect(response.json.error_description).toContain('tenant-defined field');
        expect(db.prepare('SELECT COUNT(*) AS n FROM field_mapping_versions').get()).toEqual({
          n: 0,
        });
      }
    );

    it('accepts the same namespaces on a tenant’s own set', async () => {
      const { api, platformProfile } = await setup();
      const own = await api.call(TENANT_A_ADMIN, 'POST', '', {
        fieldMappingKey: 'own',
        displayName: 'Own',
      });

      const response = await api.call(TENANT_A_ADMIN, 'POST', `/${own.result.id}/versions`, {
        versionLabel: 'v1',
        rules: [
          emailRule(platformProfile, {
            edges: [
              {
                sourceRef: { side: 'source', namespace: 'authrim.custom_claims', path: 'x' },
                targetRef: {
                  side: 'destination',
                  namespace: 'oidc.claim',
                  path: 'email',
                  profileId: platformProfile,
                },
              },
            ],
          }),
        ],
      });

      expect(response.status).toBe(200);
    });

    it('rejects a validation rule on a custom field', async () => {
      const { api, platformProfile, createPlatformSet } = await setup();
      const setId = await createPlatformSet();

      const response = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        rules: [
          emailRule(platformProfile, {
            validationRules: [
              {
                targetRef: { side: 'destination', namespace: 'authrim.custom_fields', path: 'x' },
                validationKind: 'required',
              },
            ],
          }),
        ],
      });

      expect(response.status).toBe(400);
      expect(response.json.error_description).toContain('tenant-defined field');
    });

    describe('a validation rule whose reference names no side', () => {
      // The runtime reads a missing side as `source`.
      const validation = (targetRef: Record<string, unknown>) => ({
        validationRules: [{ targetRef, validationKind: 'required' }],
      });

      it.each([
        ['no side', { namespace: 'authrim.profile', path: 'custom_claims.x' }],
        ['side source', { side: 'source', namespace: 'authrim.profile', path: 'custom_claims.x' }],
      ])('refuses one on a tenant-defined field when saved (%s)', async (_name, targetRef) => {
        const { api, platformProfile, createPlatformSet } = await setup();
        const setId = await createPlatformSet();

        const response = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
          versionLabel: 'v1',
          rules: [emailRule(platformProfile, validation(targetRef))],
        });

        expect(response.status).toBe(400);
        expect(response.json.error_description).toContain('tenant-defined field');
      });

      it('saves one on a standard field, and on a destination claim named like a tenant field', async () => {
        const { api, platformProfile, createPlatformSet } = await setup();
        const setId = await createPlatformSet();

        const response = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
          versionLabel: 'v1',
          rules: [
            emailRule(platformProfile, {
              validationRules: [
                {
                  targetRef: { namespace: 'authrim.profile', path: 'email' },
                  validationKind: 'required',
                },
                {
                  targetRef: {
                    side: 'destination',
                    namespace: 'oidc.claim',
                    path: 'custom_claims.x',
                  },
                  validationKind: 'required',
                },
              ],
            }),
          ],
        });

        expect(response.status).toBe(200);
      });

      it('refuses one in a stored row at compile and again at activation', async () => {
        const { api, db, platformProfile, createPlatformSet } = await setup();
        const setId = await createPlatformSet();
        const versionId = await savedVersion(api, setId, [emailRule(platformProfile)]);
        const addValidation = (path: string) =>
          db
            .prepare(
              `INSERT INTO mapping_validation_rules (id, tenant_id, rule_id, target_ref_json, validation_kind, severity, created_at, updated_at)
               SELECT 'stored-validation', tenant_id, id, ?, 'required', 'error', 1, 1 FROM mapping_rules LIMIT 1`
            )
            .run(JSON.stringify({ namespace: 'authrim.profile', path }));

        addValidation('custom_claims.x');
        const refusedCompile = await compile(api, setId, versionId);
        db.prepare("DELETE FROM mapping_validation_rules WHERE id = 'stored-validation'").run();
        const compiled = await compile(api, setId, versionId);
        addValidation('custom_claims.x');
        const refusedActivation = await api.call(
          PLATFORM_ADMIN,
          'POST',
          `/${setId}/versions/${versionId}/activate`,
          { snapshotId: compiled.result.id, activationScope: {} }
        );

        expect(refusedCompile.status).toBe(400);
        expect(refusedCompile.json.error_description).toContain('tenant-defined field');
        expect(compiled.status).toBe(200);
        expect(refusedActivation.status).toBe(400);
        expect(refusedActivation.json.error_description).toContain('tenant-defined field');
        expect(db.prepare('SELECT COUNT(*) AS n FROM field_mapping_activations').get()).toEqual({
          n: 0,
        });
      });
    });

    it.each([
      ['an oidc_pairwise_sub transform', { operation: 'oidc_pairwise_sub', parameters: {} }],
      [
        'a transform naming a persistent identifier profile',
        { operation: 'copy', parameters: { persistentIdentifierProfileId: 'pip-1' } },
      ],
    ])('rejects %s', async (_name, transform) => {
      const { api, platformProfile, createPlatformSet } = await setup();
      const setId = await createPlatformSet();

      const response = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        rules: [emailRule(platformProfile, { transforms: [{ edgeIndex: 0, ...transform }] })],
      });

      expect(response.status).toBe(400);
      expect(response.json.error_description).toContain('persistent identifier');
    });

    it('rejects a source profile', async () => {
      const { api, platformProfile, createPlatformSet } = await setup();
      const setId = await createPlatformSet();

      const response = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        sourceProfileIds: ['source-profile-1'],
        rules: [emailRule(platformProfile)],
      });

      expect(response.status).toBe(400);
      expect(response.json.error_description).toContain('source profile');
    });

    async function savedVersion(
      api: ReturnType<typeof createApp>,
      setId: string,
      rules: unknown[]
    ) {
      const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        rules,
      });
      expect(version.status).toBe(200);
      return version.result.id as string;
    }

    const compile = (api: ReturnType<typeof createApp>, setId: string, versionId: string) =>
      api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions/${versionId}/compile`, {
        catalogVersionId: PLATFORM_CATALOG_VERSION,
      });

    it('refuses to compile a source the platform catalog does not have', async () => {
      const { api, platformProfile, createPlatformSet } = await setup();
      const setId = await createPlatformSet();
      const versionId = await savedVersion(api, setId, [
        emailRule(platformProfile, {
          edges: [
            {
              sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'not_in_catalog' },
              targetRef: {
                side: 'destination',
                namespace: 'oidc.claim',
                path: 'email',
                profileId: platformProfile,
              },
            },
          ],
        }),
      ]);

      const rejected = await compile(api, setId, versionId);
      expect(rejected.status).toBe(400);
      expect(rejected.json.error_description).toContain('not a field of the platform catalog');
    });

    it('refuses to compile a source the catalog marks as custom', async () => {
      const { api, db, platformProfile, createPlatformSet } = await setup();
      db.prepare(
        `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, cardinality, classification, created_at, updated_at)
         VALUES ('platform_custom_loyalty', 'platform', ?, 'field.custom.loyalty', 'authrim.canonical', 'loyalty', 'custom', 'string', 'single', 'internal', 1, 1)`
      ).run(PLATFORM_CATALOG_VERSION);
      const setId = await createPlatformSet();
      const versionId = await savedVersion(api, setId, [
        emailRule(platformProfile, {
          edges: [
            {
              sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'loyalty' },
              targetRef: {
                side: 'destination',
                namespace: 'oidc.claim',
                path: 'email',
                profileId: platformProfile,
              },
            },
          ],
        }),
      ]);

      const rejected = await compile(api, setId, versionId);
      expect(rejected.status).toBe(400);
      expect(rejected.json.error_description).toContain('custom catalog field');
    });

    it.each([
      ['the row ID', 'platform_tenant_defined_loyalty'],
      ['the stable ID', 'field.tenant.loyalty'],
    ])(
      'refuses to compile a source that names only an entry of a tenant-defined namespace (%s)',
      async (_name, catalogEntryId) => {
        const { api, db, platformProfile, createPlatformSet } = await setup();
        // Not marked custom: only its namespace says that a tenant defines its keys.
        db.prepare(
          `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, cardinality, classification, created_at, updated_at)
           VALUES ('platform_tenant_defined_loyalty', 'platform', ?, 'field.tenant.loyalty', 'authrim.custom_claims', 'loyalty', 'canonical', 'string', 'single', 'internal', 1, 1)`
        ).run(PLATFORM_CATALOG_VERSION);
        const setId = await createPlatformSet();
        const versionId = await savedVersion(api, setId, [
          emailRule(platformProfile, {
            edges: [
              {
                sourceRef: { side: 'source', catalogEntryId },
                targetRef: {
                  side: 'destination',
                  namespace: 'oidc.claim',
                  path: 'email',
                  profileId: platformProfile,
                },
              },
            ],
          }),
        ]);

        const rejected = await compile(api, setId, versionId);

        expect(rejected.status).toBe(400);
        expect(rejected.json.error_description).toContain('tenant-defined field');
      }
    );

    it('refuses to compile a source that names only an entry of the older taxonomy `destination`', async () => {
      const { api, db, platformProfile, createPlatformSet } = await setup();
      db.prepare(
        `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, cardinality, classification, created_at, updated_at)
         VALUES ('platform_legacy_claim', 'platform', ?, 'field.legacy.claim', 'oidc.claim', 'nickname', 'destination', 'string', 'single', 'internal', 1, 1)`
      ).run(PLATFORM_CATALOG_VERSION);
      const setId = await createPlatformSet();
      const versionId = await savedVersion(api, setId, [
        emailRule(platformProfile, {
          edges: [
            {
              sourceRef: { side: 'source', catalogEntryId: 'field.legacy.claim' },
              targetRef: {
                side: 'destination',
                namespace: 'oidc.claim',
                path: 'email',
                profileId: platformProfile,
              },
            },
          ],
        }),
      ]);

      const rejected = await compile(api, setId, versionId);

      expect(rejected.status).toBe(400);
      expect(rejected.json.error_description).toContain('not a field of the platform catalog');
    });

    it('compiles a source of the platform catalog', async () => {
      const { api, platformProfile, createPlatformSet } = await setup();
      const setId = await createPlatformSet();
      const versionId = await savedVersion(api, setId, [emailRule(platformProfile)]);

      expect((await compile(api, setId, versionId)).status).toBe(200);
    });

    it('refuses to compile against a catalog a tenant owns', async () => {
      const { api, db, platformProfile, createPlatformSet } = await setup();
      db.prepare(
        `INSERT INTO field_catalog_versions (id, tenant_id, catalog_id, version_label, bundle_hash, lifecycle_state, created_at, updated_at)
         VALUES ('tenant-catalog-v1', 'tenant-a', 'platform_default_canonical_catalog', 'v2', 'h', 'active', 1, 1)`
      ).run();
      const setId = await createPlatformSet();
      const versionId = await savedVersion(api, setId, [emailRule(platformProfile)]);

      const response = await api.call(
        PLATFORM_ADMIN,
        'POST',
        `/${setId}/versions/${versionId}/compile`,
        { catalogVersionId: 'tenant-catalog-v1' }
      );

      expect(response.status).toBe(404);
    });

    async function createSecondPlatformProfile(context: Awaited<ReturnType<typeof setup>>) {
      const second = await context.repository.createDestinationProfile('tenant-a', {
        destinationType: 'oidc',
        profileKey: 'second',
        displayName: 'Second',
        ownerScopeType: 'platform',
        schema: OIDC_PROFILE_SCHEMA,
      } as never);
      await context.repository.reviewDestinationProfileVersion(
        'platform',
        second.id,
        second.version.id,
        true
      );
      await context.repository.activateDestinationProfileVersion(
        'platform',
        second.id,
        second.version.id,
        true
      );
      return second.id;
    }

    /**
     * An edge into `targetRef`, the way the runtime would read it: added to the rules as saved, or
     * (to reach the later checks, which exist for rows that did not come through the save) put
     * straight into the stored rules.
     */
    const extraEdge = (targetRef: Record<string, unknown>) => ({
      sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'given_name' },
      targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'given_name', ...targetRef },
    });
    const insertStoredEdge = (db: SQLiteDatabase, edge: ReturnType<typeof extraEdge>) =>
      db
        .prepare(
          `INSERT INTO mapping_rule_edges (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at)
           SELECT 'extra-edge', tenant_id, rule_id, ?, ?, 'direct', 9, 1, 1 FROM mapping_rule_edges LIMIT 1`
        )
        .run(JSON.stringify(edge.sourceRef), JSON.stringify(edge.targetRef));

    type ProfileCase = [
      string,
      (context: Awaited<ReturnType<typeof setup>>) => Promise<{
        /** The target of the one edge that is saved first (default: the platform profile). */
        mainProfile?: string;
        extra?: Record<string, unknown>;
      }>,
      string,
    ];
    const profileCases: ProfileCase[] = [
      [
        'a Destination Profile a tenant owns',
        async (context) => ({
          mainProfile: await createActiveOidcProfile(context.repository, 'tenant'),
        }),
        'platform-owned Destination Profile',
      ],
      [
        'a second profile spelled profile_id, which the runtime also reads',
        async (context) => ({
          extra: { profile_id: await createActiveOidcProfile(context.repository, 'tenant') },
        }),
        'exactly one OIDC Destination Profile',
      ],
      [
        'a second platform profile spelled profile_id',
        async (context) => ({
          extra: { profile_id: await createSecondPlatformProfile(context) },
        }),
        'exactly one OIDC Destination Profile',
      ],
      [
        'a profile reference that is not the shape of an ID, on an edge of its own',
        async () => ({ extra: { profileId: 'whatever' } }),
        'exactly one OIDC Destination Profile',
      ],
      [
        'profileId and profile_id that differ on one reference',
        async (context) => ({
          extra: {
            profileId: context.platformProfile,
            profile_id: await createActiveOidcProfile(context.repository, 'tenant'),
          },
        }),
        'two different Destination Profiles',
      ],
    ];

    it.each(profileCases)('refuses %s when the version is saved', async (_name, make, message) => {
      const context = await setup();
      const setId = await context.createPlatformSet();
      const { mainProfile, extra } = await make(context);
      const rules = [
        emailRule(mainProfile ?? context.platformProfile),
        ...(extra
          ? [
              {
                ...emailRule(context.platformProfile, { ruleKey: 'given' }),
                edges: [extraEdge(extra)],
              },
            ]
          : []),
      ];

      const response = await context.api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        rules,
      });

      expect(response.status).toBe(400);
      expect(response.json.error_description).toContain(message);
      expect(context.db.prepare('SELECT COUNT(*) AS n FROM field_mapping_versions').get()).toEqual({
        n: 0,
      });
    });

    it.each(profileCases)(
      'refuses %s at compile and at activation, for a row that did not come through the save',
      async (_name, make, message) => {
        const context = await setup();
        const setId = await context.createPlatformSet();
        const { mainProfile, extra } = await make(context);
        const versionId = await savedVersion(context.api, setId, [
          emailRule(context.platformProfile),
        ]);
        if (mainProfile) {
          context.db
            .prepare('UPDATE mapping_rule_edges SET target_ref_json = ?')
            .run(JSON.stringify(emailRule(mainProfile).edges[0].targetRef));
        }
        if (extra) insertStoredEdge(context.db, extraEdge(extra));
        const row = (id: string) => `/${setId}/versions/${versionId}/${id}`;

        const refusedCompile = await context.api.call(PLATFORM_ADMIN, 'POST', row('compile'), {
          catalogVersionId: PLATFORM_CATALOG_VERSION,
        });
        expect(refusedCompile.status).toBe(400);
        expect(refusedCompile.json.error_description).toContain(message);

        // A snapshot that was compiled before the rows were changed.
        context.db.prepare('DELETE FROM mapping_rule_edges WHERE id = ?').run('extra-edge');
        context.db
          .prepare('UPDATE mapping_rule_edges SET target_ref_json = ?')
          .run(JSON.stringify(emailRule(context.platformProfile).edges[0].targetRef));
        const compiled = await compile(context.api, setId, versionId);
        expect(compiled.status).toBe(200);
        if (mainProfile) {
          context.db
            .prepare('UPDATE mapping_rule_edges SET target_ref_json = ?')
            .run(JSON.stringify(emailRule(mainProfile).edges[0].targetRef));
        }
        if (extra) insertStoredEdge(context.db, extraEdge(extra));
        const activation = await context.api.call(PLATFORM_ADMIN, 'POST', row('activate'), {
          snapshotId: compiled.result.id,
          activationScope: {},
        });

        expect(activation.status).toBe(400);
        expect(activation.json.error_description).toContain(message);
        expect(
          context.db.prepare('SELECT COUNT(*) AS n FROM field_mapping_activations').get()
        ).toEqual({ n: 0 });
      }
    );

    it('refuses a mapping that releases to no Destination Profile, at each step', async () => {
      const context = await setup();
      const setId = await context.createPlatformSet();
      const plain = {
        ruleKey: 'plain',
        ruleKind: 'direct',
        action: 'allow',
        edges: [
          {
            sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
            targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
          },
        ],
      };

      const saved = await context.api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        rules: [plain],
      });

      expect(saved.status).toBe(400);
      expect(saved.json.error_description).toContain('exactly one OIDC Destination Profile');
    });

    it('takes a profile spelled profile_id for the mapping’s one profile, through to the tenant', async () => {
      const context = await setup();
      const setId = await context.createPlatformSet();
      const rule = emailRule('unused');
      rule.edges[0].targetRef = {
        side: 'destination',
        namespace: 'oidc.claim',
        path: 'email',
        profile_id: context.platformProfile,
      } as never;
      const versionId = await savedVersion(context.api, setId, [rule]);
      const compiled = await compile(context.api, setId, versionId);
      expect(compiled.status).toBe(200);

      const activation = await context.api.call(
        PLATFORM_ADMIN,
        'POST',
        `/${setId}/versions/${versionId}/activate`,
        { snapshotId: compiled.result.id, activationScope: {} }
      );

      expect(activation.status).toBe(200);
      await expect(
        loadMappingBindingBySetId({
          adapter: context.adapter,
          tenantId: 'tenant-b',
          setId,
          tier: 'platform_default',
          protocol: 'oidc',
          role: 'op',
        })
      ).resolves.toMatchObject({ destinationProfileId: context.platformProfile });
    });

    it('refuses at activation a source whose classification the catalog no longer gives', async () => {
      // The same source a tenant’s OIDC mapping would be let through for, as long as it is not
      // read from the profile namespace.
      const context = await setup();
      const setId = await context.createPlatformSet();
      const versionId = await savedVersion(context.api, setId, [
        emailRule(context.platformProfile, {
          edges: [
            {
              sourceRef: { side: 'source', namespace: 'authrim.canonical', path: 'email' },
              targetRef: {
                side: 'destination',
                namespace: 'oidc.claim',
                path: 'email',
                profileId: context.platformProfile,
              },
            },
          ],
        }),
      ]);
      const compiled = await compile(context.api, setId, versionId);
      expect(compiled.status).toBe(200);
      context.db
        .prepare(
          "DELETE FROM field_catalog_entries WHERE stable_field_id = 'field.canonical.email'"
        )
        .run();

      const activation = await context.api.call(
        PLATFORM_ADMIN,
        'POST',
        `/${setId}/versions/${versionId}/activate`,
        { snapshotId: compiled.result.id, activationScope: {} }
      );

      expect(activation.status).toBe(400);
      expect(activation.json.error_description).toContain('classification is unknown');
    });
  });

  it('refuses custom entries and custom fields in a platform catalog, and allows them for a tenant', async () => {
    const { repository } = await setup();
    const entry = {
      id: 'field.canonical.email',
      namespace: 'authrim.profile',
      path: 'email',
      targetType: 'canonical' as const,
      valueType: 'string',
      cardinality: 'single' as const,
      classification: 'pii' as const,
    };
    const catalog = (extra: Record<string, unknown>) =>
      ({
        catalogKey: `k-${Math.random()}`,
        displayName: 'Catalog',
        versionLabel: 'v1',
        entries: [entry],
        ...extra,
      }) as never;

    await expect(
      repository.createCatalog(
        PLATFORM_MAPPING_TENANT_ID,
        catalog({
          customEntries: [{ customKey: 'loyalty', displayName: 'Loyalty', valueType: 'string' }],
        })
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.createCatalog(
        PLATFORM_MAPPING_TENANT_ID,
        catalog({ entries: [{ ...entry, targetType: 'custom' }] })
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.createCatalog(PLATFORM_MAPPING_TENANT_ID, catalog({}))
    ).resolves.toMatchObject({ tenantId: PLATFORM_MAPPING_TENANT_ID });
    await expect(
      repository.createCatalog(
        'tenant-a',
        catalog({
          customEntries: [{ customKey: 'loyalty', displayName: 'Loyalty', valueType: 'string' }],
        })
      )
    ).resolves.toMatchObject({ tenantId: 'tenant-a' });
  });

  it('derives no catalog of custom fields for the platform, whatever the Core database holds', async () => {
    const { adapter } = await setup();
    const coreAdapter = {
      query: async () => [
        {
          id: 'schema-1',
          field_key: 'loyalty',
          active_field_key: null,
          field_type: 'string',
          cardinality: 'single',
          is_pii: 0,
          is_required: 0,
        },
      ],
    } as unknown as DatabaseAdapter;
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1, coreAdapter);

    const platform = await repository.listCatalogs(PLATFORM_MAPPING_TENANT_ID);
    const tenant = await repository.listCatalogs('tenant-a');

    expect(platform.map((catalog) => catalog.catalogKey)).toEqual([
      'authrim.platform_default_canonical',
    ]);
    expect(tenant.map((catalog) => catalog.id)).toEqual(['system_default_canonical_catalog']);
  });

  describe('who may change what the platform owns', () => {
    // Contexts the middleware can produce that must not change what every tenant shares: the
    // platform-level role or permission is not a global one, or the tenant scope is not global.
    const limited: Array<[string, Record<string, unknown>]> = [
      [
        'a wildcard-permission token limited to the tenant',
        { roles: [], permissions: ['*'], globalPermissions: [], tenantScope: ['tenant-a'] },
      ],
      [
        'a tenant-limited ar_super_admin session',
        {
          roles: ['ar_super_admin'],
          globalRoles: [],
          permissions: ['*'],
          globalPermissions: [],
          tenantScope: ['tenant-a'],
        },
      ],
      [
        'a ar_super_admin role that is not a global one, under a global scope',
        {
          roles: ['viewer', 'ar_super_admin'],
          globalRoles: ['viewer'],
          permissions: ['*', 'admin:users:read'],
          globalPermissions: ['admin:users:read'],
          tenantScope: ['*'],
        },
      ],
      [
        'a wildcard permission that is not a global one, under a global scope',
        {
          roles: ['viewer'],
          globalRoles: ['viewer'],
          permissions: ['*'],
          globalPermissions: [],
          tenantScope: ['*'],
        },
      ],
      [
        'a global ar_super_admin whose scope names only the tenant',
        { roles: ['ar_super_admin'], globalRoles: ['ar_super_admin'], tenantScope: ['tenant-a'] },
      ],
      [
        'a global ar_super_admin with an empty scope',
        { roles: ['ar_super_admin'], globalRoles: ['ar_super_admin'], tenantScope: [] },
      ],
      [
        'a global ar_super_admin whose context carries no tenant scope',
        { roles: ['ar_super_admin'], globalRoles: ['ar_super_admin'] },
      ],
      [
        'roles and permissions only, as an older context carries them',
        { roles: ['ar_super_admin'], permissions: ['*'], tenantScope: ['*'] },
      ],
      ['is_platform_admin alone', { roles: [], is_platform_admin: true, tenantScope: ['*'] }],
    ];
    const actorOf = (auth: Record<string, unknown>): Actor => ({ tenant: 'tenant-a', auth });

    it.each(limited)('refuses %s every change to a platform set', async (_name, auth) => {
      const { api, db, platformProfile, createPlatformSet } = await setup();
      const setId = await createPlatformSet();
      const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        rules: [emailRule(platformProfile)],
      });
      const versionId = version.result.id as string;
      const actor = actorOf(auth);
      const before = JSON.stringify([
        db.prepare('SELECT * FROM field_mapping_sets ORDER BY id').all(),
        db.prepare('SELECT * FROM field_mapping_versions ORDER BY id').all(),
        db.prepare('SELECT COUNT(*) AS n FROM compiled_mapping_snapshots').get(),
        db.prepare('SELECT COUNT(*) AS n FROM field_mapping_activations').get(),
      ]);

      const attempts: Array<[string, string, unknown?]> = [
        [
          'POST',
          '',
          { fieldMappingKey: 'another', displayName: 'Another', ownerScopeType: 'platform' },
        ],
        ['POST', `/${setId}/versions`, { versionLabel: 'v2', rules: [emailRule(platformProfile)] }],
        ['POST', `/${setId}/versions/${versionId}/publish`, {}],
        [
          'POST',
          `/${setId}/versions/${versionId}/compile`,
          { catalogVersionId: PLATFORM_CATALOG_VERSION },
        ],
        [
          'POST',
          `/${setId}/versions/${versionId}/activate`,
          { snapshotId: 'x', activationScope: {} },
        ],
        ['POST', `/${setId}/versions/${versionId}/deactivate`, {}],
        ['POST', `/${setId}/rollback`, {}],
        ['DELETE', `/${setId}`],
      ];
      for (const [method, path, body] of attempts) {
        const response = await api.call(actor, method, path, body);
        expect([method, path, response.status]).toEqual([method, path, 403]);
      }

      expect(
        JSON.stringify([
          db.prepare('SELECT * FROM field_mapping_sets ORDER BY id').all(),
          db.prepare('SELECT * FROM field_mapping_versions ORDER BY id').all(),
          db.prepare('SELECT COUNT(*) AS n FROM compiled_mapping_snapshots').get(),
          db.prepare('SELECT COUNT(*) AS n FROM field_mapping_activations').get(),
        ])
      ).toBe(before);
    });

    it.each(limited)(
      'refuses %s every change to a platform Destination Profile',
      async (_name, auth) => {
        const { api, db, platformProfile: profileId } = await setup();
        const version = db
          .prepare('SELECT id FROM destination_profile_versions WHERE profile_id = ?')
          .get(profileId) as { id: string };
        const profiles = '/api/admin/field-mapping/destination-profiles';
        const actor = actorOf(auth);
        const snapshot = () =>
          JSON.stringify([
            db.prepare('SELECT * FROM destination_profiles ORDER BY id').all(),
            db.prepare('SELECT * FROM destination_profile_versions ORDER BY id').all(),
          ]);
        const before = snapshot();

        const created = await api.callUrl(actor, 'POST', profiles, {
          ownerScopeType: 'platform',
          destinationType: 'oidc',
          profileKey: 'another',
          displayName: 'Another',
          schema: OIDC_PROFILE_SCHEMA,
        });
        const updated = await api.callUrl(actor, 'PUT', `${profiles}/${profileId}`, {
          ownerScopeType: 'platform',
          displayName: 'Changed',
          schema: OIDC_PROFILE_SCHEMA,
        });
        const reviewed = await api.callUrl(
          actor,
          'POST',
          `${profiles}/${profileId}/versions/${version.id}/review`,
          {}
        );
        const activated = await api.callUrl(
          actor,
          'POST',
          `${profiles}/${profileId}/versions/${version.id}/activate`,
          {}
        );
        const deleted = await api.callUrl(actor, 'DELETE', `${profiles}/${profileId}`);

        expect(created.status).toBe(403);
        expect(updated.status).toBe(403);
        // The profile is not the caller's to see, so these are answered as not found.
        expect([reviewed.status, activated.status, deleted.status]).toEqual([404, 404, 404]);
        expect(snapshot()).toBe(before);
      }
    );

    describe('when one admin holds several assignments (the real session authentication)', () => {
      type Assignment = { role: string; scope: 'global' | 'tenant' };
      let sessions = 0;

      /** An admin with these assignments, signed in, as rows the middleware reads. */
      function signIn(db: SQLiteDatabase, assignments: Assignment[]): Actor {
        sessions += 1;
        const userId = `admin-${sessions}`;
        const sessionId = `session-${sessions}`;
        const now = Date.now();
        db.prepare(
          `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
           VALUES (?, 'tenant-a', ?, 1, 'active', ?, ?)`
        ).run(userId, `${userId}@example.test`, now, now);
        db.prepare(
          `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at, mfa_verified)
           VALUES (?, 'tenant-a', ?, ?, ?, 0)`
        ).run(sessionId, userId, now, now + 3_600_000);
        assignments.forEach((assignment, index) => {
          db.prepare(
            `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
             VALUES (?, 'tenant-a', ?, ?, ?, ?, ?)`
          ).run(
            `${userId}-assignment-${index}`,
            userId,
            assignment.role,
            assignment.scope,
            assignment.scope === 'tenant' ? 'tenant-a' : null,
            now
          );
        });
        return { tenant: 'tenant-a', sessionId };
      }

      async function context() {
        const base = await setup();
        base.db
          .prepare(
            `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, created_at, updated_at)
             VALUES ('role_tenant_wildcard', 'tenant-a', 'tenant_wildcard', '["*"]', 50, 'custom', 0, 1, 1)`
          )
          .run();
        return { ...base, session: createApp(base.adapter, true) };
      }

      const create = (api: ReturnType<typeof createApp>, actor: Actor, key: string) =>
        api.call(actor, 'POST', '', {
          fieldMappingKey: key,
          displayName: key,
          ownerScopeType: 'platform',
        });

      it.each([
        [
          'a global viewer who is also a ar_super_admin for this tenant only',
          [
            { role: 'role_ar_viewer', scope: 'global' },
            { role: 'role_ar_super_admin', scope: 'tenant' },
          ],
        ],
        [
          'a global viewer who also holds a wildcard-permission role for this tenant only',
          [
            { role: 'role_ar_viewer', scope: 'global' },
            { role: 'role_tenant_wildcard', scope: 'tenant' },
          ],
        ],
        [
          'a ar_super_admin for this tenant only',
          [{ role: 'role_ar_super_admin', scope: 'tenant' }],
        ],
        [
          'a global admin (not a platform role)',
          [{ role: 'role_ar_tenant_admin', scope: 'global' }],
        ],
      ] as Array<[string, Assignment[]]>)(
        'refuses %s every change to a platform set',
        async (_name, assignments) => {
          const { session, db, platformProfile, createPlatformSet } = await context();
          const setId = await createPlatformSet();
          const actor = signIn(db, assignments);

          const created = await create(session, actor, 'sneaky');
          const version = await session.call(actor, 'POST', `/${setId}/versions`, {
            versionLabel: 'v1',
            rules: [emailRule(platformProfile)],
          });
          const deleted = await session.call(actor, 'DELETE', `/${setId}`);

          expect([created.status, version.status, deleted.status]).toEqual([403, 403, 403]);
          expect(db.prepare('SELECT COUNT(*) AS n FROM field_mapping_sets').get()).toEqual({
            n: 1,
          });
          expect(db.prepare('SELECT COUNT(*) AS n FROM field_mapping_versions').get()).toEqual({
            n: 0,
          });
        }
      );

      it.each([
        ['a global ar_super_admin', [{ role: 'role_ar_super_admin', scope: 'global' }]],
        [
          'a viewer for this tenant only who is also a global ar_super_admin',
          [
            { role: 'role_ar_viewer', scope: 'tenant' },
            { role: 'role_ar_super_admin', scope: 'global' },
          ],
        ],
        [
          'a global viewer and a global ar_super_admin',
          [
            { role: 'role_ar_viewer', scope: 'global' },
            { role: 'role_ar_super_admin', scope: 'global' },
          ],
        ],
      ] as Array<[string, Assignment[]]>)(
        'lets %s change the platform’s sets',
        async (_name, assignments) => {
          const { session, db } = await context();
          const actor = signIn(db, assignments);

          const created = await create(session, actor, 'allowed');

          expect(created.status).toBe(200);
          expect(created.result.owner).toBe('platform');
          expect((await session.call(actor, 'DELETE', `/${created.result.id}`)).status).toBe(200);
        }
      );

      it('lets the mixed admin keep working on the tenant’s own sets', async () => {
        const { session, db } = await context();
        const actor = signIn(db, [
          { role: 'role_ar_viewer', scope: 'global' },
          { role: 'role_ar_super_admin', scope: 'tenant' },
        ]);

        const created = await session.call(actor, 'POST', '', {
          fieldMappingKey: 'own',
          displayName: 'Own',
        });

        expect(created.status).toBe(200);
        expect(created.result.owner).toBe('tenant');
      });
    });

    it('lets a caller with a platform role and a global scope do all of it', async () => {
      const { api, createPlatformSet } = await setup();
      for (const auth of [
        { roles: [], permissions: ['*'], globalPermissions: ['*'], tenantScope: ['*'] },
        { roles: ['ar_super_admin'], globalRoles: ['ar_super_admin'], tenantScope: ['*'] },
        {
          roles: ['ar_super_admin'],
          globalRoles: ['ar_super_admin'],
          tenantScope: ['tenant-a', '*'],
        },
        {
          roles: ['viewer', 'ar_super_admin'],
          globalRoles: ['viewer', 'ar_super_admin'],
          tenantScope: ['*'],
        },
      ]) {
        const created = await api.call(actorOf(auth), 'POST', '', {
          fieldMappingKey: `k-${JSON.stringify(auth).length}-${Math.random()}`,
          displayName: 'Platform',
          ownerScopeType: 'platform',
        });
        expect([JSON.stringify(auth), created.status]).toEqual([JSON.stringify(auth), 200]);
        expect(created.result.owner).toBe('platform');
        expect((await api.call(actorOf(auth), 'DELETE', `/${created.result.id}`)).status).toBe(200);
      }
      await createPlatformSet();
    });

    it('does not take a global scope without a platform role for platform authority', async () => {
      const { api } = await setup();

      const response = await api.call(
        actorOf({
          roles: ['ar_tenant_admin'],
          permissions: ['admin:settings:write'],
          tenantScope: ['*'],
        }),
        'POST',
        '',
        { fieldMappingKey: 'p', displayName: 'P', ownerScopeType: 'platform' }
      );

      expect(response.status).toBe(403);
    });

    it('still lets a tenant-limited caller manage the tenant’s own sets', async () => {
      const { api } = await setup();

      const response = await api.call(
        actorOf({ roles: ['ar_super_admin'], permissions: ['*'], tenantScope: ['tenant-a'] }),
        'POST',
        '',
        { fieldMappingKey: 'own', displayName: 'Own' }
      );

      expect(response.status).toBe(200);
      expect(response.result.owner).toBe('tenant');
    });
  });

  describe('references spelled the way the runtime also reads them', () => {
    const spellings: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [
        'a source by fieldKey',
        { side: 'source', namespace: 'authrim.canonical', fieldKey: 'email' },
        {},
      ],
      [
        'a source by nodeId',
        { side: 'source', namespace: 'authrim.canonical', nodeId: 'email' },
        {},
      ],
      [
        'a source by fieldKey with the catalog entry as catalog_entry_id',
        {
          side: 'source',
          namespace: 'authrim.profile',
          fieldKey: 'email',
          catalog_entry_id: 'platform_canonical_email',
        },
        {},
      ],
      [
        'a destination by fieldKey',
        { side: 'source', namespace: 'authrim.profile', path: 'email' },
        { path: undefined, fieldKey: 'email' },
      ],
      [
        'a source whose path wins over its fieldKey',
        { side: 'source', namespace: 'authrim.profile', path: 'email', fieldKey: 'not_a_field' },
        {},
      ],
    ];

    it.each(spellings)(
      'saves, compiles, activates and resolves %s',
      async (_name, sourceRef, targetOverride) => {
        const { api, adapter, platformProfile, createPlatformSet } = await setup();
        const setId = await createPlatformSet();
        const rule = emailRule(platformProfile);
        rule.edges[0].sourceRef = sourceRef as never;
        rule.edges[0].targetRef = { ...rule.edges[0].targetRef, ...targetOverride } as never;
        const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
          versionLabel: 'v1',
          rules: [rule],
        });
        expect(version.status).toBe(200);
        const versionId = version.result.id as string;
        const compiled = await api.call(
          PLATFORM_ADMIN,
          'POST',
          `/${setId}/versions/${versionId}/compile`,
          { catalogVersionId: PLATFORM_CATALOG_VERSION }
        );
        expect(compiled.status).toBe(200);

        const activated = await api.call(
          PLATFORM_ADMIN,
          'POST',
          `/${setId}/versions/${versionId}/activate`,
          { snapshotId: compiled.result.id, activationScope: {} }
        );
        expect(activated.status).toBe(200);

        const binding = await loadMappingBindingBySetId({
          adapter,
          tenantId: 'tenant-b',
          setId,
          tier: 'platform_default',
          protocol: 'oidc',
          role: 'op',
        });
        expect(binding.edges[0].sourceRef.path).toBe('email');
        expect(binding.edges[0].targetRef.path).toBe('email');
      }
    );

    // The runtime reads the catalog by the stable field ID, the stored rows by either ID: a source
    // that names the catalog entry by its row ID must come out the same through the release
    // check, in the tenant's context, as one that names it by the stable ID.
    describe('a source naming the catalog entry in each way, through to the tenant’s ID token and UserInfo', () => {
      // A profile that releases email without the user's selection (required), so a value that is
      // read shows up in the claims.
      const RELEASED_EMAIL_SCHEMA = {
        destinationType: 'oidc',
        claims: [
          {
            claimName: 'sub',
            required: true,
            nullable: false,
            surfaces: ['id_token', 'userinfo'],
            classification: 'internal',
          },
          {
            claimName: 'email',
            required: true,
            surfaces: ['id_token', 'userinfo'],
            requiredScopes: ['email'],
            classification: 'pii',
          },
        ],
      };
      const entryForms: Array<[string, Record<string, unknown>]> = [
        ['the row ID (catalogEntryId)', { catalogEntryId: 'platform_canonical_email' }],
        ['the row ID (catalog_entry_id)', { catalog_entry_id: 'platform_canonical_email' }],
        ['the stable ID', { catalogEntryId: 'field.canonical.email' }],
        ['the stable ID (catalog_entry_id)', { catalog_entry_id: 'field.canonical.email' }],
        ['the path alone', {}],
        ['the fieldKey alone', { path: undefined, fieldKey: 'email' }],
        // The reference names its entry and nothing of where to read.
        [
          'the row ID alone',
          { path: undefined, namespace: undefined, catalogEntryId: 'platform_canonical_email' },
        ],
        [
          'the stable ID alone',
          { path: undefined, namespace: undefined, catalogEntryId: 'field.canonical.email' },
        ],
        [
          'the row ID alone (catalog_entry_id)',
          { path: undefined, namespace: undefined, catalog_entry_id: 'platform_canonical_email' },
        ],
        [
          'the stable ID alone, with the namespace',
          { path: undefined, catalogEntryId: 'field.canonical.email' },
        ],
      ];

      it.each(entryForms)('saves, compiles, activates and releases %s', async (_name, entry) => {
        const { api, adapter, repository, createPlatformSet } = await setup();
        const profileId = await createActiveOidcProfile(repository, 'platform', {
          schema: RELEASED_EMAIL_SCHEMA,
          profileKey: 'oidc_platform_released_email',
        });
        const setId = await createPlatformSet();
        const rule = emailRule(profileId);
        rule.edges[0].sourceRef = {
          side: 'source',
          namespace: 'authrim.canonical',
          path: 'email',
          ...entry,
        } as never;
        // The released claim is a catalog entry too: the mapping runtime keeps only the values the
        // catalog describes, and the platform catalog describes email by its entry.
        rule.edges[0].targetRef = {
          ...rule.edges[0].targetRef,
          catalogEntryId: 'platform_canonical_email',
        } as never;
        const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
          versionLabel: 'v1',
          rules: [rule],
        });
        expect(version.status).toBe(200);
        const versionId = version.result.id as string;
        const compiled = await api.call(
          PLATFORM_ADMIN,
          'POST',
          `/${setId}/versions/${versionId}/compile`,
          { catalogVersionId: PLATFORM_CATALOG_VERSION }
        );
        expect(compiled.status).toBe(200);
        const activated = await api.call(
          PLATFORM_ADMIN,
          'POST',
          `/${setId}/versions/${versionId}/activate`,
          { snapshotId: compiled.result.id, activationScope: {} }
        );
        expect(activated.status).toBe(200);

        // Another tenant, the platform's default naming the set, ID token and UserInfo: the value
        // of the user's email is read and released.
        const core = sqliteAdapter(openCoreDatabase());
        const env = {
          DB_ADMIN: adapter,
          SETTINGS: {
            get: async (key: string) =>
              key === 'settings:platform:identity-mapping'
                ? JSON.stringify({ 'identity_mapping.oidc_default_set_id': setId })
                : null,
          },
        } as never;
        for (const destinationSurface of ['id_token', 'userinfo'] as const) {
          const result = await applyOIDCIdentityMapping({
            adapter: core,
            env,
            tenantId: 'tenant-b',
            clientId: 'client-b',
            destinationSurface,
            grantedScopes: ['openid', 'email'],
            claims: { sub: 'user-1' },
            sourceAttributes: { email: 'alice@example.com' },
          });
          expect(result.binding).toMatchObject({
            tenantId: PLATFORM_MAPPING_TENANT_ID,
            fieldMappingSetId: setId,
          });
          expect(result.claims).toMatchObject({ sub: 'user-1', email: 'alice@example.com' });
        }
      });
    });

    // A source that names only its entry reads the entry's place, so nothing can be read from a
    // reference whose entry is not a place to read, or that does not exist.
    describe('a source that names only a catalog entry that is not a place to read', () => {
      const unreadable: Array<[string, Record<string, unknown>]> = [
        ['an ID the catalog does not have', { catalogEntryId: 'field.canonical.nothing' }],
        ['an ID the catalog does not have (row)', { catalogEntryId: 'platform_nothing' }],
        [
          'an entry of another namespace than the one the reference gives',
          { namespace: 'authrim.custom_claims', catalogEntryId: 'field.canonical.email' },
        ],
        [
          'an entry of another place than the namespace the reference gives reads',
          { namespace: 'authrim.claims', catalogEntryId: 'platform_canonical_email' },
        ],
      ];

      it.each([
        ['the row ID', 'platform_canonical_email'],
        ['the stable ID', 'field.canonical.email'],
      ])(
        'holds email to its classification at activation, naming only %s',
        async (_name, catalogEntryId) => {
          const { api, repository, createPlatformSet } = await setup();
          // A profile whose email claim is classified lower than email is.
          const unscoped = await createActiveOidcProfile(repository, 'platform', {
            profileKey: 'oidc_platform_unscoped',
            schema: {
              destinationType: 'oidc',
              claims: [
                {
                  claimName: 'sub',
                  required: true,
                  nullable: false,
                  surfaces: ['id_token', 'userinfo'],
                },
                {
                  claimName: 'email',
                  surfaces: ['id_token'],
                  requiredScopes: ['email'],
                  classification: 'public',
                },
              ],
            },
          });
          const setId = await createPlatformSet();
          const rule = emailRule(unscoped);
          rule.edges[0].sourceRef = {
            side: 'source',
            namespace: 'authrim.canonical',
            catalogEntryId,
          } as never;
          const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
            versionLabel: 'v1',
            rules: [rule],
          });
          const versionId = version.result.id as string;
          const compiled = await api.call(
            PLATFORM_ADMIN,
            'POST',
            `/${setId}/versions/${versionId}/compile`,
            { catalogVersionId: PLATFORM_CATALOG_VERSION }
          );
          expect(compiled.status).toBe(200);

          const activation = await api.call(
            PLATFORM_ADMIN,
            'POST',
            `/${setId}/versions/${versionId}/activate`,
            { snapshotId: compiled.result.id, activationScope: {} }
          );

          // Refused for what email is, not for being a source nobody can classify.
          expect(activation.status).toBe(400);
          expect(activation.json.error_description).toContain(
            'cannot lower classification from pii'
          );
        }
      );

      it.each(unreadable)('is refused when compiled, naming %s', async (_name, entry) => {
        const { api, platformProfile, createPlatformSet } = await setup();
        const setId = await createPlatformSet();
        const rule = emailRule(platformProfile);
        rule.edges[0].sourceRef = {
          side: 'source',
          namespace: 'authrim.canonical',
          path: undefined,
          ...entry,
        } as never;
        const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
          versionLabel: 'v1',
          rules: [rule],
        });

        // Refused when saved (a tenant-defined namespace) or when compiled: never accepted.
        if (version.status !== 200) {
          expect(version.status).toBe(400);
          return;
        }
        const compiled = await api.call(
          PLATFORM_ADMIN,
          'POST',
          `/${setId}/versions/${version.result.id}/compile`,
          { catalogVersionId: PLATFORM_CATALOG_VERSION }
        );

        expect(compiled.status).toBe(400);
      });
    });

    // email is pii; email_verified is internal. A source that reads email and names the entry of
    // email_verified (by either ID) must never take the lower classification from the ID.
    describe('a source that reads email and names the catalog entry of another place', () => {
      const wrongEntries: Array<[string, Record<string, unknown>]> = [
        ['the row ID', { catalogEntryId: 'platform_canonical_email_verified' }],
        [
          'the row ID (catalog_entry_id)',
          { catalog_entry_id: 'platform_canonical_email_verified' },
        ],
        ['the stable ID', { catalogEntryId: 'field.canonical.email_verified' }],
      ];
      const mismatched = (platformProfile: string, entry: Record<string, unknown>) => {
        const rule = emailRule(platformProfile);
        rule.edges[0].sourceRef = {
          side: 'source',
          namespace: 'authrim.canonical',
          path: 'email',
          ...entry,
        } as never;
        return rule;
      };

      it.each(wrongEntries)('is refused when compiled, naming %s', async (_name, entry) => {
        const { api, platformProfile, createPlatformSet } = await setup();
        const setId = await createPlatformSet();
        const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
          versionLabel: 'v1',
          rules: [mismatched(platformProfile, entry)],
        });
        expect(version.status).toBe(200);

        const compiled = await api.call(
          PLATFORM_ADMIN,
          'POST',
          `/${setId}/versions/${version.result.id}/compile`,
          { catalogVersionId: PLATFORM_CATALOG_VERSION }
        );

        expect(compiled.status).toBe(400);
        expect(compiled.json.error_description).toContain('not a field of the platform catalog');
      });

      it.each(wrongEntries)(
        'is refused at activation when it is put in after compiling, naming %s',
        async (_name, entry) => {
          const { api, db, platformProfile, createPlatformSet } = await setup();
          const setId = await createPlatformSet();
          const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
            versionLabel: 'v1',
            rules: [emailRule(platformProfile)],
          });
          const versionId = version.result.id as string;
          const compiled = await api.call(
            PLATFORM_ADMIN,
            'POST',
            `/${setId}/versions/${versionId}/compile`,
            { catalogVersionId: PLATFORM_CATALOG_VERSION }
          );
          expect(compiled.status).toBe(200);
          db.prepare('UPDATE mapping_rule_edges SET source_ref_json = ?').run(
            JSON.stringify({
              side: 'source',
              namespace: 'authrim.canonical',
              path: 'email',
              ...entry,
            })
          );

          const activation = await api.call(
            PLATFORM_ADMIN,
            'POST',
            `/${setId}/versions/${versionId}/activate`,
            { snapshotId: compiled.result.id, activationScope: {} }
          );

          expect(activation.status).toBe(400);
        }
      );
    });

    it('still refuses a source spelled by fieldKey that the catalog does not have', async () => {
      const { api, platformProfile, createPlatformSet } = await setup();
      const setId = await createPlatformSet();
      const rule = emailRule(platformProfile);
      rule.edges[0].sourceRef = {
        side: 'source',
        namespace: 'authrim.canonical',
        fieldKey: 'not_a_field',
      } as never;
      const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: 'v1',
        rules: [rule],
      });

      const compiled = await api.call(
        PLATFORM_ADMIN,
        'POST',
        `/${setId}/versions/${version.result.id}/compile`,
        { catalogVersionId: PLATFORM_CATALOG_VERSION }
      );

      expect(compiled.status).toBe(400);
      expect(compiled.json.error_description).toContain('not a field of the platform catalog');
    });

    it.each(['profileId', 'profile_id'])(
      'judges a tenant’s own source by the place it reads, not by an empty path (profile as %s)',
      async (profileKey) => {
        // A tenant mapping that reads email by fieldKey into a claim less sensitive than email
        // used to pass the check (the source was classified by its empty path, so it was unknown)
        // and is now judged as what the runtime reads.
        const { api, db, repository } = await setup();
        db.prepare(
          `INSERT INTO field_catalogs (id, tenant_id, catalog_key, display_name, lifecycle_state, created_at, updated_at)
         VALUES ('tc', 'tenant-a', 'tenant.catalog', 'Tenant', 'active', 1, 1)`
        ).run();
        db.prepare(
          `INSERT INTO field_catalog_versions (id, tenant_id, catalog_id, version_label, bundle_hash, lifecycle_state, created_at, updated_at)
         VALUES ('tcv', 'tenant-a', 'tc', 'v1', 'h', 'active', 1, 1)`
        ).run();
        db.prepare(
          `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, cardinality, classification, created_at, updated_at)
         VALUES ('te', 'tenant-a', 'tcv', 'field.canonical.email', 'authrim.canonical', 'email', 'canonical', 'string', 'single', 'pii', 1, 1)`
        ).run();
        const profile = await repository.createDestinationProfile('tenant-a', {
          destinationType: 'oidc',
          profileKey: 'lowered',
          displayName: 'Lowered',
          schema: {
            destinationType: 'oidc',
            claims: [
              {
                claimName: 'sub',
                required: true,
                nullable: false,
                surfaces: ['id_token', 'userinfo'],
                classification: 'internal',
              },
              {
                claimName: 'email',
                surfaces: ['id_token'],
                requiredScopes: ['email'],
                classification: 'internal',
              },
            ],
          },
        } as never);
        await repository.reviewDestinationProfileVersion(
          'tenant-a',
          profile.id,
          profile.version.id
        );
        await repository.activateDestinationProfileVersion(
          'tenant-a',
          profile.id,
          profile.version.id
        );
        const own = await api.call(TENANT_A_ADMIN, 'POST', '', {
          fieldMappingKey: 'own',
          displayName: 'Own',
        });
        const rule = emailRule(profile.id);
        const { profileId: _profileId, ...target } = rule.edges[0].targetRef as Record<
          string,
          unknown
        >;
        rule.edges[0].targetRef = { ...target, [profileKey]: profile.id } as never;
        rule.edges[0].sourceRef = {
          side: 'source',
          namespace: 'authrim.canonical',
          fieldKey: 'email',
        } as never;
        const version = await api.call(TENANT_A_ADMIN, 'POST', `/${own.result.id}/versions`, {
          versionLabel: 'v1',
          rules: [rule],
        });
        expect(version.status).toBe(200);
        const compiled = await api.call(
          TENANT_A_ADMIN,
          'POST',
          `/${own.result.id}/versions/${version.result.id}/compile`,
          { catalogVersionId: 'tcv' }
        );
        expect(compiled.status).toBe(200);

        const activation = await api.call(
          TENANT_A_ADMIN,
          'POST',
          `/${own.result.id}/versions/${version.result.id}/activate`,
          { snapshotId: compiled.result.id, activationScope: {} }
        );

        expect(activation.status).toBe(400);
        expect(activation.json.error_description).toContain('cannot lower classification');
      }
    );
  });

  it('lets a platform admin deactivate, roll back and delete the platform’s set', async () => {
    const { api, platformProfile, createPlatformSet, db } = await setup();
    const setId = await createPlatformSet();
    const make = async (label: string) => {
      const version = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/versions`, {
        versionLabel: label,
        rules: [emailRule(platformProfile)],
      });
      const versionId = version.result.id as string;
      const compiled = await api.call(
        PLATFORM_ADMIN,
        'POST',
        `/${setId}/versions/${versionId}/compile`,
        { catalogVersionId: PLATFORM_CATALOG_VERSION }
      );
      const activated = await api.call(
        PLATFORM_ADMIN,
        'POST',
        `/${setId}/versions/${versionId}/activate`,
        {
          snapshotId: compiled.result.id,
          activationScope: { kind: 'tenant' },
          holderId: 'one-holder',
        }
      );
      expect(activated.status).toBe(200);
      return versionId;
    };
    const first = await make('v1');
    await make('v2');

    const rollback = await api.call(PLATFORM_ADMIN, 'POST', `/${setId}/rollback`, {});
    expect(rollback.status).toBe(200);
    expect(rollback.result.fieldMappingVersionId).toBe(first);

    expect((await api.call(PLATFORM_ADMIN, 'DELETE', `/${setId}`)).status).toBe(409);
    const deactivated = await api.call(
      PLATFORM_ADMIN,
      'POST',
      `/${setId}/versions/${first}/deactivate`,
      {}
    );
    expect(deactivated.status).toBe(200);
    expect((await api.call(PLATFORM_ADMIN, 'DELETE', `/${setId}`)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM field_mapping_sets').get()).toEqual({ n: 0 });
  });
});
