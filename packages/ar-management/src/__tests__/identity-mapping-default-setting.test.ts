import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import {
  adminAuthMiddleware,
  DISABLED_MARKER,
  PLATFORM_MAPPING_TENANT_ID,
  resolveEffectiveSettingsWithSources,
  type AdminAuthContext,
  type SettingsGetResult,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, createAuditLogFromContext: vi.fn(async () => undefined) };
});

import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import settingsV2, { hasGlobalPlatformSettingsEdit } from '../routes/settings-v2';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  setupApp,
  signIn,
  sqliteAdapter,
  type AdapterHooks,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { seedDestinationProfile, seedMapping } from './helpers/identity-mapping-seed';
import { insertTenant, openCoreDatabase } from './helpers/core-database';

/**
 * The default Mapping Set of the platform and of a tenant (`identity_mapping.oidc_default_set_id`),
 * saved through the real Settings API routes on the real Admin schema: what may be named, what is
 * refused and why, and who may save it where. The release of claims reads the value (see
 * oidc-identity-mapping-explicit-resolution.test.ts in ar-lib-core); these tests are about the save.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const TENANT_URL = `/api/admin/tenants/${TENANT}/settings/identity-mapping`;
const PLATFORM_URL = '/api/admin/platform/settings/identity-mapping';

function kv() {
  const store = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  return {
    store,
    put,
    namespace: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put,
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace,
  };
}

/** The settings routes behind the real admin authentication and the declared route access. */
function setup(options: { agent?: boolean } = {}) {
  const settings = kv();
  const directory = openCoreDatabase();
  insertTenant(directory, TENANT);
  const directoryHooks: AdapterHooks = {};
  const { DB_ADMIN: _loggingAdmin, ...loggingEnv } = logging.env;
  const context = setupApp(
    (app) => {
      app.use(
        '/api/admin/*',
        adminAuthMiddleware({ plane: 'tenant' }),
        async (c, next) => {
          if (options.agent) {
            const authContext = c as unknown as {
              get(key: 'adminAuth'): AdminAuthContext;
              set(key: 'adminAuth', value: AdminAuthContext): void;
            };
            authContext.set('adminAuth', {
              ...authContext.get('adminAuth'),
              actorType: 'agent',
              roles: [],
              globalRoles: [],
              globalPermissions: [],
              tenantScope: [TENANT],
              permissions: ['admin:settings:write'],
            });
          }
          await next();
        },
        enforceDeclaredAdminRouteAccess()
      );
      app.route('/api/admin', settingsV2);
    },
    {
      ...loggingEnv,
      DB: sqliteAdapter(directory, directoryHooks),
      SETTINGS: settings.namespace,
      AUTHRIM_CONFIG: settings.namespace,
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
  // The platform's set and profile; a tenant's own set, profile, and another tenant's.
  seedMapping(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
  seedDestinationProfile(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'profile-plat' });
  seedMapping(context.db, { owner: TENANT, id: 'own' });
  seedDestinationProfile(context.db, { owner: TENANT, id: 'profile-own' });
  seedMapping(context.db, { owner: 'tenant-b', id: 'other' });
  seedDestinationProfile(context.db, { owner: 'tenant-b', id: 'profile-other' });

  const admin = (assignments: Assignment[] = GLOBAL_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const version = async (cookie: string, url: string) =>
    ((await context.call(cookie, 'GET', url)).json as unknown as SettingsGetResult).version;
  /** PATCH with the current version (or the given one). */
  const patch = async (
    cookie: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch?: string
  ) =>
    context.call(cookie, 'PATCH', url, {
      ifMatch: ifMatch ?? (await version(cookie, url)),
      ...body,
    });
  const get = async (cookie: string, url: string) =>
    (await context.call(cookie, 'GET', url)).json as unknown as SettingsGetResult;
  const effective = (tenantId: string) =>
    resolveEffectiveSettingsWithSources(
      { SETTINGS: settings.namespace } as never,
      'identity-mapping',
      { tenantId, fresh: true }
    );
  return { ...context, directory, directoryHooks, settings, admin, version, patch, get, effective };
}

let logging: Awaited<ReturnType<typeof logProducerFixture>>;
afterEach(() => logging?.close());
beforeEach(async () => {
  logging = await logProducerFixture('scheduled');
  vi.mocked(createAuditLogFromContext).mockClear();
});

const auditFailures = () =>
  vi
    .mocked(createAuditLogFromContext)
    .mock.calls.filter(([, action]) => action === 'settings.patch.failure')
    .map(([, , , , details]) => details);

describe('saving a tenant’s default Mapping Set', () => {
  it('saves a set the tenant owns, and a set the platform owns', async () => {
    const t = setup();
    const cookie = t.admin();

    const own = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-own' } });
    expect(own.status).toBe(200);
    expect(own.json.applied).toEqual([KEY]);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBe('set-own');
    expect(await t.effective(TENANT)).toMatchObject({
      values: { [KEY]: 'set-own' },
      sources: { [KEY]: 'kv' },
    });

    const shared = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-plat' } });
    expect(shared.status).toBe(200);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBe('set-plat');
    const history = t.db
      .prepare(
        'SELECT tier,before_json,after_json,via,status,source_version,actor_id FROM identity_mapping_level_history ORDER BY created_at,id'
      )
      .all() as Array<{ after_json: string; source_version: string }>;
    expect(history).toMatchObject([
      {
        tier: 'tenant_default',
        before_json: 'null',
        after_json: '"set-own"',
        via: 'settings',
        status: 'committed',
        actor_id: expect.any(String) as unknown,
      },
      {
        tier: 'tenant_default',
        before_json: '"set-own"',
        after_json: '"set-plat"',
        via: 'settings',
        status: 'committed',
      },
    ]);
    expect(history[1].source_version).toBe(await t.version(cookie, TENANT_URL));
    expect((await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-plat' } })).status).toBe(200);
    expect(
      t.db.prepare('SELECT COUNT(*) AS count FROM identity_mapping_level_history').get()
    ).toEqual({ count: 2 });
  });

  it('saves none without asking the database, and clears back to the platform’s', async () => {
    const t = setup();
    const cookie = t.admin();
    t.hooks.beforeQuery = {
      match: /field_mapping_sets/,
      run: async () => Promise.reject(new Error('d1 down')),
    };

    const refused = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'none' } });

    expect(refused.status).toBe(200);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBe('none');
    const version = await t.version(cookie, TENANT_URL);
    expect((await t.patch(cookie, TENANT_URL, { clear: [KEY] }, version)).status).toBe(200);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBeNull();
  });

  it('shows the platform’s default to a tenant as inherited, and lets the tenant override it', async () => {
    const t = setup();
    const cookie = t.admin();
    expect((await t.patch(cookie, PLATFORM_URL, { set: { [KEY]: 'set-plat' } })).status).toBe(200);

    const inherited = await t.get(cookie, TENANT_URL);
    expect(inherited.values[KEY]).toBe('set-plat');
    expect(inherited.sources[KEY]).toBe('platform');

    expect((await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-own' } })).status).toBe(200);
    const overridden = await t.get(cookie, TENANT_URL);
    expect(overridden.values[KEY]).toBe('set-own');
    expect(overridden.sources[KEY]).toBe('kv');
    expect(overridden.inherited.values[KEY]).toBe('set-plat');
    expect((await t.patch(cookie, TENANT_URL, { clear: [KEY] })).status).toBe(200);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBe('set-plat');
    expect(
      t.db
        .prepare(
          'SELECT before_json,after_json FROM identity_mapping_level_history ORDER BY created_at DESC,id DESC LIMIT 1'
        )
        .get()
    ).toEqual({ before_json: '"set-own"', after_json: 'null' });
    // Another tenant is not affected by this tenant’s choice.
    expect(await t.effective('tenant-b')).toMatchObject({ values: { [KEY]: 'set-plat' } });
  });

  it.each([
    ['another tenant’s set', 'set-other'],
    ['a set that does not exist', 'set-nothing'],
  ])('refuses %s, the same way, and saves nothing', async (_name, setId) => {
    const t = setup();
    const cookie = t.admin();
    const before = await t.version(cookie, TENANT_URL);

    const refused = await t.patch(cookie, TENANT_URL, { set: { [KEY]: setId } });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: 'validation_failed' });
    expect(refused.json.message).toBe(
      `${KEY}: The Mapping Set does not exist or is not available here`
    );
    expect(JSON.stringify(refused.json)).not.toContain('tenant-b');
    expect(await t.version(cookie, TENANT_URL)).toBe(before);
    expect(auditFailures()).toEqual([
      expect.objectContaining({
        category: 'identity-mapping',
        reason: 'identity_mapping_set_missing',
      }),
    ]);
  });

  it.each([
    [
      'a set that is not active',
      "UPDATE field_mapping_sets SET lifecycle_state = 'draft' WHERE id = 'set-own'",
      'identity_mapping_set_inactive',
    ],
    [
      'a set with no active activation',
      "UPDATE field_mapping_activations SET lifecycle_state = 'inactive' WHERE id = 'act-own'",
      'identity_mapping_set_inactive',
    ],
    [
      'a set with no active compiled snapshot',
      "UPDATE compiled_mapping_snapshots SET lifecycle_state = 'superseded' WHERE id = 'snap-own'",
      'identity_mapping_set_inactive',
    ],
    [
      'a set whose Destination Profile is a SAML one',
      "UPDATE destination_profiles SET destination_type = 'saml' WHERE id = 'profile-own'",
      'identity_mapping_destination_profile_invalid',
    ],
    [
      'a set that releases into two Destination Profiles',
      'INSERT INTO mapping_rule_edges (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at) VALUES (\'edge-2\', \'tenant-a\', \'rule-own\', \'{"side":"source","namespace":"authrim.profile","path":"email"}\', \'{"side":"destination","profileId":"profile-two","namespace":"oidc.claim","path":"email"}\', \'direct\', 1, 1, 1)',
      'identity_mapping_destination_profile_invalid',
    ],
  ])('refuses %s', async (_name, sql, reason) => {
    const t = setup();
    const cookie = t.admin();
    t.db.exec(sql);
    const before = await t.version(cookie, TENANT_URL);

    const refused = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-own' } });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: 'validation_failed' });
    expect(await t.version(cookie, TENANT_URL)).toBe(before);
    expect(auditFailures()).toEqual([expect.objectContaining({ reason })]);
  });

  it('refuses a platform set that holds what a platform set may not, even if it was activated', async () => {
    const t = setup();
    const cookie = t.admin();
    t.db.exec(
      `UPDATE mapping_rule_edges SET source_ref_json = '{"side":"source","namespace":"authrim.custom_claims","path":"tier"}' WHERE tenant_id = 'platform'`
    );

    for (const url of [TENANT_URL, PLATFORM_URL]) {
      const refused = await t.patch(cookie, url, { set: { [KEY]: 'set-plat' } });
      expect(refused.status, url).toBe(400);
      expect(refused.json.message, url).toMatch(
        /platform mapping cannot read a tenant-defined field/
      );
    }
    expect(auditFailures().map((entry) => entry.reason)).toEqual([
      'identity_mapping_platform_set_unsafe',
      'identity_mapping_platform_set_unsafe',
    ]);
  });

  it('answers 503 and saves nothing when the Admin database cannot answer', async () => {
    const t = setup();
    const cookie = t.admin();
    const before = await t.version(cookie, TENANT_URL);
    t.hooks.beforeQuery = {
      match: /FROM field_mapping_sets/,
      run: async () => Promise.reject(new Error('D1_ERROR: database_timeout')),
    };

    const refused = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-own' } }, before);

    expect(refused.status).toBe(503);
    expect(refused.json).toMatchObject({ error: 'temporarily_unavailable' });
    expect(await t.version(cookie, TENANT_URL)).toBe(before);
    expect(auditFailures()).toEqual([
      expect.objectContaining({ reason: 'identity_mapping_admin_database_unavailable' }),
    ]);
  });

  it.each([
    ['empty', ''],
    ['padded', ' set-own'],
    ['uppercase none', 'NONE'],
    ['a malformed ID', 'set/own'],
    ['over 200 characters', 'x'.repeat(201)],
    ['false', false],
    ['true', true],
    ['null', null],
    ['a number', 7],
    ['an object', { id: 'set-own' }],
    ['the disabled marker', DISABLED_MARKER],
  ])('refuses %s as the value, before looking at the database', async (_name, value) => {
    const t = setup();
    const cookie = t.admin();
    const before = await t.version(cookie, TENANT_URL);
    t.hooks.beforeQuery = {
      match: /field_mapping_sets/,
      run: async () => Promise.reject(new Error('not reached')),
    };

    const refused = await t.patch(cookie, TENANT_URL, { set: { [KEY]: value } });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: 'validation_failed' });
    expect(await t.version(cookie, TENANT_URL)).toBe(before);
  });

  it('refuses to disable the key, with a message that points at clearing it', async () => {
    const t = setup();
    const cookie = t.admin();

    const refused = await t.patch(cookie, TENANT_URL, { disable: [KEY] });

    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/cannot be disabled/);
    // Not even next to a valid change.
    const mixed = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'none' }, disable: [KEY] });
    expect(mixed.status).toBe(400);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBeNull();
  });

  it('refuses a key the category does not have', async () => {
    const t = setup();
    const refused = await t.patch(t.admin(), TENANT_URL, {
      set: { 'identity_mapping.saml_default_set_id': 'set-own' },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/is not a identity mapping setting/);
  });

  it('refuses the retired shadow comparison switch, at the platform and at a tenant', async () => {
    const t = setup();
    const cookie = t.admin();
    for (const url of [TENANT_URL, PLATFORM_URL]) {
      const refused = await t.patch(cookie, url, {
        set: { 'identity_mapping.shadow_compare_enabled': true },
      });
      expect(refused.status, url).toBe(400);
      expect(refused.json.message).toMatch(/is not a identity mapping setting/);
    }
  });

  it('is not available for an app', async () => {
    const t = setup();
    const refused = await t.patch(t.admin(), '/api/admin/clients/app-1/settings/identity-mapping', {
      set: { [KEY]: 'set-own' },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/does not support client-level settings/);
  });

  it('cannot be rolled back or read from the settings history, which would skip the check', async () => {
    const t = setup();
    const cookie = t.admin();
    for (const [method, path, body] of [
      ['POST', '/api/admin/settings/identity-mapping/rollback', { targetVersion: 1 }],
      ['GET', '/api/admin/settings/identity-mapping/history', undefined],
      ['GET', '/api/admin/settings/identity-mapping/history/1', undefined],
    ] as const) {
      const response = await t.call(cookie, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(response.json.error_description, path).toMatch(/Invalid category/);
    }
  });

  it('keeps the settings version check: a stale version is a conflict, with nothing saved', async () => {
    const t = setup();
    const cookie = t.admin();
    const stale = await t.version(cookie, TENANT_URL);
    expect((await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-own' } })).status).toBe(200);

    const conflict = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'none' } }, stale);

    expect(conflict.status).toBe(409);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBe('set-own');
  });
});

