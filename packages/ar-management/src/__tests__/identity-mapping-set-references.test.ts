import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import {
  adminAuthMiddleware,
  PLATFORM_MAPPING_TENANT_ID,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: vi.fn(async () => undefined),
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

import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import {
  adminIdentityFieldMappingSetDeleteHandler,
  adminIdentityFieldMappingSetRollbackHandler,
  adminIdentityFieldMappingVersionActivateHandler,
  adminIdentityFieldMappingVersionDeactivateHandler,
  adminIdentityMappingDestinationProfileDeleteHandler,
} from '../identity-mapping-control-plane';
import { adminIdentityMappingUsageHandler } from '../identity-mapping-usage';
import settingsV2 from '../routes/settings-v2';
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
import {
  insertOAuthClient,
  insertSamlProvider,
  insertTenant,
  openCoreDatabase,
} from './helpers/core-database';
import {
  seedDestinationProfile,
  seedMapping,
  seedMappingVersion,
} from './helpers/identity-mapping-seed';
import type { SQLiteDatabase } from './test-sqlite';

/**
 * What stops a Mapping Set being deleted, switched off or swapped while something names it, and
 * the usage API that shows the same. Real Admin schema and Core `oauth_clients` /
 * `identity_providers` on SQLite, the real admin authentication and route access, the real
 * Settings API for the defaults.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const SETS = '/api/admin/field-mapping/field-mapping-sets';
const USAGE = '/api/admin/identity-mapping/usage';
const TENANT_SETTINGS = `/api/admin/tenants/${TENANT}/settings/identity-mapping`;
const PLATFORM_SETTINGS = '/api/admin/platform/settings/identity-mapping';

/** A tenant admin of the tenant only, and one who can only read. */
const TENANT_VIEWER: Assignment[] = [{ role: 'role_ar_viewer', scope: 'tenant' }];

function kvStore() {
  const store = new Map<string, string>();
  return {
    store,
    namespace: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace,
  };
}

let idempotency = 0;

function setup() {
  const coreA = openCoreDatabase();
  const coreB = openCoreDatabase();
  const directory = openCoreDatabase();
  for (const id of [TENANT, 'tenant-b']) insertTenant(directory, id);
  const adapters = { [TENANT]: sqliteAdapter(coreA), 'tenant-b': sqliteAdapter(coreB) };
  const directoryAdapter = sqliteAdapter(directory);
  const directoryQueries: Array<{ sql: string; params?: unknown[] }> = [];
  const countingDirectory = {
    ...directoryAdapter,
    query: async (sql: string, params?: unknown[]) => {
      directoryQueries.push({ sql, params });
      return directoryAdapter.query(sql, params);
    },
  };
  const settings = kvStore();

  const { DB_ADMIN: _loggingAdmin, ...loggingEnv } = logging.env;
  const context = setupApp(
    (app) => {
      app.use('*', async (c, next) => {
        (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
          tenantId: TENANT,
          coreDb: adapters[TENANT],
          route: {},
        });
        await next();
      });
      app.use(
        '/api/admin/*',
        adminAuthMiddleware({ plane: 'tenant' }),
        enforceDeclaredAdminRouteAccess()
      );
      app.delete(`${SETS}/:fieldMappingSetId`, adminIdentityFieldMappingSetDeleteHandler);
      app.post(
        `${SETS}/:fieldMappingSetId/versions/:fieldMappingVersionId/activate`,
        adminIdentityFieldMappingVersionActivateHandler
      );
      app.post(
        `${SETS}/:fieldMappingSetId/versions/:fieldMappingVersionId/deactivate`,
        adminIdentityFieldMappingVersionDeactivateHandler
      );
      app.post(`${SETS}/:fieldMappingSetId/rollback`, adminIdentityFieldMappingSetRollbackHandler);
      app.delete(
        '/api/admin/field-mapping/destination-profiles/:destinationProfileId',
        adminIdentityMappingDestinationProfileDeleteHandler
      );
      app.get(USAGE, adminIdentityMappingUsageHandler);
      app.route('/api/admin', settingsV2);
    },
    {
      ...loggingEnv,
      DB: countingDirectory,
      SETTINGS: settings.namespace,
      AUTHRIM_CONFIG: settings.namespace,
      TEST_CORES: adapters,
      BASE_DOMAIN: 'example.com',
      ISSUER_URL: 'https://id.example.com',
      RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('rate-limit-id'),
        get: vi.fn().mockReturnValue({
          incrementRpc: vi.fn().mockResolvedValue({
            allowed: true,
            current: 1,
            limit: 100,
            resetAt: Math.floor(Date.now() / 1000) + 60,
          }),
        }),
      },
    }
  );
  // The tenant's set and the platform's, each with its profile; and another tenant's.
  seedMapping(context.db, { owner: TENANT, id: 'a' });
  seedDestinationProfile(context.db, { owner: TENANT, id: 'profile-a' });
  seedMapping(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
  seedDestinationProfile(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'profile-plat' });
  seedMapping(context.db, { owner: 'tenant-b', id: 'other' });
  seedDestinationProfile(context.db, { owner: 'tenant-b', id: 'profile-other' });

  const cookie = (assignments: Assignment[] = TENANT_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const mutate = (who: string, method: string, path: string, body: unknown = {}) => {
    idempotency += 1;
    return context.call(who, method, path, body, { 'Idempotency-Key': `key-${idempotency}` });
  };
  const deactivate = (who: string, setId: string, versionId: string) =>
    mutate(who, 'POST', `${SETS}/${setId}/versions/${versionId}/deactivate`);
  const remove = (who: string, setId: string) => mutate(who, 'DELETE', `${SETS}/${setId}`);
  const usage = (who: string, setId: string) =>
    context.call(who, 'GET', `${USAGE}?set_id=${encodeURIComponent(setId)}`);
  const count = (sql: string) => (context.db.prepare(sql).get() as { n: number }).n;
  /** A reference in each place, to be added to a database. */
  const refs = {
    tenantDefault: (setId: string, tenantId = TENANT) => saveDefault(context.db, tenantId, setId),
    platformDefault: (setId: string) => saveDefault(context.db, null, setId),
    client: (db: SQLiteDatabase, setId: string, tenantId = TENANT, clientId = 'app-1') =>
      insertOAuthClient(db, { tenantId, clientId, identityMapping: { fieldMappingSetId: setId } }),
    saml: (db: SQLiteDatabase, setId: string, tenantId = TENANT) =>
      insertSamlProvider(db, {
        tenantId,
        id: 'sp-1',
        config: { identityMapping: { fieldMappingSetId: setId } },
      }),
    credential: (setId: string, tenantId = TENANT) => {
      context.db
        .prepare(
          `INSERT INTO credential_profiles (id, tenant_id, profile_key, display_name, created_at, updated_at)
           VALUES ('cp-1', ?, 'cp', 'Profile', 1, 1)`
        )
        .run(tenantId);
      context.db
        .prepare(
          `INSERT INTO credential_profile_versions (id, tenant_id, credential_profile_id, version_number, lifecycle_state,
             credential_configuration_id, issuance_flow_id, issuance_mapping_set_id, claim_allowlist_json, created_at, updated_at)
           VALUES ('cpv-1', ?, 'cp-1', 1, 'published', 'cfg', 'flow', ?, '[]', 1, 1)`
        )
        .run(tenantId, setId);
    },
    federation: (
      setId: string,
      field: 'idpFieldMappingSetId' | 'spFieldMappingSetId' = 'spFieldMappingSetId',
      tenantId = TENANT
    ) =>
      context.db
        .prepare(
          `INSERT INTO federation_trust_sources (id, tenant_id, source_type, source_key, display_name, lifecycle_state, protocol_payload_json, created_at, updated_at)
           VALUES ('fts-1', ?, 'saml_aggregate', 'agg', 'Aggregate', 'active', ?, 1, 1)`
        )
        .run(
          tenantId,
          JSON.stringify({
            runtimeResolution: {
              mode: 'automatic',
              roles: [field === 'idpFieldMappingSetId' ? 'saml_idp' : 'saml_sp'],
              [field]: setId,
            },
          })
        ),
    scim: (setId: string, tenantId = TENANT) =>
      settings.store.set(
        `settings:tenant:${tenantId}:scim`,
        JSON.stringify({ enabled: true, mappingSetId: setId })
      ),
  };
  return {
    ...context,
    coreA,
    coreB,
    directory,
    directoryQueries,
    adapters,
    settings,
    cookie,
    mutate,
    deactivate,
    remove,
    usage,
    count,
    refs,
  };
}

