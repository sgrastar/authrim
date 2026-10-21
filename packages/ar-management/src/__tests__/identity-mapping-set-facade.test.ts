import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  applyOIDCIdentityMapping,
  PLATFORM_MAPPING_TENANT_ID,
  requireAdminPermissions,
  type DatabaseAdapter,
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

import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import { adminBodyLimitMiddleware } from '../admin-body-limit';
import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import {
  adminIdentityMappingSetCreateHandler,
  adminIdentityMappingSetDeleteHandler,
  adminIdentityMappingSetGetHandler,
  adminIdentityMappingSetPutHandler,
  adminIdentityMappingSetsListHandler,
  createMappingSetSaveIdempotency,
  sweepExpiredMappingSetSaveRecords,
} from '../identity-mapping-set-facade';
import {
  GLOBAL_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  createTokenKit,
  setupApp,
  signIn,
  sqliteAdapter,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';
import { seedDestinationProfile } from './helpers/identity-mapping-seed';
import type { SQLiteDatabase } from './test-sqlite';

/**
 * The Mapping Set facade (`/api/admin/identity-mapping/sets`) on the real Admin schema, the real
 * admin authentication and route access, and the real control plane underneath: a save is one
 * call, what it leaves behind is the same rows the five steps would, and a step that fails leaves
 * the set as it was.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const SETS = '/api/admin/identity-mapping/sets';
const PLATFORM_CATALOG_VERSION = 'platform_default_canonical_catalog_v1';
const OIDC_SCOPE = { protocol: 'oidc', role: 'op' };
const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

/** A profile that releases email without the user's selection, so a mapped value shows in the claims. */
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
    {
      claimName: 'nickname',
      required: true,
      surfaces: ['id_token', 'userinfo'],
      requiredScopes: ['profile'],
      classification: 'internal',
    },
  ],
};
/** A profile whose email claim is classified lower than email is. */
const LOWER_EMAIL_SCHEMA = {
  destinationType: 'oidc',
  claims: [
    { claimName: 'sub', required: true, nullable: false, surfaces: ['id_token', 'userinfo'] },
    {
      claimName: 'email',
      surfaces: ['id_token'],
      requiredScopes: ['email'],
      classification: 'public',
    },
  ],
};

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

/** What a test makes the Admin database do wrong, and what it was asked to write. */
interface Faults {
  /** A write whose SQL matches this fails. */
  failOn: RegExp | null;
  /** Runs once, right after a write whose SQL matches this (to put another admin's change in). */
  afterWrite: { match: RegExp; run: () => void } | null;
  /** Every write (execute or batch statement) the adapter was asked for. */
  writes: string[];
  /**
   * A batch with a statement matching this is applied and then applied again, as the D1 adapter
   * does after a lost answer: the second run is the one whose error is raised.
   */
  retryAfterApply: RegExp | null;
  /** A batch matching this is applied, and its answer is lost (an error), and the database cannot be read after. */
  blindAfterApply: RegExp | null;
  blind: boolean;
}

function faultyAdapter(inner: DatabaseAdapter, faults: Faults): DatabaseAdapter {
  const check = (sql: string) => {
    faults.writes.push(sql);
    if (faults.failOn?.test(sql)) throw new Error('injected failure');
  };
  const after = (sql: string) => {
    const hook = faults.afterWrite;
    if (hook?.match.test(sql)) {
      faults.afterWrite = null;
      hook.run();
    }
  };
  const wrapped = {
    query: async (sql: string, params?: unknown[]) => {
      if (faults.blind) throw new Error('database unreadable');
      return inner.query(sql, params);
    },
    queryOne: async (sql: string, params?: unknown[]) => {
      if (faults.blind) throw new Error('database unreadable');
      return inner.queryOne(sql, params);
    },
    execute: async (sql: string, params?: unknown[]) => {
      check(sql);
      const result = await inner.execute(sql, params);
      after(sql);
      return result;
    },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(wrapped),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      statements.forEach((statement) => check(statement.sql));
      if (faults.retryAfterApply?.test(statements.map((statement) => statement.sql).join('\n'))) {
        faults.retryAfterApply = null;
        await inner.batch(statements as never);
        return inner.batch(statements as never);
      }
      if (faults.blindAfterApply?.test(statements.map((statement) => statement.sql).join('\n'))) {
        faults.blindAfterApply = null;
        await inner.batch(statements as never);
        faults.blind = true;
        throw new Error('answer lost');
      }
      const results = await inner.batch(statements as never);
      statements.forEach((statement) => after(statement.sql));
      return results;
    },
    isHealthy: () => inner.isHealthy(),
    getType: () => inner.getType(),
    close: () => inner.close(),
  };
  return wrapped as unknown as DatabaseAdapter;
}

let sequence = 0;
let keys = 0;

async function setup(options: { bindToAuthority?: boolean } = {}) {
  const mappingSetSaveIdempotency = createMappingSetSaveIdempotency(options);
  const kit = await createTokenKit('https://tenant-a.example.com');
  const coreA = openCoreDatabase();
  const directory = openCoreDatabase();
  for (const id of [TENANT, 'tenant-b']) insertTenant(directory, id);
  insertTenant(coreA, TENANT);
  const settings = kvStore();
  const faults: Faults = {
    failOn: null,
    afterWrite: null,
    writes: [],
    retryAfterApply: null,
    blindAfterApply: null,
    blind: false,
  };
  const envExtras: Record<string, unknown> = {
    DB: sqliteAdapter(directory),
    SETTINGS: settings.namespace,
    AUTHRIM_CONFIG: settings.namespace,
    TEST_CORES: { [TENANT]: sqliteAdapter(coreA), 'tenant-b': sqliteAdapter(openCoreDatabase()) },
    BASE_DOMAIN: 'example.com',
    ...kit.env,
  };
  const context = setupApp((app) => {
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
        tenantId: TENANT,
        coreDb: sqliteAdapter(coreA),
        route: {},
      });
      await next();
    });
    // The management Worker's order: authentication, then the common body limit, then access.
    app.use(
      '/api/admin/*',
      adminAuthMiddleware({ plane: 'tenant' }),
      adminBodyLimitMiddleware(50 * 1024 * 1024),
      enforceDeclaredAdminRouteAccess()
    );
    // The same wiring as the management Worker's.
    const read = requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]);
    const write = requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]);
    app.get(SETS, read, adminIdentityMappingSetsListHandler);
    app.post(SETS, write, mappingSetSaveIdempotency, adminIdentityMappingSetCreateHandler);
    app.get(`${SETS}/:id`, read, adminIdentityMappingSetGetHandler);
    app.put(`${SETS}/:id`, write, mappingSetSaveIdempotency, adminIdentityMappingSetPutHandler);
    app.delete(
      `${SETS}/:id`,
      write,
      mappingSetSaveIdempotency,
      adminIdentityMappingSetDeleteHandler
    );
  }, envExtras);
  for (const file of [
    '028_tenant_settings_documents.sql',
    '038_tenant_settings_reconciled_at.sql',
    '039_platform_settings_documents.sql',
    '040_settings_legacy_import_state.sql',
  ]) {
    context.db.exec(readFileSync(resolve(REPO_ROOT, `migrations/admin/d1/${file}`), 'utf8'));
  }
  context.db.exec(
    readFileSync(
      resolve(REPO_ROOT, 'migrations/admin/d1/041_platform_default_canonical_catalog.sql'),
      'utf8'
    ).replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
  );
  // Every request goes through the faulty adapter; the repository the test itself uses does not.
  envExtras.DB_ADMIN = faultyAdapter(context.adapter, faults);
  const repository = new IdentityMappingControlPlaneRepository(context.adapter);

  const catalog = await repository.createCatalog(TENANT, {
    catalogKey: 'tenant-catalog',
    displayName: 'Tenant catalog',
    versionLabel: 'v1',
    entries: [
      {
        id: 'field.profile.email',
        namespace: 'authrim.profile',
        path: 'email',
        targetType: 'canonical',
        valueType: 'string',
        cardinality: 'single',
        classification: 'pii',
        uiGroupKey: 'contact',
        uiGroupLabel: 'Contact',
        uiGroupOrder: 20,
      },
      {
        id: 'field.profile.nickname',
        namespace: 'authrim.profile',
        path: 'nickname',
        targetType: 'canonical',
        valueType: 'string',
        cardinality: 'single',
        classification: 'internal',
        uiGroupKey: 'profile',
        uiGroupLabel: 'Profile',
        uiGroupOrder: 10,
      },
    ] as never,
  });
  const catalogVersionId = (catalog as { activeVersion: { id: string } }).activeVersion.id;

  async function oidcProfile(
    owner: 'tenant' | 'platform',
    options: { schema?: unknown; profileKey: string }
  ): Promise<string> {
    const created = await repository.createDestinationProfile(TENANT, {
      destinationType: 'oidc',
      profileKey: options.profileKey,
      displayName: options.profileKey,
      ownerScopeType: owner,
      schema: options.schema ?? RELEASED_EMAIL_SCHEMA,
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
  const profile = await oidcProfile('tenant', { profileKey: 'tenant_profile' });
  const platformProfile = await oidcProfile('platform', { profileKey: 'platform_profile' });
  const lowerProfile = await oidcProfile('tenant', {
    profileKey: 'tenant_lower_profile',
    schema: LOWER_EMAIL_SCHEMA,
  });

  const cookie = (assignments: Assignment[] = TENANT_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const tenantAdmin = cookie();
  const platformAdmin = cookie(GLOBAL_SUPER_ADMIN);

  const request = (
    who: string,
    method: string,
    path: string,
    body?: unknown,
    options: { key?: string | null; headers?: Record<string, string> } = {}
  ) => {
    sequence += 1;
    const headers: Record<string, string> = { ...options.headers };
    if (options.key !== null && method !== 'GET') {
      headers['Idempotency-Key'] = options.key ?? `facade-key-${sequence}`;
    }
    return context.call(who, method, path, body, headers);
  };
  const machine = (permissions: string[], scope: 'all' | 'allow') => {
    sequence += 1;
    const now = Date.now();
    const id = `amp_facade_${sequence}`;
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'Facade', 'automation', 'active', 'authrim:admin-api', 600, ?, ?)`
      )
      .run(id, `client-${id}`, now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ES256', 'Key', 'active', ?, ?)`
      )
      .run(`amk_${id}`, id, `kid-${id}`, JSON.stringify(PUBLIC_JWK), now, now);
    for (const permission of permissions) {
      context.db
        .prepare(
          `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
           VALUES (?, ?, ?)`
        )
        .run(id, permission, now);
    }
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, scope, scope === 'allow' ? TENANT : null, now);
    return kit.mint(context.db, `amk_${id}`, permissions);
  };
  const requestWithToken = (token: string, method: string, path: string, body?: unknown) => {
    sequence += 1;
    return context.callWithToken(token, method, path, body, {
      'Idempotency-Key': `facade-token-${sequence}`,
    });
  };

  /** The content of a set: an email rule into the profile, plus what a test adds. */
  const content = (
    options: {
      profileId?: string;
      rules?: unknown[];
      catalogVersionId?: string;
    } = {}
  ) => ({
    catalogVersionId: options.catalogVersionId ?? catalogVersionId,
    rules: options.rules ?? [emailRule(options.profileId ?? profile)],
  });
  const body = (overrides: Record<string, unknown> = {}) => ({
    field_mapping_key: `key-${(keys += 1)}`,
    display_name: 'Release email',
    content: content(),
    ...overrides,
  });
  const create = async (overrides: Record<string, unknown> = {}, who = tenantAdmin) => {
    const response = await request(who, 'POST', SETS, body(overrides));
    expect(response.status).toBe(201);
    return response.json;
  };
  const count = (sql: string, ...params: Array<string | number>) =>
    (context.db.prepare(sql).get(...params) as { n: number }).n;
  const rowCounts = () => ({
    sets: count('SELECT COUNT(*) AS n FROM field_mapping_sets'),
    versions: count('SELECT COUNT(*) AS n FROM field_mapping_versions'),
    rules: count('SELECT COUNT(*) AS n FROM mapping_rules'),
    edges: count('SELECT COUNT(*) AS n FROM mapping_rule_edges'),
    snapshots: count('SELECT COUNT(*) AS n FROM compiled_mapping_snapshots'),
    activations: count('SELECT COUNT(*) AS n FROM field_mapping_activations'),
    graphs: count('SELECT COUNT(*) AS n FROM dependency_graph_snapshots'),
    idempotency: count('SELECT COUNT(*) AS n FROM idempotency_records'),
    documents:
      count('SELECT COUNT(*) AS n FROM tenant_settings_documents') +
      count('SELECT COUNT(*) AS n FROM platform_settings_documents'),
  });
  const activeVersions = (setId: string) =>
    (
      context.db
        .prepare(
          "SELECT field_mapping_version_id AS v, activation_scope_json AS s FROM field_mapping_activations WHERE field_mapping_set_id = ? AND lifecycle_state = 'active'"
        )
        .all(setId) as Array<{ v: string; s: string }>
    ).map((row) => ({ version: row.v, scope: JSON.parse(row.s) as unknown }));
  const versionRows = (setId: string) =>
    context.db
      .prepare(
        'SELECT id, lifecycle_state FROM field_mapping_versions WHERE field_mapping_set_id = ? ORDER BY rowid'
      )
      .all(setId) as Array<{ id: string; lifecycle_state: string }>;
  return {
    ...context,
    envExtras,
    kit,
    coreA,
    settings,
    faults,
    repository,
    catalogVersionId,
    profile,
    platformProfile,
    lowerProfile,
    tenantAdmin,
    platformAdmin,
    cookie,
    request,
    machine,
    requestWithToken,
    content,
    body,
    create,
    count,
    rowCounts,
    activeVersions,
    versionRows,
  };
}