describe('saving the platform’s default Mapping Set', () => {
  it('saves a set the platform owns', async () => {
    const t = setup();
    const cookie = t.admin();

    const saved = await t.patch(cookie, PLATFORM_URL, { set: { [KEY]: 'set-plat' } });

    expect(saved.status).toBe(200);
    expect(saved.json.applied).toEqual([KEY]);
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBe('set-plat');
    expect(await t.effective(TENANT)).toMatchObject({
      values: { [KEY]: 'set-plat' },
      sources: { [KEY]: 'platform' },
    });
  });

  it('refuses none: the platform has nothing above it, so no default is an unset key', async () => {
    const t = setup();
    const cookie = t.admin();

    const refused = await t.patch(cookie, PLATFORM_URL, { set: { [KEY]: 'none' } });

    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/cannot be none for the platform/);
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBeNull();
    // Clearing is how the platform says it.
    expect((await t.patch(cookie, PLATFORM_URL, { set: { [KEY]: 'set-plat' } })).status).toBe(200);
    const cleared = await t.patch(cookie, PLATFORM_URL, { clear: [KEY] });
    expect(cleared.status).toBe(200);
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBeNull();
  });

  it.each([
    ['a tenant’s own set', 'set-own'],
    ['another tenant’s set', 'set-other'],
    ['a set that does not exist', 'set-nothing'],
  ])('refuses %s, as if it did not exist', async (_name, setId) => {
    const t = setup();
    const cookie = t.admin();

    const refused = await t.patch(cookie, PLATFORM_URL, { set: { [KEY]: setId } });

    expect(refused.status).toBe(400);
    expect(refused.json.message).toBe(
      `${KEY}: The Mapping Set does not exist or is not available here`
    );
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBeNull();
    expect(auditFailures()).toEqual([
      expect.objectContaining({
        scope: 'platform',
        category: 'identity-mapping',
        reason: 'identity_mapping_set_missing',
      }),
    ]);
  });

  it('refuses the disabled marker, a disable of the key, and values that are not IDs', async () => {
    const t = setup();
    const cookie = t.admin();
    for (const body of [
      { set: { [KEY]: DISABLED_MARKER } },
      { set: { [KEY]: false } },
      { set: { [KEY]: null } },
      { set: { [KEY]: '' } },
      { disable: [KEY] },
    ]) {
      const refused = await t.patch(cookie, PLATFORM_URL, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBeNull();
  });

  it('answers 503 and saves nothing when the Admin database cannot answer', async () => {
    const t = setup();
    const cookie = t.admin();
    t.hooks.beforeQuery = {
      match: /FROM field_mapping_sets/,
      run: async () => Promise.reject(new Error('database_timeout')),
    };
    const refused = await t.patch(cookie, PLATFORM_URL, { set: { [KEY]: 'set-plat' } });
    expect(refused.status).toBe(503);
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBeNull();
  });
});

describe('platform preview guards', () => {
  const snapshot = (t: ReturnType<typeof setup>) => ({
    canonical: t.db.prepare('SELECT * FROM platform_settings_documents').all(),
    kv: [...t.settings.store],
    puts: t.settings.put.mock.calls.length,
  });

  it('accepts expected_version alone as the existing CAS version', async () => {
    const t = setup();
    const cookie = t.admin();
    const expectedVersion = await t.version(cookie, PLATFORM_URL);

    const saved = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      expected_version: expectedVersion,
      set: { [KEY]: 'set-plat' },
    });

    expect(saved.status).toBe(200);
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBe('set-plat');
  });

  it('rejects conflicting version aliases without changing the canonical document or KV', async () => {
    const t = setup();
    const cookie = t.admin();
    const ifMatch = await t.version(cookie, PLATFORM_URL);
    const before = t.db.prepare('SELECT * FROM platform_settings_documents').all();
    const beforeKV = [...t.settings.store];

    const refused = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      ifMatch,
      expected_version: 'different-version',
      set: { [KEY]: 'set-plat' },
    });

    expect(refused.status).toBe(400);
    expect(t.db.prepare('SELECT * FROM platform_settings_documents').all()).toEqual(before);
    expect([...t.settings.store]).toEqual(beforeKV);
  });

  it('accepts matching aliases and still rejects a stale version with the existing CAS', async () => {
    const t = setup();
    const cookie = t.admin();
    const expectedVersion = await t.version(cookie, PLATFORM_URL);
    const body = {
      ifMatch: expectedVersion,
      expected_version: expectedVersion,
      expected_following: 1,
      set: { [KEY]: 'set-plat' },
    };
    expect((await t.call(cookie, 'PATCH', PLATFORM_URL, body)).status).toBe(200);
    const before = snapshot(t);

    const refused = await t.call(cookie, 'PATCH', PLATFORM_URL, body);

    expect(refused.status).toBe(409);
    expect(refused.json.currentVersion).toBe(await t.version(cookie, PLATFORM_URL));
    expect(snapshot(t)).toEqual(before);
  });

  it.each([
    ['negative', -1],
    ['fraction', 0.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['string', '1'],
    ['null', null],
    ['array', []],
    ['object', {}],
    ['boolean', false],
  ])('refuses a %s expected_following before any settings write', async (_name, value) => {
    const t = setup();
    const cookie = t.admin();
    const version = await t.version(cookie, PLATFORM_URL);
    const before = snapshot(t);

    const refused = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      expected_version: version,
      expected_following: value,
      clear: [KEY],
    });

    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/expected_following/);
    expect(snapshot(t)).toEqual(before);
    expect(auditFailures()).toEqual([
      expect.objectContaining({ reason: 'platform_patch_guard_invalid' }),
    ]);
  });

  it.each([null, [], 'body', 42, false])(
    'rejects a non-object body %j without bootstrapping',
    async (body) => {
      const t = setup();
      const before = snapshot(t);

      const refused = await t.call(t.admin(), 'PATCH', PLATFORM_URL, body);

      expect(refused.status).toBe(400);
      expect(refused.json.message).toMatch(/body must be an object/);
      expect(snapshot(t)).toEqual(before);
    }
  );

  it('requires a default set/clear when a following-count guard is supplied', async () => {
    const t = setup();
    const cookie = t.admin();
    const version = await t.version(cookie, PLATFORM_URL);
    const before = snapshot(t);
    for (const body of [
      { expected_version: version, expected_following: 1 },
      { ifMatch: version, expected_following: 1 },
      {
        expected_version: version,
        expected_following: 1,
        set: { 'identity_mapping.reference_display_limit': 50 },
      },
      { expected_version: version, expected_following: 1, disable: [KEY] },
    ]) {
      expect((await t.call(cookie, 'PATCH', PLATFORM_URL, body)).status).toBe(400);
      expect(snapshot(t)).toEqual(before);
    }
  });

  it('uses expected_version as an ordinary CAS alias for another setting in the same category', async () => {
    const t = setup();
    const cookie = t.admin();
    const version = await t.version(cookie, PLATFORM_URL);
    const scanKey = 'identity_mapping.reference_display_limit';

    const saved = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      expected_version: version,
      set: { [scanKey]: 50 },
    });

    expect(saved.status).toBe(200);
    expect(saved.json.applied).toEqual([scanKey]);
    expect((await t.get(cookie, PLATFORM_URL)).values).toMatchObject({
      [KEY]: null,
      [scanKey]: 50,
    });
  });

  it('keeps the existing disable validation when only the version alias is used', async () => {
    const t = setup();
    const cookie = t.admin();
    const version = await t.version(cookie, PLATFORM_URL);
    const before = snapshot(t);

    const refused = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      expected_version: version,
      disable: [KEY],
    });

    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/cannot be disabled/);
    expect(snapshot(t)).toEqual(before);
  });

  it('rejects reserved preview guards on other categories and keeps their existing ifMatch path', async () => {
    const t = setup();
    const cookie = t.admin();
    const url = '/api/admin/platform/settings/log-storage';
    const ifMatch = await t.version(cookie, url);
    const before = snapshot(t);
    for (const guard of [{ expected_version: ifMatch }, { expected_following: 0 }]) {
      const refused = await t.call(cookie, 'PATCH', url, { ifMatch, ...guard });
      expect(refused.status).toBe(400);
      expect(refused.json.message).toMatch(/only supported for identity-mapping/);
      expect(snapshot(t)).toEqual(before);
    }
    expect((await t.call(cookie, 'PATCH', url, { ifMatch })).status).toBe(200);
  });

  it('accepts expected_following zero when every tenant has its own choice, including the same ID', async () => {
    const t = setup();
    const cookie = t.admin();
    t.settings.store.set(
      `settings:tenant:${TENANT}:identity-mapping`,
      JSON.stringify({ [KEY]: 'set-plat' })
    );
    const version = await t.version(cookie, PLATFORM_URL);

    const saved = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      expected_version: version,
      expected_following: 0,
      set: { [KEY]: 'set-plat' },
    });

    expect(saved.status).toBe(200);
    expect((await t.get(cookie, PLATFORM_URL)).values[KEY]).toBe('set-plat');
  });

  it('recounts fresh tenant relations after preview, without reading the tenant app database', async () => {
    const t = setup();
    const cookie = t.admin();
    const version = await t.version(cookie, PLATFORM_URL);
    t.directoryHooks.beforeQuery = {
      match: /oauth_clients/,
      run: async () => Promise.reject(new Error('the save guard must not read apps')),
    };
    // The preview saw one following tenant; its later opt-out does not change the platform version.
    t.settings.store.set(
      `settings:tenant:${TENANT}:identity-mapping`,
      JSON.stringify({ [KEY]: 'none' })
    );
    const before = snapshot(t);

    const refused = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      expected_version: version,
      expected_following: 1,
      set: { [KEY]: 'set-plat' },
    });

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ expected_following: 1, current_following: 0 });
    expect(snapshot(t)).toEqual(before);
    expect(auditFailures()).toEqual([
      expect.objectContaining({
        reason: 'identity_mapping_following_conflict',
        expected_following: 1,
        current_following: 0,
      }),
    ]);
  });

  it('does not bootstrap a missing canonical document on a following-count conflict', async () => {
    const t = setup();
    const before = snapshot(t);

    const refused = await t.call(t.admin(), 'PATCH', PLATFORM_URL, {
      ifMatch: 'not-read-yet',
      expected_following: 0,
      clear: [KEY],
    });

    expect(refused.status).toBe(409);
    expect(snapshot(t)).toEqual(before);
  });

  it.each(['unreadable', 'invalid', 'directory failure', 'over budget'] as const)(
    'fails closed for %s tenant relations',
    async (mode) => {
      const t = setup();
      const cookie = t.admin();
      const version = await t.version(cookie, PLATFORM_URL);
      if (mode === 'over budget') {
        for (let index = 0; index < 100; index += 1) insertTenant(t.directory, `extra-${index}`);
      } else if (mode === 'directory failure') {
        t.directoryHooks.beforeQuery = {
          match: /FROM tenants/,
          run: async () => Promise.reject(new Error('directory unavailable')),
        };
      } else {
        t.settings.store.set(
          `settings:tenant:${TENANT}:identity-mapping`,
          mode === 'unreadable' ? '[' : JSON.stringify({ [KEY]: 42 })
        );
      }
      const before = snapshot(t);

      const refused = await t.call(cookie, 'PATCH', PLATFORM_URL, {
        expected_version: version,
        expected_following: 1,
        set: { [KEY]: 'set-plat' },
      });

      expect(refused.status).toBe(503);
      expect(refused.json.error).toBe('temporarily_unavailable');
      expect(snapshot(t)).toEqual(before);
      expect(auditFailures()).toEqual([
        expect.objectContaining({ reason: 'identity_mapping_following_unavailable' }),
      ]);
    }
  );

  it('keeps the platform role policy when preview guards are present', async () => {
    const t = setup();
    const version = await t.version(t.admin(), PLATFORM_URL);
    const before = snapshot(t);

    const refused = await t.call(t.admin(TENANT_SUPER_ADMIN), 'PATCH', PLATFORM_URL, {
      expected_version: version,
      expected_following: 1,
      set: { [KEY]: 'set-plat' },
    });

    expect(refused.status).toBe(403);
    expect(snapshot(t)).toEqual(before);
  });

  it('does not let an Agent use a preview guard to enter the platform save route', async () => {
    const t = setup({ agent: true });
    const before = snapshot(t);

    const refused = await t.call(t.admin(), 'PATCH', PLATFORM_URL, {
      expected_version: 'not-authorized',
      expected_following: 1,
      set: { [KEY]: 'set-plat' },
    });

    expect(refused.status).toBe(403);
    expect(snapshot(t)).toEqual(before);
  });
});