/** A default written the way the settings store writes it (a flat map of key to value). */
function saveDefault(db: SQLiteDatabase, tenantId: string | null, setId: string): void {
  const json = JSON.stringify({ [KEY]: setId });
  const version = `sha256:${'0'.repeat(16)}`;
  if (tenantId === null) {
    db.prepare(
      `INSERT INTO platform_settings_documents (category, document_json, version, revision, projection_state, updated_at, projected_at)
       VALUES ('identity-mapping', ?, ?, 1, 'applied', 1, 1)`
    ).run(json, version);
  } else {
    db.prepare(
      `INSERT INTO tenant_settings_documents (tenant_id, scope_type, scope_id, category, document_json, version, revision, projection_state, updated_at, projected_at)
       VALUES (?, 'tenant', ?, 'identity-mapping', ?, ?, 1, 'applied', 1, 1)`
    ).run(tenantId, tenantId, json, version);
  }
}

const setExists = (t: ReturnType<typeof setup>, setId: string) =>
  t.count(`SELECT COUNT(*) AS n FROM field_mapping_sets WHERE id = '${setId}'`) === 1;
const activeActivations = (t: ReturnType<typeof setup>, setId: string) =>
  t.count(
    `SELECT COUNT(*) AS n FROM field_mapping_activations WHERE field_mapping_set_id = '${setId}' AND lifecycle_state = 'active'`
  );

let logging: Awaited<ReturnType<typeof logProducerFixture>>;
afterEach(() => logging?.close());
beforeEach(async () => {
  logging = await logProducerFixture('scheduled');
  idempotency = 0;
  vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mockClear();
});

describe('a set nobody names', () => {
  it('is deleted as before: not while its activation is active, then yes', async () => {
    const t = setup();
    const admin = t.cookie();

    const early = await t.remove(admin, 'set-a');
    expect(early.status).toBe(409);
    expect(early.json.error_description).toBe(
      'active field mapping set must be deactivated before deletion'
    );
    expect(early.json.references).toBeUndefined();

    expect((await t.deactivate(admin, 'set-a', 'ver-a')).status).toBe(200);
    expect(activeActivations(t, 'set-a')).toBe(0);
    const deleted = await t.remove(admin, 'set-a');
    expect(deleted.status).toBe(200);
    expect(setExists(t, 'set-a')).toBe(false);
  });

  it('can be deleted when only other sets are named', async () => {
    const t = setup();
    t.refs.tenantDefault('set-plat');
    t.refs.client(t.coreA, 'set-other');
    const admin = t.cookie();
    expect((await t.deactivate(admin, 'set-a', 'ver-a')).status).toBe(200);
    expect((await t.remove(admin, 'set-a')).status).toBe(200);
  });
});

describe('a set that is named', () => {
  const places: Array<[string, (t: ReturnType<typeof setup>) => void, string]> = [
    ['the tenant default', (t) => t.refs.tenantDefault('set-a'), 'tenant_default'],
    ['an app', (t) => t.refs.client(t.coreA, 'set-a'), 'client'],
    ['a SAML provider', (t) => t.refs.saml(t.coreA, 'set-a'), 'saml_provider'],
    ['a credential profile', (t) => t.refs.credential('set-a'), 'credential_profile'],
    ['SCIM', (t) => t.refs.scim('set-a'), 'scim'],
  ];

  it.each(places)(
    'cannot be deactivated or deleted while %s names it',
    async (_name, add, kind) => {
      const t = setup();
      add(t);
      const admin = t.cookie();

      const deactivated = await t.deactivate(admin, 'set-a', 'ver-a');

      expect(deactivated.status).toBe(409);
      expect(deactivated.json).toMatchObject({
        error: 'conflict',
        reason: 'referenced',
        references: { count: 1, items: [expect.objectContaining({ kind })], scanComplete: true },
      });
      expect(activeActivations(t, 'set-a')).toBe(1);

      // Even with the activation gone (it was retired by hand), the set is not deleted.
      t.db.exec("UPDATE field_mapping_activations SET lifecycle_state = 'retired'");
      const deleted = await t.remove(admin, 'set-a');
      expect(deleted.status).toBe(409);
      expect(deleted.json).toMatchObject({ error: 'conflict', reason: 'referenced' });
      expect(setExists(t, 'set-a')).toBe(true);
    }
  );

  it('can be deactivated and deleted once the last reference is gone', async () => {
    const t = setup();
    t.refs.client(t.coreA, 'set-a');
    const admin = t.cookie();
    expect((await t.deactivate(admin, 'set-a', 'ver-a')).status).toBe(409);

    t.coreA.exec('DELETE FROM oauth_clients');

    expect((await t.deactivate(admin, 'set-a', 'ver-a')).status).toBe(200);
    expect((await t.remove(admin, 'set-a')).status).toBe(200);
  });

  it('is found by its legacy spelling in an app too', async () => {
    const t = setup();
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'legacy',
      identityMapping: { policySetId: 'set-a' },
    });
    const refused = await t.deactivate(t.cookie(), 'set-a', 'ver-a');
    expect(refused.status).toBe(409);
    expect(refused.json.references.items).toEqual([
      expect.objectContaining({ kind: 'client', clientId: 'legacy' }),
    ]);
  });

  it('does not stop a version that is not the one in use from being deactivated', async () => {
    const t = setup();
    seedMappingVersion(t.db, { owner: TENANT, setSeed: 'a', id: 'a2' });
    t.refs.client(t.coreA, 'set-a');
    expect((await t.deactivate(t.cookie(), 'set-a', 'ver-a2')).status).toBe(200);
    expect(activeActivations(t, 'set-a')).toBe(1);
  });

  it('shows only its own tenant’s references, at most the first of them', async () => {
    const t = setup();
    for (let index = 0; index < 25; index += 1) {
      t.refs.client(t.coreA, 'set-a', TENANT, `app-${String(index).padStart(2, '0')}`);
    }
    const refused = await t.deactivate(t.cookie(), 'set-a', 'ver-a');
    expect(refused.json.references).toMatchObject({
      count: 25,
      itemsTruncated: true,
      items: expect.any(Array),
    });
    expect(refused.json.references.items).toHaveLength(20);
  });
});

describe('a set that could not be checked everywhere', () => {
  it('is refused as scan_incomplete when an app table cannot be read', async () => {
    const t = setup();
    t.coreA.exec('DROP TABLE oauth_clients');
    const refused = await t.deactivate(t.cookie(), 'set-a', 'ver-a');
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      reason: 'scan_incomplete',
      references: {
        count: 0,
        scanComplete: false,
        unscanned: { count: 1, items: [expect.objectContaining({ area: 'tenant_clients' })] },
      },
    });
    expect(JSON.stringify(refused.json)).not.toContain('no such table');
    expect(activeActivations(t, 'set-a')).toBe(1);
  });

  it('is refused for a platform set when a tenant’s Core database cannot be had, with the tenant named only to global authority', async () => {
    const t = setup();
    insertTenant(t.directory, 'tenant-gone');
    const global = t.cookie(GLOBAL_SUPER_ADMIN);

    const refused = await t.deactivate(global, 'set-plat', 'ver-plat');

    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe('scan_incomplete');
    expect(refused.json.references.unscanned.items).toContainEqual(
      expect.objectContaining({ tenantId: 'tenant-gone', reason: 'core_database_unavailable' })
    );
    expect(activeActivations(t, 'set-plat')).toBe(1);

    // The tenant’s admin is told that something was not looked at, not which tenant.
    const seen = await t.usage(t.cookie(TENANT_SUPER_ADMIN), 'set-plat');
    expect(seen.status).toBe(200);
    expect(seen.json.usage).toMatchObject({ scanComplete: false });
    expect(JSON.stringify(seen.json)).not.toContain('tenant-gone');
  });
});

