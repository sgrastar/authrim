import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  applyOIDCIdentityMapping,
  evaluateClaimsForTarget,
  buildStandardUserClaims,
  requireAdminPermissions,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: vi.fn(async () => undefined),
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
import { enforceDeclaredAdminRouteAccess, findAdminRouteAccessRule } from '../admin-route-access';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import { adminIdentityMappingExplainHandler } from '../identity-mapping-explain';
import {
  adminIdentityMappingSetCreateHandler,
  createMappingSetSaveIdempotency,
} from '../identity-mapping-set-facade';
import {
  adminIdentityMappingTestUsersListHandler,
  adminIdentityMappingTestUsersReplaceHandler,
} from '../identity-mapping-test-users';
import {
  TENANT,
  TENANT_SUPER_ADMIN,
  insertRole,
  setupApp,
  signIn,
  sqliteAdapter,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';

/**
 * The explanation of the release for a test user, and the test users themselves, on the real
 * Admin and Core schemas, the real admin authentication and route access, sets made through the
 * real facade (so they are what the runtime can use), and the real release underneath.
 */

const SETS = '/api/admin/identity-mapping/sets';
const TEST_USERS = '/api/admin/identity-mapping/test-users';
const EXPLAIN = '/api/admin/identity-mapping/explain';
const KEY = 'identity_mapping.oidc_default_set_id';
const TENANT_DOC = `settings:tenant:${TENANT}:identity-mapping`;
/** A made-up value the answers must never carry. */
const MARKER = 'marker-value-7f3a';

/**
 * sub (required); email (optional, both surfaces, the email scope); nickname (optional, UserInfo
 * only, the profile scope); affiliation (required, both surfaces, the profile scope).
 */
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
      surfaces: ['userinfo'],
      requiredScopes: ['profile'],
      classification: 'internal',
    },
    {
      claimName: 'affiliation',
      required: true,
      surfaces: ['id_token', 'userinfo'],
      requiredScopes: ['profile'],
      classification: 'internal',
    },
  ],
};

function kvStore() {
  const store = new Map<string, string>();
  return {
    store,
    namespace: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      delete: vi.fn(async (key: string) => void store.delete(key)),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace,
  };
}

function rule(path: string, profileId: string, catalogEntryId: string) {
  return {
    ruleKey: path,
    ruleKind: 'direct',
    action: 'allow',
    edges: [
      {
        sourceRef: { side: 'source', namespace: 'authrim.profile', path },
        targetRef: {
          side: 'destination',
          namespace: 'oidc.claim',
          path,
          profileId,
          catalogEntryId,
        },
      },
    ],
  };
}

let sequence = 0;

/** Records the Core reads whose parameters name `id` (an explanation must make none). */
function watchedAdapter(
  inner: ReturnType<typeof sqliteAdapter>,
  watch: { id?: string; reads: string[] }
) {
  const seen = (sql: string, params?: unknown[]) => {
    if (watch.id && (params ?? []).includes(watch.id)) watch.reads.push(sql);
  };
  return {
    ...inner,
    query: async (sql: string, params?: unknown[]) => (seen(sql, params), inner.query(sql, params)),
    queryOne: async (sql: string, params?: unknown[]) => (
      seen(sql, params),
      inner.queryOne(sql, params)
    ),
  } as typeof inner;
}

