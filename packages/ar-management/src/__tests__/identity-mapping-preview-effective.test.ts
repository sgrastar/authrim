import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { adminAuthMiddleware, PLATFORM_MAPPING_TENANT_ID } from '@authrim/ar-lib-core';

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
import { adminClientUpdateHandler } from '../admin-clients';
import settingsV2 from '../routes/settings-v2';
import { releaseRolloutMutationFenceMiddleware } from '../release-rollout-mutation-fence';
import {
  adminIdentityMappingEffectiveHandler,
  type effectiveMappingView,
} from '../identity-mapping-effective';
import type { ClaimChange } from '../identity-mapping-content-diff';
import {
  adminIdentityMappingCompareSetsHandler,
  adminIdentityMappingPreviewEffectiveHandler,
} from '../identity-mapping-preview-effective';
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
import { seedDestinationProfile, seedMapping } from './helpers/identity-mapping-seed';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';

/**
 * A trial of a choice that is not saved: the answer is the effective endpoint's, before and after,
 * from the same selection. The real admin authentication and route access, the real effective
 * handler to compare with, the real Admin schema and Core `oauth_clients` on SQLite.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const PREVIEW = '/api/admin/identity-mapping/preview-effective';
const COMPARE = '/api/admin/identity-mapping/sets/compare';
const EFFECTIVE = '/api/admin/identity-mapping/effective';
const TENANT_DOC = `settings:tenant:${TENANT}:identity-mapping`;
const PLATFORM_DOC = 'settings:platform:identity-mapping';
const TENANT_SETTINGS = `/api/admin/tenants/${TENANT}/settings/identity-mapping`;

const schemas = adminOpenApiSchemas();

type EffectiveView = NonNullable<Awaited<ReturnType<typeof effectiveMappingView>>>;
interface PreviewResponse {
  tenantId: string;
  clientId: string | null;
  before: EffectiveView;
  after: EffectiveView;
  refusals?: Array<{ tier: string; reason: string; message: string }>;
}

function setup(rollout: 'available' | 'read_only' | 'unknown' = 'available') {
  const store = new Map<string, string>();
  const namespaceMock = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  };
  const namespace = namespaceMock as unknown as KVNamespace;
  const core = openCoreDatabase();
  insertTenant(core, TENANT);
  const coreAdapter = sqliteAdapter(core);
  const getReleaseMigrationRolloutStatus = vi.fn(async () => {
    if (rollout === 'unknown') throw new Error('rollout status unavailable');
    return { adminMutationMode: rollout };
  });
  const { DB_ADMIN: _loggingAdmin, ...loggingEnv } = logging.env;
  const context = setupApp(
    (app) => {
      app.use('*', async (c, next) => {
        Object.defineProperty(c, 'executionCtx', {
          value: {
            waitUntil: (promise: Promise<unknown>) => {
              void promise;
            },
          },
        });
        c.set(
          'tenantMetadataContext' as never,
          {
            tenantId: TENANT,
            coreDb: coreAdapter,
            route: {},
          } as never
        );
        await next();
      });
      app.use(
        '/api/admin/*',
        adminAuthMiddleware({ plane: 'tenant' }),
        releaseRolloutMutationFenceMiddleware(),
        enforceDeclaredAdminRouteAccess()
      );
      app.get(EFFECTIVE, adminIdentityMappingEffectiveHandler);
      app.post(PREVIEW, adminIdentityMappingPreviewEffectiveHandler);
      app.get(COMPARE, adminIdentityMappingCompareSetsHandler);
      app.put('/api/admin/clients/:id', adminClientUpdateHandler);
      app.route('/api/admin', settingsV2);
    },
    {
      ...loggingEnv,
      SETTINGS: namespace,
      AUTHRIM_CONFIG: namespace,
      TEST_CORES: { [TENANT]: coreAdapter },
      BASE_DOMAIN: 'example.com',
      ISSUER_URL: 'https://id.example.com',
      CONTROL: { getReleaseMigrationRolloutStatus },
      RATE_LIMITER: {
        idFromName: vi.fn(() => 'rate-limit'),
        get: vi.fn(() => ({
          incrementRpc: vi.fn(async () => ({
            allowed: true,
            current: 1,
            limit: 100,
            resetAt: Math.floor(Date.now() / 1000) + 60,
          })),
        })),
      },
    }
  );
  // Sets of the tenant (a, a2), of the platform and of another tenant, each with a profile.
  for (const [owner, id] of [
    [TENANT, 'a'],
    [TENANT, 'a2'],
    [PLATFORM_MAPPING_TENANT_ID, 'plat'],
    ['tenant-b', 'other'],
  ] as const) {
    seedMapping(context.db, { owner, id });
    seedDestinationProfile(context.db, { owner, id: `profile-${id}` });
  }
  // The seeded sets are active, each with an activation of the whole tenant (the shape a save
  // makes), so they can be named. The warning of an activation that no longer applies is the
  // effective endpoint's own and is the same on both sides.

  const save = (document: string, values: Record<string, unknown>) =>
    store.set(document, JSON.stringify(values));
  const cookie = (assignments: Assignment[] = TENANT_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const admin = cookie();
  const preview = async (body: unknown, who = admin) => {
    const result = await context.call(who, 'POST', PREVIEW, body);
    return { ...result, json: result.json as PreviewResponse };
  };
  const effective = async (clientId?: string) => {
    const result = await context.call(
      admin,
      'GET',
      `${EFFECTIVE}${clientId ? `?client_id=${clientId}` : ''}`
    );
    return { ...result, json: result.json as EffectiveView };
  };
  const app = (clientId: string, identityMapping?: unknown) =>
    insertOAuthClient(core, { tenantId: TENANT, clientId, identityMapping });
  /** Saves the proposal through the same client PUT and settings PATCH the console uses. */
  const apply = async (
    proposal: { client?: unknown; tenant_default?: unknown },
    clientId?: string
  ) => {
    if (clientId && 'client' in proposal) {
      const response = await context.call(admin, 'PUT', `/api/admin/clients/${clientId}`, {
        identity_mapping: proposal.client,
      });
      if (response.status !== 200) return response;
    }
    if ('tenant_default' in proposal) {
      const current = await context.call(admin, 'GET', TENANT_SETTINGS);
      expect(current.status).toBe(200);
      const version: unknown = current.json.version;
      if (typeof version !== 'string') throw new Error('settings version is missing');
      return context.call(admin, 'PATCH', TENANT_SETTINGS, {
        ifMatch: version,
        ...(proposal.tenant_default === null
          ? { clear: [KEY] }
          : { set: { [KEY]: proposal.tenant_default } }),
      });
    }
    return { status: 200 };
  };
  return {
    ...context,
    core,
    store,
    namespace: namespaceMock,
    getReleaseMigrationRolloutStatus,
    save,
    cookie,
    admin,
    preview,
    effective,
    app,
    apply,
  };
}