function emailRule(profileId: string, overrides: Record<string, unknown> = {}) {
  return {
    ruleKey: 'email',
    ruleKind: 'direct',
    action: 'allow',
    edges: [
      {
        sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
        targetRef: {
          side: 'destination',
          namespace: 'oidc.claim',
          path: 'email',
          profileId,
          catalogEntryId: 'field.profile.email',
        },
      },
    ],
    ...overrides,
  };
}

function nicknameRule(profileId: string) {
  return {
    ruleKey: 'nickname',
    ruleKind: 'direct',
    action: 'allow',
    edges: [
      {
        sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'nickname' },
        targetRef: {
          side: 'destination',
          namespace: 'oidc.claim',
          path: 'nickname',
          profileId,
          catalogEntryId: 'field.profile.nickname',
        },
      },
    ],
  };
}

const audits = (action: string) =>
  vi
    .mocked(createAuditLogFromContext)
    .mock.calls.filter(([, name]) => name === action)
    .map(([, , , resourceId, metadata, severity]) => ({ resourceId, metadata, severity }));

beforeEach(() => {
  vi.mocked(createAuditLogFromContext).mockClear();
});

// ---------------------------------------------------------------------------------------------

describe('creating a set with its content', () => {
  it('saves, publishes, compiles and activates in one call, with the OIDC scope', async () => {
    const t = await setup();

    const created = await t.request(t.tenantAdmin, 'POST', SETS, t.body());

    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      owner: 'tenant',
      enabled: true,
      created: true,
      display_name: 'Release email',
    });
    const setId = created.json.id as string;
    expect(t.activeVersions(setId)).toEqual([
      { version: created.json.version_id, scope: OIDC_SCOPE },
    ]);
    expect(t.versionRows(setId)).toEqual([
      { id: created.json.version_id, lifecycle_state: 'active' },
    ]);
    expect(t.db.prepare('SELECT lifecycle_state FROM compiled_mapping_snapshots').all()).toEqual([
      { lifecycle_state: 'active' },
    ]);
    expect(
      t.db.prepare('SELECT lifecycle_state FROM field_mapping_sets WHERE id = ?').get(setId)
    ).toEqual({ lifecycle_state: 'active' });
    expect(created.json.content_version).toBe(created.json.version_id);
    expect(created.json.summary).toMatchObject({ rules: 1, edges: 1, released_claims: ['email'] });
    expect(JSON.stringify(created.json)).not.toContain('alice');
  });

  it('is resolved to the tenant’s ID token and UserInfo, by the app and as the tenant default', async () => {
    const t = await setup();
    const created = await t.create();
    const setId = created.id as string;
    const core = sqliteAdapter(openCoreDatabase());
    const run = async (env: Record<string, unknown>, selector: unknown) => {
      const results = [];
      for (const destinationSurface of ['id_token', 'userinfo'] as const) {
        results.push(
          await applyOIDCIdentityMapping({
            adapter: core,
            env: { DB_ADMIN: t.adapter, ...env } as never,
            tenantId: TENANT,
            clientId: 'client-a',
            selector: selector as never,
            destinationSurface,
            grantedScopes: ['openid', 'email'],
            claims: { sub: 'user-1' },
            sourceAttributes: { email: 'alice@example.com' },
          })
        );
      }
      return results;
    };

    const byApp = await run({ SETTINGS: { get: async () => null } }, { fieldMappingSetId: setId });
    const byTenantDefault = await run(
      {
        SETTINGS: {
          get: async (key: string) =>
            key === `settings:tenant:${TENANT}:identity-mapping`
              ? JSON.stringify({ 'identity_mapping.oidc_default_set_id': setId })
              : null,
        },
      },
      undefined
    );

    for (const result of [...byApp, ...byTenantDefault]) {
      expect(result.binding).toMatchObject({ tenantId: TENANT, fieldMappingSetId: setId });
      expect(result.claims).toMatchObject({ sub: 'user-1', email: 'alice@example.com' });
    }
  });

  it('answers a duplicate key with a conflict and leaves nothing', async () => {
    const t = await setup();
    await t.create({ field_mapping_key: 'same' });
    const before = t.rowCounts();

    const second = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ field_mapping_key: 'same' })
    );

    expect(second.status).toBe(409);
    expect(second.json.error).toBe('conflict');
    expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
  });

  it('needs the key of the set and refuses fields it does not know', async () => {
    const t = await setup();
    const missing = await t.request(t.tenantAdmin, 'POST', SETS, {
      display_name: 'x',
      content: t.content(),
    });
    const unknown = await t.request(t.tenantAdmin, 'POST', SETS, t.body({ fieldMappingKey: 'x' }));
    const unknownContent = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: { ...t.content(), versionLabel: 'v9' } })
    );

    expect(missing.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(unknown.json.error_description).toContain('fieldMappingKey');
    expect(unknownContent.status).toBe(400);
    expect(unknownContent.json.error_description).toContain('content.versionLabel');
    expect(t.rowCounts().sets).toBe(0);
  });

  it('creates it switched off when enabled is false: a version and a snapshot, no activation', async () => {
    const t = await setup();

    const created = await t.request(t.tenantAdmin, 'POST', SETS, t.body({ enabled: false }));

    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ enabled: false, active_version_id: null });
    expect(t.activeVersions(created.json.id)).toEqual([]);
    expect(t.versionRows(created.json.id)).toEqual([
      { id: created.json.version_id, lifecycle_state: 'published' },
    ]);
    expect(t.rowCounts().snapshots).toBe(1);
    expect(created.json.content_version).toBe(created.json.version_id);
  });
});

describe('reading a set', () => {
  it('gives back, as content, what a PUT takes (a round trip)', async () => {
    const t = await setup();
    const rule = emailRule(t.profile, {
      priority: -3,
      metadata: { note: 'kept' },
      transforms: [{ edgeIndex: 0, operation: 'trim', parameters: {} }],
      validationRules: [
        {
          targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
          validationKind: 'required',
          severity: 'warning',
        },
      ],
      releaseRules: [
        {
          destinationType: 'oidc',
          sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
          releaseAction: 'allow',
          purpose: 'login',
        },
      ],
      conflictRules: [
        {
          targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
          conflictStrategy: 'prefer_source',
          sourcePriority: ['a'],
        },
      ],
    });
    const created = await t.create({
      content: t.content({ rules: [rule, nicknameRule(t.profile)] }),
    });

    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);

    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      id: created.id,
      owner: 'tenant',
      enabled: true,
      active_version_id: created.version_id,
      content_version: created.version_id,
      references: { count: 0, scan_complete: true },
    });
    const readContent = read.json.content;
    expect(readContent.catalogVersionId).toBe(t.catalogVersionId);
    expect(readContent.rules).toHaveLength(2);
    expect(readContent.rules[0]).toMatchObject({
      ruleKey: 'email',
      priority: -3,
      metadata: { note: 'kept' },
      transforms: [{ edgeIndex: 0, operation: 'trim' }],
      validationRules: [{ validationKind: 'required', severity: 'warning' }],
      releaseRules: [{ destinationType: 'oidc', releaseAction: 'allow', purpose: 'login' }],
      conflictRules: [{ conflictStrategy: 'prefer_source', sourcePriority: ['a'] }],
    });

    // What was read is accepted as it is, and reads back the same.
    const again = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: created.display_name,
      content: readContent,
    });
    expect(again.status).toBe(200);
    const reread = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);
    expect(reread.json.content).toEqual(readContent);
    expect(reread.json.content_version).not.toBe(read.json.content_version);
  });

  it('lists the tenant’s sets and the platform’s with their state, and no other tenant’s', async () => {
    const t = await setup();
    const own = await t.create();
    const off = await t.create({ enabled: false });
    const platform = await t.create(
      {
        owner_scope_type: 'platform',
        content: t.content({
          profileId: t.platformProfile,
          catalogVersionId: PLATFORM_CATALOG_VERSION,
        }),
      },
      t.platformAdmin
    );
    t.db
      .prepare(
        "INSERT INTO field_mapping_sets (id, tenant_id, field_mapping_key, display_name, lifecycle_state, created_at, updated_at) VALUES ('set-b', 'tenant-b', 'k', 'B', 'active', 1, 1)"
      )
      .run();

    const list = await t.request(t.tenantAdmin, 'GET', SETS);

    expect(list.status).toBe(200);
    const rows = (list.json.sets as any[]).map((row) => [row.id, row.owner, row.enabled]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        [own.id, 'tenant', true],
        [off.id, 'tenant', false],
        [platform.id, 'platform', true],
      ])
    );
    expect(JSON.stringify(list.json)).not.toContain('set-b');
    expect(list.json.sets[0]).not.toHaveProperty('content');
  });

  it('answers another tenant’s set, and one that does not exist, alike with 404', async () => {
    const t = await setup();
    t.db
      .prepare(
        "INSERT INTO field_mapping_sets (id, tenant_id, field_mapping_key, display_name, lifecycle_state, created_at, updated_at) VALUES ('set-b', 'tenant-b', 'k', 'B', 'active', 1, 1)"
      )
      .run();
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', ''],
      ['PUT', '', t.body()],
      ['DELETE', ''],
    ];

    for (const who of [t.tenantAdmin, t.platformAdmin]) {
      for (const [method, _tail, payload] of attempts) {
        const other = await t.request(who, method, `${SETS}/set-b`, payload);
        const missing = await t.request(who, method, `${SETS}/set-nothing`, payload);
        expect([method, other.status, other.json.error_description]).toEqual([
          method,
          404,
          missing.json.error_description,
        ]);
        expect(missing.status).toBe(404);
      }
    }
  });

  it('shows how many things name the set', async () => {
    const t = await setup();
    const created = await t.create();
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'app-1',
      identityMapping: { fieldMappingSetId: created.id },
    });

    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);

    expect(read.json.references).toMatchObject({ count: 1, scan_complete: true });
    expect(JSON.stringify(read.json.references)).not.toContain('app-1');
  });
});