describe('who may save a default Mapping Set where', () => {
  const kinds: Array<{ name: string; assignments: Assignment[]; outcome: 'allowed' | 'denied' }> = [
    { name: 'a global ar_super_admin', assignments: GLOBAL_SUPER_ADMIN, outcome: 'allowed' },
    {
      name: 'a ar_super_admin limited to one tenant',
      assignments: TENANT_SUPER_ADMIN,
      outcome: 'denied',
    },
    {
      name: 'a global viewer who is also a tenant ar_super_admin',
      assignments: GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
      outcome: 'denied',
    },
    {
      name: 'a global viewer',
      assignments: [{ role: 'role_ar_viewer', scope: 'global' }],
      outcome: 'denied',
    },
    {
      name: 'a viewer of one tenant',
      assignments: [{ role: 'role_ar_viewer', scope: 'tenant' }],
      outcome: 'denied',
    },
  ];

  it.each(kinds)('platform scope: $name is $outcome', async ({ assignments, outcome }) => {
    const t = setup();
    const cookie = t.admin(assignments);
    const version = (await t.get(t.admin(), PLATFORM_URL)).version;

    const response = await t.call(cookie, 'PATCH', PLATFORM_URL, {
      ifMatch: version,
      set: { [KEY]: 'set-plat' },
    });

    if (outcome === 'allowed') {
      expect(response.status).toBe(200);
      expect((await t.get(t.admin(), PLATFORM_URL)).values[KEY]).toBe('set-plat');
    } else {
      expect(response.status).toBe(403);
      expect((await t.get(t.admin(), PLATFORM_URL)).values[KEY]).toBeNull();
      expect(await t.effective(TENANT)).toMatchObject({ sources: { [KEY]: 'default' } });
    }
  });

  it('still lets a ar_super_admin limited to the tenant save the tenant’s own default', async () => {
    const t = setup();
    const cookie = t.admin(TENANT_SUPER_ADMIN);

    const own = await t.patch(cookie, TENANT_URL, { set: { [KEY]: 'set-own' } });

    expect(own.status).toBe(200);
    expect((await t.get(cookie, TENANT_URL)).values[KEY]).toBe('set-own');
    // But what every tenant inherits is not theirs to change.
    expect((await t.patch(cookie, PLATFORM_URL, { set: { [KEY]: 'set-plat' } })).status).toBe(403);
  });
});