async function setup() {
  const core = openCoreDatabase();
  const watch: { id?: string; reads: string[] } = { reads: [] };
  insertTenant(core, TENANT);
  const settings = kvStore();
  const envExtras: Record<string, unknown> = {
    DB: sqliteAdapter(core),
    SETTINGS: settings.namespace,
    AUTHRIM_CONFIG: settings.namespace,
    TEST_CORES: { [TENANT]: watchedAdapter(sqliteAdapter(core), watch) },
    BASE_DOMAIN: 'example.com',
  };
  const context = setupApp((app) => {
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
        tenantId: TENANT,
        coreDb: watchedAdapter(sqliteAdapter(core), watch),
        route: {},
      });
      await next();
    });
    app.use(
      '/api/admin/*',
      adminAuthMiddleware({ plane: 'tenant' }),
      enforceDeclaredAdminRouteAccess()
    );
    app.use(TEST_USERS, async (c, next) => {
      const get = c as unknown as { get(k: string): any; set(k: string, v: unknown): void };
      if (c.req.header('x-test-agent')) {
        get.set('adminAuth', { ...get.get('adminAuth'), actorType: 'agent' });
      }
      await next();
    });
    app.post(
      SETS,
      requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
      createMappingSetSaveIdempotency(),
      adminIdentityMappingSetCreateHandler
    );
    app.get(
      TEST_USERS,
      requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
      adminIdentityMappingTestUsersListHandler
    );
    app.put(
      TEST_USERS,
      requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
      adminIdentityMappingTestUsersReplaceHandler
    );
    app.post(
      EXPLAIN,
      requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ, ADMIN_PERMISSIONS.CLIENTS_READ]),
      adminIdentityMappingExplainHandler
    );
  }, envExtras);

  const repository = new IdentityMappingControlPlaneRepository(context.adapter);
  const entry = (path: string, classification: string) => ({
    id: `field.profile.${path}`,
    namespace: 'authrim.profile',
    path,
    targetType: 'canonical',
    valueType: 'string',
    cardinality: 'single',
    classification,
    uiGroupKey: 'profile',
    uiGroupLabel: 'Profile',
    uiGroupOrder: 10,
  });
  const catalog = await repository.createCatalog(TENANT, {
    catalogKey: 'tenant-catalog',
    displayName: 'Tenant catalog',
    versionLabel: 'v1',
    entries: [
      entry('email', 'pii'),
      entry('nickname', 'internal'),
      entry('affiliation', 'internal'),
      entry('display_name', 'pii'),
    ] as never,
  });
  const catalogVersionId = (catalog as { activeVersion: { id: string } }).activeVersion.id;
  const created = await repository.createDestinationProfile(TENANT, {
    destinationType: 'oidc',
    profileKey: 'app_profile',
    displayName: 'App profile',
    ownerScopeType: 'tenant',
    schema: PROFILE_SCHEMA,
  } as never);
  await repository.reviewDestinationProfileVersion(
    created.tenantId,
    created.id,
    created.version.id,
    false
  );
  await repository.activateDestinationProfileVersion(
    created.tenantId,
    created.id,
    created.version.id,
    false
  );
  const profileId = created.id;

  const cookie = (assignments: Assignment[] = TENANT_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const admin = cookie();
  const call = (
    method: string,
    path: string,
    body?: unknown,
    who = admin,
    headers: Record<string, string> = {}
  ) => context.call(who, method, path, body, headers);

  /** A set made through the facade, releasing the given attributes into the profile. */
  const createSet = async (paths: string[] = ['email', 'nickname', 'affiliation']) => {
    sequence += 1;
    const response = await call(
      'POST',
      SETS,
      {
        field_mapping_key: `key-${sequence}`,
        display_name: `Set ${sequence}`,
        content: {
          catalogVersionId,
          rules: paths.map((path) => rule(path, profileId, `field.profile.${path}`)),
        },
      },
      admin,
      { 'Idempotency-Key': `explain-key-${sequence}` }
    );
    expect(response.status).toBe(201);
    return response.json.id as string;
  };
  const app = (clientId: string, identityMapping?: unknown, scope = 'openid email profile') => {
    insertOAuthClient(core, { tenantId: TENANT, clientId, identityMapping });
    core.prepare('UPDATE oauth_clients SET scope = ? WHERE client_id = ?').run(scope, clientId);
  };
  const putTestUsers = (users: unknown[], who = admin, headers: Record<string, string> = {}) =>
    call('PUT', TEST_USERS, { test_users: users }, who, headers);
  /** One test user with these attributes; returns its ID. */
  const testUser = async (attributes: Record<string, unknown>) => {
    const response = await putTestUsers([{ label: 'Test person', attributes }]);
    expect(response.status).toBe(200);
    return response.json.test_users[0].user_id as string;
  };
  const explain = (body: Record<string, unknown>, who = admin) => call('POST', EXPLAIN, body, who);
  const claimOf = (json: Record<string, any>, claim: string) =>
    (json.claims as Array<Record<string, any>>).find((line) => line.claim === claim);
  return {
    ...context,
    core,
    watch,
    settings,
    repository,
    profileId,
    cookie,
    admin,
    call,
    createSet,
    app,
    putTestUsers,
    testUser,
    explain,
    claimOf,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

beforeEach(() => {
  vi.mocked(createAuditLogFromContext).mockClear();
});

const PERSON = { email: `person.${MARKER}@example.test`, nickname: MARKER, affiliation: MARKER };

// ---------------------------------------------------------------------------------------------

describe('test users', () => {
  it('are saved and read back as a whole list, in order, with IDs the endpoint gives', async () => {
    const t = await setup();
    const saved = await t.putTestUsers([
      { label: 'First', attributes: { email: 'a@example.test' } },
      { label: 'Second', attributes: { nickname: 'nick', affiliation: ['staff', 'faculty'] } },
    ]);
    expect(saved.status).toBe(200);
    const ids = saved.json.test_users.map((user: { user_id: string }) => user.user_id);
    expect(ids.every((id: string) => /^tu_/.test(id))).toBe(true);

    const read = await t.call('GET', TEST_USERS);
    expect(read.json.test_users).toEqual(saved.json.test_users);
    expect(read.json.limits).toEqual({ max_users: 10, max_attributes: 50 });

    // Keeping one by its ID, dropping the other, adding a third.
    const next = await t.putTestUsers([
      { user_id: ids[1], label: 'Second', attributes: { nickname: 'renamed' } },
      { label: 'Third', attributes: {} },
    ]);
    expect(next.json.test_users.map((user: { user_id: string }) => user.user_id)[0]).toBe(ids[1]);
    expect((await t.call('GET', TEST_USERS)).json.test_users).toHaveLength(2);
  });

  it('take only attributes a mapping can read', async () => {
    const t = await setup();
    const response = await t.putTestUsers([
      { label: 'X', attributes: { email: 'a@example.test', shoe_size: '42', groups: ['x'] } },
    ]);
    expect(response.status).toBe(400);
    expect(response.json.unknown_attributes).toEqual(['groups', 'shoe_size']);
    // The platform's canonical catalog is readable too.
    expect((await t.putTestUsers([{ label: 'Y', attributes: { given_name: 'G' } }])).status).toBe(
      200
    );
  });

  it.each([
    ['sub as an attribute', [{ label: 'X', attributes: { sub: 'someone' } }]],
    ['a nested value', [{ label: 'X', attributes: { email: { a: { b: 'c' } } } }]],
    ['an empty label', [{ label: ' ', attributes: {} }]],
    ['an unknown field', [{ label: 'X', attributes: {}, password: 'x' }]],
    ['an ID it did not give', [{ user_id: 'user-1', label: 'X', attributes: {} }]],
    ['too many', Array.from({ length: 11 }, () => ({ label: 'X', attributes: {} }))],
  ])('refuse %s', async (_name, users) => {
    const t = await setup();
    expect((await t.putTestUsers(users)).status).toBe(400);
  });

  it('are the tenant’s own: another tenant’s test user is neither listed nor kept by its ID', async () => {
    const t = await setup();
    t.db
      .prepare(
        `INSERT INTO identity_mapping_test_users (tenant_id, id, label, attributes_json, position, created_at, updated_at)
         VALUES ('tenant-b', 'tu_other', 'Other', '{}', 0, 1, 1)`
      )
      .run();
    expect((await t.call('GET', TEST_USERS)).json.test_users).toEqual([]);
    const response = await t.putTestUsers([{ user_id: 'tu_other', label: 'Mine', attributes: {} }]);
    expect(response.status).toBe(400);
    expect(
      t.db.prepare("SELECT label FROM identity_mapping_test_users WHERE id = 'tu_other'").get()
    ).toEqual({ label: 'Other' });
  });

  it('record a save without any value', async () => {
    const t = await setup();
    await t.putTestUsers([{ label: 'X', attributes: PERSON }]);
    const calls = vi.mocked(createAuditLogFromContext).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('identity_mapping.test_users.replaced');
    expect(calls[0][4]).toEqual({ test_user_count: 1, attribute_count: 3, removed_count: 0 });
    expect(JSON.stringify(calls[0])).not.toContain(MARKER);
  });

  it('are read with the settings read permission and replaced with the write one, never by an Agent', async () => {
    const t = await setup();
    const viewer = t.cookie([{ role: 'role_ar_viewer', scope: 'tenant' }]);
    expect((await t.call('GET', TEST_USERS, undefined, viewer)).status).toBe(200);
    expect((await t.putTestUsers([], viewer)).status).toBe(403);
    expect((await t.putTestUsers([], t.admin, { 'x-test-agent': '1' })).status).toBe(403);
    expect(findAdminRouteAccessRule('DELETE', TEST_USERS)).toBeNull();
    expect(findAdminRouteAccessRule('PUT', TEST_USERS)).toMatchObject({
      permissions: ['admin:settings:write'],
    });
  });
});

// ---------------------------------------------------------------------------------------------

async function bound(t: Setup, attributes: Record<string, unknown> = PERSON) {
  const setId = await t.createSet();
  t.app('app-1', { fieldMappingSetId: setId });
  const userId = await t.testUser(attributes);
  return { setId, userId };
}

const ask = (userId: string, extra: Record<string, unknown> = {}) => ({
  client_id: 'app-1',
  subject: { kind: 'test_user', id: userId },
  surface: 'userinfo',
  ...extra,
});

describe('an explanation', () => {
  it('follows each claim through the app’s own set to the final answer, with no value', async () => {
    const t = await setup();
    const { setId, userId } = await bound(t);

    const { status, json } = await t.explain(ask(userId));

    expect(status).toBe(200);
    expect(json).toMatchObject({
      tenantId: TENANT,
      clientId: 'app-1',
      surface: 'userinfo',
      subject: { kind: 'test_user', user_id: userId },
      scopes: ['openid', 'email', 'profile'],
      consent: 'all',
      selection: { kind: 'bound', tier: 'client', setId },
      outcome: { kind: 'issued' },
    });
    expect(t.claimOf(json, 'affiliation')).toEqual({
      claim: 'affiliation',
      field: 'affiliation',
      sources: ['affiliation'],
      origin: 'mapping',
      value: 'present',
      scope: 'profile',
      scope_granted: true,
      consent: 'not_required',
      released: true,
    });
    expect(t.claimOf(json, 'email')).toMatchObject({
      origin: 'mapping',
      consent: 'granted',
      released: true,
    });
    expect(t.claimOf(json, 'sub')).toMatchObject({ released: true, value: 'present' });
    expect(JSON.stringify(json)).not.toContain(MARKER);
    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.IdentityMappingExplainResponse, json)).toEqual([]);
  });

  it('gives each reason a claim is not released', async () => {
    const t = await setup();
    const { userId } = await bound(t, { affiliation: 'staff', nickname: '' });

    // No consent to the optional fields: email has a value but is held back.
    const none = (await t.explain(ask(userId, { consent: 'none', claims: ['groups'] }))).json;
    expect(t.claimOf(none, 'email')).toMatchObject({ released: false, reason: 'value_missing' });
    expect(t.claimOf(none, 'groups')).toMatchObject({
      origin: 'requested',
      released: false,
      reason: 'not_in_set',
    });
    expect(t.claimOf(none, 'nickname')).toMatchObject({ released: false, reason: 'value_empty' });

    // An empty standard attribute is no value, as the endpoints build the standard claims.
    const all = (await t.explain(ask(userId))).json;
    expect(t.claimOf(all, 'nickname')).toMatchObject({
      value: 'empty',
      released: false,
      reason: 'value_empty',
    });

    const withEmail = await t.testUser({ affiliation: 'staff', email: 'a@example.test' });
    const noConsent = (await t.explain(ask(withEmail, { consent: 'none' }))).json;
    expect(t.claimOf(noConsent, 'email')).toMatchObject({
      value: 'present',
      consent: 'missing',
      released: false,
      reason: 'consent_missing',
    });
    const noScope = (await t.explain(ask(withEmail, { scopes: ['openid', 'profile'] }))).json;
    expect(t.claimOf(noScope, 'email')).toMatchObject({
      scope: 'email',
      scope_granted: false,
      released: false,
      reason: 'scope_not_granted',
    });
    const idToken = (await t.explain(ask(withEmail, { surface: 'id_token' }))).json;
    expect(t.claimOf(idToken, 'nickname')).toMatchObject({
      released: false,
      reason: 'surface_not_listed',
    });
    expect(t.claimOf(idToken, 'email')).toMatchObject({ released: true });
  });

  it('explains a claim named like a property of every object as any other claim', async () => {
    const t = await setup();
    const { userId } = await bound(t);

    const { json } = await t.explain(
      ask(userId, { claims: ['constructor', '__proto__', 'toString'] })
    );

    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.IdentityMappingExplainResponse, json)).toEqual([]);
    for (const claim of ['constructor', '__proto__', 'toString']) {
      expect(t.claimOf(json, claim), claim).toMatchObject({
        origin: 'requested',
        value: 'missing',
        scope: null,
        released: false,
        reason: 'not_in_set',
      });
    }
  });

  it('explains a claim the profile lists twice by the entry the release used', async () => {
    const t = await setup();
    // email listed for the ID token, then again for UserInfo only.
    const schema = structuredClone(PROFILE_SCHEMA);
    schema.claims[1].surfaces = ['id_token'];
    schema.claims.push({ ...schema.claims[1], surfaces: ['userinfo'] });
    t.db
      .prepare('UPDATE destination_profile_versions SET schema_json = ? WHERE profile_id = ?')
      .run(JSON.stringify(schema), t.profileId);
    const { userId } = await bound(t);

    const none = (await t.explain(ask(userId, { surface: 'id_token', consent: 'none' }))).json;
    expect(t.claimOf(none, 'email')).toMatchObject({
      consent: 'missing',
      released: false,
      reason: 'consent_missing',
    });
    const all = (await t.explain(ask(userId, { surface: 'id_token' }))).json;
    expect(t.claimOf(all, 'email')).toMatchObject({ consent: 'granted', released: true });
  });

  it('takes the consent of every entry in play when the profile lists a claim twice', async () => {
    const t = await setup();
    // email listed as required, then again as optional, both for the ID token.
    const schema = structuredClone(PROFILE_SCHEMA);
    schema.claims.push({ ...schema.claims[1] });
    Object.assign(schema.claims[1], { required: true });
    t.db
      .prepare('UPDATE destination_profile_versions SET schema_json = ? WHERE profile_id = ?')
      .run(JSON.stringify(schema), t.profileId);
    const { userId } = await bound(t);

    const none = (await t.explain(ask(userId, { surface: 'id_token', consent: 'none' }))).json;

    expect(t.claimOf(none, 'email')).toMatchObject({
      consent: 'missing',
      released: false,
      reason: 'consent_missing',
    });
  });

  it('stops when a required claim has no value, naming the claim', async () => {
    const t = await setup();
    const { userId } = await bound(t, { email: 'a@example.test' });

    const { json } = await t.explain(ask(userId));

    expect(json.outcome).toEqual({
      kind: 'stopped',
      code: 'required_field_missing',
      claim: 'affiliation',
    });
    expect(t.claimOf(json, 'email')).toMatchObject({
      released: false,
      reason: 'issuance_stopped',
    });
  });

  it('stops when the set the app names cannot be used, and does not fall to the default', async () => {
    const t = await setup();
    const { setId, userId } = await bound(t);
    const fallback = await t.createSet(['email']);
    t.settings.store.set(TENANT_DOC, JSON.stringify({ [KEY]: fallback }));
    t.db
      .prepare(
        "UPDATE field_mapping_activations SET lifecycle_state = 'inactive' WHERE field_mapping_set_id = ?"
      )
      .run(setId);

    const { json } = await t.explain(ask(userId));

    expect(json.selection).toMatchObject({ kind: 'bound', tier: 'client', setId });
    expect(json.outcome).toEqual({ kind: 'stopped', code: 'set_inactive', tier: 'client' });
    for (const line of json.claims) {
      if (line.claim === 'sub') continue;
      expect(line, line.claim).toMatchObject({ released: false, reason: 'issuance_stopped' });
    }
  });

  it('shows the 2026-10-10 case: an activation that no longer applies, and the claim it gave', async () => {
    const t = await setup();
    const setId = await t.createSet();
    // An app that names nothing, a tenant with no default: the activation the set's save left
    // for the whole tenant once bound such an app.
    t.app('app-1');
    t.db
      .prepare(
        "UPDATE field_mapping_activations SET activation_scope_json = '{}' WHERE field_mapping_set_id = ?"
      )
      .run(setId);
    const userId = await t.testUser({ ...PERSON });

    const { json } = await t.explain(ask(userId, { claims: ['affiliation'] }));

    expect(json.selection).toEqual({ kind: 'none', reason: 'no_default' });
    expect(json.warnings).toMatchObject([{ code: 'implicit_activation_no_longer_applies' }]);
    expect(json.outcome).toEqual({ kind: 'issued' });
    expect(t.claimOf(json, 'affiliation')).toMatchObject({
      origin: 'requested',
      released: false,
      reason: 'mapping_not_applied',
    });
    // The standard claims still go out without a mapping.
    expect(t.claimOf(json, 'email')).toMatchObject({ origin: 'standard', released: true });
    expect(t.claimOf(json, 'nickname')).toMatchObject({ origin: 'standard', released: true });
  });

  it('releases what the issuing path releases for the same user', async () => {
    const t = await setup();
    const { setId, userId } = await bound(t);
    for (const surface of ['id_token', 'userinfo'] as const) {
      const explained = (await t.explain(ask(userId, { surface, consent: 'none' }))).json;
      // The issuing path for an account with the same attributes and no consent record.
      const userData = { ...buildStandardUserClaims(PERSON), sub: 'account-1' };
      const evaluated = evaluateClaimsForTarget({
        target: surface,
        initialClaims: { sub: 'account-1' },
        availableClaims: userData,
        grantedScopes: ['openid', 'email', 'profile'],
        includeScopeClaims: surface === 'userinfo',
      });
      if (!evaluated.ok) throw new Error('evaluation failed');
      const issued = await applyOIDCIdentityMapping({
        adapter: sqliteAdapter(t.core),
        env: { DB_ADMIN: t.adapter, SETTINGS: t.settings.namespace } as never,
        tenantId: TENANT,
        clientId: 'app-1',
        selector: { fieldMappingSetId: setId },
        destinationSurface: surface,
        grantedScopes: ['openid', 'email', 'profile'],
        claims: evaluated.claims,
        sourceAttributes: { ...PERSON, ...userData },
      });
      const releasedByExplain = explained.claims
        .filter((line: { released: boolean }) => line.released)
        .map((line: { claim: string }) => line.claim)
        .sort();
      expect(releasedByExplain, surface).toEqual(Object.keys(issued.claims).sort());
    }
  });

  it('reads nothing kept for an account with the test user’s ID', async () => {
    const t = await setup();
    const { userId } = await bound(t);
    t.watch.id = userId;

    for (const surface of ['id_token', 'userinfo']) {
      expect((await t.explain(ask(userId, { surface }))).status).toBe(200);
    }
    // No consent record, custom field or identifier is looked up by the test user's ID.
    expect(t.watch.reads).toEqual([]);
  });
});