describe('the headers of an answer', () => {
  it('gives the content version as the ETag of a read and of a save', async () => {
    const t = await setup();
    const created = await t.create();
    const send = (method: string, body?: unknown) =>
      t.app.request(
        `${SETS}/${created.id}`,
        {
          method,
          headers: {
            'content-type': 'application/json',
            'X-Tenant-Id': TENANT,
            Cookie: t.tenantAdmin,
            'Idempotency-Key': `etag-key-${method}`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        t.envExtras as never
      );

    const read = await send('GET');
    const readJson = (await read.json()) as Record<string, any>;
    const saved = await send('PUT', { display_name: 'x', content: t.content() });
    const savedJson = (await saved.json()) as Record<string, any>;

    expect(read.headers.get('ETag')).toBe(`"${created.version_id}"`);
    expect(readJson.content_version).toBe(created.version_id);
    expect(saved.headers.get('ETag')).toBe(`"${savedJson.version_id}"`);
  });
});

describe('replacing the content of a set', () => {
  it('adds a version and switches the activation to it; the old version is kept, no longer in use', async () => {
    const t = await setup();
    const created = await t.create();
    const setId = created.id as string;

    const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${setId}`, {
      display_name: 'Release email and nickname',
      description: 'second',
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
    });

    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      created: false,
      enabled: true,
      display_name: 'Release email and nickname',
      description: 'second',
      previous_content_version: created.version_id,
    });
    expect(saved.json.version_id).not.toBe(created.version_id);
    expect(saved.json.content_version).toBe(saved.json.version_id);
    expect(t.versionRows(setId)).toEqual([
      { id: created.version_id, lifecycle_state: 'published' },
      { id: saved.json.version_id, lifecycle_state: 'active' },
    ]);
    expect(t.activeVersions(setId)).toEqual([
      { version: saved.json.version_id, scope: OIDC_SCOPE },
    ]);
    expect(
      t.db
        .prepare(
          'SELECT field_mapping_version_id AS v, lifecycle_state AS s FROM compiled_mapping_snapshots ORDER BY rowid'
        )
        .all()
    ).toEqual([
      { v: created.version_id, s: 'retired' },
      { v: saved.json.version_id, s: 'active' },
    ]);
    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${setId}`);
    expect(read.json.content.rules.map((rule: any) => rule.ruleKey)).toEqual(['email', 'nickname']);
    expect(read.json.display_name).toBe('Release email and nickname');
    // The lock the activation takes is not left behind for the next save.
    expect(t.count('SELECT COUNT(*) AS n FROM mapping_activation_leases')).toBe(0);
  });

  it('can be saved again at once, as many times as needed', async () => {
    const t = await setup();
    const created = await t.create();
    let previous = created.version_id as string;
    for (let round = 0; round < 3; round += 1) {
      const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
        display_name: `Round ${round}`,
        content: t.content(),
      });
      expect(saved.status).toBe(200);
      expect(saved.json.previous_content_version).toBe(previous);
      previous = saved.json.version_id;
    }
    expect(t.versionRows(created.id)).toHaveLength(4);
    expect(t.activeVersions(created.id)).toHaveLength(1);
  });

  it('switches a set on again after it was switched off, and off without losing the content', async () => {
    const t = await setup();
    const created = await t.create();

    const off = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Off',
      enabled: false,
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
    });

    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ enabled: false, active_version_id: null });
    expect(t.activeVersions(created.id)).toEqual([]);
    expect(
      t.db.prepare('SELECT lifecycle_state FROM field_mapping_sets WHERE id = ?').get(created.id)
    ).toEqual({ lifecycle_state: 'published' });
    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);
    expect(read.json).toMatchObject({ enabled: false, content_version: off.json.version_id });
    expect(read.json.content.rules).toHaveLength(2);
    // The set no longer resolves.
    const core = sqliteAdapter(openCoreDatabase());
    await expect(
      applyOIDCIdentityMapping({
        adapter: core,
        env: { DB_ADMIN: t.adapter, SETTINGS: { get: async () => null } } as never,
        tenantId: TENANT,
        clientId: 'client-a',
        selector: { fieldMappingSetId: created.id } as never,
        destinationSurface: 'id_token',
        claims: { sub: 'user-1' },
      })
    ).rejects.toBeTruthy();

    const on = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'On',
      content: read.json.content,
    });
    expect(on.status).toBe(200);
    expect(on.json.enabled).toBe(true);
    expect(t.activeVersions(created.id)).toEqual([
      { version: on.json.version_id, scope: OIDC_SCOPE },
    ]);
  });

  it('does not change the key or the owner of the set', async () => {
    const t = await setup();
    const created = await t.create({ field_mapping_key: 'fixed' });
    const before = t.rowCounts();

    const key = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      t.body({ field_mapping_key: 'other' })
    );
    const sameKey = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      t.body({ field_mapping_key: 'fixed' })
    );
    const owner = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      t.body({ field_mapping_key: 'fixed', owner_scope_type: 'platform' })
    );

    expect(key.status).toBe(400);
    expect(sameKey.status).toBe(200);
    expect(owner.status).toBe(400);
    expect(t.rowCounts().versions).toBe(before.versions + 1);
  });

  it('holds the content to the limits of the version create', async () => {
    const t = await setup();
    const created = await t.create();
    const rules = Array.from({ length: 251 }, (_, index) => ({
      ...emailRule(t.profile),
      ruleKey: `rule-${index}`,
    }));

    const refused = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content({ rules }),
    });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ stage_failed: 'validate' });
    // The size of the whole content is judged first, and the number of rules next.
    expect(refused.json.error_description).toMatch(/at most (250|4000)/);
    expect(t.versionRows(created.id)).toHaveLength(1);
  });

  it('refuses a body that is not valid, a set that does not exist, and content without what it needs', async () => {
    const t = await setup();
    const created = await t.create();

    const missingName = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      content: t.content(),
    });
    const noContent = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
    });
    const array = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, []);
    const rules = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: { catalogVersionId: t.catalogVersionId, rules: [null] },
    });

    expect([missingName.status, noContent.status, array.status, rules.status]).toEqual([
      400, 400, 400, 400,
    ]);
    expect(t.versionRows(created.id)).toHaveLength(1);
  });
});

describe('the precondition of a save', () => {
  it('refuses a save whose If-Match is not what the set is, and takes the one that is', async () => {
    const t = await setup();
    const created = await t.create();
    const stale = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      t.body({ field_mapping_key: undefined }),
      { headers: { 'If-Match': '"somebody-elses-version"' } }
    );
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('conflict');
    expect(t.versionRows(created.id)).toHaveLength(1);

    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);
    const etag = `"${read.json.content_version}"`;
    const first = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      { display_name: 'a', content: t.content() },
      { headers: { 'If-Match': etag } }
    );
    const reused = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      { display_name: 'b', content: t.content() },
      { headers: { 'If-Match': etag } }
    );
    const star = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      { display_name: 'c', content: t.content() },
      { headers: { 'If-Match': '*' } }
    );

    expect(first.status).toBe(200);
    expect(reused.status).toBe(409);
    expect(star.status).toBe(200);
    expect(t.versionRows(created.id)).toHaveLength(3);
  });

  it('refuses If-None-Match: * for a set that exists', async () => {
    const t = await setup();
    const created = await t.create();

    const refused = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      { display_name: 'a', content: t.content() },
      { headers: { 'If-None-Match': '*' } }
    );

    expect(refused.status).toBe(409);
    expect(t.versionRows(created.id)).toHaveLength(1);
  });

  it('refuses the save of whoever read the set before another save changed it', async () => {
    const t = await setup();
    const created = await t.create();
    // Another admin saves the set after this save has read it and before it switches.
    t.faults.afterWrite = {
      match: /INSERT INTO compiled_mapping_snapshots/,
      run: () => {
        t.db
          .prepare(
            `INSERT INTO field_mapping_versions (id, tenant_id, field_mapping_set_id, version_label, lifecycle_state, field_mapping_hash, created_at, updated_at)
             VALUES ('ver-elsewhere', ?, ?, 'elsewhere', 'published', 'h', 1, 1)`
          )
          .run(TENANT, created.id);
        t.db
          .prepare(
            "UPDATE field_mapping_activations SET field_mapping_version_id = 'ver-elsewhere' WHERE field_mapping_set_id = ? AND lifecycle_state = 'active'"
          )
          .run(created.id);
      },
    };

    const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'late',
      content: t.content(),
    });

    expect(saved.status).toBe(409);
    expect(saved.json).toMatchObject({ error: 'conflict', stage_failed: 'activate' });
    expect(saved.json.version_discarded).toBe(true);
    // Their activation stands, and the version this save built is gone.
    expect(t.activeVersions(created.id).map((row) => row.version)).toEqual(['ver-elsewhere']);
    expect(t.versionRows(created.id).map((row) => row.id)).toEqual([
      created.version_id,
      'ver-elsewhere',
    ]);
  });
});

