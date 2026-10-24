import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  applyOIDCIdentityMapping,
  requireAdminPermissions,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: vi.fn(async () => undefined),
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

import { enforceDeclaredAdminRouteAccess, findAdminRouteAccessRule } from '../admin-route-access';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import { adminIdentityMappingSetChangePreviewHandler } from '../identity-mapping-set-change-preview';
import type { ClaimChange } from '../identity-mapping-content-diff';
import {
  adminIdentityMappingSetCreateHandler,
  adminIdentityMappingSetGetHandler,
  adminIdentityMappingSetPutHandler,
  createMappingSetSaveIdempotency,
} from '../identity-mapping-set-facade';
import {
  GLOBAL_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  insertRole,
  setupApp,
  signIn,
  sqliteAdapter,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';
import { d1OverSqlite } from './helpers/d1-over-sqlite';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';

/**
 * What a change of a Mapping Set's content would do, on the real Admin and Core schemas, the real
 * admin authentication and route access, sets made and saved through the real facade.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const SETS = '/api/admin/identity-mapping/sets';
const KEY = 'identity_mapping.oidc_default_set_id';
const PLATFORM_CATALOG_VERSION = 'platform_default_canonical_catalog_v1';
const OTHER = 'tenant-b';

/** email (the email scope), nickname and org/organization (the profile scope), all classified pii. */
const PROFILE_SCHEMA = {
  destinationType: 'oidc',
  claims: [
    { claimName: 'sub', required: true, nullable: false, surfaces: ['id_token', 'userinfo'] },
    {
      claimName: 'email',
      surfaces: ['id_token', 'userinfo'],
      requiredScopes: ['email'],
      classification: 'pii',
    },
    {
      claimName: 'nickname',
      surfaces: ['id_token', 'userinfo'],
      requiredScopes: ['profile'],
      classification: 'pii',
    },
    {
      claimName: 'organization',
      surfaces: ['id_token', 'userinfo'],
      requiredScopes: ['profile'],
      classification: 'pii',
    },
    {
      claimName: 'org',
      surfaces: ['id_token', 'userinfo'],
      requiredScopes: ['profile'],
      classification: 'pii',
    },
  ],
};

function kvStore() {
  const store = new Map<string, string>();
  const read = vi.fn(async (key: string) => store.get(key) ?? null);
  return {
    store,
    read,
    namespace: {
      get: read,
      put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      delete: vi.fn(async (key: string) => void store.delete(key)),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace,
  };
}

const rule = (claim: string, source: string, profileId: string) => ({
  ruleKey: claim,
  ruleKind: 'direct',
  action: 'allow',
  edges: [
    {
      sourceRef: { side: 'source', namespace: 'authrim.profile', path: source },
      targetRef: {
        side: 'destination',
        namespace: 'oidc.claim',
        path: claim,
        profileId,
        catalogEntryId: `field.profile.${source}`,
      },
    },
  ],
});

let sequence = 0;

/** Shapes read by these fixtures; successful preview bodies are checked against OpenAPI too. */
interface TestResponse {
  id: string;
  content_version?: string;
  owner?: string;
  error?: string;
  error_description?: string;
  changes: ClaimChange[];
  references: { count: number };
  apps: Array<{
    client_id: string;
    tier: string;
    changes: ClaimChange[];
    held_back: Array<{ claim: string; scope: string | null }>;
  }>;
  tenants?: unknown[];
  defaults_unavailable?: string;
}

async function setup() {
  // tenant-c has no apps at all.
  const cores: Record<string, ReturnType<typeof openCoreDatabase>> = {
    [TENANT]: openCoreDatabase(),
    [OTHER]: openCoreDatabase(),
    'tenant-c': openCoreDatabase(),
  };
  const directory = openCoreDatabase();
  for (const id of [TENANT, OTHER, 'tenant-c', 'tenant-gone']) insertTenant(directory, id);
  directory.exec("UPDATE tenants SET lifecycle_state = 'deleted' WHERE id = 'tenant-gone'");
  const settings = kvStore();
  const context = setupApp(
    (app) => {
      app.use('*', async (c, next) => {
        (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
          tenantId: TENANT,
          coreDb: sqliteAdapter(cores[TENANT]),
          route: {},
        });
        await next();
      });
      app.use(
        '/api/admin/*',
        adminAuthMiddleware({ plane: 'tenant' }),
        enforceDeclaredAdminRouteAccess()
      );
      const read = requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]);
      const write = requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]);
      const idempotency = createMappingSetSaveIdempotency();
      app.post(SETS, write, idempotency, adminIdentityMappingSetCreateHandler);
      app.get(`${SETS}/:id`, read, adminIdentityMappingSetGetHandler);
      app.put(`${SETS}/:id`, write, idempotency, adminIdentityMappingSetPutHandler);
      app.post(
        `${SETS}/:id/preview-change`,
        requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ, ADMIN_PERMISSIONS.CLIENTS_READ]),
        adminIdentityMappingSetChangePreviewHandler
      );
    },
    {
      DB: sqliteAdapter(directory),
      SETTINGS: settings.namespace,
      AUTHRIM_CONFIG: settings.namespace,
      TEST_CORES: Object.fromEntries(
        Object.entries(cores).map(([id, db]) => [id, sqliteAdapter(db)])
      ),
      BASE_DOMAIN: 'example.com',
    }
  );
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
  const repository = new IdentityMappingControlPlaneRepository(context.adapter);
  const entry = (path: string) => ({
    id: `field.profile.${path}`,
    namespace: 'authrim.profile',
    path,
    targetType: 'canonical',
    valueType: 'string',
    cardinality: 'single',
    classification: path === 'email' ? 'pii' : 'internal',
    uiGroupKey: 'profile',
    uiGroupLabel: 'Profile',
    uiGroupOrder: 10,
  });
  const catalog = await repository.createCatalog(TENANT, {
    catalogKey: 'tenant-catalog',
    displayName: 'Tenant catalog',
    versionLabel: 'v1',
    entries: ['email', 'nickname', 'org'].map(entry) as never,
  });
  const catalogVersionId = (catalog as { activeVersion: { id: string } }).activeVersion.id;
  const profile = async (
    owner: 'tenant' | 'platform',
    schema: typeof PROFILE_SCHEMA = PROFILE_SCHEMA,
    key: string = owner
  ) => {
    const created = await repository.createDestinationProfile(TENANT, {
      destinationType: 'oidc',
      profileKey: `${key}_profile`,
      displayName: `${key} profile`,
      ownerScopeType: owner,
      schema,
    } as never);
    const platform = owner === 'platform';
    await repository.reviewDestinationProfileVersion(
      created.tenantId,
      created.id,
      created.version.id,
      platform
    );
    await repository.activateDestinationProfileVersion(
      created.tenantId,
      created.id,
      created.version.id,
      platform
    );
    return created.id;
  };
  const tenantProfile = await profile('tenant');
  const platformProfile = await profile('platform');
  // The same, without email.
  const withoutEmail = await profile(
    'tenant',
    { ...PROFILE_SCHEMA, claims: PROFILE_SCHEMA.claims.filter((c) => c.claimName !== 'email') },
    'no_email'
  );

  const cookie = (assignments: Assignment[] = TENANT_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const admin = cookie();
  const operator = cookie(GLOBAL_SUPER_ADMIN);
  const call = async (who: string, method: string, path: string, body?: unknown, headers = {}) => {
    const response = await context.call(who, method, path, body, headers);
    return { status: response.status, json: response.json as TestResponse };
  };
  const tenantContent = (claims: Array<[string, string]>, profileId = tenantProfile) => ({
    catalogVersionId,
    rules: claims.map(([claim, source]) => rule(claim, source, profileId)),
  });
  const platformContent = (claims: Array<[string, string]>) => ({
    catalogVersionId: PLATFORM_CATALOG_VERSION,
    rules: claims.map(([claim, source]) => rule(claim, source, platformProfile)),
  });
  const createSet = async (content: unknown, owner: 'tenant' | 'platform' = 'tenant') => {
    sequence += 1;
    const response = await call(
      owner === 'platform' ? operator : admin,
      'POST',
      SETS,
      {
        field_mapping_key: `key-${sequence}`,
        display_name: `Set ${sequence}`,
        ...(owner === 'platform' ? { owner_scope_type: 'platform' } : {}),
        content,
      },
      { 'Idempotency-Key': `preview-key-${sequence}` }
    );
    expect(response.status).toBe(201);
    return response.json.id;
  };
  const app = (tenantId: string, clientId: string, identityMapping?: unknown, scope?: string) => {
    insertOAuthClient(cores[tenantId], { tenantId, clientId, identityMapping });
    cores[tenantId]
      .prepare('UPDATE oauth_clients SET scope = ? WHERE client_id = ?')
      .run(scope ?? 'openid email profile', clientId);
  };
  const preview = (setId: string, body: unknown, who = admin, query = '') =>
    call(who, 'POST', `${SETS}/${setId}/preview-change${query}`, body);
  const saveDefault = (tenantId: string | null, setId: string) =>
    settings.store.set(
      tenantId
        ? `settings:tenant:${tenantId}:identity-mapping`
        : 'settings:platform:identity-mapping',
      JSON.stringify({ [KEY]: setId })
    );
  return {
    ...context,
    repository,
    cores,
    settings,
    admin,
    operator,
    cookie,
    call,
    tenantContent,
    withoutEmail,
    profile,
    platformContent,
    createSet,
    app,
    preview,
    saveDefault,
  };
}