describe('a platform set that other tenants name', () => {
  function named() {
    const t = setup();
    t.refs.platformDefault('set-plat');
    t.refs.tenantDefault('set-plat', 'tenant-b');
    t.refs.client(t.coreB, 'set-plat', 'tenant-b', 'b-app');
    t.refs.client(t.coreA, 'set-plat', TENANT, 'a-app');
    return t;
  }

  it('is refused to a platform admin with everything that names it', async () => {
    const t = named();
    const refused = await t.deactivate(t.cookie(GLOBAL_SUPER_ADMIN), 'set-plat', 'ver-plat');
    expect(refused.status).toBe(409);
    expect(refused.json.references.count).toBe(4);
    expect(refused.json.references.items).toEqual(
      expect.arrayContaining([
        { kind: 'platform_default' },
        { kind: 'tenant_default', tenantId: 'tenant-b' },
        { kind: 'client', tenantId: 'tenant-b', clientId: 'b-app' },
        { kind: 'client', tenantId: TENANT, clientId: 'a-app' },
      ])
    );
    expect(refused.json.references.otherTenants).toBeUndefined();
  });

  it('is shown to a tenant admin as its own references and a count of the others', async () => {
    const t = named();
    const seen = await t.usage(t.cookie(TENANT_SUPER_ADMIN), 'set-plat');

    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ setId: 'set-plat', owner: 'platform', blocksChange: true });
    // Other tenants' apps are not looked at for a caller without global authority; what the Admin
    // database holds of other tenants (their default) is counted.
    expect(seen.json.usage.count).toBe(3);
    expect(seen.json.usage.items).toEqual([
      { kind: 'platform_default' },
      { kind: 'client', tenantId: TENANT, clientId: 'a-app' },
    ]);
    expect(seen.json.usage.otherTenants).toEqual({
      referenceCount: 1,
      tenantCount: 1,
      scanned: false,
    });
    expect(seen.json.blocksChange).toBe(true);
    expect(JSON.stringify(seen.json)).not.toMatch(/tenant-b|b-app/);
  });

  it('is shown in full only to a caller whose wildcard is global', async () => {
    const t = named();
    const global = await t.usage(t.cookie(GLOBAL_SUPER_ADMIN), 'set-plat');
    expect(global.json.usage.items).toHaveLength(4);
    expect(global.json.usage.otherTenants).toBeUndefined();
    expect(global.json.usage.scanComplete).toBe(true);

    // The wildcard held for this tenant only, next to a global viewer assignment, is not global.
    const mixed = await t.usage(t.cookie(GLOBAL_VIEWER_TENANT_SUPER_ADMIN), 'set-plat');
    expect(mixed.status).toBe(200);
    expect(mixed.json.usage.otherTenants).toEqual({
      referenceCount: 1,
      tenantCount: 1,
      scanned: false,
    });
    expect(JSON.stringify(mixed.json)).not.toMatch(/tenant-b|b-app/);
  });

  it('is not changed by a tenant admin, who is not told what names it either', async () => {
    const t = named();
    const refused = await t.deactivate(t.cookie(TENANT_SUPER_ADMIN), 'set-plat', 'ver-plat');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).not.toMatch(/references|tenant-b|b-app/);
  });

  it('is not named by a credential profile that is only a draft, when it is switched off', async () => {
    const t = setup();
    t.refs.credential('set-plat', 'tenant-b');
    t.db.exec("UPDATE credential_profile_versions SET lifecycle_state = 'draft'");
    const global = t.cookie(GLOBAL_SUPER_ADMIN);
    expect((await t.deactivate(global, 'set-plat', 'ver-plat')).status).toBe(200);
  });
});

describe('putting another version in use', () => {
  /** The set in use is `ver-a`; `ver-a2` is another version that can be activated. */
  function twoVersions(profiles?: string[]) {
    const t = setup();
    const second = seedMappingVersion(t.db, { owner: TENANT, setSeed: 'a', id: 'a2', profiles });
    const activate = (who: string) =>
      t.mutate(who, 'POST', `${SETS}/set-a/versions/${second.versionId}/activate`, {
        snapshotId: second.snapshotId,
        activationScope: { kind: 'tenant', id: TENANT },
      });
    return { t, activate, second };
  }

  it('activates a version that still meets what the references need', async () => {
    const { t, activate } = twoVersions();
    t.refs.client(t.coreA, 'set-a');
    const done = await activate(t.cookie());
    expect(done.status).toBe(200);
    expect(
      t.db
        .prepare(
          "SELECT field_mapping_version_id AS v FROM field_mapping_activations WHERE field_mapping_set_id = 'set-a' AND lifecycle_state = 'active'"
        )
        .all()
    ).toEqual([{ v: 'ver-a2' }]);
  });

  it('refuses a version that releases into two Destination Profiles while an app names the set', async () => {
    const { t, activate } = twoVersions(['profile-a', 'profile-extra']);
    t.refs.client(t.coreA, 'set-a');
    const refused = await activate(t.cookie());
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      reason: 'would_break_references',
      references: {
        count: 1,
        violation: { code: 'destination_profile_invalid' },
      },
    });
    expect(
      t.db
        .prepare(
          "SELECT field_mapping_version_id AS v FROM field_mapping_activations WHERE field_mapping_set_id = 'set-a' AND lifecycle_state = 'active'"
        )
        .all()
    ).toEqual([{ v: 'ver-a' }]);
  });

  it('refuses a version whose profile is a SAML one while an app (OIDC) names the set, and accepts it for a SAML provider', async () => {
    const { t, activate } = twoVersions(['profile-saml']);
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-saml', destinationType: 'saml' });
    t.refs.client(t.coreA, 'set-a');
    expect((await activate(t.cookie())).status).toBe(409);
    t.coreA.exec('DELETE FROM oauth_clients');
    t.refs.saml(t.coreA, 'set-a');
    expect((await activate(t.cookie())).status).toBe(200);
  });

  it('allows the same version when nothing names the set', async () => {
    const { t, activate } = twoVersions(['profile-a', 'profile-extra']);
    expect((await activate(t.cookie())).status).toBe(200);
  });

  it('refuses a platform set version that holds what a platform set may not', async () => {
    const t = setup();
    const second = seedMappingVersion(t.db, {
      owner: PLATFORM_MAPPING_TENANT_ID,
      setSeed: 'plat',
      id: 'plat2',
    });
    t.db.exec(
      "INSERT INTO mapping_transform_steps (id, tenant_id, rule_id, edge_id, step_order, operation, parameters_json, created_at, updated_at) VALUES ('t1', 'platform', 'rule-plat2', 'edge-plat2-0', 0, 'oidc_pairwise_sub', '{}', 1, 1)"
    );
    t.refs.client(t.coreA, 'set-plat');
    const refused = await t.mutate(
      t.cookie(GLOBAL_SUPER_ADMIN),
      'POST',
      `${SETS}/set-plat/versions/${second.versionId}/activate`,
      { snapshotId: second.snapshotId, activationScope: { kind: 'tenant', id: 'platform' } }
    );
    expect(refused.status).toBe(409);
    expect(refused.json.references.violation.code).toBe('platform_set_unsafe');
  });

  it('refuses when what names the set could not be checked everywhere, though the version is fine', async () => {
    const { t, activate } = twoVersions();
    t.refs.client(t.coreA, 'set-a');
    t.coreA.exec('DROP TABLE identity_providers');
    const refused = await activate(t.cookie());
    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe('scan_incomplete');
  });

  describe('rolling back', () => {
    /** `ver-a` was in use and replaced by `ver-a2`, which is in use now. */
    function replaced() {
      const { t, second } = twoVersions();
      t.db.exec(
        `UPDATE field_mapping_activations SET lifecycle_state = 'retired', active_until = 150 WHERE id = 'act-a';
         UPDATE compiled_mapping_snapshots SET lifecycle_state = 'retired' WHERE id = 'snap-a';
         UPDATE field_mapping_versions SET lifecycle_state = 'published' WHERE id = 'ver-a';
         UPDATE compiled_mapping_snapshots SET lifecycle_state = 'active' WHERE id = '${second.snapshotId}';
         UPDATE field_mapping_versions SET lifecycle_state = 'active' WHERE id = 'ver-a2';
         INSERT INTO field_mapping_activations (id, tenant_id, field_mapping_set_id, field_mapping_version_id, activation_scope_json, lifecycle_state, active_from, activated_at, created_at, updated_at)
         VALUES ('act-a2', '${TENANT}', 'set-a', 'ver-a2', '{}', 'active', 200, 200, 200, 200);`
      );
      return t;
    }
    const rollback = (t: ReturnType<typeof setup>) =>
      t.mutate(t.cookie(), 'POST', `${SETS}/set-a/rollback`);

    it('goes ahead when nothing names the set', async () => {
      const t = replaced();
      expect((await rollback(t)).status).toBe(200);
    });

    it('is refused while the set is named, since the earlier version has no active compiled snapshot', async () => {
      const t = replaced();
      t.refs.tenantDefault('set-a');
      const refused = await rollback(t);
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({
        reason: 'would_break_references',
        references: { violation: { code: 'snapshot_inactive' } },
      });
      expect(
        t.db
          .prepare(
            "SELECT field_mapping_version_id AS v FROM field_mapping_activations WHERE field_mapping_set_id = 'set-a' AND lifecycle_state = 'active'"
          )
          .all()
      ).toEqual([{ v: 'ver-a2' }]);
    });
  });
});