let logging: Awaited<ReturnType<typeof logProducerFixture>>;
afterEach(() => logging?.close());
beforeEach(async () => {
  logging = await logProducerFixture('scheduled');
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe('a trial of an app’s choice', () => {
  it('shows what is saved and what the choice would bind, and saves nothing', async () => {
    const t = setup();
    t.app('app-1');
    t.save(TENANT_DOC, { [KEY]: 'set-a' });

    const { status, json } = await t.preview({
      client_id: 'app-1',
      proposal: { client: { fieldMappingSetId: 'set-a2' } },
    });

    expect(status).toBe(200);
    expect(json.before.selection).toMatchObject({ tier: 'tenant_default', setId: 'set-a' });
    expect(json.after.selection).toMatchObject({
      kind: 'bound',
      tier: 'client',
      setId: 'set-a2',
      setName: 'Set a2',
    });
    expect(json.after.chain.map((e: { state: string }) => e.state)).toEqual([
      'set',
      'set',
      'unset',
    ]);
    expect(json.refusals).toBeUndefined();
    // The app's row and the settings are as they were.
    expect(
      t.core.prepare("SELECT identity_mapping FROM oauth_clients WHERE client_id = 'app-1'").get()
    ).toEqual({ identity_mapping: null });
    expect(t.store.get(TENANT_DOC)).toBe(JSON.stringify({ [KEY]: 'set-a' }));
    expect(t.namespace.put).not.toHaveBeenCalled();
    expect(t.namespace.delete).not.toHaveBeenCalled();
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get()).toEqual({
      count: 0,
    });
    expect(shapeErrors(schemas, schemas.IdentityMappingPreviewEffectiveResponse, json)).toEqual([]);
  });

  it.each([
    ['its own set', { fieldMappingSetId: 'set-a2' }],
    ['a set the platform owns', { fieldMappingSetId: 'set-plat' }],
    ['the opt-out', { mode: 'none' }],
    ['following the defaults', null],
  ])('is what the effective endpoint says once %s is saved', async (_name, choice) => {
    const t = setup();
    t.app('app-1', { fieldMappingSetId: 'set-a' });
    t.save(TENANT_DOC, { [KEY]: 'set-a' });
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });

    const previewed = (await t.preview({ client_id: 'app-1', proposal: { client: choice } })).json;
    const applied = await t.apply({ client: choice }, 'app-1');
    const saved = (await t.effective('app-1')).json;

    // A platform set may not be the choice of an app (backup), so a save would refuse it.
    if (previewed.refusals) {
      expect(applied.status).toBe(404);
      expect(previewed.after.selection).toMatchObject({ kind: 'failed', code: 'proposal_refused' });
    } else {
      expect(applied.status).toBe(200);
      expect(previewed.after).toEqual(saved);
    }
    expect(previewed.before).toBeDefined();
  });

  it('uses the same pinned version as a saved app choice', async () => {
    const t = setup();
    t.app('app-1');
    const versionId = 'ver-a';
    const client = { fieldMappingSetId: 'set-a', fieldMappingVersionId: versionId };

    const previewed = await t.preview({ client_id: 'app-1', proposal: { client } });
    expect(previewed.status).toBe(200);
    expect(previewed.json.after.selection).toMatchObject({
      kind: 'bound',
      tier: 'client',
      pinnedVersionId: versionId,
    });
    expect((await t.apply({ client }, 'app-1')).status).toBe(200);
    expect(previewed.json.after).toEqual((await t.effective('app-1')).json);
  });

  it('refuses a pin from another set as the client save does', async () => {
    const t = setup();
    t.app('app-1');
    const client = { fieldMappingSetId: 'set-a', fieldMappingVersionId: 'ver-a2' };

    const previewed = await t.preview({ client_id: 'app-1', proposal: { client } });

    expect(previewed.status).toBe(200);
    expect(previewed.json.after.selection).toMatchObject({
      kind: 'failed',
      code: 'proposal_refused',
    });
    expect(previewed.json.refusals?.[0].reason).toBe('set_inactive');
    expect((await t.apply({ client }, 'app-1')).status).toBe(400);
    expect(
      shapeErrors(schemas, schemas.IdentityMappingPreviewEffectiveResponse, previewed.json)
    ).toEqual([]);
  });
});