describe('what a save changes while something names the set', () => {
  async function inUse(t: Awaited<ReturnType<typeof setup>>) {
    const created = await t.create();
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'app-1',
      identityMapping: { fieldMappingSetId: created.id },
    });
    return created;
  }

  it('wants the number of references it affects, and takes the right one', async () => {
    const t = await setup();
    const created = await inUse(t);
    const payload = (extra: Record<string, unknown> = {}) => ({
      display_name: 'x',
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
      ...extra,
    });
    const before = t.versionRows(created.id).length;

    const none = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload());
    const wrong = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      payload({ confirm_impact: 5 })
    );

    expect(none.status).toBe(409);
    expect(none.json).toMatchObject({
      error: 'impact_confirmation_required',
      references: { count: 1 },
    });
    expect(none.json.references.items).toEqual([
      { kind: 'client', tenantId: TENANT, clientId: 'app-1' },
    ]);
    expect(none.json.stage_failed).toBeUndefined();
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toBe('impact_confirmation_required');
    expect(t.versionRows(created.id)).toHaveLength(before);

    const done = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}`,
      payload({ confirm_impact: 1 })
    );
    expect(done.status).toBe(200);
    expect(t.versionRows(created.id)).toHaveLength(before + 1);
  });

  it('does not ask for it when nothing names the set, or for a set being created', async () => {
    const t = await setup();
    const created = await t.create();

    const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content(),
    });

    expect(saved.status).toBe(200);
    expect(created.id).toBeTruthy();
  });

  it('refuses switching the set off while it is named, even with the number confirmed', async () => {
    const t = await setup();
    const created = await inUse(t);

    const off = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      enabled: false,
      confirm_impact: 1,
      content: t.content(),
    });

    expect(off.status).toBe(409);
    expect(off.json).toMatchObject({
      error: 'conflict',
      reason: 'referenced',
      stage_failed: 'activate',
      version_discarded: true,
    });
    expect(t.activeVersions(created.id)).toHaveLength(1);
    expect(t.versionRows(created.id)).toHaveLength(1);
    expect(t.activeVersions(created.id)[0].version).toBe(created.version_id);
  });

  it('refuses content that releases into two profiles while the set is named, and keeps the one in use', async () => {
    const t = await setup();
    const created = await inUse(t);
    // A second profile in the content: the app that names the set could no longer be served.
    const second = await t.repository.createDestinationProfile(TENANT, {
      destinationType: 'oidc',
      profileKey: 'second',
      displayName: 'second',
      ownerScopeType: 'tenant',
      schema: RELEASED_EMAIL_SCHEMA,
    } as never);
    await t.repository.reviewDestinationProfileVersion(TENANT, second.id, second.version.id, false);
    await t.repository.activateDestinationProfileVersion(
      TENANT,
      second.id,
      second.version.id,
      false
    );

    const refused = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      confirm_impact: 1,
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(second.id)] }),
    });

    // Refused already as content: a set releases into one profile.
    expect(refused.status).toBe(400);
    expect(refused.json.stage_failed).toBe('validate');
    expect(t.activeVersions(created.id)).toEqual([
      { version: created.version_id, scope: OIDC_SCOPE },
    ]);
  });
});

describe('a preview', () => {
  it('writes nothing: no rows, no settings document, no replay record, no write at all', async () => {
    const t = await setup();
    const created = await t.create();
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'app-1',
      identityMapping: { fieldMappingSetId: created.id },
    });
    const before = t.rowCounts();
    const settingsBefore = JSON.stringify([...t.settings.store.entries()]);
    t.faults.writes.length = 0;

    const putPreview = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}?preview=true`,
      {
        display_name: 'x',
        content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
      },
      { key: null }
    );
    const createPreview = await t.request(t.tenantAdmin, 'POST', `${SETS}?preview=true`, t.body(), {
      key: null,
    });

    expect(putPreview.status).toBe(200);
    expect(putPreview.json).toMatchObject({
      preview: true,
      valid: true,
      would_create: false,
      enabled: true,
      content_version: created.version_id,
      compile: { ok: true, catalog_version_id: t.catalogVersionId },
      activation: { scope: OIDC_SCOPE, deactivation_refusal: null },
      confirm_impact_required: true,
      references: { count: 1, scan_complete: true },
    });
    expect(putPreview.json.diff).toMatchObject({
      before: { rules: 1, edges: 1, released_claims: ['email'] },
      after: { rules: 2, edges: 2, released_claims: ['email', 'nickname'] },
      claims_added: ['nickname'],
      claims_removed: [],
    });
    expect(createPreview.status).toBe(200);
    expect(createPreview.json).toMatchObject({
      preview: true,
      valid: true,
      would_create: true,
      id: null,
    });
    expect(t.faults.writes.filter((sql) => !/admin_sessions/.test(sql))).toEqual([]);
    expect(t.rowCounts()).toEqual(before);
    expect(JSON.stringify([...t.settings.store.entries()])).toBe(settingsBefore);
    expect(audits('identity_mapping.set.saved')).toHaveLength(1);
  });

  it('says what is wrong with the content instead of failing', async () => {
    const t = await setup();
    const created = await t.create();

    const preview = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}?preview=true`,
      { display_name: 'x', content: t.content({ profileId: t.lowerProfile }) },
      { key: null }
    );

    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ preview: true, valid: false, stage_failed: 'validate' });
    expect(preview.json.error_description).toContain('cannot lower classification from pii');
  });

  it('says that switching the set off would be refused while it is named', async () => {
    const t = await setup();
    const created = await t.create();
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'app-1',
      identityMapping: { fieldMappingSetId: created.id },
    });

    const preview = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.id}?preview=true`,
      { display_name: 'x', enabled: false, content: t.content() },
      { key: null }
    );

    expect(preview.json.activation.deactivation_refusal).toMatchObject({
      error: 'conflict',
      reason: 'referenced',
    });
  });

  it('is judged by the same permission and ownership as a save', async () => {
    const t = await setup();
    const platform = await t.create(
      {
        owner_scope_type: 'platform',
        content: t.content({
          profileId: t.platformProfile,
          catalogVersionId: PLATFORM_CATALOG_VERSION,
        }),
      },
      t.platformAdmin
    );

    const preview = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${platform.id}?preview=true`,
      t.body(),
      { key: null }
    );
    const viewer = await t.request(
      t.cookie([{ role: 'role_viewer', scope: 'tenant' }]),
      'PUT',
      `${SETS}/${platform.id}?preview=true`,
      t.body(),
      { key: null }
    );

    expect(preview.status).toBe(403);
    expect(viewer.status).toBe(403);
  });

  it('refuses a value of preview that is neither true nor false', async () => {
    const t = await setup();
    const created = await t.create();

    const response = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}?preview=yes`, {
      display_name: 'x',
      content: t.content(),
    });

    expect(response.status).toBe(400);
  });
});

describe('a step that fails', () => {
  const steps: Array<[string, RegExp, number]> = [
    ['create_version', /INSERT INTO field_mapping_versions/, 500],
    ['publish', /UPDATE field_mapping_versions\s+SET lifecycle_state = \?, published_at/, 500],
    ['compile', /INSERT INTO compiled_mapping_snapshots/, 500],
    ['activate', /INSERT INTO field_mapping_activations/, 500],
  ];

  it.each(steps)(
    'at %s leaves the version in use in use, removes the draft, and says which step',
    async (stage, sql, status) => {
      const t = await setup();
      const created = await t.create();
      const before = t.rowCounts();
      t.faults.failOn = sql;

      const payload = {
        display_name: 'renamed',
        description: 'changed',
        content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
      };
      const key = `failing-key-${stage}`;
      const failed = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, {
        key,
      });
      t.faults.failOn = null;

      expect(failed.status).toBe(status);
      expect(failed.json).toMatchObject({ error: 'internal_error', stage_failed: stage });
      // The version's ID is chosen before its first row is written, so it is known (and gone).
      expect(typeof failed.json.version_id).toBe('string');
      expect(failed.json.version_discarded).toBe(true);
      expect(
        t.count(
          'SELECT COUNT(*) AS n FROM field_mapping_versions WHERE id = ?',
          failed.json.version_id
        )
      ).toBe(0);
      // The same rows as before, the same version in use, the name as it was.
      expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
      expect(t.activeVersions(created.id)).toEqual([
        { version: created.version_id, scope: OIDC_SCOPE },
      ]);
      expect(t.versionRows(created.id)).toEqual([
        { id: created.version_id, lifecycle_state: 'active' },
      ]);
      const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);
      expect(read.json).toMatchObject({
        display_name: 'Release email',
        description: null,
        content_version: created.version_id,
      });
      expect(t.count('SELECT COUNT(*) AS n FROM mapping_activation_leases')).toBe(0);
      // The key is held: a request that started, and failed with a server error, is not run
      // again by a repeat of its key (its result is not known to the caller).
      const repeat = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, {
        key,
      });
      expect(repeat.status).toBe(409);
      expect(repeat.json.error).toBe('result_unknown');
      expect(t.versionRows(created.id)).toHaveLength(1);
    }
  );

  it.each(steps)('at %s of a creation leaves no set behind', async (stage, sql) => {
    const t = await setup();
    const before = t.rowCounts();
    t.faults.failOn = sql;

    const failed = await t.request(t.tenantAdmin, 'POST', SETS, t.body());
    t.faults.failOn = null;

    expect(failed.json.stage_failed).toBe(stage);
    expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
    // The same request works once the fault is gone.
    const again = await t.request(t.tenantAdmin, 'POST', SETS, t.body());
    expect(again.status).toBe(201);
  });

  it('at validate writes nothing and names the step', async () => {
    const t = await setup();
    const created = await t.create();
    const before = t.rowCounts();
    t.faults.writes.length = 0;

    const failed = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content({ rules: [emailRule(t.profile, { ruleKind: 'not a symbol!' })] }),
    });

    expect(failed.status).toBe(400);
    expect(failed.json).toMatchObject({ error: 'invalid_request', stage_failed: 'validate' });
    expect(failed.json.version_id).toBeUndefined();
    expect(
      t.faults.writes.filter((sql) => !/idempotency_records|admin_sessions/.test(sql))
    ).toEqual([]);
    expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
  });

  it('at activation by a refusal of the references removes the draft and leaves the set as it was', async () => {
    const t = await setup();
    const created = await t.create();
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'app-1',
      identityMapping: { fieldMappingSetId: created.id },
    });
    // Where the set is used cannot be read everywhere: the switch is refused.
    t.coreA.exec('DROP TABLE identity_providers');

    const refused = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      confirm_impact: 1,
      content: t.content(),
    });

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ reason: 'scan_incomplete', stage_failed: 'activate' });
    expect(t.versionRows(created.id)).toHaveLength(1);
    expect(t.activeVersions(created.id)).toHaveLength(1);
  });

  it('records one audit entry for the attempt, with the step and no value', async () => {
    const t = await setup();
    const created = await t.create();
    vi.mocked(createAuditLogFromContext).mockClear();
    t.faults.failOn = /INSERT INTO compiled_mapping_snapshots/;

    await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content(),
    });

    expect(audits('identity_mapping.set.saved')).toEqual([
      {
        resourceId: created.id,
        severity: 'warning',
        metadata: {
          set_id: created.id,
          owner: 'tenant',
          version_id: expect.any(String),
          enabled: true,
          created: false,
          result: 'failed',
          stage_failed: 'compile',
          rule_count: 1,
        },
      },
    ]);
  });
});