const appOf = (json: TestResponse, clientId: string) =>
  json.apps.find((line) => line.client_id === clientId);

beforeEach(() => {
  sequence += 100;
});

describe('a change of a tenant’s set', () => {
  const criticalRequired = {
    targetRef: { side: 'source', namespace: 'authrim.profile', path: 'nickname' },
    validationKind: 'required',
    severity: 'critical',
  };

  it.each([
    { change: 'added', before: [], after: [criticalRequired] },
    { change: 'removed', before: [criticalRequired], after: [] },
    {
      change: 'changed',
      before: [criticalRequired],
      after: [{ ...criticalRequired, severity: 'error' }],
    },
  ])(
    'shows critical validation $change to every app, independently of release scopes and namespace',
    async ({ change, before, after }) => {
      const t = await setup();
      const content = (validationRules: typeof before) => {
        const content = t.tenantContent([['email', 'email']]);
        return { ...content, rules: content.rules.map((rule) => ({ ...rule, validationRules })) };
      };
      const setId = await t.createSet(content(before));
      t.app(TENANT, 'no-profile-scope', { fieldMappingSetId: setId }, 'openid');
      t.app(
        TENANT,
        'other-namespace',
        {
          fieldMappingSetId: setId,
          destinationNamespace: 'custom.claim',
        },
        'openid'
      );

      const { status, json } = await t.preview(setId, { content: content(after) });
      const expected = {
        kind: 'validation_changed',
        claim: 'nickname',
        namespace: 'authrim.profile',
        profile_id: expect.any(String) as unknown,
        validation_change: change,
        validation_effect: 'may_reject',
      };

      expect(status).toBe(200);
      expect(json.changes).toEqual([expected]);
      for (const id of ['no-profile-scope', 'other-namespace']) {
        expect(appOf(json, id)).toMatchObject({ changes: [expected], held_back: [] });
      }
      const schemas = adminOpenApiSchemas();
      expect(shapeErrors(schemas, schemas.IdentityMappingSetChangePreviewResponse, json)).toEqual(
        []
      );
      // This is a valid save, including when the validation targets no mapped output.
      const saved = await t.call(
        t.admin,
        'PUT',
        `${SETS}/${setId}`,
        {
          display_name: 'Validation change',
          content: content(after),
          confirm_impact: json.references.count,
        },
        { 'Idempotency-Key': `validation-save-${sequence}` }
      );
      expect(saved.status).toBe(200);
    }
  );

  it('warns of a critical validation that actually rejects issuance for an unreleased attribute', async () => {
    const t = await setup();
    const content = t.tenantContent([['email', 'email']]);
    const setId = await t.createSet(content);
    t.app(TENANT, 'app', { fieldMappingSetId: setId }, 'openid');
    const input = {
      adapter: sqliteAdapter(t.cores[TENANT]),
      env: { DB_ADMIN: d1OverSqlite(t.db), SETTINGS: t.settings.namespace },
      tenantId: TENANT,
      clientId: 'app',
      selector: { fieldMappingSetId: setId },
      claims: { sub: 'preview-test-subject', email: 'preview@example.test' },
      grantedScopes: ['openid'],
      fixture: { consent: 'all' as const },
    };
    await expect(applyOIDCIdentityMapping(input)).resolves.toHaveProperty(
      'claims.sub',
      input.claims.sub
    );
    const draft = {
      ...content,
      rules: content.rules.map((rule) => ({ ...rule, validationRules: [criticalRequired] })),
    };
    const { json } = await t.preview(setId, { content: draft });
    expect(appOf(json, 'app')?.changes).toContainEqual(
      expect.objectContaining({
        kind: 'validation_changed',
        validation_effect: 'may_reject',
      })
    );
    const saved = await t.call(
      t.admin,
      'PUT',
      `${SETS}/${setId}`,
      {
        display_name: 'Critical validation',
        content: draft,
        confirm_impact: json.references.count,
      },
      { 'Idempotency-Key': `critical-save-${sequence}` }
    );
    expect(saved.status).toBe(200);
    await expect(applyOIDCIdentityMapping(input)).rejects.toMatchObject({
      details: { code: 'policy.identity_mapping_failed' },
    });
  });

  it('shows noncritical validation only at the set level, without calling it a scope restriction', async () => {
    const t = await setup();
    const content = t.tenantContent([['email', 'email']]);
    const setId = await t.createSet(content);
    t.app(TENANT, 'app', { fieldMappingSetId: setId });
    const draft = {
      ...content,
      rules: content.rules.map((rule) => ({
        ...rule,
        validationRules: [{ ...criticalRequired, severity: 'warning' }],
      })),
    };

    const { status, json } = await t.preview(setId, { content: draft });

    expect(status).toBe(200);
    expect(json.changes).toEqual([
      expect.objectContaining({
        kind: 'validation_changed',
        validation_change: 'added',
        validation_effect: 'validation_only',
      }),
    ]);
    expect(appOf(json, 'app')).toMatchObject({ changes: [], held_back: [] });
  });

  it.each([
    { before: ['string', 'number'], after: ['string', 'string'], label: 'mixed to one type' },
    { before: ['string', 'string'], after: ['string', 'number'], label: 'one type to mixed' },
    { before: ['string', 'number'], after: ['string', 'boolean'], label: 'mixed types changed' },
    { before: ['string', 'number'], after: ['number', 'string'], label: 'source types swapped' },
  ] as const)('previews per-source catalog type changes: $label', async ({ before, after }) => {
    const t = await setup();
    const catalog = async (types: readonly ('string' | 'number' | 'boolean')[], suffix: string) => {
      const created = await t.repository.createCatalog(TENANT, {
        catalogKey: `preview-type-${sequence}-${suffix}`,
        displayName: 'Type preview',
        versionLabel: 'v1',
        entries: ['email', 'nickname'].map((path, index) => ({
          id: `field.profile.${path}`,
          namespace: 'authrim.profile',
          path,
          targetType: 'canonical' as const,
          valueType: types[index],
          cardinality: 'single' as const,
          classification: 'pii' as const,
        })),
      });
      return created.activeVersion.id;
    };
    const content = t.tenantContent([['nickname', 'email']]);
    content.rules[0].edges.push({
      ...content.rules[0].edges[0],
      sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'nickname' },
    });
    const oldContent = { ...content, catalogVersionId: await catalog(before, 'before') };
    const draft = { ...content, catalogVersionId: await catalog(after, 'after') };
    const setId = await t.createSet(oldContent);
    t.app(TENANT, 'app', { fieldMappingSetId: setId });

    const { status, json } = await t.preview(setId, { content: draft });

    expect(status).toBe(200);
    expect(json.changes).toEqual([
      expect.objectContaining({
        kind: 'type_changed',
        claim: 'nickname',
        source_types_before: ['email', 'nickname'].map((path, index) => ({
          source: `authrim.profile:${path}`,
          type: before[index],
        })),
        source_types_after: ['email', 'nickname'].map((path, index) => ({
          source: `authrim.profile:${path}`,
          type: after[index],
        })),
      }),
    ]);
    expect(appOf(json, 'app')?.changes).toEqual(json.changes);
    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.IdentityMappingSetChangePreviewResponse, json)).toEqual([]);
  });

  it('says what each app that uses it would see, by why it uses it, and saves nothing', async () => {
    const t = await setup();
    const before: Array<[string, string]> = [
      ['email', 'email'],
      ['organization', 'org'],
    ];
    const setId = await t.createSet(t.tenantContent(before));
    t.app(TENANT, 'own', { fieldMappingSetId: setId });
    t.app(TENANT, 'follows');
    t.app(TENANT, 'email-only', undefined, 'openid email');
    t.app(TENANT, 'opted-out', { mode: 'none' });
    t.saveDefault(TENANT, setId);
    const read = (await t.call(t.admin, 'GET', `${SETS}/${setId}`)).json;

    const { status, json } = await t.preview(setId, {
      content: t.tenantContent([
        ['email', 'email'],
        ['org', 'org'],
        ['nickname', 'nickname'],
      ]),
    });

    expect(status).toBe(200);
    expect(json.changes).toEqual([
      {
        kind: 'added',
        claim: 'nickname',
        namespace: 'oidc.claim',
        profile_id: expect.any(String) as unknown,
      },
      {
        kind: 'renamed',
        claim: 'org',
        previous_claim: 'organization',
        namespace: 'oidc.claim',
        profile_id: expect.any(String) as unknown,
      },
    ]);
    expect(json.apps.map((line: { client_id: string }) => line.client_id)).toEqual([
      'email-only',
      'follows',
      'own',
    ]);
    expect(appOf(json, 'own')).toMatchObject({ tier: 'client', held_back: [] });
    expect(appOf(json, 'own')?.changes).toHaveLength(2);
    expect(appOf(json, 'follows')).toMatchObject({ tier: 'tenant_default' });
    // Without the profile scope, neither change reaches this app.
    expect(appOf(json, 'email-only')).toMatchObject({
      changes: [],
      held_back: [
        { claim: 'nickname', scope: 'profile' },
        { claim: 'org', scope: 'profile' },
      ],
    });
    expect(json).toMatchObject({ apps_truncated: false, sample: null, owner: 'tenant' });
    // Nothing was saved.
    expect((await t.call(t.admin, 'GET', `${SETS}/${setId}`)).json.content_version).toBe(
      read.content_version
    );
    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.IdentityMappingSetChangePreviewResponse, json)).toEqual([]);
  });

  it('counts a rename as reaching an app that loses the claim it had', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    t.app(TENANT, 'email-only', { fieldMappingSetId: setId }, 'openid email');

    // email becomes nickname: same attribute, same profile; the app has no profile scope.
    const { json } = await t.preview(setId, { content: t.tenantContent([['nickname', 'email']]) });

    expect(json.changes).toEqual([
      expect.objectContaining({ kind: 'renamed', claim: 'nickname', previous_claim: 'email' }),
    ]);
    expect(appOf(json, 'email-only')).toMatchObject({
      changes: [expect.objectContaining({ kind: 'renamed' })],
      held_back: [],
    });
  });

  it('says what switching the profile does to a claim no edge writes', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['nickname', 'nickname']]));
    t.app(TENANT, 'email-only', { fieldMappingSetId: setId }, 'openid email');

    // Only the profile changes: the new one does not list email, which the app had by its scope.
    const { json } = await t.preview(setId, {
      content: t.tenantContent([['nickname', 'nickname']], t.withoutEmail),
    });

    expect(json.changes).toContainEqual(
      expect.objectContaining({ kind: 'profile_field_removed', claim: 'email' })
    );
    expect(appOf(json, 'email-only')?.changes).toContainEqual(
      expect.objectContaining({ kind: 'profile_field_removed', claim: 'email' })
    );
  });

  it('says a switched profile’s fields to an app whatever namespace it releases from', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['nickname', 'nickname']]));
    t.app(
      TENANT,
      'custom-namespace',
      { fieldMappingSetId: setId, destinationNamespace: 'custom.claim' },
      'openid email'
    );

    const { json } = await t.preview(setId, {
      content: t.tenantContent([['nickname', 'nickname']], t.withoutEmail),
    });

    expect(appOf(json, 'custom-namespace')?.changes).toContainEqual(
      expect.objectContaining({ kind: 'profile_field_removed', claim: 'email' })
    );
  });

  it('says a switched profile’s field even where the mapping changes the claim too', async () => {
    const t = await setup();
    const strict = await t.profile(
      'tenant',
      {
        ...PROFILE_SCHEMA,
        claims: PROFILE_SCHEMA.claims.map((claim) =>
          claim.claimName === 'email' ? { ...claim, allowedValues: ['a@example.test'] } : claim
        ),
      },
      'strict_mapped'
    );
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    t.app(
      TENANT,
      'custom-namespace',
      { fieldMappingSetId: setId, destinationNamespace: 'custom.claim' },
      'openid email'
    );

    const { json } = await t.preview(setId, {
      content: t.tenantContent([['email', 'email']], strict),
    });

    // The mapping's email moves profile; the app's standard email is held to the new values.
    expect(json.changes.map((change: { kind: string }) => change.kind)).toEqual([
      'profile_changed',
      'profile_field_changed',
    ]);
    expect(appOf(json, 'custom-namespace')?.changes).toEqual([
      expect.objectContaining({ kind: 'profile_field_changed', claim: 'email' }),
    ]);
  });

  it('says a switched profile that accepts other values for a field', async () => {
    const t = await setup();
    const strict = await t.profile(
      'tenant',
      {
        ...PROFILE_SCHEMA,
        claims: PROFILE_SCHEMA.claims.map((claim) =>
          claim.claimName === 'email' ? { ...claim, allowedValues: ['a@example.test'] } : claim
        ),
      },
      'strict'
    );
    const setId = await t.createSet(t.tenantContent([['nickname', 'nickname']]));
    t.app(TENANT, 'email-only', { fieldMappingSetId: setId }, 'openid email');

    const { json } = await t.preview(setId, {
      content: t.tenantContent([['nickname', 'nickname']], strict),
    });

    expect(appOf(json, 'email-only')?.changes).toContainEqual(
      expect.objectContaining({ kind: 'profile_field_changed', claim: 'email' })
    );
  });

  it('sees nothing for an app whose own choice releases from another namespace', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    t.app(TENANT, 'other-namespace', {
      fieldMappingSetId: setId,
      destinationNamespace: 'custom.claim',
    });
    t.app(TENANT, 'usual', { fieldMappingSetId: setId });

    const { json } = await t.preview(setId, {
      content: t.tenantContent([
        ['email', 'email'],
        ['nickname', 'nickname'],
      ]),
    });

    expect(appOf(json, 'usual')?.changes).toHaveLength(1);
    expect(appOf(json, 'other-namespace')).toMatchObject({
      changes: [],
      held_back: [{ claim: 'nickname', scope: null }],
    });
  });

  it('still judges the apps that name the set when the defaults cannot be read', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    t.app(TENANT, 'own', { fieldMappingSetId: setId });
    t.app(TENANT, 'follows');
    t.saveDefault(TENANT, setId);
    // The tenant's settings document cannot be read; the rest can.
    const get = t.settings.read;
    const readStore = get.getMockImplementation();
    get.mockImplementation(async (key: string) => {
      if (key === `settings:tenant:${TENANT}:identity-mapping`) throw new Error('KV is down');
      return readStore?.(key) ?? null;
    });

    const { status, json } = await t.preview(setId, {
      content: t.tenantContent([['nickname', 'nickname']]),
    });

    expect(status).toBe(200);
    expect(json.apps.map((line: { client_id: string }) => line.client_id)).toEqual(['own']);
    expect(json.defaults_unavailable).toBe('settings_unreadable');
  });

  it('counts the references as the save does, so the count can be confirmed', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    t.app(TENANT, 'own', { fieldMappingSetId: setId });
    const draft = t.tenantContent([['nickname', 'nickname']]);

    const { json } = await t.preview(setId, { content: draft });
    const refused = await t.call(
      t.admin,
      'PUT',
      `${SETS}/${setId}`,
      { display_name: 'Set', content: draft },
      { 'Idempotency-Key': `put-key-${sequence}-a` }
    );

    expect(refused.status).toBe(409);
    expect(json.references.count).toBe(refused.json.references.count);
    const saved = await t.call(
      t.admin,
      'PUT',
      `${SETS}/${setId}`,
      { display_name: 'Set', content: draft, confirm_impact: json.references.count },
      { 'Idempotency-Key': `put-key-${sequence}-b` }
    );
    expect(saved.status).toBe(200);
  });

  it('refuses a draft a save would refuse, as the save does', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    const draft = { ...t.tenantContent([['email', 'email']]), catalogVersionId: 'nope' };

    const previewed = await t.preview(setId, { content: draft });
    const saved = await t.call(
      t.admin,
      'PUT',
      `${SETS}/${setId}`,
      { display_name: 'Set', content: draft },
      { 'Idempotency-Key': `put-key-${sequence}-a` }
    );

    expect(previewed.status).toBe(400);
    expect(previewed.json.error).toBe(saved.json.error);
    expect(previewed.json.error_description).toBe(saved.json.error_description);
  });

  it('says the sample cannot be given yet, in the same shape', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    const { json } = await t.preview(setId, {
      content: t.tenantContent([['email', 'email']]),
      sample: { test_user_id: 'tu_1' },
    });
    expect(json).toMatchObject({ sample: null, sample_unavailable: 'draft_not_compiled' });
  });

  it('is 404 for another tenant’s set, and 400 for a tenant_id on a tenant’s set', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    t.db.prepare('UPDATE field_mapping_sets SET tenant_id = ? WHERE id = ?').run(OTHER, setId);
    expect((await t.preview(setId, { content: {} })).status).toBe(404);

    const own = await t.createSet(t.tenantContent([['email', 'email']]));
    const body = { content: t.tenantContent([['email', 'email']]) };
    expect((await t.preview(own, body, t.admin, `?tenant_id=${OTHER}`)).status).toBe(400);
  });

  it('is a read: a viewer may ask, and the route is declared for POST only', async () => {
    const t = await setup();
    const setId = await t.createSet(t.tenantContent([['email', 'email']]));
    const viewer = t.cookie([{ role: 'role_viewer', scope: 'tenant' }]);
    const body = { content: t.tenantContent([['nickname', 'nickname']]) };
    expect((await t.preview(setId, body, viewer)).status).toBe(200);
    expect(findAdminRouteAccessRule('POST', `${SETS}/x/preview-change`)?.permissions).toEqual([
      'admin:settings:read',
      'admin:clients:read',
    ]);
    expect(findAdminRouteAccessRule('GET', `${SETS}/x/preview-change`)).toBeNull();
  });
});