describe('deleting a Destination Profile', () => {
  const del = (t: ReturnType<typeof setup>, who: string, profileId: string) =>
    t.mutate(who, 'DELETE', `/api/admin/field-mapping/destination-profiles/${profileId}`);

  it('is refused while a set that releases into it is named, and says which set', async () => {
    const t = setup();
    t.refs.client(t.coreA, 'set-a');
    const refused = await del(t, t.cookie(), 'profile-a');
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      error: 'conflict',
      reason: 'referenced',
      references: {
        count: 1,
        items: [expect.objectContaining({ kind: 'client', viaMappingSetId: 'set-a' })],
      },
    });
    expect(t.count("SELECT COUNT(*) AS n FROM destination_profiles WHERE id = 'profile-a'")).toBe(
      1
    );
  });

  it('is deleted as before when the set it serves is not named', async () => {
    const t = setup();
    expect((await del(t, t.cookie(), 'profile-a')).status).toBe(200);
    expect(t.count("SELECT COUNT(*) AS n FROM destination_profiles WHERE id = 'profile-a'")).toBe(
      0
    );
  });

  it('is deleted when only an inactive version of a named set released into it', async () => {
    const t = setup();
    seedMappingVersion(t.db, { owner: TENANT, setSeed: 'a', id: 'a2', profiles: ['profile-x'] });
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-x' });
    t.refs.client(t.coreA, 'set-a');
    expect((await del(t, t.cookie(), 'profile-x')).status).toBe(200);
  });

  it('is refused for the platform’s profile when a tenant’s set that uses it is named, shown in full to global authority only', async () => {
    const t = setup();
    seedMapping(t.db, {
      owner: 'tenant-b',
      id: 'b2',
      profiles: ['profile-plat'],
    });
    t.refs.client(t.coreB, 'set-b2', 'tenant-b', 'b-app');
    const refused = await del(t, t.cookie(GLOBAL_SUPER_ADMIN), 'profile-plat');
    expect(refused.status).toBe(409);
    expect(refused.json.references.items).toEqual([
      expect.objectContaining({ kind: 'client', tenantId: 'tenant-b', clientId: 'b-app' }),
    ]);
    // A tenant admin cannot reach the platform’s profile at all.
    const tenantAdmin = await del(t, t.cookie(TENANT_SUPER_ADMIN), 'profile-plat');
    expect(tenantAdmin.status).toBe(404);
  });
});

describe('the usage API', () => {
  it('answers 404 for a set another tenant owns and for one that does not exist, alike', async () => {
    const t = setup();
    const admin = t.cookie();
    t.refs.client(t.coreB, 'set-other', 'tenant-b');
    const other = await t.usage(admin, 'set-other');
    const nothing = await t.usage(admin, 'set-nothing');
    expect(other.status).toBe(404);
    expect(nothing.status).toBe(404);
    expect(other.json).toEqual(nothing.json);
  });

  it('answers a tenant’s own set, with whether a change would be refused', async () => {
    const t = setup();
    const admin = t.cookie();
    const free = await t.usage(admin, 'set-a');
    expect(free.json).toMatchObject({
      setId: 'set-a',
      owner: 'tenant',
      blocksChange: false,
      usage: { count: 0, items: [], scanComplete: true },
    });
    t.refs.saml(t.coreA, 'set-a');
    const used = await t.usage(admin, 'set-a');
    expect(used.json).toMatchObject({ blocksChange: true, usage: { count: 1 } });
  });

  it('wants a set_id, and the permission to read settings', async () => {
    const t = setup();
    expect((await t.call('authrim_admin_session=none', 'GET', USAGE)).status).toBe(401);
    expect((await t.call(t.cookie(), 'GET', USAGE)).status).toBe(400);
    expect((await t.call(t.cookie(), 'GET', `${USAGE}?set_id=%20set-a`)).status).toBe(400);
    expect((await t.usage(t.cookie(TENANT_VIEWER), 'set-a')).status).toBe(200);
  });

  it('finds the defaults saved through the Settings API, which is how the document is really written', async () => {
    const t = setup();
    const admin = t.cookie(GLOBAL_SUPER_ADMIN);
    const version = async (url: string) => (await t.call(admin, 'GET', url)).json.version as string;

    const tenantSaved = await t.call(admin, 'PATCH', TENANT_SETTINGS, {
      ifMatch: await version(TENANT_SETTINGS),
      set: { [KEY]: 'set-a' },
    });
    const platformSaved = await t.call(admin, 'PATCH', PLATFORM_SETTINGS, {
      ifMatch: await version(PLATFORM_SETTINGS),
      set: { [KEY]: 'set-plat' },
    });
    expect([tenantSaved.status, platformSaved.status]).toEqual([200, 200]);

    const own = await t.usage(admin, 'set-a');
    expect(own.json.usage.items).toEqual([{ kind: 'tenant_default', tenantId: TENANT }]);
    const shared = await t.usage(admin, 'set-plat');
    expect(shared.json.usage.items).toEqual([{ kind: 'platform_default' }]);

    // And so it stops the platform set being switched off.
    const refused = await t.deactivate(admin, 'set-plat', 'ver-plat');
    expect(refused.status).toBe(409);
    expect(refused.json.references.items).toEqual([{ kind: 'platform_default' }]);
  });
});