describe('the release safety check', () => {
  it('runs when the content is saved: what cannot be activated is not saved', async () => {
    const t = await setup();
    const before = t.rowCounts();

    const refused = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ profileId: t.lowerProfile }) })
    );

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: 'invalid_request', stage_failed: 'validate' });
    expect(refused.json.error_description).toContain('cannot lower classification from pii');
    expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
  });

  it('refuses a replacement of a set in use before it touches the version in use', async () => {
    const t = await setup();
    const created = await t.create();

    const refused = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content({ profileId: t.lowerProfile }),
    });

    expect(refused.status).toBe(400);
    expect(t.versionRows(created.id)).toEqual([
      { id: created.version_id, lifecycle_state: 'active' },
    ]);
  });

  it('is the same check the activation makes, which stays: the old endpoints still stop it there', async () => {
    const t = await setup();
    // The old path is the repository's five steps.
    const legacy = await t.repository.createFieldMappingSet(TENANT, {
      fieldMappingKey: 'legacy',
      displayName: 'Legacy',
    });
    const version = await t.repository.createFieldMappingVersion(TENANT, legacy.id, {
      versionLabel: 'v1',
      rules: [emailRule(t.lowerProfile)],
    } as never);
    await t.repository.publishFieldMappingVersion(TENANT, legacy.id, version.id);
    const compiled = await t.repository.compileFieldMappingVersion(TENANT, legacy.id, version.id, {
      catalogVersionId: t.catalogVersionId,
    });

    // Saved and compiled by the five steps, then refused only on activation.
    await expect(
      t.repository.activateFieldMappingVersion(TENANT, legacy.id, version.id, {
        snapshotId: compiled.id,
        activationScope: {},
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('the kind of Destination Profile', () => {
  it('refuses a set that releases into a SAML profile, and says to use the activation endpoints', async () => {
    const t = await setup();
    seedDestinationProfile(t.db, { owner: TENANT, id: 'profile-saml', destinationType: 'saml' });

    const refused = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ profileId: 'profile-saml' }) })
    );

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({
      error: 'unsupported_destination',
      stage_failed: 'validate',
    });
    expect(refused.json.error_description).toContain('activation endpoints');
    expect(t.rowCounts().sets).toBe(0);
  });

  it('refuses it when the profile is not found, when there is none, and when there are two', async () => {
    const t = await setup();
    const second = await t.repository.createDestinationProfile(TENANT, {
      destinationType: 'oidc',
      profileKey: 'second',
      displayName: 'second',
      ownerScopeType: 'tenant',
      schema: RELEASED_EMAIL_SCHEMA,
    } as never);
    await t.repository.reviewDestinationProfileVersion(TENANT, second.id, second.version.id, false);
    await t.repository.activateDestinationProfileVersion(
      TENANT,
      second.id,
      second.version.id,
      false
    );
    const noProfile = emailRule(t.profile);
    delete (noProfile.edges[0].targetRef as Record<string, unknown>).profileId;

    const missing = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ profileId: 'nothing' }) })
    );
    const none = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ rules: [noProfile] }) })
    );
    const two = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ rules: [emailRule(t.profile), nicknameRule(second.id)] }) })
    );

    expect(missing.json.error).toBe('unsupported_destination');
    expect(none.json.error).toBe('unsupported_destination');
    expect(two.status).toBe(400);
    expect(two.json.error).toBe('invalid_request');
    expect(t.rowCounts().sets).toBe(0);
  });

  it('does not read a profile of another tenant', async () => {
    const t = await setup();
    seedDestinationProfile(t.db, { owner: 'tenant-b', id: 'profile-of-b' });

    const refused = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ profileId: 'profile-of-b' }) })
    );

    expect(refused.json.error).toBe('unsupported_destination');
  });
});

describe('platform-owned sets', () => {
  const platformContent = (t: Awaited<ReturnType<typeof setup>>, rules?: unknown[]) =>
    t.content({
      profileId: t.platformProfile,
      catalogVersionId: PLATFORM_CATALOG_VERSION,
      rules,
    });

  it('is created, replaced and read by whoever holds the platform authority, with no scope', async () => {
    const t = await setup();

    const created = await t.request(
      t.platformAdmin,
      'POST',
      SETS,
      t.body({ owner_scope_type: 'platform', content: platformContent(t) })
    );

    expect(created.status).toBe(201);
    expect(created.json.owner).toBe('platform');
    expect(
      t.db.prepare('SELECT tenant_id, activation_scope_json FROM field_mapping_activations').all()
    ).toEqual([{ tenant_id: PLATFORM_MAPPING_TENANT_ID, activation_scope_json: '{}' }]);

    const saved = await t.request(t.platformAdmin, 'PUT', `${SETS}/${created.json.id}`, {
      display_name: 'Platform again',
      content: platformContent(t),
    });
    expect(saved.status).toBe(200);
    expect(t.activeVersions(created.json.id)).toEqual([
      { version: saved.json.version_id, scope: {} },
    ]);
  });

  it('is read by a tenant admin and changed by none: not created, replaced, previewed or deleted', async () => {
    const t = await setup();
    const platform = await t.create(
      { owner_scope_type: 'platform', content: platformContent(t) },
      t.platformAdmin
    );
    const before = t.rowCounts();

    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${platform.id}`);
    const create = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ owner_scope_type: 'platform', content: platformContent(t) })
    );
    const replace = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${platform.id}`,
      t.body({ field_mapping_key: undefined, content: platformContent(t) })
    );
    const remove = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${platform.id}`);

    expect(read.status).toBe(200);
    expect(read.json.owner).toBe('platform');
    expect([create.status, replace.status, remove.status]).toEqual([403, 403, 403]);
    expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
  });

  it('is not changed by a machine credential that holds the permission for one tenant only', async () => {
    const t = await setup();
    const platform = await t.create(
      { owner_scope_type: 'platform', content: platformContent(t) },
      t.platformAdmin
    );
    const token = await t.machine(
      [ADMIN_PERMISSIONS.SETTINGS_WRITE, ADMIN_PERMISSIONS.SETTINGS_READ],
      'allow'
    );

    const create = await t.requestWithToken(
      token,
      'POST',
      SETS,
      t.body({ owner_scope_type: 'platform', content: platformContent(t) })
    );
    const replace = await t.requestWithToken(token, 'PUT', `${SETS}/${platform.id}`, {
      display_name: 'x',
      content: platformContent(t),
    });
    const ownSet = await t.requestWithToken(token, 'POST', SETS, t.body());

    expect(create.status).toBe(403);
    expect(replace.status).toBe(403);
    expect(ownSet.status).toBe(201);
    expect(t.versionRows(platform.id)).toHaveLength(1);
  });

  it('is held to what a platform set may hold, already as content', async () => {
    const t = await setup();
    const rule = emailRule(t.platformProfile);
    (rule.edges[0].sourceRef as Record<string, unknown>).namespace = 'authrim.custom_claims';

    const refused = await t.request(
      t.platformAdmin,
      'POST',
      SETS,
      t.body({ owner_scope_type: 'platform', content: platformContent(t, [rule]) })
    );

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ stage_failed: 'validate' });
    expect(refused.json.error_description).toContain('tenant-defined field');
    expect(t.rowCounts().sets).toBe(0);
  });

  it('cannot be made with a Destination Profile of a tenant', async () => {
    const t = await setup();

    const refused = await t.request(
      t.platformAdmin,
      'POST',
      SETS,
      t.body({
        owner_scope_type: 'platform',
        content: t.content({ catalogVersionId: PLATFORM_CATALOG_VERSION }),
      })
    );

    expect(refused.status).toBe(400);
    expect(t.rowCounts().sets).toBe(0);
  });
});

describe('who may use the facade', () => {
  it('lets a viewer read and no one without the settings permissions do anything', async () => {
    const t = await setup();
    const created = await t.create();
    const viewer = t.cookie([{ role: 'role_viewer', scope: 'tenant' }]);

    const list = await t.request(viewer, 'GET', SETS);
    const read = await t.request(viewer, 'GET', `${SETS}/${created.id}`);
    const write = await t.request(
      viewer,
      'PUT',
      `${SETS}/${created.id}`,
      t.body({ field_mapping_key: undefined })
    );
    const create = await t.request(viewer, 'POST', SETS, t.body());
    const remove = await t.request(viewer, 'DELETE', `${SETS}/${created.id}`);
    const anonymous = await t.request('', 'GET', SETS);

    expect([list.status, read.status]).toEqual([200, 200]);
    expect([write.status, create.status, remove.status]).toEqual([403, 403, 403]);
    expect(anonymous.status).toBe(401);
    expect(t.versionRows(created.id)).toHaveLength(1);
  });
});

describe('repeating a request', () => {
  it('answers a repeat of a creation with the stored answer and creates one set', async () => {
    const t = await setup();
    const payload = t.body();
    const key = 'replay-key-0000';

    const first = await t.request(t.tenantAdmin, 'POST', SETS, payload, { key });
    const second = await t.request(t.tenantAdmin, 'POST', SETS, payload, { key });

    expect(first.status).toBe(201);
    expect(second).toEqual(first);
    expect(t.rowCounts()).toMatchObject({ sets: 1, versions: 1, activations: 1 });
  });

  it('answers a repeat with the stored answer and does the work once', async () => {
    const t = await setup();
    const created = await t.create();
    const payload = { display_name: 'x', content: t.content() };
    const key = 'replay-key-0001';

    const first = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, { key });
    const second = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, { key });

    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    expect(t.versionRows(created.id)).toHaveLength(2);
    expect(audits('identity_mapping.set.saved')).toHaveLength(2);
  });

  it('keeps the stored answer in the Admin database, and answers a repeat of a refusal alike', async () => {
    const t = await setup();
    const key = 'replay-key-0002';
    const payload = t.body({ content: t.content({ profileId: t.lowerProfile }) });

    const first = await t.request(t.tenantAdmin, 'POST', SETS, payload, { key });
    const second = await t.request(t.tenantAdmin, 'POST', SETS, payload, { key });

    expect(first.status).toBe(400);
    expect(second).toEqual(first);
    expect(
      t.count(
        "SELECT COUNT(*) AS n FROM idempotency_records WHERE operation_key LIKE 'identity_mapping.set.save:%'"
      )
    ).toBe(1);
    expect(
      (t.coreA.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number }).n
    ).toBe(0);
  });

  it('refuses the same key with another body, and for another set', async () => {
    const t = await setup();
    const one = await t.create();
    const two = await t.create();
    const key = 'replay-key-0003';
    const payload = { display_name: 'x', content: t.content() };

    const first = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${one.id}`, payload, { key });
    const changed = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${one.id}`,
      { ...payload, display_name: 'y' },
      { key }
    );
    const other = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${two.id}`, payload, { key });

    expect(first.status).toBe(200);
    expect(changed.status).toBe(409);
    expect(changed.json.error).toBe('idempotency_conflict');
    // The same key and body for another set is another request: it is not answered with the
    // stored answer of the first set.
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('idempotency_conflict');
    expect(t.versionRows(one.id)).toHaveLength(2);
    expect(t.versionRows(two.id)).toHaveLength(1);
  });

  it('keeps another administrator’s key apart', async () => {
    const t = await setup();
    const one = await t.create();
    const key = 'replay-key-0004';
    const payload = { display_name: 'x', content: t.content() };
    const other = t.cookie();

    const first = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${one.id}`, payload, { key });
    const second = await t.request(other, 'PUT', `${SETS}/${one.id}`, payload, { key });

    expect(first.json.version_id).not.toBe(second.json.version_id);
    expect(t.versionRows(one.id)).toHaveLength(3);
  });

  it('needs a key to write, and not to read or preview', async () => {
    const t = await setup();
    const created = await t.create();
    const payload = { display_name: 'x', content: t.content() };

    const noKey = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, {
      key: null,
    });
    const short = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, {
      key: 'short',
    });
    const noKeyDelete = await t.request(
      t.tenantAdmin,
      'DELETE',
      `${SETS}/${created.id}`,
      undefined,
      { key: null }
    );
    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`, undefined, {
      key: null,
    });

    expect([noKey.status, short.status, noKeyDelete.status]).toEqual([400, 400, 400]);
    expect(read.status).toBe(200);
    expect(t.versionRows(created.id)).toHaveLength(1);
  });

  it('refuses a body larger than the content may be', async () => {
    const t = await setup();
    const created = await t.create();
    const big = { display_name: 'x', description: 'y'.repeat(300 * 1024), content: t.content() };

    const refused = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, big);

    expect(refused.status).toBe(413);
    expect(t.versionRows(created.id)).toHaveLength(1);
  });

  it('removes the stored answers that have run out', async () => {
    const t = await setup();
    await t.create();
    expect(t.count('SELECT COUNT(*) AS n FROM idempotency_records')).toBe(1);
    t.db.prepare('UPDATE idempotency_records SET expires_at = 1').run();

    const removed = await sweepExpiredMappingSetSaveRecords({ DB_ADMIN: t.adapter } as never);

    expect(removed).toBe(1);
    expect(t.count('SELECT COUNT(*) AS n FROM idempotency_records')).toBe(0);
  });
});

