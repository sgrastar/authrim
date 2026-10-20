import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_CATEGORY_META,
  adminAuthMiddleware,
  PLATFORM_MAPPING_TENANT_ID,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: vi.fn(async () => undefined),
    bulkApplyKeyVerdict: vi.fn(actual.bulkApplyKeyVerdict),
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
vi.mock('../tenant-backup-writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tenant-backup-writer')>();
  return {
    ...actual,
    runTenantBackupCoveredMutation: vi.fn(actual.runTenantBackupCoveredMutation),
  };
});
vi.mock('../external-plugin-gate-sync', () => ({
  setRunnerExternalGate: vi.fn(async () => undefined),
  reconcileRunnerExternalGate: vi.fn(async () => undefined),
}));

import { bulkApplyKeyVerdict, createAuditLogFromContext } from '@authrim/ar-lib-core';
import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import { setRunnerExternalGate } from '../external-plugin-gate-sync';
import {
  bulkApplyImpactProviders,
  registerBulkApplyImpactProvider,
} from '../routes/settings-v2/bulk-apply-impact';
import settingsV2 from '../routes/settings-v2';
import { estimateResponseBytes } from '../routes/settings-v2/bulk-apply-size';
import { runTenantBackupCoveredMutation } from '../tenant-backup-writer';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  createTokenKit,
  setupApp,
  signIn,
  sqliteAdapter,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';
import { seedDestinationProfile, seedMapping } from './helpers/identity-mapping-seed';

/**
 * The bulk apply of settings (POST /api/admin/settings/bulk-apply) on the real Admin schema, the
 * real admin authentication and route access, and the real Settings API: who may use it, that a
 * preview writes nothing and says what an apply does, that tenants are applied independently, and
 * that the same checks as a PATCH stand in front of every write.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const BULK = '/api/admin/settings/bulk-apply';
const MAPPING_KEY = 'identity_mapping.oidc_default_set_id';
const TTL = 'session.default_ttl';
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d'];
/** Only in the tenant directory: more tenants than are worked on at once. */
const MORE_TENANTS = ['tenant-e', 'tenant-f', 'tenant-g'];
/** Thirty tenants that exist, for a request as large as the default limit allows. */
/** A hundred tenants whose IDs are as long as an ID can be (128 characters). */
const LONG_TENANTS = Array.from({ length: 100 }, (_, i) =>
  `long-${String(i).padStart(3, '0')}-`.padEnd(128, 'z')
);
const BULK_TENANTS = Array.from({ length: 30 }, (_, i) => `bulk-${String(i + 1).padStart(2, '0')}`);
const SETTINGS_MIGRATIONS = [
  '028_tenant_settings_documents.sql',
  '038_tenant_settings_reconciled_at.sql',
  '039_platform_settings_documents.sql',
  '040_settings_legacy_import_state.sql',
];