describe('a change of a platform set', () => {
  async function platformSetup() {
    const t = await setup();
    const setId = await t.createSet(t.platformContent([['email', 'email']]), 'platform');
    t.saveDefault(null, setId);
    // tenant-a follows the platform default; tenant-b has a default of its own.
    t.app(TENANT, 'a-1');
    t.app(TENANT, 'a-2', undefined, 'openid');
    const ownOfB = await t.createSet(t.tenantContent([['email', 'email']]));
    t.db.prepare('UPDATE field_mapping_sets SET tenant_id = ? WHERE id = ?').run(OTHER, ownOfB);
    t.saveDefault(OTHER, ownOfB);
    t.app(OTHER, 'b-1');
    t.app(OTHER, 'b-own', { fieldMappingSetId: setId });
    const body = {
      content: t.platformContent([
        ['email', 'email'],
        ['nickname', 'nickname'],
      ]),
    };
    return { ...t, setId, body };
  }

  it('is counted tenant by tenant for the operator', async () => {
    const t = await platformSetup();

    const { status, json } = await t.preview(t.setId, t.body, t.operator);

    expect(status).toBe(200);
    expect(json.owner).toBe('platform');
    expect(json.tenants).toEqual([
      { tenant_id: TENANT, apps_using: 2, apps_changed: 1 },
      { tenant_id: OTHER, apps_using: 1, apps_changed: 1 },
    ]);
    expect(json).toMatchObject({ tenants_truncated: false, apps: [] });
    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.IdentityMappingSetChangePreviewResponse, json)).toEqual([]);
  });

  it('counts the references in every tenant, as the save does', async () => {
    const t = await platformSetup();

    const { json } = await t.preview(t.setId, t.body, t.operator);
    const refused = await t.call(
      t.operator,
      'PUT',
      `${SETS}/${t.setId}`,
      { display_name: 'Set', content: t.body.content },
      { 'Idempotency-Key': `put-key-${sequence}-p` }
    );

    expect(refused.status).toBe(409);
    expect(json.references.count).toBe(refused.json.references.count);
    // tenant-b's app names the set: a count of the request's tenant alone would miss it.
    expect(json.references.count).toBeGreaterThanOrEqual(1);
  });

  it('keeps a tenant whose apps were not all read, even with none found', async () => {
    const t = await platformSetup();
    // More apps than are read, none of the first ones using the set, the last one naming it.
    const db = t.cores['tenant-c'];
    const insert = db.prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types,
         tenant_id, identity_mapping, created_at, updated_at)
       VALUES (?, ?, '[]', '[]', '[]', 'tenant-c', '{"mode":"none"}', 1, 1)`
    );
    for (let index = 0; index < 2000; index += 1) {
      insert.run(`app-${String(index).padStart(4, '0')}`, 'Opted out');
    }
    t.app('tenant-c', 'zz-last', { fieldMappingSetId: t.setId });

    const { json } = await t.preview(t.setId, t.body, t.operator);

    expect(json.tenants).toContainEqual({
      tenant_id: 'tenant-c',
      apps_using: 0,
      apps_changed: 0,
      apps_count_is_lower_bound: true,
    });
  });

  it('looks at the other tenants without leaving a trace', async () => {
    const t = await platformSetup();
    vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mockClear();

    await t.preview(t.setId, t.body, t.operator);
    await t.preview(t.setId, t.body, t.operator, `?tenant_id=${OTHER}`);

    const calls = vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[2]).toMatchObject({ sideEffects: 'none' });
  });

  it('lists one tenant’s apps when asked for it', async () => {
    const t = await platformSetup();

    const { json } = await t.preview(t.setId, t.body, t.operator, `?tenant_id=${OTHER}`);

    expect(json.apps).toEqual([
      expect.objectContaining({ tenant_id: OTHER, client_id: 'b-own', tier: 'client' }),
    ]);
    expect((await t.preview(t.setId, t.body, t.operator, '?tenant_id=tenant-gone')).status).toBe(
      404
    );
  });

  it('needs the apps’ read for every tenant too, as it lists other tenants’ apps', async () => {
    const t = await platformSetup();
    // The settings read for every tenant, the clients read for this tenant only.
    insertRole(t.db, {
      id: 'role_global_settings_reader',
      name: 'viewer',
      permissions: ['admin:settings:read'],
      hierarchy: 10,
    });
    const reader = t.cookie([
      { role: 'role_global_settings_reader', scope: 'global' },
      { role: 'role_viewer', scope: 'tenant' },
    ]);

    for (const query of ['', `?tenant_id=${OTHER}`]) {
      const response = await t.preview(t.setId, t.body, reader, query);
      expect(response.status, query).toBe(403);
      expect(JSON.stringify(response.json)).not.toContain('b-own');
    }
  });

  it('is not for a tenant’s administrator', async () => {
    const t = await platformSetup();
    const response = await t.preview(t.setId, t.body, t.admin);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.json)).not.toContain(OTHER);
  });
});