describe('deleting a set', () => {
  it('is refused while the set is switched on, and goes when it is off and nothing names it', async () => {
    const t = await setup();
    const created = await t.create();

    const early = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${created.id}`);
    await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      enabled: false,
      content: t.content(),
    });
    const done = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${created.id}`);

    expect(early.status).toBe(409);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ id: created.id, owner: 'tenant', deleted: true });
    expect({ ...t.rowCounts(), idempotency: 0 }).toMatchObject({
      sets: 0,
      versions: 0,
      rules: 0,
      edges: 0,
      snapshots: 0,
      activations: 0,
      graphs: 0,
    });
    expect(audits('identity_mapping.set.deleted')).toHaveLength(1);
  });

  it('is refused while something names it, as the old endpoint does', async () => {
    const t = await setup();
    const created = await t.create({ enabled: false });
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'app-1',
      identityMapping: { fieldMappingSetId: created.id },
    });

    const refused = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${created.id}`);

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ reason: 'referenced', references: { count: 1 } });
    expect(t.rowCounts().sets).toBe(1);
  });
});

describe('the five steps underneath', () => {
  it('shows a set the facade saved to the old endpoints’ view of versions and activations', async () => {
    const t = await setup();
    const created = await t.create();

    const versions = await t.repository.listFieldMappingVersions(TENANT, created.id);

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: created.version_id,
      lifecycleState: 'active',
      latestSnapshot: { id: created.snapshot_id, lifecycleState: 'active' },
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('saves that run at the same time', () => {
  /** Another admin's save, finished: a version of theirs is in use, with their name for the set. */
  function otherAdminSaves(t: Awaited<ReturnType<typeof setup>>, setId: string) {
    return () => {
      t.db
        .prepare(
          `INSERT INTO field_mapping_versions (id, tenant_id, field_mapping_set_id, version_label, lifecycle_state, field_mapping_hash, created_at, updated_at)
           VALUES ('ver-elsewhere', ?, ?, 'elsewhere', 'published', 'h', 1, 1)`
        )
        .run(TENANT, setId);
      t.db
        .prepare(
          "UPDATE field_mapping_activations SET field_mapping_version_id = 'ver-elsewhere' WHERE field_mapping_set_id = ? AND lifecycle_state = 'active'"
        )
        .run(setId);
      t.db
        .prepare(
          "UPDATE field_mapping_sets SET display_name = 'Name by the other admin', description = 'theirs' WHERE id = ?"
        )
        .run(setId);
    };
  }

  it('does not replace a version that another save switched in after this one looked (the switch checks it)', async () => {
    const t = await setup();
    const created = await t.create();
    // Every look has passed when the switch is applied: the other save comes in between.
    t.hooks.beforeBatch = async () => otherAdminSaves(t, created.id)();

    const lost = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Name by this admin',
      description: 'mine',
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
    });

    expect(lost.status).toBe(409);
    expect(lost.json).toMatchObject({
      error: 'conflict',
      stage_failed: 'activate',
      version_discarded: true,
    });
    // Theirs stands: the version in use, and the name and description they gave.
    expect(t.activeVersions(created.id).map((row) => row.version)).toEqual(['ver-elsewhere']);
    expect(t.versionRows(created.id).map((row) => row.id)).toEqual([
      created.version_id,
      'ver-elsewhere',
    ]);
    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);
    expect(read.json).toMatchObject({
      display_name: 'Name by the other admin',
      description: 'theirs',
    });
    expect(t.count('SELECT COUNT(*) AS n FROM mapping_activation_leases')).toBe(0);
  });

  it('does not switch a set off that another save has put another version in use', async () => {
    const t = await setup();
    const created = await t.create();
    t.hooks.beforeBatch = async () => otherAdminSaves(t, created.id)();

    const lost = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Name by this admin',
      enabled: false,
      content: t.content(),
    });

    expect(lost.status).toBe(409);
    expect(lost.json).toMatchObject({ error: 'conflict', stage_failed: 'activate' });
    expect(t.activeVersions(created.id).map((row) => row.version)).toEqual(['ver-elsewhere']);
    expect(
      t.db.prepare('SELECT display_name FROM field_mapping_sets WHERE id = ?').get(created.id)
    ).toEqual({ display_name: 'Name by the other admin' });
  });

  it('writes the name and description with the switch and not before', async () => {
    const t = await setup();
    const created = await t.create();
    let nameWhenSwitching: unknown;
    t.hooks.beforeBatch = async () => {
      nameWhenSwitching = t.db
        .prepare('SELECT display_name FROM field_mapping_sets WHERE id = ?')
        .get(created.id);
    };

    const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Renamed',
      content: t.content(),
    });

    expect(saved.status).toBe(200);
    expect(nameWhenSwitching).toEqual({ display_name: 'Release email' });
    expect(saved.json.display_name).toBe('Renamed');
  });

  it('does not rename a set that is saved switched off and unchanged in use, before the save is whole', async () => {
    const t = await setup();
    const created = await t.create({ enabled: false });
    t.faults.failOn = /UPDATE field_mapping_sets SET display_name/;

    const failed = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Renamed',
      enabled: false,
      content: t.content(),
    });
    t.faults.failOn = null;

    expect(failed.json.stage_failed).toBe('activate');
    expect(
      t.db.prepare('SELECT display_name FROM field_mapping_sets WHERE id = ?').get(created.id)
    ).toEqual({ display_name: 'Release email' });
    expect(t.versionRows(created.id)).toHaveLength(1);
  });

  it('asks again for the number of references at the switch, when one came in after it was confirmed', async () => {
    const t = await setup();
    const created = await t.create();
    insertOAuthClient(t.coreA, {
      tenantId: TENANT,
      clientId: 'app-1',
      identityMapping: { fieldMappingSetId: created.id },
    });
    // A second app names the set while the new version is being compiled.
    t.faults.afterWrite = {
      match: /INSERT INTO compiled_mapping_snapshots/,
      run: () =>
        insertOAuthClient(t.coreA, {
          tenantId: TENANT,
          clientId: 'app-2',
          identityMapping: { fieldMappingSetId: created.id },
        }),
    };

    const refused = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      confirm_impact: 1,
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
    });

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      error: 'impact_confirmation_required',
      stage_failed: 'activate',
      version_discarded: true,
      references: { count: 2 },
    });
    expect(t.activeVersions(created.id).map((row) => row.version)).toEqual([created.version_id]);
    expect(t.versionRows(created.id)).toHaveLength(1);
  });
});

describe('a version that is put in use while it is being removed', () => {
  it('is not removed: the removal is one batch that checks first and changes nothing when it fails', async () => {
    const t = await setup();
    const set = await t.repository.createFieldMappingSet(TENANT, {
      fieldMappingKey: 'discard',
      displayName: 'Discard',
    });
    const version = await t.repository.createFieldMappingVersion(TENANT, set.id, {
      versionLabel: 'v1',
      rules: [emailRule(t.profile)],
    } as never);
    await t.repository.publishFieldMappingVersion(TENANT, set.id, version.id);
    const compiled = await t.repository.compileFieldMappingVersion(TENANT, set.id, version.id, {
      catalogVersionId: t.catalogVersionId,
    });
    const before = t.rowCounts();
    // The version has been looked at and found unused; then someone activates it.
    t.hooks.beforeBatch = async () => {
      await t.repository.activateFieldMappingVersion(TENANT, set.id, version.id, {
        snapshotId: compiled.id,
        activationScope: OIDC_SCOPE,
      });
    };

    const discarded = await t.repository.discardUnusedFieldMappingVersion(
      TENANT,
      set.id,
      version.id
    );

    expect(discarded).toBe(false);
    expect(t.activeVersions(set.id)).toEqual([{ version: version.id, scope: OIDC_SCOPE }]);
    expect({ ...t.rowCounts(), activations: 0 }).toEqual({ ...before, activations: 0 });
    expect(t.rowCounts().activations).toBe(1);
    expect(t.rowCounts().snapshots).toBe(1);
    expect(t.rowCounts().rules).toBe(1);
  });

  it('is removed with everything under it when nothing names it, in one batch', async () => {
    const t = await setup();
    const set = await t.repository.createFieldMappingSet(TENANT, {
      fieldMappingKey: 'discard-2',
      displayName: 'Discard',
    });
    const version = await t.repository.createFieldMappingVersion(TENANT, set.id, {
      versionLabel: 'v1',
      rules: [emailRule(t.profile)],
    } as never);
    await t.repository.publishFieldMappingVersion(TENANT, set.id, version.id);
    await t.repository.compileFieldMappingVersion(TENANT, set.id, version.id, {
      catalogVersionId: t.catalogVersionId,
    });
    t.faults.writes.length = 0;
    const batches: number[] = [];
    t.hooks.beforeBatch = async () => {
      batches.push(1);
    };

    const discarded = await t.repository.discardUnusedFieldMappingVersion(
      TENANT,
      set.id,
      version.id
    );

    expect(discarded).toBe(true);
    expect(batches).toHaveLength(1);
    expect(t.rowCounts()).toMatchObject({
      versions: 0,
      rules: 0,
      edges: 0,
      snapshots: 0,
      graphs: 0,
    });
  });
});

describe('a save that fails while the version is being written', () => {
  it('removes the rows written so far: the version’s ID is known before the first row', async () => {
    const t = await setup();
    const created = await t.create();
    const before = t.rowCounts();
    // The version row and its rule are in when the edge fails.
    t.faults.failOn = /INSERT INTO mapping_rule_edges/;

    const failed = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content(),
    });
    t.faults.failOn = null;

    expect(failed.json).toMatchObject({
      stage_failed: 'create_version',
      version_discarded: true,
    });
    expect(typeof failed.json.version_id).toBe('string');
    expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
    expect(t.activeVersions(created.id)).toHaveLength(1);
  });

  it('does not leave a half-written version when the database refuses a value the checks let through', async () => {
    const t = await setup();
    const created = await t.create();
    const before = t.rowCounts();
    const rule = { ...emailRule(t.profile), priority: { not: 'a number' } };

    const failed = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content({ rules: [rule] }),
    });

    // Refused as content (a priority is an integer); nothing was written.
    expect(failed.status).toBe(400);
    expect({ ...t.rowCounts(), idempotency: 0 }).toEqual({ ...before, idempotency: 0 });
  });
});

describe('what is read is accepted as it is read, at the limits of a rule', () => {
  it('spreads the release and conflict rules of a version over its rules within their limits', async () => {
    const t = await setup();
    const conflict = (index: number) => ({
      targetRef: { side: 'destination', namespace: 'oidc.claim', path: `c${index}` },
      conflictStrategy: 'prefer_source',
    });
    const release = (index: number) => ({
      destinationType: 'oidc',
      sourceRef: { side: 'source', namespace: 'authrim.profile', path: `r${index}` },
      releaseAction: 'allow',
    });
    const rules = [0, 1].map((rule) => ({
      ...(rule === 0 ? emailRule(t.profile) : nicknameRule(t.profile)),
      conflictRules: Array.from({ length: 80 }, (_, i) => conflict(rule * 100 + i)),
      releaseRules: Array.from({ length: 130 }, (_, i) => release(rule * 1000 + i)),
    }));
    const created = await t.create({ content: t.content({ rules }) });

    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);

    const readRules = read.json.content.rules as Array<{
      conflictRules: unknown[];
      releaseRules: unknown[];
    }>;
    expect(readRules.map((rule) => rule.conflictRules.length)).toEqual([100, 60]);
    expect(readRules.map((rule) => rule.releaseRules.length)).toEqual([250, 10]);
    const again = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: read.json.content,
    });
    expect(again.status).toBe(200);
    const reread = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);
    expect(reread.json.content).toEqual(read.json.content);
  });
});

describe('a stored answer is for the credential that made the request', () => {
  /** One machine principal, two credentials: one for every tenant, one for the tenant only. */
  async function credentials(t: Awaited<ReturnType<typeof setup>>) {
    sequence += 1;
    const now = Date.now();
    const principal = `amp_pair_${sequence}`;
    t.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'Pair', 'automation', 'active', 'authrim:admin-api', 600, ?, ?)`
      )
      .run(principal, `client-${principal}`, now, now);
    t.db
      .prepare(
        `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'all', NULL, ?)`
      )
      .run(principal, now);
    const ids = ['wide', 'narrow'].map((kind) => {
      const credential = `amk_${principal}_${kind}`;
      t.db
        .prepare(
          `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
             status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'ES256', 'Key', 'active', ?, ?)`
        )
        .run(credential, principal, `kid-${credential}`, JSON.stringify(PUBLIC_JWK), now, now);
      return credential;
    });
    t.db
      .prepare(
        `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at) VALUES (?, '*', ?)`
      )
      .run(principal, now);
    return {
      wide: await t.kit.sign(t.db, ids[0], ['*'], ['*']),
      narrow: await t.kit.sign(t.db, ids[1], ['*'], [TENANT]),
    };
  }
  const send = (
    t: Awaited<ReturnType<typeof setup>>,
    token: string,
    method: string,
    path: string,
    body: unknown,
    key: string
  ) => t.callWithToken(token, method, path, body, { 'Idempotency-Key': key });

  it('is not given to another credential of the same principal that could not have made it', async () => {
    const t = await setup();
    const platform = await t.create(
      {
        owner_scope_type: 'platform',
        content: t.content({
          profileId: t.platformProfile,
          catalogVersionId: PLATFORM_CATALOG_VERSION,
        }),
      },
      t.platformAdmin
    );
    const { wide, narrow } = await credentials(t);
    const payload = {
      display_name: 'Platform again',
      content: t.content({
        profileId: t.platformProfile,
        catalogVersionId: PLATFORM_CATALOG_VERSION,
      }),
    };

    const first = await send(t, wide, 'PUT', `${SETS}/${platform.id}`, payload, 'pair-key-0001');
    const replayed = await send(
      t,
      narrow,
      'PUT',
      `${SETS}/${platform.id}`,
      payload,
      'pair-key-0001'
    );

    expect(first.status).toBe(200);
    expect(replayed.status).toBe(403);
    expect(JSON.stringify(replayed.json)).not.toContain('Platform again');
    expect(t.versionRows(platform.id)).toHaveLength(2);
  });

  it('is refused the same way when only the judging of the set is left (the key is not bound to the credential)', async () => {
    const t = await setup({ bindToAuthority: false });
    const platform = await t.create(
      {
        owner_scope_type: 'platform',
        content: t.content({
          profileId: t.platformProfile,
          catalogVersionId: PLATFORM_CATALOG_VERSION,
        }),
      },
      t.platformAdmin
    );
    const { wide, narrow } = await credentials(t);
    const payload = {
      display_name: 'Platform again',
      content: t.content({
        profileId: t.platformProfile,
        catalogVersionId: PLATFORM_CATALOG_VERSION,
      }),
    };

    await send(t, wide, 'PUT', `${SETS}/${platform.id}`, payload, 'pair-key-0002');
    const replayed = await send(
      t,
      narrow,
      'PUT',
      `${SETS}/${platform.id}`,
      payload,
      'pair-key-0002'
    );

    expect(replayed.status).toBe(403);
  });

  it('is not replayed to another credential even where both may make the request', async () => {
    const t = await setup();
    const created = await t.create();
    const { wide, narrow } = await credentials(t);
    const payload = { display_name: 'x', content: t.content() };

    const first = await send(t, wide, 'PUT', `${SETS}/${created.id}`, payload, 'pair-key-0003');
    const other = await send(t, narrow, 'PUT', `${SETS}/${created.id}`, payload, 'pair-key-0003');
    const again = await send(t, wide, 'PUT', `${SETS}/${created.id}`, payload, 'pair-key-0003');

    expect(first.status).toBe(200);
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('idempotency_conflict');
    expect(again).toEqual(first);
    expect(t.versionRows(created.id)).toHaveLength(2);
  });

  it('is not given to the same admin once a right it needed has been taken away', async () => {
    const t = await setup();
    const platform = await t.create(
      {
        owner_scope_type: 'platform',
        content: t.content({
          profileId: t.platformProfile,
          catalogVersionId: PLATFORM_CATALOG_VERSION,
        }),
      },
      t.platformAdmin
    );
    const payload = {
      display_name: 'Platform again',
      content: t.content({
        profileId: t.platformProfile,
        catalogVersionId: PLATFORM_CATALOG_VERSION,
      }),
    };
    const first = await t.request(t.platformAdmin, 'PUT', `${SETS}/${platform.id}`, payload, {
      key: 'demoted-key-0001',
    });
    // The admin keeps the right to write settings, and loses the platform’s.
    const userId = (
      t.db
        .prepare('SELECT admin_user_id AS id FROM admin_sessions WHERE id = ?')
        .get(t.platformAdmin.split('=')[1]) as { id: string }
    ).id;
    t.db.prepare('DELETE FROM admin_role_assignments WHERE admin_user_id = ?').run(userId);
    t.db
      .prepare(
        `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
         VALUES ('demoted-assignment', ?, ?, 'role_super_admin', 'tenant', ?, ?)`
      )
      .run(TENANT, userId, TENANT, Date.now());

    const replayed = await t.request(t.platformAdmin, 'PUT', `${SETS}/${platform.id}`, payload, {
      key: 'demoted-key-0001',
    });

    expect(first.status).toBe(200);
    expect(replayed.status).toBe(403);
  });
});