describe('what the explanation follows', () => {
  it('follows a default just changed, in the selection and in the claims alike', async () => {
    const t = await setup();
    const first = await t.createSet(['email', 'affiliation']);
    const second = await t.createSet(['nickname', 'affiliation']);
    t.app('app-1');
    const userId = await t.testUser(PERSON);
    t.settings.store.set(TENANT_DOC, JSON.stringify({ [KEY]: first }));
    const before = (await t.explain(ask(userId))).json;
    expect(before.selection).toMatchObject({ tier: 'tenant_default', setId: first });

    t.settings.store.set(TENANT_DOC, JSON.stringify({ [KEY]: second }));
    const after = (await t.explain(ask(userId))).json;

    expect(after.selection).toMatchObject({ tier: 'tenant_default', setId: second });
    expect(t.claimOf(after, 'nickname')).toMatchObject({ origin: 'mapping', released: true });
    expect(t.claimOf(after, 'email')).toMatchObject({ origin: 'standard' });
  });

  it('gives a standard claim from the attribute a catalog names by its neutral alias', async () => {
    const t = await setup();
    t.app('app-1');
    const userId = await t.testUser({ display_name: 'Someone' });

    const { json } = await t.explain(ask(userId));

    expect(json.selection).toEqual({ kind: 'none', reason: 'no_default' });
    expect(t.claimOf(json, 'name')).toMatchObject({
      origin: 'standard',
      value: 'present',
      released: true,
    });

    // An empty alias is an empty value, as an empty standard attribute is.
    for (const attributes of [{ display_name: '' }, { name: '' }]) {
      const empty = await t.testUser(attributes);
      const answer = (await t.explain(ask(empty))).json;
      expect(t.claimOf(answer, 'name'), JSON.stringify(attributes)).toMatchObject({
        value: 'empty',
        released: false,
        reason: 'value_empty',
      });
    }
  });

  it('says sub is released whatever scope an older profile entry lists for it', async () => {
    const t = await setup();
    const schema = structuredClone(PROFILE_SCHEMA);
    Object.assign(schema.claims[0], { requiredScopes: ['legacy'] });
    t.db
      .prepare('UPDATE destination_profile_versions SET schema_json = ? WHERE profile_id = ?')
      .run(JSON.stringify(schema), t.profileId);
    const { userId } = await bound(t);

    const { json } = await t.explain(ask(userId));

    expect(t.claimOf(json, 'sub')).toMatchObject({
      released: true,
      scope: null,
      scope_granted: true,
    });
  });

  it('takes attribute keys and claim names the control plane takes', async () => {
    const t = await setup();
    t.db
      .prepare(
        `INSERT INTO custom_field_catalog_entries (id, tenant_id, custom_key, display_name, value_type, created_at, updated_at)
         VALUES ('cf-1', ?, 'team~name', 'Team', 'string', 1, 1)`
      )
      .run(TENANT);
    await bound(t);
    const saved = await t.putTestUsers([
      { label: 'X', attributes: { 'team~name': 'a', affiliation: 'staff' } },
    ]);
    expect(saved.status).toBe(200);
    const userId = saved.json.test_users[0].user_id as string;
    const { status, json } = await t.explain(ask(userId, { claims: ['team~name'] }));
    expect(status).toBe(200);
    expect(t.claimOf(json, 'team~name')).toMatchObject({ released: false, reason: 'not_in_set' });
  });
});