describe('a trial of the tenant’s default', () => {
  it.each([
    ['a set', 'set-a2'],
    ['a set the platform owns', 'set-plat'],
    ['none', 'none'],
    ['no default of its own', null],
  ])('is what the effective endpoint says once %s is saved', async (_name, value) => {
    const t = setup();
    t.app('app-1');
    t.save(TENANT_DOC, { [KEY]: 'set-a' });
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });

    const previewed = (await t.preview({ client_id: 'app-1', proposal: { tenant_default: value } }))
      .json;
    expect((await t.apply({ tenant_default: value })).status).toBe(200);
    const saved = (await t.effective('app-1')).json;

    expect(previewed.refusals).toBeUndefined();
    expect(previewed.after).toEqual(saved);
  });

  it('is the tenant’s view without an app', async () => {
    const t = setup();
    t.save(TENANT_DOC, { [KEY]: 'set-a' });

    const { json } = await t.preview({ proposal: { tenant_default: 'none' } });

    expect(json.clientId).toBeNull();
    expect(json.before.selection).toMatchObject({ setId: 'set-a' });
    expect(json.after.selection).toEqual({ kind: 'none', reason: 'tenant_opt_out' });
  });

  it('shows the app’s own choice still deciding, whatever the default would be', async () => {
    const t = setup();
    t.app('app-1', { fieldMappingSetId: 'set-a' });

    const { json } = await t.preview({
      client_id: 'app-1',
      proposal: { tenant_default: 'set-a2' },
    });

    expect(json.after.selection).toMatchObject({ tier: 'client', setId: 'set-a' });
    expect(json.after.chain[1]).toMatchObject({
      tier: 'tenant_default',
      state: 'set',
      setId: 'set-a2',
    });
  });

  it('can be tried together with the app’s choice', async () => {
    const t = setup();
    t.app('app-1');

    const { json } = await t.preview({
      client_id: 'app-1',
      proposal: { client: null, tenant_default: 'set-a2' },
    });

    expect(json.after.selection).toMatchObject({ tier: 'tenant_default', setId: 'set-a2' });
  });
});