describe('the headers kept with a stored answer', () => {
  it('replays the ETag of a save with its answer', async () => {
    const t = await setup();
    const created = await t.create();
    const send = () =>
      t.app.request(
        `${SETS}/${created.id}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'X-Tenant-Id': TENANT,
            Cookie: t.tenantAdmin,
            'Idempotency-Key': 'etag-replay-0001',
          },
          body: JSON.stringify({ display_name: 'x', content: t.content() }),
        },
        t.envExtras as never
      );

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(first.headers.get('ETag')).toMatch(/^"field_mapping_version_/);
    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'));
    expect(t.versionRows(created.id)).toHaveLength(2);
  });
});

describe('the size of a body the common limit lets through', () => {
  /** A rule whose metadata makes the content about 110 KiB: inside the 128 KiB the checks allow. */
  const largeRule = (profileId: string) => ({
    ...emailRule(profileId),
    metadata: Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`note-${index}`, 'x'.repeat(260)])
    ),
  });

  it('accepts content of 110 KiB to create, to replace, and to preview, past the 100 KiB of other routes', async () => {
    const t = await setup();
    const rules = [largeRule(t.profile)];
    expect(JSON.stringify(rules).length).toBeGreaterThan(105 * 1024);

    const created = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ rules }) })
    );
    const replaced = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.json.id}`, {
      display_name: 'x',
      content: t.content({ rules }),
    });
    const previewed = await t.request(
      t.tenantAdmin,
      'PUT',
      `${SETS}/${created.json.id}?preview=true`,
      { display_name: 'x', content: t.content({ rules }) },
      { key: null }
    );

    expect([created.status, replaced.status, previewed.status]).toEqual([201, 200, 200]);
  });

  it('refuses a body of 300 KiB, and a body of 110 KiB to any other route of the Admin API', async () => {
    const t = await setup();
    const created = await t.create();
    const big = { display_name: 'x', description: 'y'.repeat(300 * 1024), content: t.content() };

    const refused = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, big);
    const other = await t.request(t.tenantAdmin, 'POST', '/api/admin/elsewhere', {
      text: 'z'.repeat(110 * 1024),
    });

    expect(refused.status).toBe(413);
    expect(other.status).toBe(413);
  });

  it('is the middleware that the management Worker puts in front of every Admin API route', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    const limit = source.indexOf("app.use('/api/admin/*', adminBodyLimitMiddleware(");
    const access = source.indexOf('registerDeclaredAdminRouteAccessMiddleware(app);');
    const sets = source.indexOf("'/api/admin/identity-mapping/sets/:id'");

    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(access);
    expect(access).toBeLessThan(sets);
    expect(source).not.toContain("from 'hono/body-limit'");
  });
});

// ---------------------------------------------------------------------------------------------

describe('a switch whose answer is lost', () => {
  it('stands when the batch was applied and the database applies it again and refuses (the D1 retry)', async () => {
    const t = await setup();
    const created = await t.create();
    t.faults.retryAfterApply = /INSERT INTO field_mapping_activations/;

    const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Renamed',
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
    });

    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ display_name: 'Renamed', enabled: true });
    expect(t.activeVersions(created.id)).toEqual([
      { version: saved.json.version_id, scope: OIDC_SCOPE },
    ]);
    // Nothing of what was applied is cleaned up.
    expect(t.versionRows(created.id)).toHaveLength(2);
  });

  it('stands when ending the activation was applied and the retry is refused', async () => {
    const t = await setup();
    const created = await t.create();
    t.faults.retryAfterApply = /UPDATE field_mapping_activations/;

    const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Renamed',
      enabled: false,
      content: t.content(),
    });

    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ enabled: false, display_name: 'Renamed' });
    expect(t.activeVersions(created.id)).toEqual([]);
    expect(t.versionRows(created.id)).toHaveLength(2);
    expect(saved.json.content_version).toBe(saved.json.version_id);
  });

  it('is answered as not known, with nothing cleaned up, when the state cannot be read afterwards', async () => {
    const t = await setup();
    const created = await t.create();
    t.faults.blindAfterApply = /INSERT INTO field_mapping_activations/;
    const payload = { display_name: 'Renamed', content: t.content() };

    const unknown = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, {
      key: 'unknown-key-0001',
    });
    t.faults.blind = false;

    expect(unknown.status).toBe(500);
    expect(unknown.json).toMatchObject({
      error: 'outcome_unknown',
      stage_failed: 'activate',
      version_discarded: false,
    });
    // The version stays: it may be the one in use.
    expect(t.versionRows(created.id)).toHaveLength(2);
    expect(t.activeVersions(created.id)).toEqual([
      { version: unknown.json.version_id, scope: OIDC_SCOPE },
    ]);
    // And a repeat of the key does not run it again.
    const repeat = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, payload, {
      key: 'unknown-key-0001',
    });
    expect(repeat.status).toBe(409);
    expect(repeat.json.error).toBe('result_unknown');
  });

  it('is a failure with cleanup when the batch changed nothing', async () => {
    const t = await setup();
    const created = await t.create();
    t.faults.failOn = /INSERT INTO field_mapping_activations/;

    const failed = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content(),
    });
    t.faults.failOn = null;

    expect(failed.json).toMatchObject({ error: 'internal_error', version_discarded: true });
    expect(t.versionRows(created.id)).toHaveLength(1);
  });
});