describe('who may ask', () => {
  it('needs both the settings read and the clients read permission', async () => {
    const t = await setup();
    const { userId } = await bound(t);
    insertRole(t.db, {
      id: 'role_settings_only',
      // Signing in takes one of the Admin roles by name; the permissions are this role's own.
      name: 'ar_viewer',
      permissions: ['admin:settings:read'],
      hierarchy: 10,
    });
    const viewer = t.cookie([{ role: 'role_ar_viewer', scope: 'tenant' }]);
    const support = t.cookie([{ role: 'role_ar_support', scope: 'tenant' }]);
    const settingsOnly = t.cookie([{ role: 'role_settings_only', scope: 'tenant' }]);

    expect((await t.explain(ask(userId), viewer)).status).toBe(200);
    expect((await t.explain(ask(userId), support)).status).toBe(403);
    expect((await t.explain(ask(userId), settingsOnly)).status).toBe(403);
    expect(findAdminRouteAccessRule('GET', EXPLAIN)).toBeNull();
    expect(findAdminRouteAccessRule('POST', EXPLAIN)?.permissions).toEqual([
      'admin:settings:read',
      'admin:clients:read',
    ]);
  });

  it('answers another tenant’s app and test user as not found', async () => {
    const t = await setup();
    const { userId } = await bound(t);
    insertOAuthClient(t.core, { tenantId: 'tenant-b', clientId: 'app-b' });
    t.db
      .prepare(
        `INSERT INTO identity_mapping_test_users (tenant_id, id, label, attributes_json, position, created_at, updated_at)
         VALUES ('tenant-b', 'tu_other', 'Other', '{}', 0, 1, 1)`
      )
      .run();

    expect((await t.explain(ask(userId, { client_id: 'app-b' }))).status).toBe(404);
    expect((await t.explain(ask('tu_other'))).status).toBe(404);
  });

  it.each([
    ['a real user', { subject: { kind: 'user', id: 'user-1' } }],
    ['an unknown surface', { surface: 'introspection' }],
    ['an unknown consent', { consent: 'some' }],
    ['an unknown field', { purpose: 'x' }],
    ['a bad scope list', { scopes: 'openid' }],
  ])('refuses %s', async (_name, extra) => {
    const t = await setup();
    const { userId } = await bound(t);
    expect((await t.explain(ask(userId, extra))).status).toBe(400);
  });
});