describe('the authority to edit a platform category', () => {
  const auth = (overrides: Record<string, unknown>) =>
    ({ userId: 'admin', authMethod: 'session', roles: [], ...overrides }) as never;

  it('asks for a platform role held through a global assignment, and a global tenant scope', () => {
    expect(
      hasGlobalPlatformSettingsEdit(
        auth({ roles: ['ar_super_admin'], globalRoles: ['ar_super_admin'], tenantScope: ['*'] }),
        'identity-mapping'
      )
    ).toBe(true);
    expect(
      hasGlobalPlatformSettingsEdit(
        auth({ roles: ['ar_super_admin'], globalRoles: ['ar_super_admin'], tenantScope: ['*'] }),
        'identity-mapping'
      )
    ).toBe(true);
    // The role is only held for a tenant: it is in `roles`, not in `globalRoles`.
    expect(
      hasGlobalPlatformSettingsEdit(
        auth({ roles: ['ar_super_admin'], globalRoles: [], tenantScope: ['tenant-a'] }),
        'identity-mapping'
      )
    ).toBe(false);
    // Roles without a global scope, or none of the roles that may edit, are not enough.
    expect(
      hasGlobalPlatformSettingsEdit(
        auth({
          roles: ['ar_super_admin'],
          globalRoles: ['ar_super_admin'],
          tenantScope: ['tenant-a'],
        }),
        'identity-mapping'
      )
    ).toBe(false);
    expect(
      hasGlobalPlatformSettingsEdit(
        auth({ roles: ['viewer'], globalRoles: ['viewer'], tenantScope: ['*'] }),
        'identity-mapping'
      )
    ).toBe(false);
    expect(hasGlobalPlatformSettingsEdit(undefined, 'identity-mapping')).toBe(false);
    // An older context without the global fields is refused, not read from `roles`.
    expect(
      hasGlobalPlatformSettingsEdit(auth({ roles: ['ar_super_admin'] }), 'identity-mapping')
    ).toBe(false);
  });

  describe('a machine token', () => {
    const machine = (overrides: Record<string, unknown>) =>
      auth({
        authMethod: 'machine_access_token',
        actorType: 'machine',
        roles: [],
        globalRoles: [],
        ...overrides,
      });

    it('may edit when its scope is global and it holds the settings write permission', () => {
      expect(
        hasGlobalPlatformSettingsEdit(
          machine({
            tenantScope: ['*'],
            permissions: ['admin:settings:write'],
            globalPermissions: ['admin:settings:write'],
          }),
          'identity-mapping'
        )
      ).toBe(true);
      // The wildcard covers it.
      expect(
        hasGlobalPlatformSettingsEdit(
          machine({ tenantScope: ['*'], permissions: ['*'], globalPermissions: ['*'] }),
          'identity-mapping'
        )
      ).toBe(true);
    });

    it.each([
      [
        'global scope without the permission',
        {
          tenantScope: ['*'],
          permissions: ['admin:settings:read'],
          globalPermissions: ['admin:settings:read'],
        },
      ],
      [
        'global scope with no permission at all',
        { tenantScope: ['*'], permissions: [], globalPermissions: [] },
      ],
      [
        'the permission but limited to some tenants',
        {
          tenantScope: ['tenant-a'],
          permissions: ['admin:settings:write'],
          globalPermissions: [],
        },
      ],
      [
        'the permission for a tenant only, next to a global scope',
        { tenantScope: ['*'], permissions: ['admin:settings:write'], globalPermissions: [] },
      ],
    ])('may not edit with %s', (_name, overrides) => {
      expect(hasGlobalPlatformSettingsEdit(machine(overrides), 'identity-mapping')).toBe(false);
    });

    it('is not let in by a role name it does not have', () => {
      expect(
        hasGlobalPlatformSettingsEdit(
          machine({
            tenantScope: ['*'],
            roles: ['ar_super_admin'],
            globalRoles: ['ar_super_admin'],
          }),
          'identity-mapping'
        )
      ).toBe(false);
    });
  });
});