describe('a proposal a save would refuse', () => {
  it.each([
    ['a set that does not exist', { tenant_default: 'set-nothing' }, 'set_missing'],
    ['another tenant’s set', { tenant_default: 'set-other' }, 'set_missing'],
  ])('is %s: the answer binds nothing', async (_name, proposal, reason) => {
    const t = setup();
    t.app('app-1');
    t.save(TENANT_DOC, { [KEY]: 'set-a' });

    const { status, json } = await t.preview({ client_id: 'app-1', proposal });

    expect(status).toBe(200);
    expect(json.after.selection).toEqual({
      kind: 'failed',
      code: 'proposal_refused',
      tier: 'tenant_default',
      reason,
    });
    expect(json.refusals).toEqual([
      { tier: 'tenant_default', reason, message: expect.any(String) as unknown },
    ]);
  });

  it('is a set that is not active', async () => {
    const t = setup();
    t.app('app-1');
    t.db
      .prepare("UPDATE field_mapping_sets SET lifecycle_state = 'draft' WHERE id = 'set-a2'")
      .run();

    const { json } = await t.preview({
      client_id: 'app-1',
      proposal: { client: { fieldMappingSetId: 'set-a2' } },
    });

    expect(json.after.selection).toMatchObject({
      kind: 'failed',
      code: 'proposal_refused',
      tier: 'client',
      reason: 'set_inactive',
    });
  });

  it('is judged as the save judges it: a platform set cannot be an app’s own choice', async () => {
    const t = setup();
    t.app('app-1');
    const { json } = await t.preview({
      client_id: 'app-1',
      proposal: { client: { fieldMappingSetId: 'set-plat' } },
    });
    expect(json.after.selection).toMatchObject({ code: 'proposal_refused', tier: 'client' });
  });
});

