import { describe, expect, it, vi } from 'vitest';
import {
  adminAuthMiddleware,
  institutionFromSettings,
  resolveEffectiveSettings,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: vi.fn(async () => undefined),
  };
});
vi.mock('../external-plugin-gate-sync', () => ({
  setRunnerExternalGate: vi.fn(async () => undefined),
  reconcileRunnerExternalGate: vi.fn(async () => undefined),
}));

import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import settingsV2, { hasTenantSettingsPermission } from '../routes/settings-v2';
import { validateCategoryPatch } from '../routes/settings-v2/patch-validation';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  createTokenKit,
  insertRole,
  setupApp,
  signIn,
  type Assignment,
} from './helpers/admin-authority-fixture';

/**
 * Who may change the institution of a tenant (its scopes and its names), on the real Admin schema,
 * the real admin authentication and route access, and the real Settings API. The people and
 * credentials that run a tenant may read it and may not change it; only platform authority may.
 */

const SCOPES = 'institution.scopes';
const NAMES = 'institution.display_names';
const URL = `/api/admin/tenants/${TENANT}/settings/institution`;
const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
const NAMES_VALUE = JSON.stringify({ ja: '例大学', en: 'Example University' });

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

async function setup() {
  const kit = await createTokenKit('https://tenant-a.example.com');
  const settings = kv();
  const envExtras: Record<string, unknown> = {
    SETTINGS: settings.namespace,
    AUTHRIM_CONFIG: settings.namespace,
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
  };
  const context = setupApp((app) => {
    app.use(
      '/api/admin/*',
      adminAuthMiddleware({ plane: 'tenant' }),
      enforceDeclaredAdminRouteAccess()
    );
    app.route('/api/admin', settingsV2);
  }, envExtras);
  const cookie = (assignments: Assignment[]) => signIn(context.db, assignments).cookie;
  const principal = (permissions: string[], scope: 'all' | 'allow') => {
    sequence += 1;
    const now = Date.now();
    const id = `amp_institution_${sequence}`;
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'Institution', 'automation', 'active', 'authrim:admin-api', 600, ?, ?)`
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
  const version = async (who: string) =>
    (await context.call(who, 'GET', URL)).json.version as string;
  const patch = async (who: string, body: Record<string, unknown>) =>
    context.call(who, 'PATCH', URL, { ifMatch: await version(who), ...body });
  const patchAsToken = async (token: string, reader: string, body: Record<string, unknown>) =>
    context.callWithToken(token, 'PATCH', URL, { ifMatch: await version(reader), ...body });
  const saved = async () =>
    institutionFromSettings(
      await resolveEffectiveSettings({ SETTINGS: settings.namespace } as never, 'institution', {
        tenantId: TENANT,
        fresh: true,
      })
    );
  return { ...context, settings, cookie, principal, patch, patchAsToken, saved };
}

const registration = { set: { [SCOPES]: 'example.ac.jp,med.example.ac.jp', [NAMES]: NAMES_VALUE } };

describe('who may change the institution of a tenant', () => {
  const people: Array<{
    name: string;
    assignments: Assignment[];
    outcome: 'changes' | 'refused';
  }> = [
    {
      name: 'a platform administrator (global ar_super_admin)',
      assignments: GLOBAL_SUPER_ADMIN,
      outcome: 'changes',
    },
    {
      name: 'the tenant’s own ar_super_admin (held for the tenant alone)',
      assignments: TENANT_SUPER_ADMIN,
      outcome: 'refused',
    },
    {
      name: 'a global viewer who is the ar_super_admin of the tenant',
      assignments: GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
      outcome: 'refused',
    },
  ];

  it.each(people)('$name: $outcome', async ({ assignments, outcome }) => {
    const t = await setup();
    const who = t.cookie(assignments);
    const response = await t.patch(who, registration);

    if (outcome === 'changes') {
      expect(response.status).toBe(200);
      expect(response.json.applied.sort()).toEqual([NAMES, SCOPES]);
      expect(await t.saved()).toEqual({
        scopes: {
          state: 'set',
          scopes: ['example.ac.jp', 'med.example.ac.jp'],
          defaultScope: 'example.ac.jp',
        },
        displayNames: { ja: '例大学', en: 'Example University' },
      });
    } else {
      expect(response.status).toBe(403);
      expect(await t.saved()).toEqual({ scopes: { state: 'unset' }, displayNames: {} });
    }
  });

  it('refuses a tenant administrator whose role does change the other settings of the tenant', async () => {
    const t = await setup();
    // A role the tenant settings API lets edit the other settings of its tenant (ar_tenant_admin).
    insertRole(t.db, {
      id: 'role_settings_admin',
      name: 'ar_tenant_admin',
      permissions: ['admin:settings:read', 'admin:settings:write'],
      hierarchy: 50,
    });
    const who = t.cookie([
      { role: 'role_settings_admin', scope: 'tenant' },
      { role: 'role_ar_viewer', scope: 'tenant' },
    ]);

    const session = await t.call(who, 'GET', `/api/admin/tenants/${TENANT}/settings/limits`);
    const other = await t.call(who, 'PATCH', `/api/admin/tenants/${TENANT}/settings/limits`, {
      ifMatch: session.json.version,
      set: { 'limits.max_custom_claims': 30 },
    });
    const institution = await t.patch(who, registration);

    expect(other.status).toBe(200);
    expect(institution.status).toBe(403);
    expect((await t.saved()).scopes.state).toBe('unset');
  });

  it('lets the tenant’s own administrators read what the platform set', async () => {
    const t = await setup();
    await t.patch(t.cookie(GLOBAL_SUPER_ADMIN), registration);

    const read = await t.call(t.cookie(TENANT_SUPER_ADMIN), 'GET', URL);

    expect(read.status).toBe(200);
    expect(read.json.values[SCOPES]).toBe('example.ac.jp,med.example.ac.jp');
    expect(read.json.values[NAMES]).toBe(NAMES_VALUE);
  });

  it('does not let the tenant’s own administrators clear it either', async () => {
    const t = await setup();
    await t.patch(t.cookie(GLOBAL_SUPER_ADMIN), registration);

    const cleared = await t.patch(t.cookie(TENANT_SUPER_ADMIN), { clear: [SCOPES] });

    expect(cleared.status).toBe(403);
    expect((await t.saved()).scopes.state).toBe('set');
  });

  it('has no way around it in the settings history, which does not take this category', async () => {
    const t = await setup();
    await t.patch(t.cookie(GLOBAL_SUPER_ADMIN), registration);

    // The tenant's administrators are stopped by the platform gate of the rollback itself, the
    // platform's by the category, which the history does not take.
    for (const [who, status] of [
      [TENANT_SUPER_ADMIN, 403],
      [GLOBAL_SUPER_ADMIN, 400],
    ] as const) {
      const rollback = await t.call(
        t.cookie(who),
        'POST',
        '/api/admin/settings/institution/rollback',
        { targetVersion: 1 }
      );
      expect(rollback.status).toBe(status);
    }
    expect((await t.saved()).scopes.state).toBe('set');
  });

  it('lets a credential that may write the settings of every tenant change it, and no other', async () => {
    const t = await setup();
    const reader = t.cookie(GLOBAL_SUPER_ADMIN);
    const everyTenant = await t.principal(['admin:settings:write', 'admin:settings:read'], 'all');
    const oneTenant = await t.principal(['admin:settings:write', 'admin:settings:read'], 'allow');
    const readOnly = await t.principal(['admin:settings:read'], 'all');

    expect((await t.patchAsToken(oneTenant, reader, registration)).status).toBe(403);
    expect((await t.patchAsToken(readOnly, reader, registration)).status).toBe(403);
    expect((await t.saved()).scopes.state).toBe('unset');

    expect((await t.patchAsToken(everyTenant, reader, registration)).status).toBe(200);
    expect((await t.saved()).scopes.state).toBe('set');
  });
});

describe('the check itself', () => {
  const auth = (overrides: Partial<AdminAuthContext>): AdminAuthContext =>
    ({
      userId: 'admin-x',
      tenantId: TENANT,
      roles: ['ar_super_admin'],
      globalRoles: [],
      tenantScope: [TENANT],
      permissions: ['*'],
      authMethod: 'session',
      actorType: 'human',
      ...overrides,
    }) as unknown as AdminAuthContext;

  it('asks for platform authority to edit, and nothing more to view', () => {
    const tenantAdmin = auth({});
    const platformAdmin = auth({ globalRoles: ['ar_super_admin'], tenantScope: ['*'] });

    expect(hasTenantSettingsPermission(tenantAdmin, 'institution', 'view', TENANT)).toBe(true);
    expect(hasTenantSettingsPermission(tenantAdmin, 'institution', 'edit', TENANT)).toBe(false);
    expect(hasTenantSettingsPermission(platformAdmin, 'institution', 'edit', TENANT)).toBe(true);
    // Another category is as it was.
    expect(hasTenantSettingsPermission(tenantAdmin, 'session', 'edit', TENANT)).toBe(true);
  });

  it('never lets an agent edit, whatever permissions it holds', () => {
    const agent = auth({
      actorType: 'agent',
      authMethod: 'machine_access_token',
      tenantScope: ['*'],
      permissions: ['*'],
    });

    expect(hasTenantSettingsPermission(agent, 'institution', 'edit', TENANT)).toBe(false);
  });

  it('has no one without authority edit', () => {
    expect(hasTenantSettingsPermission(undefined, 'institution', 'edit', TENANT)).toBe(false);
    expect(hasTenantSettingsPermission(undefined, 'institution', 'view', TENANT)).toBe(false);
  });
});

describe('what may be saved', () => {
  it.each([
    ['an unregistrable domain name', 'exa mple.ac.jp'],
    ['a wildcard', '*.example.ac.jp'],
    ['an uppercase domain name', 'Example.AC.JP'],
    ['a single label', 'example'],
    ['an IP address', '192.168.0.1'],
    ['an empty list', ''],
    ['an empty entry', 'example.ac.jp,'],
    ['a repeated scope', 'example.ac.jp,example.ac.jp'],
  ])('refuses scopes with %s', async (_name, value) => {
    const t = await setup();
    const response = await t.patch(t.cookie(GLOBAL_SUPER_ADMIN), { set: { [SCOPES]: value } });

    expect(response.status).toBe(400);
    expect(response.json.message).toMatch(/institution\.scopes/);
    expect((await t.saved()).scopes.state).toBe('unset');
  });

  it.each([
    ['names with no English', JSON.stringify({ ja: '例大学' })],
    ['names with no Japanese', JSON.stringify({ en: 'Example University' })],
    ['an empty set of names', '{}'],
    ['text that is not JSON', 'Example University'],
    ['a name that is empty', JSON.stringify({ ja: '', en: 'Example University' })],
  ])('refuses %s', async (_name, value) => {
    const t = await setup();
    const response = await t.patch(t.cookie(GLOBAL_SUPER_ADMIN), { set: { [NAMES]: value } });

    expect(response.status).toBe(400);
    expect(response.json.message).toMatch(/institution\.display_names/);
    expect((await t.saved()).displayNames).toEqual({});
  });

  it('refuses a value that is not text, and a key the category does not have', async () => {
    const t = await setup();
    const who = t.cookie(GLOBAL_SUPER_ADMIN);

    expect((await t.patch(who, { set: { [SCOPES]: ['example.ac.jp'] } })).status).toBe(400);
    expect((await t.patch(who, { set: { 'institution.other': 'x' } })).status).toBe(400);
  });

  it('refuses to disable a setting, which would read back as something else', async () => {
    const t = await setup();
    const who = t.cookie(GLOBAL_SUPER_ADMIN);
    await t.patch(who, registration);

    const response = await t.patch(who, { disable: [SCOPES] });

    expect(response.status).toBe(400);
    expect((await t.saved()).scopes.state).toBe('set');
  });

  it('saves nothing of a request that has one bad value among good ones', async () => {
    const t = await setup();
    const response = await t.patch(t.cookie(GLOBAL_SUPER_ADMIN), {
      set: { [SCOPES]: 'example.ac.jp', [NAMES]: JSON.stringify({ ja: '例大学' }) },
    });

    expect(response.status).toBe(400);
    expect(await t.saved()).toEqual({ scopes: { state: 'unset' }, displayNames: {} });
  });

  it('lets the platform clear them, back to a tenant with no institution', async () => {
    const t = await setup();
    const who = t.cookie(GLOBAL_SUPER_ADMIN);
    await t.patch(who, registration);

    const cleared = await t.patch(who, { clear: [SCOPES, NAMES] });

    expect(cleared.status).toBe(200);
    expect(await t.saved()).toEqual({ scopes: { state: 'unset' }, displayNames: {} });
  });

  it('is checked the same way wherever else settings are validated (imports, profiles)', () => {
    expect(
      validateCategoryPatch('institution', { ifMatch: '', set: { [SCOPES]: '*.x.example' } })
    ).toMatch(/institution\.scopes/);
    expect(
      validateCategoryPatch('institution', { ifMatch: '', set: { [SCOPES]: 'example.ac.jp' } })
    ).toBeNull();
    expect(validateCategoryPatch('institution', { ifMatch: '', disable: [SCOPES] })).toMatch(
      /cannot be disabled/
    );
    expect(validateCategoryPatch('institution', { ifMatch: '', clear: [SCOPES] })).toBeNull();
  });

  it('is available at the tenant and nowhere else', async () => {
    const t = await setup();
    const who = t.cookie(GLOBAL_SUPER_ADMIN);

    const platform = await t.call(who, 'PATCH', '/api/admin/platform/settings/institution', {
      ifMatch: 'x',
      set: { [SCOPES]: 'example.ac.jp' },
    });

    expect(platform.status).toBe(400);
  });
});
