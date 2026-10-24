import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminAuthMiddleware, PLATFORM_MAPPING_TENANT_ID } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
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
import { insertOAuthClient, openCoreDatabase } from './helpers/core-database';
import { seedDestinationProfile, seedMapping } from './helpers/identity-mapping-seed';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';

/**
 * A trial of a choice that is not saved: the answer is the effective endpoint's, before and after,
 * from the same selection. The real admin authentication and route access, the real effective
 * handler to compare with, the real Admin schema and Core `oauth_clients` on SQLite.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const PREVIEW = '/api/admin/identity-mapping/preview-effective';
const COMPARE = '/api/admin/identity-mapping/compare-sets';
const EFFECTIVE = '/api/admin/identity-mapping/effective';
const TENANT_DOC = `settings:tenant:${TENANT}:identity-mapping`;
const PLATFORM_DOC = 'settings:platform:identity-mapping';

function setup() {
  const store = new Map<string, string>();
  const namespace = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
  const core = openCoreDatabase();
  const coreAdapter = sqliteAdapter(core);
  const context = setupApp(
    (app) => {
      app.use('*', async (c, next) => {
        (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
          tenantId: TENANT,
          coreDb: coreAdapter,
          route: {},
        });
        await next();
      });
      app.use(
        '/api/admin/*',
        adminAuthMiddleware({ plane: 'tenant' }),
        enforceDeclaredAdminRouteAccess()
      );
      app.get(EFFECTIVE, adminIdentityMappingEffectiveHandler);
      app.post(PREVIEW, adminIdentityMappingPreviewEffectiveHandler);
      app.get(COMPARE, adminIdentityMappingCompareSetsHandler);
    },
    {
      SETTINGS: namespace,
      AUTHRIM_CONFIG: namespace,
      TEST_CORES: { [TENANT]: coreAdapter },
      BASE_DOMAIN: 'example.com',
      ISSUER_URL: 'https://id.example.com',
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
  const preview = (body: unknown, who = admin) => context.call(who, 'POST', PREVIEW, body);
  const effective = (clientId?: string) =>
    context.call(admin, 'GET', `${EFFECTIVE}${clientId ? `?client_id=${clientId}` : ''}`);
  const app = (clientId: string, identityMapping?: unknown) =>
    insertOAuthClient(core, { tenantId: TENANT, clientId, identityMapping });
  /** Saves a choice for real: the app's row, or the tenant's default. */
  const apply = (proposal: { client?: unknown; tenant_default?: unknown }, clientId?: string) => {
    if (clientId && 'client' in proposal) {
      core
        .prepare('UPDATE oauth_clients SET identity_mapping = ? WHERE client_id = ?')
        .run(proposal.client === null ? null : JSON.stringify(proposal.client), clientId);
    }
    if ('tenant_default' in proposal) {
      if (proposal.tenant_default === null) store.delete(TENANT_DOC);
      else save(TENANT_DOC, { [KEY]: proposal.tenant_default });
    }
  };
  return { ...context, core, store, save, cookie, admin, preview, effective, app, apply };
}

beforeEach(() => {
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
    const schemas = adminOpenApiSchemas();
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
    t.apply({ client: choice }, 'app-1');
    const saved = (await t.effective('app-1')).json;

    // A platform set may not be the choice of an app (backup), so a save would refuse it.
    if (previewed.refusals) {
      expect(previewed.after.selection).toMatchObject({ kind: 'failed', code: 'proposal_refused' });
    } else {
      expect(previewed.after).toEqual(saved);
    }
    expect(previewed.before).toBeDefined();
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
    t.apply({ tenant_default: value });
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
      { tier: 'tenant_default', reason, message: expect.any(String) },
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
    ['a default that is not a set ID', { client_id: 'app-1', proposal: { tenant_default: 5 } }],
    ['a default with spaces', { client_id: 'app-1', proposal: { tenant_default: ' set-a ' } }],
    ['an unknown field', { client_id: 'app-1', proposal: { client: null }, extra: 1 }],
  ])('refuses %s', async (_name, body) => {
    const t = setup();
    t.app('app-1');
    expect((await t.preview(body)).status).toBe(400);
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
      name: 'viewer',
      permissions: ['admin:settings:read'],
      hierarchy: 10,
    });
    const settingsOnly = t.cookie([{ role: 'role_settings_only', scope: 'tenant' }]);
    const viewer = t.cookie([{ role: 'role_viewer', scope: 'tenant' }]);

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
});

describe('a comparison of two sets', () => {
  async function compare(t: ReturnType<typeof setup>, a: string, b: string, who = t.admin) {
    return t.call(who, 'GET', `${COMPARE}?a=${a}&b=${b}`);
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
    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.IdentityMappingCompareSetsResponse, json)).toEqual([]);
  });

  it('is empty for a set against itself', async () => {
    const t = setup();
    expect((await compare(t, 'set-a', 'set-a')).json.changes).toEqual([]);
  });

  it('is 404 for another tenant’s set and for one that does not exist, 400 for a bad ID', async () => {
    const t = setup();
    expect((await compare(t, 'set-a', 'set-other')).status).toBe(404);
    expect((await compare(t, 'set-a', 'set-nothing')).status).toBe(404);
    expect((await t.call(t.admin, 'GET', `${COMPARE}?a=set-a`)).status).toBe(400);
  });

  it('is a read of the settings, declared for GET only', async () => {
    const t = setup();
    const viewer = t.cookie([{ role: 'role_viewer', scope: 'tenant' }]);
    expect((await compare(t, 'set-a', 'set-a2', viewer)).status).toBe(200);
    expect(findAdminRouteAccessRule('GET', COMPARE)?.permissions).toEqual(['admin:settings:read']);
    expect(findAdminRouteAccessRule('POST', COMPARE)).toBeNull();
  });
});