describe('what is asked', () => {
  it.each(['read_only', 'unknown'] as const)(
    'inspects an unsaved proposal while rollout state is %s, preserving authorization and writes',
    async (rollout) => {
      const t = setup(rollout);
      t.app('app-1');
      t.save(TENANT_DOC, { [KEY]: 'set-a' });
      const body = { client_id: 'app-1', proposal: { client: { fieldMappingSetId: 'set-a2' } } };

      const result = await t.preview(body);

      expect(result.status).toBe(200);
      expect(result.json.before.selection).toMatchObject({ setId: 'set-a' });
      expect(result.json.after.selection).toMatchObject({ setId: 'set-a2' });
      expect(t.getReleaseMigrationRolloutStatus).not.toHaveBeenCalled();
      expect(t.namespace.put).not.toHaveBeenCalled();
      expect(t.namespace.delete).not.toHaveBeenCalled();
      expect(t.store.get(TENANT_DOC)).toBe(JSON.stringify({ [KEY]: 'set-a' }));
      expect(t.core.prepare('SELECT identity_mapping FROM oauth_clients').get()).toEqual({
        identity_mapping: null,
      });
      expect(t.db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get()).toEqual({
        count: 0,
      });
      expect((await t.preview(body, '')).status).toBe(401);
      const expected = rollout === 'read_only' ? 409 : 503;
      expect((await t.apply({ client: body.proposal.client }, 'app-1')).status).toBe(expected);
      expect((await t.apply({ tenant_default: 'set-a2' })).status).toBe(expected);
      expect(t.namespace.put).not.toHaveBeenCalled();
      expect(t.namespace.delete).not.toHaveBeenCalled();
      expect(t.core.prepare('SELECT identity_mapping FROM oauth_clients').get()).toEqual({
        identity_mapping: null,
      });
    }
  );

  it.each([
    ['no proposal', { client_id: 'app-1' }],
    ['an empty proposal', { client_id: 'app-1', proposal: {} }],
    ['an unknown key', { client_id: 'app-1', proposal: { other: 1 } }],
    ['an app’s choice without an app', { proposal: { client: null } }],
    ['a choice that is not one', { client_id: 'app-1', proposal: { client: { mode: 'all' } } }],
    [
      'a set beside the opt-out',
      { client_id: 'app-1', proposal: { client: { mode: 'none', fieldMappingSetId: 'set-a' } } },
    ],
    [
      'a pin without a set',
      { client_id: 'app-1', proposal: { client: { fieldMappingVersionId: 'ver-a' } } },
    ],
    [
      'a profile without a set',
      { client_id: 'app-1', proposal: { client: { destinationProfileId: 'profile-a' } } },
    ],
    ['a default that is not a set ID', { client_id: 'app-1', proposal: { tenant_default: 5 } }],
    ['a default with spaces', { client_id: 'app-1', proposal: { tenant_default: ' set-a ' } }],
    ['an unknown field', { client_id: 'app-1', proposal: { client: null }, extra: 1 }],
  ])('refuses %s', async (_name, body) => {
    const t = setup();
    t.app('app-1');
    expect((await t.preview(body)).status).toBe(400);
    const proposal = 'proposal' in body ? body.proposal : undefined;
    if (proposal && 'client' in proposal && 'client_id' in body && !('extra' in body)) {
      expect((await t.apply({ client: proposal.client }, 'app-1')).status).toBe(400);
    }
  });

  it('is 404 for an app that does not exist, and for another tenant’s app', async () => {
    const t = setup();
    insertOAuthClient(t.core, { tenantId: 'tenant-b', clientId: 'app-b' });
    const missing = await t.preview({ client_id: 'nope', proposal: { client: null } });
    const other = await t.preview({ client_id: 'app-b', proposal: { client: null } });
    expect(missing.status).toBe(404);
    expect(other.json).toEqual(missing.json);
  });

  it('needs the clients read for an app, and only the settings read for the tenant', async () => {
    const t = setup();
    t.app('app-1');
    insertRole(t.db, {
      id: 'role_settings_only',
      // Signing in takes one of the Admin roles by name; the permissions are this role's own.
      name: 'ar_viewer',
      permissions: ['admin:settings:read'],
      hierarchy: 10,
    });
    const settingsOnly = t.cookie([{ role: 'role_settings_only', scope: 'tenant' }]);
    const viewer = t.cookie([{ role: 'role_ar_viewer', scope: 'tenant' }]);

    expect(
      (await t.preview({ client_id: 'app-1', proposal: { client: null } }, settingsOnly)).status
    ).toBe(403);
    expect((await t.preview({ proposal: { tenant_default: 'none' } }, settingsOnly)).status).toBe(
      200
    );
    expect(
      (await t.preview({ client_id: 'app-1', proposal: { client: null } }, viewer)).status
    ).toBe(200);
    expect(findAdminRouteAccessRule('GET', PREVIEW)).toBeNull();
    expect(findAdminRouteAccessRule('POST', PREVIEW)?.permissions).toEqual(['admin:settings:read']);
  });

  it('requires authentication and settings read even for an app reader', async () => {
    const t = setup();
    t.app('app-1');
    insertRole(t.db, {
      id: 'role_clients_only',
      name: 'ar_viewer',
      permissions: ['admin:clients:read'],
      hierarchy: 10,
    });
    const reader = t.cookie([{ role: 'role_clients_only', scope: 'tenant' }]);
    const body = { client_id: 'app-1', proposal: { client: null } };

    expect((await t.preview(body, '')).status).toBe(401);
    expect((await t.preview(body, reader)).status).toBe(403);
    expect((await t.call(reader, 'GET', `${COMPARE}?a=set-a&b=set-a2`)).status).toBe(403);
    expect(t.namespace.put).not.toHaveBeenCalled();
  });

  it('does not treat unreadable settings as an absent default', async () => {
    const t = setup();
    t.app('app-1');
    vi.mocked(t.namespace.get).mockRejectedValue(new Error('unavailable'));

    const result = await t.preview({ client_id: 'app-1', proposal: { tenant_default: 'none' } });

    expect(result.status).toBe(503);
    expect(result.json).not.toHaveProperty('after');
    expect(t.namespace.put).not.toHaveBeenCalled();
    expect(t.namespace.delete).not.toHaveBeenCalled();
  });
});