describe('a version that another call has already put in use', () => {
  it('is not taken for a finished switch: the save is a conflict and the scope of the other call stands', async () => {
    const t = await setup();
    const created = await t.create();
    // Between the last look and the switch, the activation endpoint puts this save's version in
    // use with a scope of a SAML provider.
    t.hooks.beforeQuery = {
      match:
        /SELECT id, tenant_id, field_mapping_version_id, catalog_version_id, snapshot_hash, lifecycle_state/,
      run: async () => {
        const version = t.db
          .prepare(
            "SELECT id FROM field_mapping_versions WHERE field_mapping_set_id = ? AND lifecycle_state = 'published' ORDER BY rowid DESC LIMIT 1"
          )
          .get(created.id) as { id: string };
        const snapshot = t.db
          .prepare('SELECT id FROM compiled_mapping_snapshots WHERE field_mapping_version_id = ?')
          .get(version.id) as { id: string };
        await t.repository.activateFieldMappingVersion(TENANT, created.id, version.id, {
          snapshotId: snapshot.id,
          activationScope: { protocol: 'saml', role: 'idp' },
        });
      },
    };

    const lost = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
    });

    expect(lost.status).toBe(409);
    expect(lost.json).toMatchObject({ error: 'conflict', stage_failed: 'activate' });
    // The version is theirs now: it is not removed, and the scope is the one they wrote.
    expect(t.activeVersions(created.id)).toEqual([
      { version: lost.json.version_id, scope: { protocol: 'saml', role: 'idp' } },
    ]);
    expect(lost.json.version_discarded).toBe(false);
  });
});

describe('a save that leaves the set off', () => {
  it('does not stand when another save was made after it looked', async () => {
    const t = await setup();
    const created = await t.create({ enabled: false });
    // Another admin saves the set between this save's last look and its confirmation.
    t.hooks.beforeBatch = async () => {
      t.db
        .prepare(
          `INSERT INTO field_mapping_versions (id, tenant_id, field_mapping_set_id, version_label, lifecycle_state, field_mapping_hash, created_at, updated_at)
           VALUES ('ver-elsewhere', ?, ?, 'elsewhere', 'published', 'h', ?, ?)`
        )
        .run(TENANT, created.id, Date.now() + 60_000, Date.now() + 60_000);
      t.db
        .prepare(
          "UPDATE field_mapping_sets SET display_name = 'Name by the other admin' WHERE id = ?"
        )
        .run(created.id);
    };

    const lost = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Name by this admin',
      enabled: false,
      content: t.content({ rules: [emailRule(t.profile), nicknameRule(t.profile)] }),
    });

    expect(lost.status).toBe(409);
    expect(lost.json).toMatchObject({
      error: 'conflict',
      stage_failed: 'activate',
      version_discarded: true,
    });
    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.id}`);
    expect(read.json).toMatchObject({
      display_name: 'Name by the other admin',
      content_version: 'ver-elsewhere',
    });
    expect(t.versionRows(created.id).map((row) => row.id)).toEqual([
      created.version_id,
      'ver-elsewhere',
    ]);
  });

  it('does not stand when the set was switched on after it looked', async () => {
    const t = await setup();
    const created = await t.create({ enabled: false });
    t.hooks.beforeBatch = async () => {
      t.db
        .prepare(
          `INSERT INTO field_mapping_activations (id, tenant_id, field_mapping_set_id, field_mapping_version_id, activation_scope_json, lifecycle_state, activated_at, created_at, updated_at)
           VALUES ('act-elsewhere', ?, ?, ?, '{}', 'active', 1, 1, 1)`
        )
        .run(TENANT, created.id, created.version_id);
    };

    const lost = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'x',
      enabled: false,
      content: t.content(),
    });

    expect(lost.status).toBe(409);
    expect(lost.json.stage_failed).toBe('activate');
    expect(t.versionRows(created.id)).toHaveLength(1);
  });

  it('is confirmed by the same single write whether or not the name changed', async () => {
    const t = await setup();
    const created = await t.create({ enabled: false });
    const before = t.db
      .prepare('SELECT updated_at FROM field_mapping_sets WHERE id = ?')
      .get(created.id) as { updated_at: number };
    await new Promise((resolve) => setTimeout(resolve, 5));

    const saved = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.id}`, {
      display_name: 'Release email',
      enabled: false,
      content: t.content(),
    });

    expect(saved.status).toBe(200);
    const after = t.db
      .prepare('SELECT updated_at FROM field_mapping_sets WHERE id = ?')
      .get(created.id) as { updated_at: number };
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
  });
});

describe('repeating a deletion', () => {
  async function deletable(t: Awaited<ReturnType<typeof setup>>, platform = false) {
    return platform
      ? t.create(
          {
            owner_scope_type: 'platform',
            enabled: false,
            content: t.content({
              profileId: t.platformProfile,
              catalogVersionId: PLATFORM_CATALOG_VERSION,
            }),
          },
          t.platformAdmin
        )
      : t.create({ enabled: false });
  }

  it('answers a repeat of a deletion that succeeded with the stored answer, though the set is gone', async () => {
    const t = await setup();
    const created = await deletable(t);

    const first = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${created.id}`, undefined, {
      key: 'delete-key-0001',
    });
    const second = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${created.id}`, undefined, {
      key: 'delete-key-0001',
    });

    expect(first.status).toBe(200);
    expect(second).toEqual(first);
  });

  it('answers a repeat of a platform set’s deletion for the one who made it, and 403 for one who lost the platform’s right', async () => {
    const t = await setup();
    const created = await deletable(t, true);
    const first = await t.request(t.platformAdmin, 'DELETE', `${SETS}/${created.id}`, undefined, {
      key: 'delete-key-0002',
    });
    const again = await t.request(t.platformAdmin, 'DELETE', `${SETS}/${created.id}`, undefined, {
      key: 'delete-key-0002',
    });
    const userId = (
      t.db
        .prepare('SELECT admin_user_id AS id FROM admin_sessions WHERE id = ?')
        .get(t.platformAdmin.split('=')[1]) as { id: string }
    ).id;
    t.db.prepare('DELETE FROM admin_role_assignments WHERE admin_user_id = ?').run(userId);
    t.db
      .prepare(
        `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
         VALUES ('demoted-delete', ?, ?, 'role_super_admin', 'tenant', ?, ?)`
      )
      .run(TENANT, userId, TENANT, Date.now());

    const demoted = await t.request(t.platformAdmin, 'DELETE', `${SETS}/${created.id}`, undefined, {
      key: 'delete-key-0002',
    });

    expect(first.status).toBe(200);
    expect(again).toEqual(first);
    expect(demoted.status).toBe(403);
  });

  it('answers a repeat whose result was lost as not known, not as a set that is not there', async () => {
    const t = await setup();
    const created = await deletable(t);
    const first = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${created.id}`, undefined, {
      key: 'delete-key-0003',
    });
    t.db.prepare("UPDATE idempotency_records SET status = 'unknown', response_ref = NULL").run();

    const repeat = await t.request(t.tenantAdmin, 'DELETE', `${SETS}/${created.id}`, undefined, {
      key: 'delete-key-0003',
    });

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(409);
    expect(repeat.json.error).toBe('result_unknown');
  });
});

describe('what is read is never larger than what was saved', () => {
  const numbers = (length: number) => Array.from({ length }, (_, index) => index % 10);

  /** The JSON nodes the checks count in a version's input: every value, objects and arrays too. */
  const countNodes = (value: unknown): number =>
    1 +
    (Array.isArray(value)
      ? value.reduce<number>((total, item) => total + countNodes(item), 0)
      : value !== null && typeof value === 'object'
        ? Object.values(value).reduce<number>((total, item) => total + countNodes(item), 0)
        : 0);

  it('is accepted again at the limit of the JSON nodes of a content', async () => {
    const t = await setup();
    // A content of exactly the 4000 nodes a content may hold, most of them in metadata.
    const build = (last: number) =>
      emailRule(t.profile, {
        metadata: { a: numbers(1000), b: numbers(1000), c: numbers(1000), d: numbers(last) },
      });
    const last =
      1000 - (countNodes({ versionLabel: 'x', authorId: 'a', rules: [build(1000)] }) - 4000);
    const rule = build(last);
    expect(countNodes({ versionLabel: 'x', authorId: 'a', rules: [rule] })).toBe(4000);
    const created = await t.request(
      t.tenantAdmin,
      'POST',
      SETS,
      t.body({ content: t.content({ rules: [rule] }) })
    );
    expect(created.status).toBe(201);

    const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.json.id}`);
    const again = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.json.id}`, {
      display_name: 'x',
      content: read.json.content,
    });
    const reread = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.json.id}`);

    expect(
      countNodes({ versionLabel: 'x', authorId: 'a', rules: read.json.content.rules })
    ).toBeLessThanOrEqual(4000);
    expect(again.status).toBe(200);
    expect(reread.json.content).toEqual(read.json.content);
  });

  it('is accepted again for contents of every part, and reads the same the second time', async () => {
    const t = await setup();
    const variants: unknown[][] = [
      [emailRule(t.profile)],
      [emailRule(t.profile, { priority: 0, scope: {}, edges: undefined }), nicknameRule(t.profile)],
      [
        emailRule(t.profile, {
          transforms: [{ edgeIndex: 0, operation: 'trim', parameters: {} }],
          validationRules: [
            {
              targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
              validationKind: 'required',
            },
          ],
          releaseRules: [
            {
              destinationType: 'oidc',
              sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
              releaseAction: 'allow',
              condition: {},
              priority: 0,
            },
          ],
          conflictRules: [
            {
              targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
              conflictStrategy: 'prefer_source',
              sourcePriority: [],
            },
          ],
        }),
      ],
    ];
    for (const rules of variants) {
      const created = await t.request(
        t.tenantAdmin,
        'POST',
        SETS,
        t.body({ content: t.content({ rules }) })
      );
      expect(created.status).toBe(201);
      const read = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.json.id}`);
      const again = await t.request(t.tenantAdmin, 'PUT', `${SETS}/${created.json.id}`, {
        display_name: 'x',
        content: read.json.content,
      });
      const reread = await t.request(t.tenantAdmin, 'GET', `${SETS}/${created.json.id}`);
      expect(again.status).toBe(200);
      expect(reread.json.content).toEqual(read.json.content);
      expect(JSON.stringify(read.json.content.rules).length).toBeLessThanOrEqual(
        JSON.stringify(rules).length + 200
      );
    }
  });
});