describe('the limits of the search are platform settings', () => {
  /** Saves the platform's identity-mapping settings through the Settings API. */
  async function savePlatform(t: ReturnType<typeof setup>, set: Record<string, unknown>) {
    const admin = t.cookie(GLOBAL_SUPER_ADMIN);
    const current = await t.call(admin, 'GET', PLATFORM_SETTINGS);
    return t.call(admin, 'PATCH', PLATFORM_SETTINGS, { ifMatch: current.json.version, set });
  }

  it('list as many references as the display limit says, and count all of them', async () => {
    const t = setup();
    for (let index = 0; index < 25; index += 1) {
      t.refs.client(t.coreA, 'set-a', TENANT, `app-${String(index).padStart(2, '0')}`);
    }
    expect((await savePlatform(t, { 'identity_mapping.reference_display_limit': 5 })).status).toBe(
      200
    );

    const refused = await t.deactivate(t.cookie(), 'set-a', 'ver-a');
    const usage = await t.usage(t.cookie(), 'set-a');

    for (const references of [refused.json.references, usage.json.usage]) {
      expect(references).toMatchObject({ count: 25, itemsTruncated: true });
      expect(references.items).toHaveLength(5);
    }
  });

  it('cut a place at the row limit, and give the count as a lower bound', async () => {
    const t = setup();
    for (let index = 0; index < 15; index += 1) {
      t.refs.client(t.coreA, 'set-a', TENANT, `app-${String(index).padStart(2, '0')}`);
    }
    await savePlatform(t, { 'identity_mapping.reference_scan_row_limit': 10 });

    const refused = await t.deactivate(t.cookie(), 'set-a', 'ver-a');

    expect(refused.status).toBe(409);
    expect(refused.json.references).toMatchObject({ count: 10, countIsLowerBound: true });
  });

  it('refuse a platform set’s change when there are more tenants than the tenant limit, though nothing names it', async () => {
    const t = setup();
    const global = t.cookie(GLOBAL_SUPER_ADMIN);
    await savePlatform(t, { 'identity_mapping.reference_scan_tenant_limit': 1 });

    const refused = await t.deactivate(global, 'set-plat', 'ver-plat');

    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe('scan_incomplete');
    expect(refused.json.references.unscanned.items).toContainEqual(
      expect.objectContaining({ area: 'tenant_limit' })
    );
    expect(activeActivations(t, 'set-plat')).toBe(1);

    // With the limit raised the same request goes through.
    await savePlatform(t, { 'identity_mapping.reference_scan_tenant_limit': 50 });
    expect((await t.deactivate(global, 'set-plat', 'ver-plat')).status).toBe(200);
  });

  it('are refused outside their range, and to a tenant', async () => {
    const t = setup();
    for (const value of [0, 101, 2.5, '5']) {
      const saved = await savePlatform(t, { 'identity_mapping.reference_display_limit': value });
      expect(saved.status, String(value)).toBe(400);
    }
    const admin = t.cookie(GLOBAL_SUPER_ADMIN);
    const current = await t.call(admin, 'GET', TENANT_SETTINGS);
    const tenantSaved = await t.call(admin, 'PATCH', TENANT_SETTINGS, {
      ifMatch: current.json.version,
      set: { 'identity_mapping.reference_display_limit': 5 },
    });
    expect(tenantSaved.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Review follow-ups
// ---------------------------------------------------------------------------------------------

/** `ver-a` is in use; `ver-a2` is another version of the same set that can be activated. */
function withSecondVersion(profiles?: string[]) {
  const t = setup();
  const second = seedMappingVersion(t.db, { owner: TENANT, setSeed: 'a', id: 'a2', profiles });
  const activate = (scope: unknown = { kind: 'tenant', id: TENANT }, who = t.cookie()) =>
    t.mutate(who, 'POST', `${SETS}/set-a/versions/${second.versionId}/activate`, {
      snapshotId: second.snapshotId,
      activationScope: scope,
    });
  const inUse = () =>
    (
      t.db
        .prepare(
          "SELECT field_mapping_version_id AS v FROM field_mapping_activations WHERE field_mapping_set_id = 'set-a' AND lifecycle_state = 'active'"
        )
        .all() as Array<{ v: string }>
    ).map((row) => row.v);
  return { t, second, activate, inUse };
}

describe('a reference that pins a version', () => {
  it.each([
    [
      'an app',
      (t: ReturnType<typeof setup>, version: string) =>
        insertOAuthClient(t.coreA, {
          tenantId: TENANT,
          clientId: 'pinned',
          identityMapping: { fieldMappingSetId: 'set-a', fieldMappingVersionId: version },
        }),
    ],
    [
      'a SAML provider',
      (t: ReturnType<typeof setup>, version: string) =>
        insertSamlProvider(t.coreA, {
          tenantId: TENANT,
          id: 'idp-pinned',
          providerType: 'saml_idp',
          config: {
            entityId: 'https://sp.example.test',
            identityMapping: { fieldMappingSetId: 'set-a', fieldMappingVersionId: version },
          },
        }),
    ],
  ])(
    'keeps the version %s pins: a compatible other version is refused, the pinned one is not',
    async (_name, pin) => {
      const refused = withSecondVersion();
      pin(refused.t, 'ver-a');
      const result = await refused.activate();
      expect(result.status).toBe(409);
      expect(result.json).toMatchObject({
        reason: 'would_break_references',
        references: { violation: { code: 'pinned_version_replaced' } },
      });
      expect(refused.inUse()).toEqual(['ver-a']);

      const allowed = withSecondVersion();
      pin(allowed.t, 'ver-a2');
      expect((await allowed.activate()).status).toBe(200);
      expect(allowed.inUse()).toEqual(['ver-a2']);
    }
  );

  it('keeps the version and snapshot a published credential profile pins', async () => {
    const { t, activate, inUse } = withSecondVersion();
    t.refs.credential('set-a');
    t.db.exec(
      "UPDATE credential_profile_versions SET issuance_mapping_version_id = 'ver-a', issuance_mapping_snapshot_hash = 'snapshot-a'"
    );
    const refused = await activate();
    expect(refused.status).toBe(409);
    expect(refused.json.references.violation.code).toBe('pinned_version_replaced');
    expect(inUse()).toEqual(['ver-a']);
  });
});

describe('a version that belongs to another set', () => {
  it('cannot be deactivated through a set it is not in, and its snapshot is left alone', async () => {
    const t = setup();
    seedMapping(t.db, { owner: TENANT, id: 'c' });
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-c' });
    t.refs.client(t.coreA, 'set-c');
    const snapshotStates = () =>
      t.db
        .prepare("SELECT lifecycle_state AS s FROM compiled_mapping_snapshots WHERE id = 'snap-c'")
        .get();

    const attempt = await t.deactivate(t.cookie(), 'set-a', 'ver-c');

    expect(attempt.status).toBe(404);
    expect(snapshotStates()).toEqual({ s: 'active' });
    expect(activeActivations(t, 'set-c')).toBe(1);
  });

  it('is judged under its own set when it is deactivated through its own', async () => {
    const t = setup();
    seedMapping(t.db, { owner: TENANT, id: 'c' });
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-c' });
    t.refs.client(t.coreA, 'set-c');
    expect((await t.deactivate(t.cookie(), 'set-c', 'ver-c')).status).toBe(409);
  });
});

describe('the scope of an activation put in place of the one in use', () => {
  it.each([
    ['another protocol', { kind: 'tenant', id: TENANT, protocol: 'saml' }],
    ['another app', { kind: 'tenant', id: TENANT, clientId: 'someone-else' }],
    ['another role', { kind: 'tenant', id: TENANT, role: 'rp' }],
    ['another tenant', { kind: 'tenant', id: 'tenant-b' }],
  ])('refuses a scope for %s while an app of the tenant names the set', async (_n, scope) => {
    const { t, activate, inUse } = withSecondVersion();
    t.refs.client(t.coreA, 'set-a');
    const refused = await activate(scope);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      reason: 'would_break_references',
      references: { violation: { code: 'activation_scope_mismatch' } },
    });
    expect(inUse()).toEqual(['ver-a']);
  });

  it('accepts a scope that still fits the apps, and refuses one that leaves one of them out', async () => {
    const { t, activate } = withSecondVersion();
    t.refs.client(t.coreA, 'set-a', TENANT, 'app-1');
    expect(
      (await activate({ kind: 'tenant', id: TENANT, protocol: 'oidc', role: 'op' })).status
    ).toBe(200);
    const narrowed = withSecondVersion();
    narrowed.t.refs.client(narrowed.t.coreA, 'set-a', TENANT, 'app-1');
    insertOAuthClient(narrowed.t.coreA, {
      tenantId: TENANT,
      clientId: 'app-2',
      identityMapping: { fieldMappingSetId: 'set-a' },
    });
    expect(
      (await narrowed.activate({ kind: 'tenant', id: TENANT, clientId: 'app-1' })).status
    ).toBe(409);
  });

  it('refuses an app-specific scope when the tenant default names the set, which applies to every app', async () => {
    const { t, activate } = withSecondVersion();
    t.refs.tenantDefault('set-a');
    expect((await activate({ kind: 'tenant', id: TENANT, clientId: 'app-1' })).status).toBe(409);
    expect((await activate({ kind: 'tenant', id: TENANT })).status).toBe(200);
  });

  it('is judged on the scope of the activation a rollback brings back', async () => {
    const { t, second } = withSecondVersion();
    t.refs.client(t.coreA, 'set-a');
    t.db.exec(
      `UPDATE field_mapping_activations SET lifecycle_state = 'retired', active_until = 150,
         activation_scope_json = '{"kind":"tenant","id":"${TENANT}","protocol":"saml"}' WHERE id = 'act-a';
       UPDATE compiled_mapping_snapshots SET lifecycle_state = 'active' WHERE id = 'snap-a';
       UPDATE compiled_mapping_snapshots SET lifecycle_state = 'active' WHERE id = '${second.snapshotId}';
       INSERT INTO field_mapping_activations (id, tenant_id, field_mapping_set_id, field_mapping_version_id, activation_scope_json, lifecycle_state, active_from, activated_at, created_at, updated_at)
       VALUES ('act-a2', '${TENANT}', 'set-a', 'ver-a2', '{}', 'active', 200, 200, 200, 200);`
    );
    const refused = await t.mutate(t.cookie(), 'POST', `${SETS}/set-a/rollback`);
    expect(refused.status).toBe(409);
    expect(refused.json.references.violation.code).toBe('activation_scope_mismatch');
  });
});

describe('federation trust sources that resolve entities with a set', () => {
  it.each([
    ['spFieldMappingSetId', 'federation_trust_source'],
    ['idpFieldMappingSetId', 'federation_trust_source'],
  ] as const)('stops a set named in %s from being deactivated or deleted', async (field, kind) => {
    const t = setup();
    t.refs.federation('set-a', field);
    const admin = t.cookie();

    const usage = await t.usage(admin, 'set-a');
    expect(usage.json.usage.items).toEqual([
      expect.objectContaining({ kind, tenantId: TENANT, trustSourceId: 'fts-1' }),
    ]);

    const refused = await t.deactivate(admin, 'set-a', 'ver-a');
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ reason: 'referenced', references: { count: 1 } });
    t.db.exec("UPDATE field_mapping_activations SET lifecycle_state = 'retired'");
    expect((await t.remove(admin, 'set-a')).status).toBe(409);
  });

  it('is found for a platform set in another tenant, shown to global authority only', async () => {
    const t = setup();
    t.refs.federation('set-plat', 'spFieldMappingSetId', 'tenant-b');
    const global = await t.usage(t.cookie(GLOBAL_SUPER_ADMIN), 'set-plat');
    expect(global.json.usage.items).toEqual([
      expect.objectContaining({ kind: 'federation_trust_source', tenantId: 'tenant-b' }),
    ]);
    const tenantAdmin = await t.usage(t.cookie(TENANT_SUPER_ADMIN), 'set-plat');
    expect(tenantAdmin.json.usage.items).toEqual([]);
    expect(tenantAdmin.json.usage.otherTenants).toMatchObject({ referenceCount: 1 });
    expect(JSON.stringify(tenantAdmin.json)).not.toMatch(/tenant-b|fts-1/);
  });

  it('refuses a scope that does not fit when only a trust source names the set', async () => {
    const { t, activate } = withSecondVersion();
    t.refs.federation('set-a', 'idpFieldMappingSetId');
    // Authrim as the service provider reads the assertion: role sp.
    expect((await activate({ kind: 'tenant', id: TENANT, role: 'idp' })).status).toBe(409);
  });

  it('is not tripped by a payload that is not JSON', async () => {
    const t = setup();
    t.db.exec(
      "INSERT INTO federation_trust_sources (id, tenant_id, source_type, source_key, display_name, lifecycle_state, protocol_payload_json, created_at, updated_at) VALUES ('bad', 'tenant-a', 'x', 'k', 'n', 'draft', 'not json', 1, 1)"
    );
    expect((await t.deactivate(t.cookie(), 'set-a', 'ver-a')).status).toBe(200);
  });
});

describe('what counts as in use for a Destination Profile', () => {
  it('still counts a set whose active version was published again, since its activation is active', async () => {
    const t = setup();
    t.refs.client(t.coreA, 'set-a');
    // The publish API can run on the active version: only the version row says published.
    t.db.exec("UPDATE field_mapping_versions SET lifecycle_state = 'published' WHERE id = 'ver-a'");
    const refused = await t.mutate(
      t.cookie(),
      'DELETE',
      '/api/admin/field-mapping/destination-profiles/profile-a'
    );
    expect(refused.status).toBe(409);
    expect(refused.json.references.items[0]).toMatchObject({ viaMappingSetId: 'set-a' });
  });

  it('does not count a version that has no active activation, whatever its state', async () => {
    const t = setup();
    t.refs.client(t.coreA, 'set-a');
    t.db.exec("UPDATE field_mapping_activations SET lifecycle_state = 'retired'");
    t.db.exec("UPDATE field_mapping_versions SET lifecycle_state = 'active' WHERE id = 'ver-a'");
    expect(
      (
        await t.mutate(
          t.cookie(),
          'DELETE',
          '/api/admin/field-mapping/destination-profiles/profile-a'
        )
      ).status
    ).toBe(200);
  });
});

describe('what the references need of the version put in place', () => {
  it('lets SCIM and credential profiles move to a version with no Destination Profile', async () => {
    const { t, activate, inUse } = withSecondVersion([]);
    t.refs.scim('set-a');
    expect((await activate()).status).toBe(200);
    expect(inUse()).toEqual(['ver-a2']);
  });

  it('lets an inbound SAML provider move to a version with no or several Destination Profiles', async () => {
    const { t, activate } = withSecondVersion(['profile-a', 'profile-extra']);
    insertSamlProvider(t.coreA, {
      tenantId: TENANT,
      id: 'idp-1',
      providerType: 'saml_idp',
      config: {
        entityId: 'https://idp.example.test',
        identityMapping: { fieldMappingSetId: 'set-a' },
      },
    });
    expect((await activate({ kind: 'tenant', id: TENANT, role: 'sp' })).status).toBe(200);
  });

  it('wants a SAML Destination Profile for a SAML provider that Authrim releases to, and an OIDC one for an app', async () => {
    const saml = withSecondVersion(['profile-oidc2']);
    seedDestinationProfile(saml.t.db, { owner: TENANT, id: 'profile-oidc2' });
    insertSamlProvider(saml.t.coreA, {
      tenantId: TENANT,
      id: 'sp-1',
      providerType: 'saml_sp',
      config: {
        entityId: 'https://sp.example.test',
        identityMapping: { fieldMappingSetId: 'set-a' },
      },
    });
    expect((await saml.activate({ kind: 'tenant', id: TENANT, role: 'idp' })).status).toBe(409);

    const ok = withSecondVersion(['profile-saml2']);
    seedDestinationProfile(ok.t.db, {
      owner: TENANT,
      id: 'profile-saml2',
      destinationType: 'saml',
    });
    insertSamlProvider(ok.t.coreA, {
      tenantId: TENANT,
      id: 'sp-1',
      providerType: 'saml_sp',
      config: {
        entityId: 'https://sp.example.test',
        identityMapping: { fieldMappingSetId: 'set-a' },
      },
    });
    expect((await ok.activate({ kind: 'tenant', id: TENANT, role: 'idp' })).status).toBe(200);
  });
});

describe('which tenants are looked at for a platform set', () => {
  it('leaves out a tenant whose deletion is complete, but not one that is only suspended', async () => {
    const t = setup();
    insertTenant(t.directory, 'tenant-gone');
    t.directory.exec("UPDATE tenants SET lifecycle_state = 'deleted' WHERE id = 'tenant-gone'");
    const global = t.cookie(GLOBAL_SUPER_ADMIN);
    expect((await t.deactivate(global, 'set-plat', 'ver-plat')).status).toBe(200);

    const suspended = setup();
    insertTenant(suspended.directory, 'tenant-paused');
    suspended.directory.exec(
      "UPDATE tenants SET lifecycle_state = 'suspended' WHERE id = 'tenant-paused'"
    );
    const refused = await suspended.deactivate(
      suspended.cookie(GLOBAL_SUPER_ADMIN),
      'set-plat',
      'ver-plat'
    );
    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe('scan_incomplete');
  });

  it('asks the directory for no more than the limit and one more', async () => {
    const t = setup();
    for (let index = 0; index < 250; index += 1) insertTenant(t.directory, `bulk-${index}`);
    const seen = await t.usage(t.cookie(GLOBAL_SUPER_ADMIN), 'set-plat');
    expect(seen.json.usage.unscanned.items).toContainEqual(
      expect.objectContaining({ area: 'tenant_limit' })
    );
    const asked = t.directoryQueries.filter((item) => /FROM tenants/.test(item.sql));
    expect(asked).toHaveLength(1);
    expect(asked[0].sql).toMatch(/LIMIT/);
    expect(asked[0].params).toContain(201);
  });
});

describe('the usage API for a platform set', () => {
  it('does not read other tenants’ Core databases for a caller without global authority', async () => {
    const t = setup();
    t.refs.client(t.coreB, 'set-plat', 'tenant-b', 'b-app');
    const seen = await t.usage(t.cookie(TENANT_SUPER_ADMIN), 'set-plat');
    expect(seen.status).toBe(200);
    expect(vi.mocked(resolveAuthCorePersistenceAdapterFromEnv)).not.toHaveBeenCalled();
    expect(t.directoryQueries.filter((item) => /FROM tenants/.test(item.sql))).toHaveLength(0);
    expect(seen.json.usage.otherTenants).toMatchObject({ scanned: false });
    // It is not known whether a change would be refused, so it is not said that it would not.
    expect(seen.json.blocksChange).toBeNull();
    expect(JSON.stringify(seen.json)).not.toMatch(/tenant-b|b-app/);
  });

  it('reads them for a caller with global authority', async () => {
    const t = setup();
    t.refs.client(t.coreB, 'set-plat', 'tenant-b', 'b-app');
    const seen = await t.usage(t.cookie(GLOBAL_SUPER_ADMIN), 'set-plat');
    expect(vi.mocked(resolveAuthCorePersistenceAdapterFromEnv)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-b' })
    );
    expect(seen.json.usage.items).toEqual([
      { kind: 'client', tenantId: 'tenant-b', clientId: 'b-app' },
    ]);
  });
});

describe('every reference is checked, not only the first ones read', () => {
  /** 501 apps name the set (one more than is read); the last one in order pins the version in use. */
  function manyApps() {
    const w = withSecondVersion();
    const insert = w.t.coreA.prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types, tenant_id, identity_mapping, created_at, updated_at)
       VALUES (?, ?, '[]', '[]', '[]', ?, ?, 1, 1)`
    );
    for (let index = 0; index <= 500; index += 1) {
      const clientId = `app-${String(index).padStart(3, '0')}`;
      insert.run(
        clientId,
        clientId,
        TENANT,
        JSON.stringify({
          fieldMappingSetId: 'set-a',
          ...(index === 500 ? { fieldMappingVersionId: 'ver-a' } : {}),
        })
      );
    }
    return w;
  }

  it('refuses a replacement when the references were cut off, instead of judging only the first', async () => {
    const { activate, inUse } = manyApps();
    const refused = await activate();
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      reason: 'scan_incomplete',
      references: { countIsLowerBound: true, scanComplete: false },
    });
    expect(inUse()).toEqual(['ver-a']);
  });

  it('refuses a replacement that breaks a reference it did read, whether or not it was cut off', async () => {
    const { t, activate } = manyApps();
    t.coreA.exec(
      `UPDATE oauth_clients SET identity_mapping = '{"fieldMappingSetId":"set-a","fieldMappingVersionId":"ver-a"}' WHERE client_id = 'app-000'`
    );
    expect((await activate()).json.reason).toBe('would_break_references');
  });

  it('refuses deactivation for the same reason whether or not they were cut off', async () => {
    const few = setup();
    few.refs.client(few.coreA, 'set-a');
    const fewRefused = await few.deactivate(few.cookie(), 'set-a', 'ver-a');

    const { t } = manyApps();
    const manyRefused = await t.deactivate(t.cookie(), 'set-a', 'ver-a');

    expect(fewRefused.json.reason).toBe('referenced');
    expect(manyRefused.status).toBe(409);
    expect(manyRefused.json.reason).toBe('referenced');
    expect(manyRefused.json.references.countIsLowerBound).toBe(true);
  });

  it('says in the usage answer that the list is not complete', async () => {
    const { t } = manyApps();
    const seen = await t.usage(t.cookie(), 'set-a');
    expect(seen.json.usage).toMatchObject({ countIsLowerBound: true, scanComplete: false });
    expect(seen.json.usage.items).toHaveLength(20);
  });
});

describe('the Destination Profile the runtime counts for the version', () => {
  it.each([
    ['another profile that exists', 'profile-two'],
    ['a profile that does not exist', 'profile-nowhere'],
  ])(
    'refuses an activation scope that names %s besides the one the edges name',
    async (_n, other) => {
      const { t, activate, inUse } = withSecondVersion();
      seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-two' });
      t.refs.client(t.coreA, 'set-a');
      const refused = await activate({ kind: 'tenant', id: TENANT, destinationProfileId: other });
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({
        reason: 'would_break_references',
        references: { violation: { code: 'destination_profile_invalid' } },
      });
      expect(inUse()).toEqual(['ver-a']);
    }
  );

  it('accepts a scope that names the profile the edges name', async () => {
    const { t, activate } = withSecondVersion();
    t.refs.client(t.coreA, 'set-a');
    expect(
      (await activate({ kind: 'tenant', id: TENANT, destinationProfileId: 'profile-a' })).status
    ).toBe(200);
  });

  it('is the set the runtime counts: a scope that names the profile with the prefix is two', async () => {
    const { t, activate } = withSecondVersion();
    t.refs.client(t.coreA, 'set-a');
    expect(
      (
        await activate({
          kind: 'tenant',
          id: TENANT,
          destinationProfileId: 'destination-profile-profile-a',
        })
      ).status
    ).toBe(409);
  });
});

describe('what a SAML service provider saved about its Destination Profile', () => {
  const entityId = 'https://sp.example.test';

  /** `set-a` releases into the SAML profile `profile-s1` (field mail) to a provider that saved a policy for it. */
  function samlProvider(extra: Record<string, unknown> = {}, secondProfile = 'profile-s2') {
    const w = withSecondVersion([secondProfile]);
    seedDestinationProfile(w.t.db, {
      owner: TENANT,
      id: 'profile-s1',
      destinationType: 'saml',
      attributes: ['mail'],
    });
    seedDestinationProfile(w.t.db, {
      owner: TENANT,
      id: 'profile-s2',
      destinationType: 'saml',
      attributes: ['uid'],
    });
    seedDestinationProfile(w.t.db, {
      owner: TENANT,
      id: 'profile-s3',
      destinationType: 'saml',
      attributes: ['mail'],
    });
    w.t.db.exec(
      "UPDATE mapping_rule_edges SET target_ref_json = replace(target_ref_json, 'profile-a', 'profile-s1') WHERE id LIKE 'edge-a-%'"
    );
    insertSamlProvider(w.t.coreA, {
      tenantId: TENANT,
      id: 'sp-1',
      providerType: 'saml_sp',
      config: {
        entityId,
        identityMapping: {
          fieldMappingSetId: 'set-a',
          destinationFieldPolicies: { mail: 'required' },
          ...extra,
        },
      },
    });
    return w;
  }
  const scope = { kind: 'tenant', id: TENANT, role: 'idp' };

  it('refuses a version that points to a profile whose fields are not the ones the policy names', async () => {
    const { t, activate, inUse } = samlProvider();
    const refused = await activate(scope);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      reason: 'would_break_references',
      references: { violation: { code: 'saml_destination_policy_mismatch' } },
    });
    expect(inUse()).toEqual(['ver-a']);
    // What the provider saved is not shown with the reference.
    const seen = await t.usage(t.cookie(), 'set-a');
    expect(JSON.stringify(seen.json)).not.toMatch(/policyKeys|swapInputs|destinationFieldPolicies/);
  });

  it('accepts a version whose profile has the same fields', async () => {
    const { activate, inUse } = samlProvider({}, 'profile-s3');
    expect((await activate(scope)).status).toBe(200);
    expect(inUse()).toEqual(['ver-a2']);
  });

  it('refuses a version that releases an attribute under a name other than its field’s', async () => {
    const { t, activate } = samlProvider(
      { attributeDescriptors: { mail: { name: 'urn:oid:0.9.2342.19200300.100.1.3' } } },
      'profile-s3'
    );
    t.db.exec(
      "UPDATE mapping_rule_edges SET target_ref_json = json_set(target_ref_json, '$.namespace', 'saml.attribute', '$.path', 'mail') WHERE rule_id = 'rule-a2'"
    );
    const refused = await activate(scope);
    expect(refused.status).toBe(409);
    expect(refused.json.references.violation.code).toBe('saml_attribute_descriptor_renames_field');
  });

  it.each([
    [
      'fieldKey',
      "json_set(json_remove(target_ref_json, '$.path'), '$.namespace', 'saml.attribute', '$.fieldKey', 'mail')",
      { mail: { name: 'urn:mail' } },
      409,
    ],
    [
      'catalogEntryId with the field’s own name',
      "json_set(json_remove(target_ref_json, '$.path'), '$.namespace', 'saml.attribute', '$.fieldKey', 'mail', '$.catalogEntryId', 'e1')",
      { e1: { name: 'mail' } },
      200,
    ],
  ])(
    'reads the attribute reference spelled with %s as the runtime does',
    async (_n, targetSql, descriptors, status) => {
      const { t, activate } = samlProvider({ attributeDescriptors: descriptors }, 'profile-s3');
      t.db.exec(
        `UPDATE mapping_rule_edges SET target_ref_json = ${targetSql} WHERE rule_id = 'rule-a2'`
      );
      const result = await activate(scope);
      expect(result.status).toBe(status);
      if (status === 409) {
        expect(result.json.references.violation.code).toBe(
          'saml_attribute_descriptor_renames_field'
        );
      }
    }
  );

  it('is the rule that saves the provider’s configuration', async () => {
    // The same two functions decide it there and here.
    const { samlDestinationPolicyCoversProfile } = await import('@authrim/ar-lib-core');
    expect(samlDestinationPolicyCoversProfile(['mail'], ['mail'])).toBe(true);
    expect(samlDestinationPolicyCoversProfile(['mail'], ['uid'])).toBe(false);
    expect(samlDestinationPolicyCoversProfile(['mail'], ['mail', 'uid'])).toBe(false);
    expect(samlDestinationPolicyCoversProfile([], [])).toBe(false);
  });
});

describe('a Destination Profile an activation scope names', () => {
  const del = (t: ReturnType<typeof setup>, profileId: string, who = t.cookie()) =>
    t.mutate(who, 'DELETE', `/api/admin/field-mapping/destination-profiles/${profileId}`);
  const profileExists = (t: ReturnType<typeof setup>, id: string) =>
    t.count(`SELECT COUNT(*) AS n FROM destination_profiles WHERE id = '${id}'`) === 1;

  /** `set-c` is named by an app; its activation has the given scope and its edges the given profiles. */
  function named(scope: Record<string, unknown>, edgeProfiles: string[]) {
    const t = setup();
    seedMapping(t.db, { owner: TENANT, id: 'c', scope, profiles: edgeProfiles });
    for (const id of ['profile-c', 'profile-x'])
      seedDestinationProfile(t.db, { owner: TENANT, id });
    t.refs.client(t.coreA, 'set-c');
    return t;
  }

  it.each([
    ['only the scope names it', { destinationProfileId: 'profile-c' }, [], 'profile-c'],
    [
      'only the scope names it, with the prefix',
      { destinationProfileId: 'destination-profile-profile-c' },
      [],
      'profile-c',
    ],
    ['only the edges name it', {}, ['profile-c'], 'profile-c'],
    [
      'the edges and the scope both name it',
      { destinationProfileId: 'profile-c' },
      ['profile-c'],
      'profile-c',
    ],
    [
      'the scope names it besides the edges’ profile',
      { destinationProfileId: 'profile-x' },
      ['profile-c'],
      'profile-x',
    ],
    [
      'the scope names another besides the edges’ profile, which is then named by the edges',
      { destinationProfileId: 'profile-x' },
      ['profile-c'],
      'profile-c',
    ],
  ])(
    'cannot be deleted while a set in use releases into it: %s',
    async (_n, scope, edges, target) => {
      const t = named(scope, edges);
      const refused = await del(t, target);
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({
        reason: 'referenced',
        references: {
          items: [expect.objectContaining({ kind: 'client', viaMappingSetId: 'set-c' })],
        },
      });
      expect(profileExists(t, target)).toBe(true);
    }
  );

  it('can be deleted when no set in use names it, in the edges or the scope', async () => {
    const t = named({ destinationProfileId: 'profile-c' }, []);
    expect((await del(t, 'profile-x')).status).toBe(200);
  });

  it('is not held by an activation that is no longer active', async () => {
    const t = named({ destinationProfileId: 'profile-c' }, []);
    t.db.exec(
      "UPDATE field_mapping_activations SET lifecycle_state = 'retired' WHERE id = 'act-c'"
    );
    expect((await del(t, 'profile-c')).status).toBe(200);
  });

  it('is refused as incomplete when more activations are in use than are read in full', async () => {
    const t = setup();
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-c' });
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-x' });
    const insert = t.db.prepare(
      `INSERT INTO field_mapping_activations (id, tenant_id, field_mapping_set_id, field_mapping_version_id, activation_scope_json, lifecycle_state, activated_at, created_at, updated_at)
       VALUES (?, ?, 'set-a', 'ver-a', '{}', 'active', 1, 1, 1)`
    );
    for (let index = 0; index < 5001; index += 1) insert.run(`bulk-${index}`, TENANT);
    const refused = await del(t, 'profile-x');
    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe('scan_incomplete');
    expect(profileExists(t, 'profile-x')).toBe(true);
  });

  it('is not held by a set nothing names', async () => {
    const t = setup();
    seedMapping(t.db, {
      owner: TENANT,
      id: 'c',
      scope: { destinationProfileId: 'profile-c' },
      profiles: [],
    });
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-c' });
    expect((await del(t, 'profile-c')).status).toBe(200);
  });

  it('is held for the platform’s profile too, by a tenant’s set whose scope names it', async () => {
    const t = setup();
    seedMapping(t.db, {
      owner: 'tenant-b',
      id: 'b2',
      scope: { destinationProfileId: 'profile-plat' },
      profiles: [],
    });
    t.refs.client(t.coreB, 'set-b2', 'tenant-b', 'b-app');
    const refused = await del(t, 'profile-plat', t.cookie(GLOBAL_SUPER_ADMIN));
    expect(refused.status).toBe(409);
    expect(refused.json.references.items).toEqual([
      expect.objectContaining({ tenantId: 'tenant-b', clientId: 'b-app' }),
    ]);
  });
});