describe('a comparison of two sets', () => {
  async function compare(t: ReturnType<typeof setup>, a: string, b: string, who = t.admin) {
    const result = await t.call(who, 'GET', `${COMPARE}?a=${a}&b=${b}`);
    return { ...result, json: result.json as { a: unknown; b: unknown; changes: ClaimChange[] } };
  }

  it('gives the changes of b against a, for the tenant’s sets and the platform’s', async () => {
    const t = setup();
    // set-a2 releases email through profile-a2; set-plat through profile-plat, both from `email`.
    const { json } = await compare(t, 'set-a', 'set-plat');

    expect(json.a).toEqual({ setId: 'set-a', owner: 'tenant' });
    expect(json.b).toEqual({ setId: 'set-plat', owner: 'platform' });
    expect(json.changes).toEqual([
      expect.objectContaining({ kind: 'profile_changed', claim: 'email' }),
    ]);
    expect(shapeErrors(schemas, schemas.IdentityMappingCompareSetsResponse, json)).toEqual([]);
  });

  it('is empty for a set against itself', async () => {
    const t = setup();
    expect((await compare(t, 'set-a', 'set-a')).json.changes).toEqual([]);
  });

  it.each([
    { before: null, after: 'critical', change: 'added', effect: 'may_reject' },
    { before: 'critical', after: null, change: 'removed', effect: 'may_reject' },
    { before: 'critical', after: 'error', change: 'changed', effect: 'may_reject' },
    { before: null, after: 'warning', change: 'added', effect: 'validation_only' },
  ])('includes validation $change ($effect), without values or parameters', async (test) => {
    const t = setup();
    for (const [id, severity] of [
      ['a', test.before],
      ['a2', test.after],
    ] as const) {
      if (severity === null) continue;
      t.db
        .prepare(
          `INSERT INTO mapping_validation_rules
         (id, tenant_id, rule_id, target_ref_json, validation_kind, severity, parameters_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'required', ?, ?, 1, 1)`
        )
        .run(
          `validation-${id}`,
          TENANT,
          `rule-${id}`,
          JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'nickname' }),
          severity,
          JSON.stringify({ message: 'not returned by a comparison' })
        );
    }

    const result = await compare(t, 'set-a', 'set-a2');

    expect(result.status).toBe(200);
    expect(result.json.changes).toContainEqual({
      kind: 'validation_changed',
      claim: 'nickname',
      namespace: 'authrim.profile',
      profile_id: 'profile-a2',
      previous_profile_id: 'profile-a',
      validation_change: test.change,
      validation_effect: test.effect,
    });
    expect(JSON.stringify(result.json)).not.toContain('not returned by a comparison');
    expect(shapeErrors(schemas, schemas.IdentityMappingCompareSetsResponse, result.json)).toEqual(
      []
    );
  });

  it.each([
    { before: ['string', 'number'], after: ['string', 'string'], label: 'mixed to one type' },
    { before: ['string', 'string'], after: ['string', 'number'], label: 'one type to mixed' },
    { before: ['string', 'number'], after: ['string', 'boolean'], label: 'mixed types changed' },
    { before: ['string', 'number'], after: ['number', 'string'], label: 'source types swapped' },
  ] as const)('includes per-source type changes: $label', async ({ before, after }) => {
    const t = setup();
    for (const [id, types] of [
      ['a', before],
      ['a2', after],
    ] as const) {
      t.db
        .prepare('UPDATE field_catalog_entries SET value_type = ? WHERE id = ?')
        .run(types[0], `entry-${id}`);
      t.db
        .prepare(
          `INSERT INTO field_catalog_entries
         (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, classification, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'authrim.profile', 'nickname', 'canonical', ?, 'pii', 1, 1)`
        )
        .run(`entry-nickname-${id}`, TENANT, `catalog-${id}`, `field.nickname.${id}`, types[1]);
      t.db
        .prepare(
          `INSERT INTO mapping_rule_edges
         (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'direct', 1, 1, 1)`
        )
        .run(
          `edge-nickname-${id}`,
          TENANT,
          `rule-${id}`,
          JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'nickname' }),
          JSON.stringify({
            side: 'destination',
            profileId: `profile-${id}`,
            namespace: 'oidc.claim',
            path: 'email',
          })
        );
    }

    const result = await compare(t, 'set-a', 'set-a2');

    expect(result.status).toBe(200);
    expect(result.json.changes).toContainEqual(
      expect.objectContaining({
        kind: 'type_changed',
        claim: 'email',
        source_types_before: ['email', 'nickname'].map((path, index) => ({
          source: `authrim.profile:${path}`,
          type: before[index],
        })),
        source_types_after: ['email', 'nickname'].map((path, index) => ({
          source: `authrim.profile:${path}`,
          type: after[index],
        })),
      })
    );
    expect(shapeErrors(schemas, schemas.IdentityMappingCompareSetsResponse, result.json)).toEqual(
      []
    );
  });

  it('compares the release scopes and surfaces of the profiles under each set owner', async () => {
    const t = setup();
    t.db.prepare('UPDATE destination_profile_versions SET schema_json = ? WHERE id = ?').run(
      JSON.stringify({
        destinationType: 'oidc',
        claims: [{ claimName: 'email', surfaces: ['userinfo'], requiredScopes: ['profile'] }],
      }),
      'profile-plat-v1'
    );

    const result = await compare(t, 'set-a', 'set-plat');

    expect(result.status).toBe(200);
    expect(result.json.changes).toContainEqual({
      kind: 'profile_field_changed',
      claim: 'email',
      namespace: 'oidc.claim',
      profile_id: 'profile-plat',
      previous_profile_id: 'profile-a',
    });
  });

  it('is 404 for another tenant’s set and for one that does not exist, 400 for a bad ID', async () => {
    const t = setup();
    expect((await compare(t, 'set-a', 'set-other')).status).toBe(404);
    expect((await compare(t, 'set-a', 'set-nothing')).status).toBe(404);
    expect((await t.call(t.admin, 'GET', `${COMPARE}?a=set-a`)).status).toBe(400);
  });

  it('is a read of the settings, declared for GET only', async () => {
    const t = setup();
    const viewer = t.cookie([{ role: 'role_ar_viewer', scope: 'tenant' }]);
    expect((await compare(t, 'set-a', 'set-a2', viewer)).status).toBe(200);
    expect(findAdminRouteAccessRule('GET', COMPARE)?.permissions).toEqual(['admin:settings:read']);
    expect(findAdminRouteAccessRule('GET', COMPARE)?.pattern).toBe(COMPARE);
    expect((await t.call(t.admin, 'POST', COMPARE)).status).toBe(404);
  });
});