function kv() {
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

let sequence = 0;
const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

async function setup(env: Record<string, unknown> = {}) {
  const kit = await createTokenKit('https://tenant-a.example.com');
  const cores: Record<string, ReturnType<typeof openCoreDatabase>> = {};
  for (const id of ['tenant-a', 'tenant-b', 'tenant-d']) cores[id] = openCoreDatabase();
  insertTenant(cores['tenant-a'], 'tenant-a');
  const adapters = Object.fromEntries(
    Object.entries(cores).map(([id, db]) => [id, sqliteAdapter(db)])
  );
  const directory = openCoreDatabase();
  for (const id of [...TENANTS, ...MORE_TENANTS, ...BULK_TENANTS, ...LONG_TENANTS, 'tenant-gone']) {
    insertTenant(directory, id);
  }
  directory.exec("UPDATE tenants SET lifecycle_state = 'deleted' WHERE id = 'tenant-gone'");
  const settings = kv();

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
      // A test can narrow what the signed-in caller holds after the real authentication, to reach
      // checks that the real contexts never fail (the entrance and the tenant right differ).
      app.use(BULK, async (c, next) => {
        const how = c.req.header('x-test-narrow');
        const get = c as unknown as { get(k: string): any; set(k: string, v: unknown): void };
        const auth = get.get('adminAuth');
        if (how === 'roles') get.set('adminAuth', { ...auth, roles: ['viewer'] });
        if (how === 'agent') get.set('adminAuth', { ...auth, actorType: 'agent' });
        await next();
      });
      app.route('/api/admin', settingsV2);
    },
    {
      DB: sqliteAdapter(directory),
      SETTINGS: settings.namespace,
      AUTHRIM_CONFIG: settings.namespace,
      TEST_CORES: adapters,
      BASE_DOMAIN: 'example.com',
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
      ...kit.env,
      ...env,
    }
  );
  for (const file of SETTINGS_MIGRATIONS) {
    context.db.exec(readFileSync(resolve(REPO_ROOT, `migrations/admin/d1/${file}`), 'utf8'));
  }
  seedMapping(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
  seedDestinationProfile(context.db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'profile-plat' });
  seedMapping(context.db, { owner: 'tenant-a', id: 'a1' });
  seedDestinationProfile(context.db, { owner: 'tenant-a', id: 'profile-a1' });
  seedMapping(context.db, { owner: 'tenant-b', id: 'b1' });
  seedDestinationProfile(context.db, { owner: 'tenant-b', id: 'profile-b1' });

  const cookie = (assignments: Assignment[] = GLOBAL_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const admin = cookie();
  const bulk = (
    who: string,
    body: unknown,
    options: { key?: string | null; headers?: Record<string, string> } = {}
  ) => {
    sequence += 1;
    const headers: Record<string, string> = { ...options.headers };
    if (options.key !== null) headers['Idempotency-Key'] = options.key ?? `bulk-key-${sequence}`;
    return context.call(who, 'POST', BULK, body, headers);
  };
  const bulkAsToken = (token: string, body: unknown) => {
    sequence += 1;
    return context.callWithToken(token, 'POST', BULK, body, {
      'Idempotency-Key': `bulk-token-key-${sequence}`,
    });
  };
  const doc = async (tenantId: string, category: string) =>
    (await context.call(admin, 'GET', `/api/admin/tenants/${tenantId}/settings/${category}`)).json;
  const own = async (tenantId: string, category: string, key: string) => {
    const d = await doc(tenantId, category);
    return d.sources[key] === 'kv' ? d.values[key] : undefined;
  };
  /** The tenant's own value, saved through its PATCH: a tenant that already decided. */
  const seed = async (tenantId: string, category: string, set: Record<string, unknown>) => {
    const d = await doc(tenantId, category);
    const saved = await context.call(
      admin,
      'PATCH',
      `/api/admin/tenants/${tenantId}/settings/${category}`,
      { ifMatch: d.version, set }
    );
    expect(saved.status).toBe(200);
  };
  const versions = async () =>
    Object.fromEntries(
      await Promise.all(
        TENANTS.flatMap((id) =>
          ['session', 'oauth', 'identity-mapping'].map(async (category) => [
            `${id}/${category}`,
            (await doc(id, category)).version as string,
          ])
        )
      )
    );
  const rows = (sql: string) => (context.db.prepare(sql).get() as { n: number }).n;
  /** Every saved settings document and KV copy, exactly as stored (no reads that would create one). */
  const snapshot = () => ({
    documents: context.db
      .prepare(
        // A read makes a tenant's empty document the first time; what a write leaves is not empty.
        "SELECT tenant_id, scope_id, category, version, revision, document_json FROM tenant_settings_documents WHERE document_json <> '{}' ORDER BY 1, 2, 3"
      )
      .all(),
    kv: [...settings.store.entries()].filter(([, value]) => value !== '{}').sort(),
  });
  const principal = (permissions: string[], scope: 'all' | 'allow') => {
    sequence += 1;
    const now = Date.now();
    const id = `amp_bulk_${sequence}`;
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'Bulk', 'automation', 'active', 'authrim:admin-api', 600, ?, ?)`
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
  return {
    ...context,
    cores,
    settings,
    admin,
    cookie,
    bulk,
    bulkAsToken,
    doc,
    own,
    seed,
    versions,
    rows,
    snapshot,
    principal,
  };
}

const audits = (action: string) =>
  vi
    .mocked(createAuditLogFromContext)
    .mock.calls.filter(([, name]) => name === action)
    .map(([, , , resourceId, metadata]) => ({ resourceId, metadata }));

beforeEach(() => {
  vi.mocked(createAuditLogFromContext).mockClear();
  vi.mocked(setRunnerExternalGate).mockClear();
  vi.mocked(runTenantBackupCoveredMutation).mockClear();
});

const ttl = (value: unknown, extra: Record<string, unknown> = {}) => ({
  category: 'session',
  set: { [TTL]: value },
  ...extra,
});
const request = (overrides: Record<string, unknown> = {}) => ({
  mode: 'apply',
  tenant_ids: ['tenant-a', 'tenant-b'],
  changes: [ttl(7200000)],
  ...overrides,
});
const resultFor = (json: Record<string, any>, tenantId: string) =>
  (json.results as Array<Record<string, any>>).find((r) => r.tenant_id === tenantId)!;

// ---------------------------------------------------------------------------------------------

describe('who may use the bulk apply', () => {
  const kinds: Array<{ name: string; assignments: Assignment[]; outcome: 'allowed' | 'denied' }> = [
    { name: 'a global super_admin', assignments: GLOBAL_SUPER_ADMIN, outcome: 'allowed' },
    {
      name: 'a super_admin limited to one tenant',
      assignments: TENANT_SUPER_ADMIN,
      outcome: 'denied',
    },
    {
      name: 'a global viewer who is also a tenant super_admin',
      assignments: GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
      outcome: 'denied',
    },
    {
      name: 'a global viewer',
      assignments: [{ role: 'role_viewer', scope: 'global' }],
      outcome: 'denied',
    },
    {
      name: 'a viewer of one tenant',
      assignments: [{ role: 'role_viewer', scope: 'tenant' }],
      outcome: 'denied',
    },
  ];

  it.each(kinds)(
    '$name is $outcome, for a preview and for an apply',
    async ({ assignments, outcome }) => {
      const t = await setup();
      const who = t.cookie(assignments);
      for (const mode of ['preview', 'apply']) {
        await t.versions();
        const before = t.snapshot();
        const response = await t.bulk(who, request({ mode }));
        if (outcome === 'allowed') {
          expect(response.status, mode).toBe(200);
        } else {
          expect(response.status, mode).toBe(403);
          // Nothing was written, and the refused call left no idempotency record behind.
          expect(t.snapshot()).toEqual(before);
          expect(
            (
              t.cores['tenant-a'].prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as {
                n: number;
              }
            ).n
          ).toBe(0);
        }
      }
    }
  );

  it('lets a machine token for every tenant with the settings write permission in', async () => {
    const t = await setup();
    const token = await t.principal(['admin:settings:write'], 'all');
    const response = await t.bulkAsToken(token, request());
    expect(response.status).toBe(200);
    // It reaches tenants other than the one the request arrived on.
    expect(resultFor(response.json, 'tenant-b').status).toBe('applied');
    expect(await t.own('tenant-b', 'session', TTL)).toBe(7200000);
  });

  it.each([
    ['every tenant but only the read permission', ['admin:settings:read'], 'all'],
    ['every tenant but a permission that is not for settings', ['admin:users:write'], 'all'],
    ['the settings write permission but only some tenants', ['admin:settings:write'], 'allow'],
  ] as const)('refuses a machine token with %s', async (_name, permissions, scope) => {
    const t = await setup();
    const token = await t.principal([...permissions], scope);
    const response = await t.bulkAsToken(token, request());
    expect(response.status).toBe(403);
    expect(await t.own('tenant-a', 'session', TTL)).toBeUndefined();
  });

  it('asks again, for each tenant, for the right to edit its settings', async () => {
    const t = await setup();
    // The entrance passes (the platform authority is held) but the tenant right is not.
    const response = await t.bulk(t.admin, request(), { headers: { 'x-test-narrow': 'roles' } });
    expect(response.status).toBe(200);
    for (const id of ['tenant-a', 'tenant-b']) {
      expect(resultFor(response.json, id)).toMatchObject({
        status: 'rejected',
        changes: [{ status: 'rejected', reason: 'forbidden' }],
      });
    }
    expect(await t.own('tenant-a', 'session', TTL)).toBeUndefined();
    expect(await t.own('tenant-b', 'session', TTL)).toBeUndefined();
  });

  it('does not show a tenant’s values to a caller who may not edit them, in a preview either', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });
    const response = await t.bulk(t.admin, request({ mode: 'preview' }), {
      headers: { 'x-test-narrow': 'roles' },
    });
    expect(response.status).toBe(200);
    for (const id of ['tenant-a', 'tenant-b']) {
      expect(resultFor(response.json, id).changes).toEqual([
        expect.objectContaining({ action: 'would_reject', reason: 'forbidden', current: null }),
      ]);
    }
    expect(JSON.stringify(response.json)).not.toContain('1800000');
  });

  it('never lets an Agent in: its settings writes need an approval for each Tool call', async () => {
    const t = await setup();
    const response = await t.bulk(t.admin, request(), { headers: { 'x-test-narrow': 'agent' } });
    expect(response.status).toBe(403);
    expect(await t.own('tenant-a', 'session', TTL)).toBeUndefined();
  });

  it('is declared in the route access rules, for the platform administrators', async () => {
    const { findAdminRouteAccessRule } = await import('../admin-route-access');
    expect(findAdminRouteAccessRule('POST', BULK)).toMatchObject({
      permissions: ['admin:settings:write'],
      roles: ['super_admin', 'system_admin'],
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('the request', () => {
  it('needs an Idempotency-Key', async () => {
    const t = await setup();
    const response = await t.bulk(t.admin, request(), { key: null });
    expect(response.status).toBe(400);
    expect(response.json.error_description).toMatch(/Idempotency-Key/);
  });

  it.each([
    ['a body that is not an object', [], 'invalid_body'],
    ['no mode', { tenant_ids: ['tenant-a'], changes: [ttl(1)] }, 'invalid_mode'],
    ['an unknown mode', request({ mode: 'dry' }), 'invalid_mode'],
    ['an unknown field', request({ tenants: ['tenant-a'] }), 'unknown_field'],
    ['no tenants', request({ tenant_ids: [] }), 'invalid_tenant_ids'],
    ['a tenant ID that is not an ID', request({ tenant_ids: ['a b'] }), 'invalid_tenant_id'],
    ['a tenant ID that is not a string', request({ tenant_ids: [1] }), 'invalid_tenant_id'],
    ['no changes', request({ changes: [] }), 'invalid_changes'],
    [
      'a change with nothing in it',
      request({ changes: [{ category: 'session' }] }),
      'empty_change',
    ],
    [
      'a category twice',
      request({ changes: [ttl(1), { category: 'session', clear: [TTL] }] }),
      'duplicate_category',
    ],
    [
      'a key both set and cleared',
      request({ changes: [ttl(1, { clear: [TTL] })] }),
      'conflicting_operations',
    ],
    [
      'an unknown policy for existing values',
      request({ on_existing_override: 'merge' }),
      'invalid_on_existing_override',
    ],
    [
      'expected that is not versions',
      request({ expected: { 'tenant-a': 'v' } }),
      'invalid_expected',
    ],
  ])('refuses %s with 400', async (_name, body, code) => {
    const t = await setup();
    const before = t.snapshot();
    const response = await t.bulk(t.admin, body);
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: 'invalid_request', code });
    expect(t.snapshot()).toEqual(before);
  });

  it('refuses a request that names more tenants than the limit, and one with more settings', async () => {
    const t = await setup();
    const tooMany = await t.bulk(
      t.admin,
      request({ tenant_ids: Array.from({ length: 26 }, (_, i) => `t${i}`) })
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.json).toMatchObject({ code: 'too_many_tenants', limit: 25 });

    const set = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`oauth.key_${i}`, i]));
    const tooBig = await t.bulk(t.admin, request({ changes: [{ category: 'oauth', set }] }));
    expect(tooBig.status).toBe(400);
    expect(tooBig.json).toMatchObject({ code: 'too_many_keys', limit: 20 });
    expect(t.snapshot().documents).toEqual([]);
  });

  it('counts a tenant named twice once, and answers in the order of first appearance', async () => {
    const t = await setup();
    const ids = [
      'tenant-b',
      'tenant-b',
      'tenant-a',
      ...Array.from({ length: 30 }, () => 'tenant-a'),
    ];
    const response = await t.bulk(t.admin, request({ tenant_ids: ids }));
    expect(response.status).toBe(200);
    expect(response.json.results.map((r: any) => r.tenant_id)).toEqual(['tenant-b', 'tenant-a']);
    expect(response.json.summary.tenants).toBe(2);
  });

  it('refuses an unknown category as a malformed request', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({ changes: [{ category: 'Not A Category', set: { a: 1 } }] })
    );
    expect(response.status).toBe(400);
  });
});

describe('the limits are settings', () => {
  const tenants3 = ['tenant-a', 'tenant-b', 'tenant-d'];

  it('use the saved platform value before the environment variable and the default', async () => {
    const t = await setup({ BULK_APPLY_MAX_TENANTS_PER_REQUEST: '5' });
    const fromEnv = await t.bulk(t.admin, request({ mode: 'preview' }));
    expect(fromEnv.json.limits).toEqual({ max_tenants_per_request: 5, max_keys_per_request: 20 });

    const url = '/api/admin/platform/settings/bulk-apply';
    const saved = await t.call(t.admin, 'GET', url);
    const patched = await t.call(t.admin, 'PATCH', url, {
      ifMatch: saved.json.version,
      set: { 'bulk_apply.max_tenants_per_request': 2, 'bulk_apply.max_keys_per_request': 3 },
    });
    expect(patched.status).toBe(200);
    const refused = await t.bulk(t.admin, request({ tenant_ids: tenants3 }));
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ code: 'too_many_tenants', limit: 2 });
    const ok = await t.bulk(t.admin, request({ mode: 'preview' }));
    expect(ok.json.limits).toEqual({ max_tenants_per_request: 2, max_keys_per_request: 3 });
  });

  it.each([
    ['1000', 100],
    ['0', 1],
    ['-4', 1],
    ['abc', 25],
  ])('hold an environment value of %s to %s', async (value, expected) => {
    const t = await setup({ BULK_APPLY_MAX_TENANTS_PER_REQUEST: value });
    const response = await t.bulk(t.admin, request({ mode: 'preview', tenant_ids: ['tenant-a'] }));
    expect(response.json.limits.max_tenants_per_request).toBe(expected);
  });

  it('cannot be saved outside 1 to 100, or by a tenant', async () => {
    const t = await setup();
    const url = '/api/admin/platform/settings/bulk-apply';
    const version = (await t.call(t.admin, 'GET', url)).json.version;
    for (const value of [0, 101, 2.5, '5']) {
      const response = await t.call(t.admin, 'PATCH', url, {
        ifMatch: version,
        set: { 'bulk_apply.max_tenants_per_request': value },
      });
      expect(response.json.applied ?? [], String(value)).toEqual([]);
    }
    const tenantLevel = await t.call(
      t.admin,
      'GET',
      '/api/admin/tenants/tenant-a/settings/bulk-apply'
    );
    expect(tenantLevel.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------

describe('a preview', () => {
  it('writes nothing, audits nothing, and leaves the plugin gate alone', async () => {
    const t = await setup();
    await t.versions();
    const before = t.snapshot();

    const response = await t.bulk(
      t.admin,
      request({
        mode: 'preview',
        tenant_ids: TENANTS,
        changes: [
          ttl(7200000),
          { category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-plat' } },
          { category: 'plugin', set: { 'plugin.enabled': false } },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(response.json.bulk_id).toBeUndefined();
    expect(t.snapshot()).toEqual(before);
    expect(audits('settings.bulk_apply')).toEqual([]);
    expect(audits('settings.settings.updated')).toEqual([]);
    expect(audits('settings.patch.failure')).toEqual([]);
    expect(setRunnerExternalGate).not.toHaveBeenCalled();
  });

  it('says for each key what the tenant has now, what is proposed, and what would happen', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });

    const response = await t.bulk(t.admin, request({ mode: 'preview' }));

    expect(response.json.mode).toBe('preview');
    const a = resultFor(response.json, 'tenant-a');
    expect(a.changes).toEqual([
      expect.objectContaining({
        category: 'session',
        key: TTL,
        current: {
          overridden: false,
          own: null,
          effective: expect.any(Number),
          source: expect.any(String),
        },
        proposed: 7200000,
        action: 'would_apply',
        validation: { ok: true },
        version: expect.stringMatching(/^sha256:/),
      }),
    ]);
    const b = resultFor(response.json, 'tenant-b');
    expect(b.changes[0]).toMatchObject({
      current: { overridden: true, own: 1800000, effective: 1800000, source: 'kv' },
      action: 'would_skip',
      reason: 'existing_override',
    });
    expect(b.status).toBe('nothing_to_do');
    // The version is the one an apply is held to with `expected`.
    expect(a.changes[0].version).toBe((await t.doc('tenant-a', 'session')).version);
  });

  it('would overwrite a tenant’s own value only when asked to', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });
    const response = await t.bulk(
      t.admin,
      request({ mode: 'preview', on_existing_override: 'overwrite' })
    );
    expect(resultFor(response.json, 'tenant-b').changes[0]).toMatchObject({
      action: 'would_apply',
    });
  });

  it('says what a clear would do, and that a tenant without a value of its own has nothing to clear', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });
    const body = request({
      mode: 'preview',
      changes: [{ category: 'session', clear: [TTL] }],
      on_existing_override: 'overwrite',
    });
    const response = await t.bulk(t.admin, body);
    expect(resultFor(response.json, 'tenant-b').changes[0]).toMatchObject({
      proposed: 'clear',
      action: 'would_clear',
    });
    expect(resultFor(response.json, 'tenant-a').changes[0]).toMatchObject({
      action: 'would_skip',
      reason: 'not_overridden',
    });
  });

  it('runs the checks an apply runs, the Admin database reference check included', async () => {
    const t = await setup();
    const change = { category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-b1' } };
    const preview = await t.bulk(
      t.admin,
      request({ mode: 'preview', tenant_ids: ['tenant-a', 'tenant-b'], changes: [change] })
    );
    // The set is tenant-b's own: it can be named there and not in tenant-a.
    expect(resultFor(preview.json, 'tenant-b').changes[0]).toMatchObject({
      action: 'would_apply',
      validation: { ok: true },
    });
    expect(resultFor(preview.json, 'tenant-a').changes[0]).toMatchObject({
      action: 'would_reject',
      validation: { ok: false, errors: [{ code: 'validation_failed' }] },
    });
    const applied = await t.bulk(
      t.admin,
      request({ tenant_ids: ['tenant-a', 'tenant-b'], changes: [change] })
    );
    expect(resultFor(applied.json, 'tenant-a').changes[0].status).toBe('rejected');
    expect(resultFor(applied.json, 'tenant-b').changes[0].status).toBe('applied');
  });

  it.each([
    ['a set that does not exist', 'set-nothing'],
    ['another tenant’s set', 'set-b1'],
    ['a malformed ID', 'set/own'],
  ])('refuses %s in the preview as the apply does', async (_name, setId) => {
    const t = await setup();
    const change = { category: 'identity-mapping', set: { [MAPPING_KEY]: setId } };
    const tenantIds = ['tenant-a'];
    const preview = await t.bulk(
      t.admin,
      request({ mode: 'preview', tenant_ids: tenantIds, changes: [change] })
    );
    const apply = await t.bulk(t.admin, request({ tenant_ids: tenantIds, changes: [change] }));
    expect(preview.json.results[0].changes[0].action).toBe('would_reject');
    expect(apply.json.results[0].changes[0].status).toBe('rejected');
    expect(await t.own('tenant-a', 'identity-mapping', MAPPING_KEY)).toBeUndefined();
  });

  it('refuses a set that is not active, in both', async () => {
    const t = await setup();
    t.db.exec("UPDATE field_mapping_sets SET lifecycle_state = 'draft' WHERE id = 'set-plat'");
    const change = { category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-plat' } };
    const preview = await t.bulk(t.admin, request({ mode: 'preview', changes: [change] }));
    const apply = await t.bulk(t.admin, request({ changes: [change] }));
    for (const id of ['tenant-a', 'tenant-b']) {
      expect(resultFor(preview.json, id).changes[0].action).toBe('would_reject');
      expect(resultFor(apply.json, id).changes[0].status).toBe('rejected');
    }
  });

  it('shows the apps the default Mapping Set would reach, and why it could not count them', async () => {
    const t = await setup();
    // Four apps: no choice, no choice ({}), a set of their own, an opt-out.
    insertOAuthClient(t.cores['tenant-a'], { tenantId: 'tenant-a', clientId: 'app-1' });
    insertOAuthClient(t.cores['tenant-a'], {
      tenantId: 'tenant-a',
      clientId: 'app-2',
      identityMapping: {},
    });
    insertOAuthClient(t.cores['tenant-a'], {
      tenantId: 'tenant-a',
      clientId: 'app-3',
      identityMapping: { fieldMappingSetId: 'set-a1' },
    });
    insertOAuthClient(t.cores['tenant-a'], {
      tenantId: 'tenant-a',
      clientId: 'app-4',
      identityMapping: { mode: 'none' },
    });
    // Another tenant's app is not counted for this one.
    insertOAuthClient(t.cores['tenant-a'], { tenantId: 'tenant-b', clientId: 'app-x' });

    const response = await t.bulk(
      t.admin,
      request({
        mode: 'preview',
        tenant_ids: ['tenant-a', 'tenant-b', 'tenant-c'],
        changes: [{ category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-plat' } }],
      })
    );

    expect(resultFor(response.json, 'tenant-a').impact['identity-mapping']).toEqual({
      available: true,
      applies: true,
      apps_total: 4,
      apps_following_default: 2,
    });
    expect(resultFor(response.json, 'tenant-b').impact['identity-mapping']).toMatchObject({
      available: true,
      apps_total: 0,
      apps_following_default: 0,
    });
    // tenant-c has no Core database in this setup.
    expect(resultFor(response.json, 'tenant-c').impact['identity-mapping']).toEqual({
      available: false,
      reason: 'core_database_unavailable',
    });
    expect(JSON.stringify(response.json)).not.toMatch(/app-x/);
  });

  it('gives the impact only where the change would be written, and only for categories with a provider', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        mode: 'preview',
        changes: [
          ttl(7200000),
          { category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-nothing' } },
        ],
      })
    );
    // The refused one has no impact; session has no provider.
    expect(resultFor(response.json, 'tenant-a').impact).toEqual({});
  });

  it('lets a category register what its changes affect', async () => {
    const t = await setup();
    registerBulkApplyImpactProvider('session', async ({ tenantId, keys }) => ({
      available: true,
      tenant: tenantId,
      keys: [...keys],
    }));
    try {
      const response = await t.bulk(t.admin, request({ mode: 'preview' }));
      expect(resultFor(response.json, 'tenant-b').impact.session).toEqual({
        available: true,
        tenant: 'tenant-b',
        keys: [TTL],
      });
    } finally {
      delete bulkApplyImpactProviders.session;
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('an apply', () => {
  it('gives the same value to the tenants named, and only to them', async () => {
    const t = await setup();
    const before = await t.versions();

    const response = await t.bulk(
      t.admin,
      request({ tenant_ids: ['tenant-a', 'tenant-b', 'tenant-c'] })
    );

    expect(response.status).toBe(200);
    expect(response.json.bulk_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json.summary).toEqual({ tenants: 3, by_status: { applied: 3 } });
    for (const id of ['tenant-a', 'tenant-b', 'tenant-c']) {
      const result = resultFor(response.json, id);
      expect(result.status).toBe('applied');
      expect(result.changes).toEqual([
        {
          category: 'session',
          key: TTL,
          status: 'applied',
          previous: null,
          new: 7200000,
          version_before: before[`${id}/session`],
          version_after: expect.stringMatching(/^sha256:/),
        },
      ]);
      expect(result.changes[0].version_after).not.toBe(before[`${id}/session`]);
      expect(await t.own(id, 'session', TTL)).toBe(7200000);
    }
    // A tenant the request does not name is not touched.
    const after = await t.versions();
    expect(after['tenant-d/session']).toBe(before['tenant-d/session']);
    expect(await t.own('tenant-d', 'session', TTL)).toBeUndefined();
    expect(JSON.stringify(response.json)).not.toContain('tenant-d');
  });

  it('works for any setting a tenant can have: several categories and keys in one call', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        changes: [
          ttl(7200000),
          {
            category: 'oauth',
            set: { 'oauth.access_token_expiry': 900, 'oauth.refresh_token_rotation': false },
          },
          { category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-plat' } },
        ],
      })
    );

    expect(response.status).toBe(200);
    const a = resultFor(response.json, 'tenant-a');
    expect(a.changes.map((c: any) => `${c.key}:${c.status}`)).toEqual([
      `${TTL}:applied`,
      'oauth.access_token_expiry:applied',
      'oauth.refresh_token_rotation:applied',
      `${MAPPING_KEY}:applied`,
    ]);
    expect(await t.own('tenant-b', 'oauth', 'oauth.access_token_expiry')).toBe(900);
    expect(await t.own('tenant-b', 'oauth', 'oauth.refresh_token_rotation')).toBe(false);
    expect(await t.own('tenant-b', 'identity-mapping', MAPPING_KEY)).toBe('set-plat');
  });

  it('refuses a value the setting does not take, for that key only', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        changes: [
          {
            category: 'oauth',
            set: { 'oauth.access_token_expiry': 'soon', 'oauth.refresh_token_rotation': false },
          },
        ],
      })
    );
    const a = resultFor(response.json, 'tenant-a');
    expect(a.changes[0]).toMatchObject({
      key: 'oauth.access_token_expiry',
      status: 'rejected',
      reason: 'validation_failed',
    });
    expect(a.changes[1]).toMatchObject({ key: 'oauth.refresh_token_rotation', status: 'applied' });
    expect(await t.own('tenant-a', 'oauth', 'oauth.access_token_expiry')).toBeUndefined();
  });

  it('runs the checks a PATCH runs, such as the login UI locale rules', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        changes: [{ category: 'login-ui', set: { 'login-ui.supported_locales': 'xx-nowhere' } }],
      })
    );
    expect(resultFor(response.json, 'tenant-a').changes[0]).toMatchObject({
      status: 'rejected',
      reason: 'validation_failed',
      message: expect.stringMatching(/supported_locales/),
    });
    const pat = await t.call(t.admin, 'PATCH', '/api/admin/tenants/tenant-a/settings/login-ui', {
      ifMatch: (await t.doc('tenant-a', 'login-ui')).version,
      set: { 'login-ui.supported_locales': 'xx-nowhere' },
    });
    expect(pat.status).toBe(400);
  });

  it('closes the plugin gate when it turns external plugins off, as a PATCH does', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({ changes: [{ category: 'plugin', set: { 'plugin.enabled': false } }] })
    );
    expect(resultFor(response.json, 'tenant-a').changes[0].status).toBe('applied');
    expect(
      vi
        .mocked(setRunnerExternalGate)
        .mock.calls.map((call) => call[1])
        .sort()
    ).toEqual(['tenant-a', 'tenant-b']);
  });

  describe('when the tenant already has a value of its own', () => {
    it('leaves it alone by default, and says so', async () => {
      const t = await setup();
      await t.seed('tenant-b', 'session', { [TTL]: 1800000 });

      const response = await t.bulk(t.admin, request());

      expect(resultFor(response.json, 'tenant-a').status).toBe('applied');
      const b = resultFor(response.json, 'tenant-b');
      expect(b.status).toBe('skipped');
      expect(b.changes[0]).toMatchObject({
        status: 'skipped',
        reason: 'existing_override',
        previous: 1800000,
        new: 7200000,
        version_after: null,
      });
      expect(await t.own('tenant-b', 'session', TTL)).toBe(1800000);
    });

    it('overwrites it when asked to, and returns what it was', async () => {
      const t = await setup();
      await t.seed('tenant-b', 'session', { [TTL]: 1800000 });

      const response = await t.bulk(t.admin, request({ on_existing_override: 'overwrite' }));

      expect(resultFor(response.json, 'tenant-b').changes[0]).toMatchObject({
        status: 'applied',
        previous: 1800000,
        new: 7200000,
      });
      expect(await t.own('tenant-b', 'session', TTL)).toBe(7200000);
    });

    it('does nothing for a value that is already the one proposed, even when overwriting', async () => {
      const t = await setup();
      await t.seed('tenant-b', 'session', { [TTL]: 7200000 });
      const before = (await t.doc('tenant-b', 'session')).version;

      const response = await t.bulk(t.admin, request({ on_existing_override: 'overwrite' }));

      expect(resultFor(response.json, 'tenant-b').changes[0]).toMatchObject({
        status: 'skipped',
        reason: 'already_set',
      });
      expect((await t.doc('tenant-b', 'session')).version).toBe(before);
    });

    it('is the default, and only "overwrite" changes it', async () => {
      const t = await setup();
      await t.seed('tenant-a', 'session', { [TTL]: 1800000 });
      const explicit = await t.bulk(t.admin, request({ on_existing_override: 'skip' }));
      expect(resultFor(explicit.json, 'tenant-a').changes[0].status).toBe('skipped');
      const implicit = await t.bulk(t.admin, request());
      expect(implicit.json.on_existing_override).toBe('skip');
      expect(resultFor(implicit.json, 'tenant-a').changes[0].status).toBe('skipped');
      expect(await t.own('tenant-a', 'session', TTL)).toBe(1800000);
    });
  });

  describe('clearing', () => {
    const clear = (overrides: Record<string, unknown> = {}) =>
      request({ changes: [{ category: 'session', clear: [TTL] }], ...overrides });

    it('takes the tenant back to inheriting, when asked to overwrite, and returns the value it had', async () => {
      const t = await setup();
      await t.seed('tenant-a', 'session', { [TTL]: 1800000 });

      const response = await t.bulk(t.admin, clear({ on_existing_override: 'overwrite' }));

      expect(resultFor(response.json, 'tenant-a').changes[0]).toMatchObject({
        status: 'cleared',
        previous: 1800000,
        new: 'clear',
      });
      expect(await t.own('tenant-a', 'session', TTL)).toBeUndefined();
      // No value of its own to clear.
      expect(resultFor(response.json, 'tenant-b').changes[0]).toMatchObject({
        status: 'skipped',
        reason: 'not_overridden',
        previous: null,
      });
    });

    it('does not remove a tenant’s own value by default', async () => {
      const t = await setup();
      await t.seed('tenant-a', 'session', { [TTL]: 1800000 });
      const response = await t.bulk(t.admin, clear());
      expect(resultFor(response.json, 'tenant-a').changes[0]).toMatchObject({
        status: 'skipped',
        reason: 'existing_override',
      });
      expect(await t.own('tenant-a', 'session', TTL)).toBe(1800000);
    });

    it('can undo an apply with the previous values it returned', async () => {
      const t = await setup();
      await t.seed('tenant-a', 'session', { [TTL]: 1800000 });
      const applied = await t.bulk(t.admin, request({ on_existing_override: 'overwrite' }));
      const a = resultFor(applied.json, 'tenant-a').changes[0];
      const b = resultFor(applied.json, 'tenant-b').changes[0];
      expect([a.previous, b.previous]).toEqual([1800000, null]);

      await t.bulk(
        t.admin,
        request({
          changes: [ttl(a.previous)],
          tenant_ids: ['tenant-a'],
          on_existing_override: 'overwrite',
        })
      );
      await t.bulk(
        t.admin,
        request({
          changes: [{ category: 'session', clear: [TTL] }],
          tenant_ids: ['tenant-b'],
          on_existing_override: 'overwrite',
        })
      );
      expect(await t.own('tenant-a', 'session', TTL)).toBe(1800000);
      expect(await t.own('tenant-b', 'session', TTL)).toBeUndefined();
    });
  });

  describe('expected versions', () => {
    it('writes only where the version is still the one the preview returned', async () => {
      const t = await setup();
      const preview = await t.bulk(t.admin, request({ mode: 'preview' }));
      const versions = Object.fromEntries(
        preview.json.results.map((r: any) => [r.tenant_id, { session: r.changes[0].version }])
      );
      // tenant-b changes between the preview and the apply.
      await t.seed('tenant-b', 'session', { 'session.max_ttl': 86400000 });

      const response = await t.bulk(t.admin, request({ expected: versions }));

      expect(resultFor(response.json, 'tenant-a').changes[0].status).toBe('applied');
      expect(resultFor(response.json, 'tenant-b')).toMatchObject({
        status: 'conflict',
        changes: [{ status: 'conflict', reason: 'version_changed', version_after: null }],
      });
      expect(await t.own('tenant-b', 'session', TTL)).toBeUndefined();
    });

    it('does not hold a category to a version that was not given for it', async () => {
      const t = await setup();
      const response = await t.bulk(
        t.admin,
        request({
          changes: [ttl(7200000), { category: 'oauth', set: { 'oauth.access_token_expiry': 900 } }],
          expected: { 'tenant-a': { session: 'sha256:0000000000000000' } },
        })
      );
      const a = resultFor(response.json, 'tenant-a').changes;
      expect(a.map((c: any) => c.status)).toEqual(['conflict', 'applied']);
      expect(resultFor(response.json, 'tenant-b').changes.map((c: any) => c.status)).toEqual([
        'applied',
        'applied',
      ]);
    });

    it('takes a document that changed between the read and the save as a conflict', async () => {
      const t = await setup();
      const real = t.adapter.execute.bind(t.adapter);
      let raced = false;
      // The tenant's document changes after the apply read it and before it saves.
      t.adapter.execute = async (sql: string, params?: unknown[]) => {
        if (!raced && /UPDATE tenant_settings_documents/.test(sql)) {
          raced = true;
          await t.seed('tenant-a', 'session', { 'session.max_ttl': 86400000 });
        }
        return real(sql, params);
      };
      const response = await t.bulk(t.admin, request({ tenant_ids: ['tenant-a'] }));
      expect(response.status).toBe(200);
      expect(resultFor(response.json, 'tenant-a')).toMatchObject({
        status: 'conflict',
        changes: [{ status: 'conflict', reason: 'version_changed' }],
      });
      expect(await t.own('tenant-a', 'session', TTL)).toBeUndefined();
      expect(await t.own('tenant-a', 'session', 'session.max_ttl')).toBe(86400000);
    });
  });

  describe('tenants apart', () => {
    it('does not stop at a tenant that refuses: the others are applied', async () => {
      const t = await setup();
      const response = await t.bulk(
        t.admin,
        request({
          tenant_ids: ['tenant-a', 'tenant-b', 'tenant-d'],
          changes: [{ category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-b1' } }],
        })
      );

      expect(response.json.summary.by_status).toEqual({ rejected: 2, applied: 1 });
      expect(resultFor(response.json, 'tenant-a').status).toBe('rejected');
      expect(resultFor(response.json, 'tenant-b').status).toBe('applied');
      expect(resultFor(response.json, 'tenant-d').status).toBe('rejected');
      expect(await t.own('tenant-b', 'identity-mapping', MAPPING_KEY)).toBe('set-b1');
      // A refusal says that the set is not available, and nothing of the other tenant.
      const refused = JSON.stringify(resultFor(response.json, 'tenant-a'));
      expect(refused).not.toContain('tenant-b');
    });

    it('goes on past a refused tenant to the ones queued behind it, more than are worked on at once', async () => {
      const t = await setup();
      const ids = [
        'tenant-nope',
        'tenant-gone',
        'tenant-a',
        'tenant-b',
        'tenant-d',
        'tenant-e',
        'tenant-f',
        'tenant-g',
      ];
      const response = await t.bulk(t.admin, request({ tenant_ids: ids }));
      expect(response.json.results.map((r: any) => `${r.tenant_id}:${r.status}`)).toEqual([
        'tenant-nope:rejected',
        'tenant-gone:rejected',
        'tenant-a:applied',
        'tenant-b:applied',
        'tenant-d:applied',
        'tenant-e:applied',
        'tenant-f:applied',
        'tenant-g:applied',
      ]);
      expect(await t.own('tenant-g', 'session', TTL)).toBe(7200000);
    });

    it('reports a tenant whose work breaks unexpectedly as failed, without the cause, and goes on', async () => {
      const t = await setup();
      vi.mocked(bulkApplyKeyVerdict).mockImplementationOnce(() => {
        throw new Error('boom secret-host.internal');
      });
      const response = await t.bulk(
        t.admin,
        request({ tenant_ids: ['tenant-a', 'tenant-b', 'tenant-d'] })
      );
      expect(response.status).toBe(200);
      expect(response.json.results.map((r: any) => r.status).sort()).toEqual([
        'applied',
        'applied',
        'failed',
      ]);
      const failed = response.json.results.find((r: any) => r.status === 'failed');
      expect(failed.changes[0]).toMatchObject({ status: 'failed', reason: 'internal_error' });
      expect(JSON.stringify(response.json)).not.toMatch(/boom|secret-host/);
    });

    it('does the same in a preview', async () => {
      const t = await setup();
      vi.mocked(bulkApplyKeyVerdict).mockImplementationOnce(() => {
        throw new Error('boom secret-host.internal');
      });
      const response = await t.bulk(
        t.admin,
        request({ mode: 'preview', tenant_ids: ['tenant-a', 'tenant-b'] })
      );
      expect(response.status).toBe(200);
      expect(response.json.results.map((r: any) => r.status).sort()).toEqual(['failed', 'ready']);
      const failed = response.json.results.find((r: any) => r.status === 'failed');
      expect(failed.error).toEqual({ code: 'internal_error' });
      expect(JSON.stringify(response.json)).not.toMatch(/boom|secret-host/);
    });

    it('does not stop at a tenant whose save fails, and says only that it failed', async () => {
      const t = await setup();
      const real = t.adapter.execute.bind(t.adapter);
      let broken = false;
      t.adapter.execute = async (sql: string, params?: unknown[]) => {
        if (!broken && /UPDATE tenant_settings_documents/.test(sql)) {
          broken = true;
          throw new Error('D1_ERROR: connection to secret-host.internal:5432 refused');
        }
        return real(sql, params);
      };

      const response = await t.bulk(
        t.admin,
        request({ tenant_ids: ['tenant-a', 'tenant-b', 'tenant-d'] })
      );

      expect(response.status).toBe(200);
      const statuses = response.json.results.map((r: any) => r.status).sort();
      expect(statuses).toEqual(['applied', 'applied', 'failed']);
      const failed = response.json.results.find((r: any) => r.status === 'failed');
      expect(failed.changes[0]).toMatchObject({ status: 'failed', reason: 'internal_error' });
      const text = JSON.stringify(response.json);
      expect(text).not.toMatch(/secret-host|D1_ERROR|connection|refused|stack/i);
      // The tenants that did not fail were written.
      for (const r of response.json.results.filter((x: any) => x.status === 'applied')) {
        expect(await t.own(r.tenant_id, 'session', TTL)).toBe(7200000);
      }
    });

    it('rejects a tenant that does not exist and one that is deleted, and tells them apart', async () => {
      const t = await setup();
      const response = await t.bulk(
        t.admin,
        request({ tenant_ids: ['tenant-a', 'tenant-nope', 'tenant-gone'] })
      );
      expect(resultFor(response.json, 'tenant-a').status).toBe('applied');
      expect(resultFor(response.json, 'tenant-nope')).toMatchObject({
        status: 'rejected',
        reason: 'tenant_not_found',
        changes: [],
      });
      expect(resultFor(response.json, 'tenant-gone')).toMatchObject({
        status: 'rejected',
        reason: 'tenant_deleted',
        changes: [],
      });
      expect(await t.own('tenant-gone', 'session', TTL)).toBeUndefined();
    });

    it('answers in single tenant mode only for the default tenant', async () => {
      const t = await setup({ BASE_DOMAIN: '' });
      const response = await t.bulk(t.admin, request({ tenant_ids: ['tenant-a', 'default'] }));
      expect(resultFor(response.json, 'tenant-a')).toMatchObject({
        status: 'rejected',
        reason: 'tenant_not_found',
      });
    });

    it('answers 503 and changes nothing when the tenants cannot be looked up', async () => {
      const t = await setup({ DB: undefined });
      const response = await t.bulk(t.admin, request());
      expect(response.status).toBe(503);
      expect(response.json.error).toBe('temporarily_unavailable');
      expect(await t.own('tenant-a', 'session', TTL)).toBeUndefined();
    });

    it('goes through the tenant backup coverage once for each tenant it writes, and only for them', async () => {
      const t = await setup();
      await t.bulk(t.admin, request({ tenant_ids: ['tenant-a', 'tenant-b'] }));
      const calls = vi.mocked(runTenantBackupCoveredMutation).mock.calls.map(([input]) => input);
      expect(calls.map((input) => (input as { tenantId?: string }).tenantId).sort()).toEqual([
        'tenant-a',
        'tenant-b',
      ]);
      expect(calls.every((input) => (input as { scope?: string }).scope === undefined)).toBe(true);
    });

    it('reports a tenant whose backup coverage cannot be confirmed as failed, and applies the others', async () => {
      const t = await setup();
      const actual =
        await vi.importActual<typeof import('../tenant-backup-writer')>('../tenant-backup-writer');
      vi.mocked(runTenantBackupCoveredMutation).mockImplementation(async (input) =>
        'tenantId' in input && input.tenantId === 'tenant-b'
          ? Response.json({ error: 'backup_mutation_unavailable' }, { status: 503 })
          : actual.runTenantBackupCoveredMutation(input)
      );
      try {
        const response = await t.bulk(t.admin, request());
        expect(resultFor(response.json, 'tenant-a').status).toBe('applied');
        expect(resultFor(response.json, 'tenant-b')).toMatchObject({
          status: 'failed',
          changes: [{ status: 'failed', reason: 'backup_mutation_unavailable' }],
        });
        expect(await t.own('tenant-b', 'session', TTL)).toBeUndefined();
      } finally {
        vi.mocked(runTenantBackupCoveredMutation).mockImplementation(
          actual.runTenantBackupCoveredMutation
        );
      }
    });
  });

  describe('what may be given', () => {
    it.each([
      ['a URL', 'tenant', 'tenant.ui_base_url', 'https://x.example', 'tenant_specific_url'],
      [
        'a path of the tenant’s UI',
        'tenant',
        'tenant.ui_login_path',
        '/login',
        'tenant_ui_routing',
      ],
      [
        'an origin list',
        'security',
        'security.trusted_redirect_origins',
        '[]',
        'tenant_specific_url',
      ],
      ['brand text', 'login-ui', 'login-ui.brand_name', 'Acme', 'tenant_brand_text'],
      [
        'a reference to a provider',
        'external-idp',
        'external_idp.jit_default_role_id',
        'role-1',
        'tenant_specific_reference',
      ],
      ['a structured document', 'login-ui', 'login-ui.custom_css', 'a{}', 'structured_value'],
      [
        'a binding of the deployment',
        'dr-backup',
        'dr-backup.storage_destination_id',
        'x',
        'environment_mapping',
      ],
      [
        'a default access token target',
        'dcr',
        'dcr.default_audience',
        'https://x.example',
        'tenant_identifier',
      ],
      [
        'a setup-time setting',
        'tenant',
        'tenant.user_id_format',
        'uuid',
        'setting_setup_time_only',
      ],
      [
        'a platform-only setting',
        'rate-limit',
        'rate_limit.strict',
        5,
        'setting_not_at_tenant_scope',
      ],
      ['a setting that does not exist', 'session', 'session.no_such_setting', 1, 'unknown_setting'],
    ])(
      'rejects %s, with the reason, and writes nothing',
      async (_name, category, key, value, reason) => {
        const t = await setup();
        await t.versions();
        const before = t.snapshot();
        const response = await t.bulk(
          t.admin,
          request({ changes: [{ category, set: { [key as string]: value } }] })
        );
        expect(response.status).toBe(200);
        for (const id of ['tenant-a', 'tenant-b']) {
          expect(resultFor(response.json, id)).toMatchObject({
            status: 'rejected',
            changes: [{ key, status: 'rejected', reason }],
          });
        }
        expect(t.snapshot()).toEqual(before);
      }
    );

    it.each([
      ['a platform-only category', 'infrastructure', 'category_not_at_tenant_scope'],
      ['an app-only category', 'client', 'category_not_at_tenant_scope'],
      ['the limits of this very feature', 'bulk-apply', 'category_not_at_tenant_scope'],
    ])('rejects %s', async (_name, category, reason) => {
      const t = await setup();
      const response = await t.bulk(
        t.admin,
        request({ changes: [{ category, set: { 'x.y': 1 } }] })
      );
      expect(resultFor(response.json, 'tenant-a').changes[0]).toMatchObject({
        status: 'rejected',
        reason,
      });
    });

    it('rejects the refused keys in a preview as well, next to the ones that would be applied', async () => {
      const t = await setup();
      const response = await t.bulk(
        t.admin,
        request({
          mode: 'preview',
          changes: [{ category: 'tenant', set: { 'tenant.ui_login_path': '/x' } }, ttl(7200000)],
        })
      );
      const actions = resultFor(response.json, 'tenant-a').changes.map(
        (c: any) => `${c.key}:${c.action}:${c.reason ?? ''}`
      );
      expect(actions).toEqual([
        'tenant.ui_login_path:would_reject:tenant_ui_routing',
        `${TTL}:would_apply:`,
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('the record of an apply', () => {
  it('is one summary for the request, with counts, categories and key names but no value', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });

    const response = await t.bulk(
      t.admin,
      request({
        tenant_ids: ['tenant-a', 'tenant-b', 'tenant-nope'],
        changes: [ttl(1234567), { category: 'oauth', set: { 'oauth.access_token_expiry': 43210 } }],
      })
    );

    const summary = audits('settings.bulk_apply');
    expect(summary).toHaveLength(1);
    expect(summary[0].resourceId).toBe(response.json.bulk_id);
    expect(summary[0].metadata).toMatchObject({
      bulk_id: response.json.bulk_id,
      mode: 'apply',
      on_existing_override: 'skip',
      tenant_count: 3,
      tenant_results: { applied: 2, rejected: 1 },
      change_results: { applied: 3, skipped: 1 },
      categories: ['session', 'oauth'],
      keys: [TTL, 'oauth.access_token_expiry'],
    });
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/1234567|43210|1800000/);
    expect(text).not.toContain('tenant-b');
  });

  it('counts each result, so a person can see how the request went', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });
    await t.bulk(t.admin, request({ tenant_ids: ['tenant-a', 'tenant-b'] }));
    const [summary] = audits('settings.bulk_apply');
    expect(summary.metadata).toMatchObject({
      change_results: { applied: 1, skipped: 1 },
      tenant_results: { applied: 1, skipped: 1 },
    });
  });

  it('marks every tenant’s own record with the bulk ID, those of a refusal too', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        changes: [
          ttl(7200000),
          { category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-nothing' } },
        ],
      })
    );
    const updated = audits('settings.settings.updated');
    expect(updated.map((u) => (u.metadata as any).scope_id).sort()).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    for (const entry of updated) {
      expect(entry.metadata).toMatchObject({ bulk_id: response.json.bulk_id, category: 'session' });
    }
    const failures = audits('settings.patch.failure');
    expect(failures).toHaveLength(2);
    for (const entry of failures) {
      expect(entry.metadata).toMatchObject({
        bulk_id: response.json.bulk_id,
        category: 'identity-mapping',
        reason: 'identity_mapping_set_missing',
      });
    }
  });

  it('is not written by a PATCH of the same setting: the per-tenant record has no bulk ID there', async () => {
    const t = await setup();
    await t.seed('tenant-a', 'session', { [TTL]: 1800000 });
    const updated = audits('settings.settings.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0].metadata).not.toHaveProperty('bulk_id');
  });

  it('is not written when the audit cannot be: the apply stands and the answer is still given', async () => {
    const t = await setup();
    vi.mocked(createAuditLogFromContext).mockImplementation(async (_c, action) => {
      if (action === 'settings.bulk_apply') throw new Error('audit down');
    });
    try {
      const response = await t.bulk(t.admin, request());
      expect(response.status).toBe(200);
      expect(await t.own('tenant-a', 'session', TTL)).toBe(7200000);
    } finally {
      vi.mocked(createAuditLogFromContext).mockImplementation(async () => undefined);
    }
  });
});

describe('repeating a request', () => {
  it('answers with the stored result for the same key and body, and writes nothing again', async () => {
    const t = await setup();
    const first = await t.bulk(t.admin, request(), { key: 'same-key-0001' });
    const writes = audits('settings.settings.updated').length;
    // The tenant changes in the meantime: the repeat must not look at it.
    await t.seed('tenant-a', 'session', { [TTL]: 90000 });
    const afterSeed = audits('settings.settings.updated').length;

    const second = await t.bulk(t.admin, request(), { key: 'same-key-0001' });

    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(audits('settings.settings.updated').length).toBe(afterSeed);
    expect(writes).toBe(2);
    expect(audits('settings.bulk_apply')).toHaveLength(1);
    expect(await t.own('tenant-a', 'session', TTL)).toBe(90000);
  });

  it('refuses the same key with another body', async () => {
    const t = await setup();
    await t.bulk(t.admin, request(), { key: 'same-key-0002' });
    const other = await t.bulk(t.admin, request({ changes: [ttl(100)] }), { key: 'same-key-0002' });
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('idempotency_conflict');
    expect(await t.own('tenant-a', 'session', TTL)).toBe(7200000);
  });

  it('is a different request for a different caller', async () => {
    const t = await setup();
    const first = await t.bulk(t.admin, request(), { key: 'shared-key-0003' });
    const second = await t.bulk(t.cookie(), request(), { key: 'shared-key-0003' });
    expect(second.json.bulk_id).not.toBe(first.json.bulk_id);
  });
});

describe('the existing tenant PATCH', () => {
  it('still answers as before and shares nothing of the bulk request', async () => {
    const t = await setup();
    const version = (await t.doc('tenant-a', 'session')).version;
    const saved = await t.call(t.admin, 'PATCH', '/api/admin/tenants/tenant-a/settings/session', {
      ifMatch: version,
      set: { [TTL]: 3000000 },
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ applied: [TTL], cleared: [], rejected: {} });
    expect(saved.json.dryRun).toBeUndefined();
    const stale = await t.call(t.admin, 'PATCH', '/api/admin/tenants/tenant-a/settings/session', {
      ifMatch: version,
      set: { [TTL]: 3100000 },
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await t.call(t.admin, 'PATCH', '/api/admin/tenants/tenant-a/settings/session', {
          set: { [TTL]: 1 },
        })
      ).status
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the size of an answer', () => {
  /** String settings of the login UI: they exist, and the bulk apply does not give them. */
  const longKeys = Object.values(ALL_CATEGORY_META['login-ui'].settings)
    .filter((meta) => meta.type === 'string')
    .map((meta) => meta.key)
    .slice(0, 15);
  const big = (n: number) => 'x'.repeat(n);
  const heavy = (mode: string) =>
    request({
      mode,
      tenant_ids: BULK_TENANTS.slice(0, 25),
      changes: [
        ttl(7200000),
        { category: 'login-ui', set: Object.fromEntries(longKeys.map((k) => [k, big(2000)])) },
      ],
    });

  it.each(['preview', 'apply'])(
    'keeps a %s of 25 tenants and 16 settings with long values within what a replay can keep',
    async (mode) => {
      const t = await setup();
      expect(longKeys).toHaveLength(15);
      const first = await t.bulk(t.admin, heavy(mode), { key: `heavy-key-${mode}` });

      expect(first.status).toBe(200);
      const size = JSON.stringify(first.json).length;
      expect(size).toBeLessThan(1024 * 1024);
      // The long values are not repeated in the answer, whole.
      expect(JSON.stringify(first.json)).not.toContain(big(300));
      // The answer was kept, and a repeat of the request gets it back.
      const stored = t.cores['tenant-a']
        .prepare('SELECT response_status AS s FROM idempotency_keys')
        .all() as Array<{ s: number }>;
      expect(stored.map((row) => row.s)).toEqual([200]);
      const again = await t.bulk(t.admin, heavy(mode), { key: `heavy-key-${mode}` });
      expect(again.status).toBe(200);
      expect(again.json).toEqual(first.json);
      if (mode === 'apply') {
        expect(await t.own('bulk-25', 'session', TTL)).toBe(7200000);
      }
    }
  );

  it('shows a long proposed value as its type and length, and a short one as it is', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        mode: 'preview',
        tenant_ids: ['tenant-a'],
        changes: [ttl(7200000), { category: 'login-ui', set: { [longKeys[0]]: big(1000) } }],
      })
    );
    const [short, long] = resultFor(response.json, 'tenant-a').changes;
    expect(short.proposed).toBe(7200000);
    expect(long.proposed).toEqual({ value_too_large: true, type: 'string', length: 1002 });
  });

  it('refuses a value over 2048 characters, and values that add up to over 32768, before doing anything', async () => {
    const t = await setup();
    const before = t.snapshot();
    const one = await t.bulk(
      t.admin,
      request({ changes: [{ category: 'login-ui', set: { [longKeys[0]]: big(2100) } }] })
    );
    expect(one.status).toBe(400);
    expect(one.json).toMatchObject({ code: 'value_too_large' });
    const twenty = Object.values(ALL_CATEGORY_META['login-ui'].settings)
      .filter((meta) => meta.type === 'string')
      .map((meta) => meta.key)
      .slice(0, 20);
    const many = await t.bulk(
      t.admin,
      request({
        changes: [
          {
            category: 'login-ui',
            set: Object.fromEntries(twenty.map((k) => [k, big(2040)])),
          },
        ],
      })
    );
    expect(many.status).toBe(400);
    expect(many.json).toMatchObject({ code: 'value_too_large' });
    expect(t.snapshot()).toEqual(before);
    expect(
      t.cores['tenant-a']
        .prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_status = 425')
        .get()
    ).toEqual({ n: 0 });
  });

  it('refuses at once a request whose answer could pass the limit, with the limits raised', async () => {
    const t = await setup({
      BULK_APPLY_MAX_TENANTS_PER_REQUEST: '100',
      BULK_APPLY_MAX_KEYS_PER_REQUEST: '100',
    });
    const keys = Object.values(ALL_CATEGORY_META['login-ui'].settings)
      .map((meta) => meta.key)
      .slice(0, 100);
    const response = await t.bulk(
      t.admin,
      request({
        mode: 'preview',
        tenant_ids: BULK_TENANTS.concat(Array.from({ length: 70 }, (_, i) => `more-${i}`)),
        changes: [{ category: 'login-ui', set: Object.fromEntries(keys.map((k) => [k, 'v'])) }],
      })
    );
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ code: 'response_too_large' });
    expect(
      t.cores['tenant-a']
        .prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_status = 425')
        .get()
    ).toEqual({ n: 0 });
  });
});

describe('counting what a request asks for', () => {
  it('counts a category and a key together, so the same key in several categories counts each time', async () => {
    const t = await setup({ BULK_APPLY_MAX_KEYS_PER_REQUEST: '3' });
    const response = await t.bulk(
      t.admin,
      request({
        changes: [
          { category: 'session', set: { 'a.b': 1, 'c.d': 1 } },
          { category: 'oauth', set: { 'a.b': 1, 'c.d': 1 } },
        ],
      })
    );
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ code: 'too_many_keys', limit: 3 });
  });

  it('limits the changes, and refuses a long list at once rather than expanding it for every tenant', async () => {
    const t = await setup();
    const changes = Array.from({ length: 1500 }, (_, i) => ({
      category: `unknown-${i}`,
      set: { 'a.b': 1 },
    }));
    const response = await t.bulk(
      t.admin,
      request({ changes, tenant_ids: BULK_TENANTS.slice(0, 25) })
    );
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ code: 'too_many_changes', limit: 20 });
  });

  it('refuses a category that does not exist for the request as a whole, not once for each tenant', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({ changes: [ttl(7200000), { category: 'no-such-category', set: { 'a.b': 1 } }] })
    );
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ code: 'unknown_category' });
    expect(await t.own('tenant-a', 'session', TTL)).toBeUndefined();
  });
});

describe('a preview leaves no trace', () => {
  it('makes no settings document, in KV or the Admin database, and takes no backup permit', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        mode: 'preview',
        tenant_ids: TENANTS,
        changes: [
          ttl(7200000),
          { category: 'oauth', set: { 'oauth.access_token_expiry': 900 } },
          { category: 'identity-mapping', set: { [MAPPING_KEY]: 'set-plat' } },
          { category: 'plugin', set: { 'plugin.enabled': false } },
        ],
      })
    );
    expect(response.status).toBe(200);
    expect(t.rows('SELECT COUNT(*) AS n FROM tenant_settings_documents')).toBe(0);
    expect(t.rows('SELECT COUNT(*) AS n FROM platform_settings_documents')).toBe(0);
    expect([...t.settings.store.keys()]).toEqual([]);
    expect(runTenantBackupCoveredMutation).not.toHaveBeenCalled();
    expect(
      response.json.results.every((r: any) => r.changes.every((c: any) => c.version !== null))
    ).toBe(true);
  });

  it('is not what an apply is: an apply does take the permit, for each tenant', async () => {
    const t = await setup();
    await t.bulk(t.admin, request());
    expect(runTenantBackupCoveredMutation).toHaveBeenCalledTimes(2);
  });
});

describe('the records of a change made in bulk', () => {
  it('name the keys and what was done, and hold no value, before or after, in the record or the log', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });
    vi.mocked(createAuditLogFromContext).mockClear();
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      })
    );
    try {
      await t.bulk(
        t.admin,
        request({
          on_existing_override: 'overwrite',
          changes: [
            ttl(7654321),
            { category: 'oauth', set: { 'oauth.access_token_expiry': 4321 } },
            { category: 'session', clear: ['session.max_ttl'] },
          ].slice(0, 2),
        })
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const updated = audits('settings.settings.updated');
    expect(updated).toHaveLength(4);
    for (const entry of updated) {
      const text = JSON.stringify(entry.metadata);
      expect(text).not.toMatch(/7654321|4321|1800000|before|after|diff/);
      expect(entry.metadata).toMatchObject({
        changed_keys: expect.any(Array),
        results: expect.any(Object),
        bulk_id: expect.any(String),
      });
    }
    const session = updated.find(
      (u) =>
        (u.metadata as any).scope_id === 'tenant-b' && (u.metadata as any).category === 'session'
    )!;
    expect(session.metadata).toMatchObject({
      changed_keys: [TTL],
      results: { [TTL]: 'applied' },
      bulk_operations: { [TTL]: 'set' },
    });
    expect(logged.join('\n')).not.toMatch(/7654321|1800000/);
  });

  it('record an undo as a clear', async () => {
    const t = await setup();
    await t.seed('tenant-a', 'session', { [TTL]: 1800000 });
    vi.mocked(createAuditLogFromContext).mockClear();
    await t.bulk(
      t.admin,
      request({
        tenant_ids: ['tenant-a'],
        changes: [{ category: 'session', clear: [TTL] }],
        on_existing_override: 'overwrite',
      })
    );
    const [entry] = audits('settings.settings.updated');
    expect(entry.metadata).toMatchObject({ results: { [TTL]: 'cleared' } });
    expect(JSON.stringify(entry.metadata)).not.toContain('1800000');
  });

  it('leave the record of a PATCH as it was: with the values', async () => {
    const t = await setup();
    await t.seed('tenant-a', 'session', { [TTL]: 1800000 });
    const [entry] = audits('settings.settings.updated');
    expect(entry.metadata).toHaveProperty('diff');
    expect(entry.metadata).not.toHaveProperty('changed_keys');
  });
});

describe('expected versions, before anything is left alone', () => {
  it('reports a changed document as a conflict even where the key would have been skipped', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });
    const preview = await t.bulk(t.admin, request({ mode: 'preview', tenant_ids: ['tenant-b'] }));
    const version = resultFor(preview.json, 'tenant-b').changes[0].version;
    // The tenant sets a value of its own after the preview.
    const doc = await t.doc('tenant-b', 'session');
    await t.call(t.admin, 'PATCH', '/api/admin/tenants/tenant-b/settings/session', {
      ifMatch: doc.version,
      set: { [TTL]: 2400000 },
    });

    const response = await t.bulk(
      t.admin,
      request({ tenant_ids: ['tenant-b'], expected: { 'tenant-b': { session: version } } })
    );

    expect(resultFor(response.json, 'tenant-b')).toMatchObject({
      status: 'conflict',
      changes: [{ status: 'conflict', reason: 'version_changed', version_after: null }],
    });
    expect(await t.own('tenant-b', 'session', TTL)).toBe(2400000);
  });

  it('still skips a key when the version is the one the preview returned', async () => {
    const t = await setup();
    await t.seed('tenant-b', 'session', { [TTL]: 1800000 });
    const preview = await t.bulk(t.admin, request({ mode: 'preview', tenant_ids: ['tenant-b'] }));
    const version = resultFor(preview.json, 'tenant-b').changes[0].version;
    const response = await t.bulk(
      t.admin,
      request({ tenant_ids: ['tenant-b'], expected: { 'tenant-b': { session: version } } })
    );
    expect(resultFor(response.json, 'tenant-b').changes[0]).toMatchObject({
      status: 'skipped',
      reason: 'existing_override',
    });
  });

  it('does not hold a category the caller may not edit to a version: that is a refusal', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({ expected: { 'tenant-a': { session: 'sha256:0000000000000000' } } }),
      { headers: { 'x-test-narrow': 'roles' } }
    );
    expect(resultFor(response.json, 'tenant-a').changes[0]).toMatchObject({
      status: 'rejected',
      reason: 'forbidden',
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('an answer is never bigger than its estimate', () => {
  const FREE_TEXT_KEYS: Array<[string, string]> = [
    ['discovery', 'discovery.claims_supported'],
    ['discovery', 'discovery.acr_values_supported'],
    ['tokens', 'tokens.rbac_id_token_claims'],
    ['tokens', 'tokens.rbac_access_token_claims'],
  ];
  const textChanges = (value: string) =>
    ['discovery', 'tokens'].map((category) => ({
      category,
      set: Object.fromEntries(
        FREE_TEXT_KEYS.filter(([c]) => c === category).map(([, key]) => [key, value])
      ),
    }));
  const bytes = (json: unknown) => new TextEncoder().encode(JSON.stringify(json)).length;
  const variants: Array<[string, string, string]> = [
    ['plain text', 'a'.repeat(254), 'b'.repeat(254)],
    ['kanji', '漢'.repeat(84), '字'.repeat(84)],
    ['kanji over the cap', '漢'.repeat(254), '字'.repeat(254)],
    ['quotes', '"'.repeat(127), '"'.repeat(126)],
    ['backslashes', '\\'.repeat(127), '\\'.repeat(126)],
    ['control characters', '\u0001'.repeat(41), '\u001f'.repeat(41)],
    ['surrogate pairs', '😀'.repeat(63), '😁'.repeat(63)],
    ['a lone surrogate', '\ud800'.repeat(42), '\udc00'.repeat(42)],
    ['combining characters', 'e\u0301'.repeat(80), 'a\u0300'.repeat(80)],
  ];

  it.each(variants)(
    'holds for %s that the tenants already have and the request proposes, in a preview and an apply',
    async (_name, existing, proposed) => {
      const t = await setup();
      const ids = BULK_TENANTS.slice(0, 8);
      for (const id of ids) {
        for (const change of textChanges(existing)) await t.seed(id, change.category, change.set);
      }
      for (const mode of ['preview', 'apply']) {
        const changes = textChanges(proposed);
        const response = await t.bulk(
          t.admin,
          request({ mode, tenant_ids: ids, changes, on_existing_override: 'overwrite' }),
          { key: `utf8-key-${mode}-${sequence}` }
        );
        expect(response.status, mode).toBe(200);
        const estimate = estimateResponseBytes(
          mode as 'preview' | 'apply',
          ids,
          changes.map((c) => ({ ...c, clear: [] }))
        );
        expect(bytes(response.json), mode).toBeLessThanOrEqual(estimate);
        expect(estimate).toBeLessThan(1_000_000);
      }
    }
  );

  it('keeps 100 tenants with 128-character IDs and four kanji values within the limit, and replayable', async () => {
    const t = await setup({
      BULK_APPLY_MAX_TENANTS_PER_REQUEST: '100',
      BULK_APPLY_MAX_KEYS_PER_REQUEST: '100',
    });
    const existing = '漢'.repeat(254);
    for (const id of LONG_TENANTS) {
      for (const change of textChanges(existing)) await t.seed(id, change.category, change.set);
    }
    for (const mode of ['preview', 'apply']) {
      const changes = textChanges('字'.repeat(254));
      const body = request({
        mode,
        tenant_ids: LONG_TENANTS,
        changes,
        on_existing_override: 'overwrite',
      });
      const first = await t.bulk(t.admin, body, { key: `long-ids-key-${mode}` });
      expect(first.status, mode).toBe(200);
      expect(bytes(first.json), mode).toBeLessThan(1024 * 1024);
      expect(bytes(first.json), mode).toBeLessThanOrEqual(
        estimateResponseBytes(
          mode as 'preview' | 'apply',
          LONG_TENANTS,
          changes.map((c) => ({ ...c, clear: [] }))
        )
      );
      const again = await t.bulk(t.admin, body, { key: `long-ids-key-${mode}` });
      expect(again.status, mode).toBe(200);
      expect(again.json).toEqual(first.json);
    }
    expect(
      t.cores['tenant-a']
        .prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_status = 425')
        .get()
    ).toEqual({ n: 0 });
  });

  it('does not refuse the largest request that is in order: 25 tenants and 20 settings of 254 characters', async () => {
    const t = await setup();
    const colors = [
      'background_color',
      'accent_color',
      'title_color',
      'text_color',
      'copy_color',
      'login_panel_background_color',
      'login_panel_background_gradient_color',
    ].map((name) => `login-ui.${name}`);
    const long = '#' + 'a'.repeat(253);
    const changes = [
      {
        category: 'login-ui',
        set: {
          ...Object.fromEntries(colors.map((key) => [key, long])),
          'login-ui.supported_locales': 'en,ja',
          'login-ui.header_enabled': true,
          'login-ui.footer_enabled': true,
          'login-ui.powered_by_enabled': false,
        },
      },
      {
        category: 'security',
        set: {
          'security.request_object_signing_algs': 'RS256,ES256',
          'security.authorization_signing_algs': 'RS256,ES256',
          'security.fapi_message_signing_enabled': false,
        },
      },
      {
        category: 'tokens',
        set: { 'tokens.rbac_id_token_claims': long, 'tokens.rbac_access_token_claims': long },
      },
      {
        category: 'discovery',
        set: { 'discovery.claims_supported': long, 'discovery.acr_values_supported': long },
      },
      {
        category: 'authentication-methods',
        set: { 'authentication-methods.totp.default_acr': long },
      },
      { category: 'diagnostic-logging', set: { 'diagnostic-logging.http_safe_headers': long } },
    ];
    expect(changes.flatMap((c) => Object.keys(c.set))).toHaveLength(20);
    const ids = BULK_TENANTS.slice(0, 25);
    for (const mode of ['preview', 'apply']) {
      const response = await t.bulk(t.admin, request({ mode, tenant_ids: ids, changes }));
      expect(response.status, mode).toBe(200);
      expect(bytes(response.json), mode).toBeLessThanOrEqual(
        estimateResponseBytes(
          mode as 'preview' | 'apply',
          ids,
          changes.map((c) => ({ ...c, clear: [] }))
        )
      );
    }
  });

  it('is the bytes of the JSON that are counted for a value of a request, not its characters', async () => {
    const t = await setup();
    // 700 kanji are 700 characters but 2,102 bytes as JSON.
    const response = await t.bulk(
      t.admin,
      request({
        changes: [
          { category: 'discovery', set: { 'discovery.claims_supported': '漢'.repeat(700) } },
        ],
      })
    );
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ code: 'value_too_large' });
    // And 600 are 1,802 bytes: within the limit.
    const ok = await t.bulk(
      t.admin,
      request({
        changes: [
          { category: 'discovery', set: { 'discovery.claims_supported': '漢'.repeat(600) } },
        ],
      })
    );
    expect(ok.status).toBe(200);
  });
});

describe('what a refusal says', () => {
  it('names no setting the tenant has saved: not in the answer, not in the failure record', async () => {
    const t = await setup();
    // The tenant has an App Login client saved; its App Login is not on, so choosing it is refused.
    const doc = await t.doc('tenant-a', 'login-entry');
    expect(
      (
        await t.call(t.admin, 'PATCH', '/api/admin/tenants/tenant-a/settings/login-entry', {
          ifMatch: doc.version,
          set: {
            'login-entry.app_login_client_id': 'client-sensitive',
            'login-entry.app_login_redirect_uri': 'https://secret.example.com/cb',
          },
        })
      ).status
    ).toBe(200);
    vi.mocked(createAuditLogFromContext).mockClear();

    const body = (mode: string) =>
      request({
        mode,
        tenant_ids: ['tenant-a'],
        changes: [
          { category: 'login-entry', set: { 'login-entry.post_login_behavior': 'app_login' } },
        ],
      });
    const preview = await t.bulk(t.admin, body('preview'));
    const apply = await t.bulk(t.admin, body('apply'));

    expect(resultFor(apply.json, 'tenant-a').changes[0]).toMatchObject({
      status: 'rejected',
      reason: 'validation_failed',
    });
    expect(resultFor(preview.json, 'tenant-a').changes[0]).toMatchObject({
      action: 'would_reject',
    });
    const answer = JSON.stringify([preview.json, apply.json]);
    expect(answer).not.toMatch(/client-sensitive|secret\.example\.com|resolutionLink/);
    const failures = audits('settings.patch.failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].metadata).toMatchObject({
      category: 'login-entry',
      reason: 'post_login_validation_failed',
      bulk_id: apply.json.bulk_id,
    });
    expect(JSON.stringify(failures)).not.toMatch(
      /client-sensitive|secret\.example\.com|resolutionLink|clientId/
    );
  });

  it('leaves the failure record of a PATCH as it was, with what the validation found', async () => {
    const t = await setup();
    const doc = await t.doc('tenant-a', 'login-entry');
    await t.call(t.admin, 'PATCH', '/api/admin/tenants/tenant-a/settings/login-entry', {
      ifMatch: doc.version,
      set: { 'login-entry.app_login_client_id': 'client-sensitive' },
    });
    vi.mocked(createAuditLogFromContext).mockClear();
    const again = await t.doc('tenant-a', 'login-entry');
    const refused = await t.call(
      t.admin,
      'PATCH',
      '/api/admin/tenants/tenant-a/settings/login-entry',
      {
        ifMatch: again.version,
        set: { 'login-entry.post_login_behavior': 'app_login' },
      }
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(audits('settings.patch.failure'))).toContain(
      'post_login_validation_failed'
    );
  });

  it('keeps the other details of a failure to codes: the version and the keys, no messages', async () => {
    const t = await setup();
    const response = await t.bulk(
      t.admin,
      request({
        changes: [
          { category: 'oauth', set: { 'oauth.access_token_expiry': 'a value that is wrong' } },
        ],
      })
    );
    expect(resultFor(response.json, 'tenant-a').changes[0].status).toBe('rejected');
    const [failure] = audits('settings.patch.failure');
    expect(failure.metadata).toMatchObject({ rejected_keys: ['oauth.access_token_expiry'] });
    expect(JSON.stringify(failure.metadata)).not.toContain('a value that is wrong');
    expect(failure.metadata).not.toHaveProperty('rejected');
  });
});
