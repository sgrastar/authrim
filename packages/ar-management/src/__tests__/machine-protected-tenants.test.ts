import { beforeEach, describe, expect, it, vi } from 'vitest';

// The step-up gate (tested on its own) is mocked: it stands for "enforcement switched off" or a
// human who passed it. What is under test here is that a machine is refused BEFORE it.
const { gate } = vi.hoisted(() => ({
  gate: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
}));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(),
}));
vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return { ...actual, writeAdminAuditLog: vi.fn(async () => undefined) };
});

import { adminAuthMiddleware } from '@authrim/ar-lib-core';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';
import { machineAccessRouter } from '../routes/admin-management/machine-access';
import {
  GLOBAL_SUPER_ADMIN,
  TENANT,
  createTokenKit,
  insertRole,
  setupApp,
  signIn,
} from './helpers/admin-authority-fixture';

/**
 * The tenants the platform excludes from an all-tenants machine scope, against the real Admin
 * authentication, the real routers and the real Admin schema: machine access management and the
 * admin invitation (code hand-off) routes.
 */

const PROTECTED = 'tenant-prot';
const OTHER = 'tenant-b';
const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
const READ = 'admin:machine_access:read';
const WRITE = 'admin:machine_access:write';
const DELETE = 'admin:machine_access:delete';

type Scope = { mode: 'all' } | { mode: 'allow'; tenant: string };

async function setup(
  env: Record<string, unknown> = { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: PROTECTED }
) {
  const kit = await createTokenKit();
  const context = setupApp(
    (app) => {
      // The request context of a tenant-scoped route: the tenant is the X-Tenant-Id.
      app.use('/api/admin/*', async (c, next) => {
        const header = c.req.header('X-Tenant-Id');
        if (header) (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', header);
        await next();
      });
      app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
      app.route('/api/admin/machine-access', machineAccessRouter);
      app.route('/api/admin/admin-invitations', adminInvitationsRouter);
    },
    { ...kit.env, ...env }
  );
  // The column the hand-off migration adds (the fixture schema predates it).
  const hasColumn = (
    context.db.prepare("SELECT name FROM pragma_table_info('admin_invitations')").all() as Array<{
      name: string;
    }>
  ).some((column) => column.name === 'code_delivery');
  if (!hasColumn) {
    context.db.exec(
      "ALTER TABLE admin_invitations ADD COLUMN code_delivery TEXT NOT NULL DEFAULT 'email' CHECK (code_delivery IN ('email', 'response'))"
    );
  }
  let sequence = 0;
  const addPrincipal = (options: {
    type?: string;
    scopes: Scope[];
    permissions?: string[];
    clientId?: string;
  }) => {
    sequence += 1;
    const id = `amp_t${sequence}`;
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'Test', ?, 'active', 'authrim:admin-api', 600, ?, ?)`
      )
      .run(id, options.clientId ?? `client-${id}`, options.type ?? 'automation', now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ES256', 'Key', 'active', ?, ?)`
      )
      .run(`amk_${id}`, id, `kid-${id}`, JSON.stringify(PUBLIC_JWK), now, now);
    for (const permission of options.permissions ?? []) {
      context.db
        .prepare(
          `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
           VALUES (?, ?, ?)`
        )
        .run(id, permission, now);
    }
    for (const scope of options.scopes) {
      context.db
        .prepare(
          `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(id, scope.mode, scope.mode === 'allow' ? scope.tenant : null, now);
    }
    return { id, credentialId: `amk_${id}` };
  };
  const tokenOf = (principal: { credentialId: string }, permissions: string[]) =>
    kit.mint(context.db, principal.credentialId, permissions);
  const statusOf = (id: string) =>
    (
      context.db.prepare('SELECT status FROM admin_machine_principals WHERE id = ?').get(id) as
        | { status: string }
        | undefined
    )?.status;
  const credentialStatus = (id: string) =>
    (
      context.db.prepare('SELECT status FROM admin_machine_credentials WHERE id = ?').get(id) as
        | { status: string }
        | undefined
    )?.status;
  const principalCount = () =>
    (
      context.db.prepare('SELECT COUNT(*) AS n FROM admin_machine_principals').get() as {
        n: number;
      }
    ).n;
  return { ...context, kit, addPrincipal, tokenOf, statusOf, credentialStatus, principalCount };
}

const MGMT = '/api/admin/machine-access/principals';
const operations = () =>
  gate.mock.calls.flatMap((call) => {
    const descriptor = call[1] as { operation: string; alsoCovers?: string[] };
    return [descriptor.operation, ...(descriptor.alsoCovers ?? [])];
  });
const body = (overrides: Record<string, unknown> = {}) => ({
  client_id: `c-${Math.random().toString(36).slice(2)}`,
  display_name: 'New',
  principal_type: 'automation',
  permissions: [READ],
  tenant_scopes: [{ scope_mode: 'allow', tenant_id: OTHER }],
  ...overrides,
});

beforeEach(() => {
  gate.mockClear();
  gate.mockResolvedValue(null);
});

describe('machine access management by a non-platform all-tenants machine', () => {
  async function actor(env?: Record<string, unknown>) {
    const t = await setup(env);
    const principal = t.addPrincipal({
      scopes: [{ mode: 'all' }],
      permissions: [READ, WRITE, DELETE],
    });
    const token = await t.tokenOf(principal, [READ, WRITE, DELETE]);
    return { t, principal, token };
  }

  it('does not show, change, disable, delete or revoke what reaches a protected tenant', async () => {
    const { t, token } = await actor();
    const scoped = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: PROTECTED }],
      permissions: ['admin:users:read'],
    });
    const everyTenant = t.addPrincipal({
      scopes: [{ mode: 'all' }],
      permissions: ['admin:users:read'],
    });
    const mixed = t.addPrincipal({
      scopes: [
        { mode: 'allow', tenant: OTHER },
        { mode: 'allow', tenant: PROTECTED },
      ],
      permissions: ['admin:users:read'],
    });
    for (const target of [scoped, everyTenant, mixed]) {
      const base = `${MGMT}/${target.id}`;
      expect((await t.callWithToken(token, 'GET', base)).status, 'read').toBe(404);
      expect((await t.callWithToken(token, 'POST', `${base}/disable`)).status, 'disable').toBe(404);
      expect((await t.callWithToken(token, 'DELETE', base)).status, 'delete').toBe(404);
      expect(
        (await t.callWithToken(token, 'DELETE', `${base}/credentials/${target.credentialId}`))
          .status,
        'revoke'
      ).toBe(404);
      expect(
        (await t.callWithToken(token, 'PATCH', base, { display_name: 'x' })).status,
        'patch'
      ).toBe(404);
      expect(t.statusOf(target.id)).toBe('active');
      expect(t.credentialStatus(target.credentialId)).toBe('active');
    }
    const list = await t.callWithToken(token, 'GET', MGMT);
    const ids = (list.json.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).not.toContain(scoped.id);
    expect(ids).not.toContain(everyTenant.id);
    expect(ids).not.toContain(mixed.id);
  });

  it('still manages what reaches an unprotected tenant only', async () => {
    const { t, token } = await actor();
    const plain = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: OTHER }],
      permissions: ['admin:users:read'],
    });
    expect((await t.callWithToken(token, 'GET', `${MGMT}/${plain.id}`)).status).toBe(200);
    expect((await t.callWithToken(token, 'POST', `${MGMT}/${plain.id}/disable`)).status).toBe(200);
    expect(t.statusOf(plain.id)).toBe('disabled');
  });

  it('cannot name a protected tenant, give itself every tenant plus a protected one, or hand out every tenant', async () => {
    const { t, token, principal } = await actor();
    const before = t.principalCount();
    for (const scopes of [
      [{ scope_mode: 'allow', tenant_id: PROTECTED }],
      [
        { scope_mode: 'allow', tenant_id: OTHER },
        { scope_mode: 'allow', tenant_id: PROTECTED },
      ],
      [{ scope_mode: 'all' }],
    ]) {
      const created = await t.callWithToken(token, 'POST', MGMT, body({ tenant_scopes: scopes }));
      expect(created.status, JSON.stringify(scopes)).toBeGreaterThanOrEqual(400);
    }
    expect(t.principalCount()).toBe(before);
    // Itself: its own principal reaches every tenant, which is beyond its reach, so it is not found.
    const self = await t.callWithToken(token, 'PATCH', `${MGMT}/${principal.id}`, {
      tenant_scopes: [{ scope_mode: 'all' }, { scope_mode: 'allow', tenant_id: PROTECTED }],
    });
    expect(self.status).toBe(404);
    // A credential that names a protected tenant on a principal that does not reach it reaches
    // nothing (the principal's scope narrowed by the credential's): no protected grant is made.
    const victim = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: OTHER }],
      permissions: ['admin:users:read'],
    });
    const credential = await t.callWithToken(token, 'POST', `${MGMT}/${victim.id}/credentials`, {
      kid: 'k1',
      display_name: 'Key',
      alg: 'ES256',
      public_jwk: PUBLIC_JWK,
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }],
    });
    expect(credential.status).toBe(201);
    expect(operations()).not.toContain('machine.protected_grant');
  });

  it('can still create a principal for an unprotected tenant', async () => {
    const { t, token } = await actor();
    const created = await t.callWithToken(token, 'POST', MGMT, body());
    expect(created.status).toBe(201);
  });

  it('never creates or changes a platform principal while a tenant is listed', async () => {
    const { t, token } = await actor();
    const before = t.principalCount();
    for (const type of ['setup_tool', 'admin_ui_bff', 'internal_service']) {
      const created = await t.callWithToken(
        token,
        'POST',
        MGMT,
        body({
          principal_type: type,
          permissions: [],
          tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
        })
      );
      expect(created.status, type).toBeGreaterThanOrEqual(400);
    }
    expect(t.principalCount()).toBe(before);
    const platform = t.addPrincipal({
      type: 'setup_tool',
      scopes: [{ mode: 'allow', tenant: TENANT }],
      permissions: ['admin:users:read'],
    });
    expect((await t.callWithToken(token, 'GET', `${MGMT}/${platform.id}`)).status).toBe(404);
    expect((await t.callWithToken(token, 'POST', `${MGMT}/${platform.id}/disable`)).status).toBe(
      404
    );
    expect(t.statusOf(platform.id)).toBe('active');
    expect(gate).not.toHaveBeenCalled();
  });

  it('behaves as before while the list is empty: an admin:* machine still reads, rotates and creates platform principals', async () => {
    const t = await setup({ MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: '' });
    const principal = t.addPrincipal({ scopes: [{ mode: 'all' }], permissions: ['admin:*'] });
    const token = await t.tokenOf(principal, ['admin:*']);
    const platform = t.addPrincipal({
      type: 'setup_tool',
      scopes: [{ mode: 'all' }],
      permissions: ['admin:users:read'],
    });
    expect((await t.callWithToken(token, 'GET', `${MGMT}/${platform.id}`)).status).toBe(200);
    expect(
      (
        await t.callWithToken(
          token,
          'POST',
          `${MGMT}/${platform.id}/credentials/${platform.credentialId}/rotate`,
          { kid: 'rot-1', display_name: 'Rotated', alg: 'ES256', public_jwk: PUBLIC_JWK }
        )
      ).status
    ).toBe(201);
    const created = await t.callWithToken(
      token,
      'POST',
      MGMT,
      body({
        principal_type: 'internal_service',
        permissions: ['admin:users:read'],
        tenant_scopes: [{ scope_mode: 'all' }],
      })
    );
    expect(created.status).toBe(201);
    // Only the grant's own step-up was asked for, as before.
    expect(operations()).not.toContain('machine.protected_grant');
  });

  it('does not change for a machine while the list is empty, except for platform principals', async () => {
    const { t, token } = await actor({ MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: '' });
    const target = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: PROTECTED }],
      permissions: ['admin:users:read'],
    });
    expect((await t.callWithToken(token, 'GET', `${MGMT}/${target.id}`)).status).toBe(200);
    const created = await t.callWithToken(
      token,
      'POST',
      MGMT,
      body({ tenant_scopes: [{ scope_mode: 'all' }] })
    );
    expect(created.status).toBe(201);
  });

  it('is limited to what it names itself when it also names a protected tenant explicitly', async () => {
    const t = await setup();
    const principal = t.addPrincipal({
      scopes: [{ mode: 'all' }, { mode: 'allow', tenant: PROTECTED }],
      permissions: [READ, WRITE, DELETE],
    });
    const token = await t.tokenOf(principal, [READ, WRITE, DELETE]);
    const scoped = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: PROTECTED }],
      permissions: ['admin:users:read'],
    });
    expect((await t.callWithToken(token, 'GET', `${MGMT}/${scoped.id}`)).status).toBe(200);
    // Naming a protected tenant is still a signed-in human's step-up only.
    const created = await t.callWithToken(
      token,
      'POST',
      MGMT,
      body({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }] })
    );
    expect(created.status).toBe(403);
    expect(created.json.error).toBe('step_up_human_required');
  });
});

describe('machine access management by a signed-in platform administrator', () => {
  it('names a protected tenant or creates a platform principal only through the always-enforced step-up', async () => {
    const t = await setup();
    const human = signIn(t.db, GLOBAL_SUPER_ADMIN);
    const named = await t.call(
      human.cookie,
      'POST',
      MGMT,
      body({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }] })
    );
    expect(named.status).toBe(201);
    // One step-up for the whole request: the grant's, covering the protected grant too.
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0]?.[1]).toMatchObject({
      operation: 'machine.permission.grant',
      alsoCovers: ['machine.protected_grant'],
    });
    gate.mockClear();
    const platform = await t.call(
      human.cookie,
      'POST',
      MGMT,
      body({
        principal_type: 'setup_tool',
        permissions: [],
        tenant_scopes: [{ scope_mode: 'all' }],
      })
    );
    expect(platform.status).toBe(201);
    expect((gate.mock.calls[0]?.[1] as { operation: string }).operation).toBe(
      'machine.protected_grant'
    );
    // A refusal of the step-up stops the write.
    gate.mockResolvedValue(
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
    );
    const before = t.principalCount();
    const refused = await t.call(
      human.cookie,
      'POST',
      MGMT,
      body({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }] })
    );
    expect(refused.status).toBe(403);
    expect(t.principalCount()).toBe(before);
  });

  it('judges the protected grant on what a credential reaches by intersection: create, update and rotate', async () => {
    const t = await setup();
    const human = signIn(t.db, GLOBAL_SUPER_ADMIN);
    const principal = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: PROTECTED }],
      permissions: [READ],
    });
    // The key's own scope reaches another tenant, so reaching the protected one is a widening.
    t.db
      .prepare(
        `INSERT INTO admin_machine_credential_tenant_scopes (credential_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'allow', 'tenant-c', ?)`
      )
      .run(principal.credentialId, Date.now());
    const base = `${MGMT}/${principal.id}/credentials`;
    const key = { alg: 'ES256', public_jwk: PUBLIC_JWK, display_name: 'Key' };
    const allScope = { tenant_scopes: [{ scope_mode: 'all' }] };
    const calls: Array<[string, string, Record<string, unknown>]> = [
      ['POST', base, { kid: 'k-create', ...key, ...allScope }],
      ['PATCH', `${base}/${principal.credentialId}`, { ...allScope }],
      [
        'POST',
        `${base}/${principal.credentialId}/rotate`,
        { kid: 'k-rotate', ...key, ...allScope },
      ],
    ];
    for (const [method, path, payload] of calls) {
      gate.mockClear();
      const response = await t.call(human.cookie, method, path, payload);
      expect(response.status, `${method} ${path} ${JSON.stringify(response.json)}`).toBeLessThan(
        300
      );
      expect(operations(), `${method} ${path}`).toContain('machine.protected_grant');
    }
  });

  it('is not asked for the extra step-up for an unprotected tenant', async () => {
    const t = await setup();
    const human = signIn(t.db, GLOBAL_SUPER_ADMIN);
    const created = await t.call(human.cookie, 'POST', MGMT, body());
    expect(created.status).toBe(201);
    expect(
      gate.mock.calls.some(
        (call) => (call[1] as { operation: string }).operation === 'machine.protected_grant'
      )
    ).toBe(false);
  });
});

describe('what counts as a grant: taking access away stays easy', () => {
  const TENANT_ADMIN = [{ role: 'role_ar_super_admin', scope: 'tenant' as const }];
  const protectOwnTenant = { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: TENANT };

  it('a tenant administrator of the protected tenant still renames, narrows, disables and revokes', async () => {
    const t = await setup(protectOwnTenant);
    const admin = signIn(t.db, TENANT_ADMIN);
    const principal = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: TENANT }],
      permissions: ['admin:users:read'],
    });
    const base = `${MGMT}/${principal.id}`;
    expect(
      (await t.call(admin.cookie, 'PATCH', base, { display_name: 'Renamed', description: 'x' }))
        .status
    ).toBe(200);
    expect((await t.call(admin.cookie, 'POST', `${base}/disable`)).status).toBe(200);
    expect(t.statusOf(principal.id)).toBe('disabled');
    const other = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: TENANT }],
      permissions: ['admin:users:read'],
    });
    expect(
      (
        await t.call(
          admin.cookie,
          'PATCH',
          `${MGMT}/${other.id}/credentials/${other.credentialId}`,
          {
            status: 'revoked',
          }
        )
      ).status
    ).toBe(200);
    expect(t.credentialStatus(other.credentialId)).toBe('revoked');
    expect(operations()).not.toContain('machine.protected_grant');
  });

  it('granting or widening access to the protected tenant is for the platform administrator', async () => {
    const t = await setup(protectOwnTenant);
    const admin = signIn(t.db, TENANT_ADMIN);
    const refused = await t.call(
      admin.cookie,
      'POST',
      MGMT,
      body({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] })
    );
    expect(refused.status).toBe(400);
    const global = signIn(t.db, GLOBAL_SUPER_ADMIN);
    const created = await t.call(
      global.cookie,
      'POST',
      MGMT,
      body({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] })
    );
    expect(created.status).toBe(201);
    expect(operations()).toContain('machine.protected_grant');
  });

  it('a global administrator is asked for no extra step-up to rename or narrow what reaches a protected tenant', async () => {
    const t = await setup();
    const global = signIn(t.db, GLOBAL_SUPER_ADMIN);
    const principal = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: PROTECTED }],
      permissions: ['admin:users:read'],
    });
    const renamed = await t.call(global.cookie, 'PATCH', `${MGMT}/${principal.id}`, {
      display_name: 'Renamed',
    });
    expect(renamed.status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
    // Narrowing the scope to nothing is not a grant either (the grant's own step-up, as before).
    const narrowed = await t.call(global.cookie, 'PATCH', `${MGMT}/${principal.id}`, {
      tenant_scopes: [{ scope_mode: 'none' }],
    });
    expect(narrowed.status).toBe(200);
    expect(operations()).not.toContain('machine.protected_grant');
  });

  it('enabling a disabled principal that reaches a protected tenant, and widening it, are grants', async () => {
    const t = await setup();
    const global = signIn(t.db, GLOBAL_SUPER_ADMIN);
    const principal = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: PROTECTED }],
      permissions: ['admin:users:read'],
    });
    t.db
      .prepare("UPDATE admin_machine_principals SET status = 'disabled' WHERE id = ?")
      .run(principal.id);
    expect((await t.call(global.cookie, 'POST', `${MGMT}/${principal.id}/enable`)).status).toBe(
      200
    );
    expect(operations()).toContain('machine.protected_grant');
    gate.mockClear();
    const widened = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: OTHER }],
      permissions: ['admin:users:read'],
    });
    expect(
      (
        await t.call(global.cookie, 'PATCH', `${MGMT}/${widened.id}`, {
          tenant_scopes: [
            { scope_mode: 'allow', tenant_id: OTHER },
            { scope_mode: 'allow', tenant_id: PROTECTED },
          ],
        })
      ).status
    ).toBe(200);
    expect(operations()).toContain('machine.protected_grant');
  });
});

describe('when the setting cannot be read', () => {
  const failingKv = (reads: string[]) =>
    ({
      get: async (key: string) => {
        reads.push(key);
        if (key === 'settings:platform:machine-access') throw new Error('KV unavailable');
        return null;
      },
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true }),
    }) as unknown as KVNamespace;

  it('does not touch a human: non-granting operations work, a grant needs the step-up, not a refusal', async () => {
    const reads: string[] = [];
    const t = await setup({ SETTINGS: failingKv(reads) });
    const tenantAdmin = signIn(t.db, [{ role: 'role_ar_super_admin', scope: 'tenant' as const }]);
    const principal = t.addPrincipal({
      scopes: [{ mode: 'allow', tenant: TENANT }],
      permissions: ['admin:users:read'],
    });
    const renamed = await t.call(tenantAdmin.cookie, 'PATCH', `${MGMT}/${principal.id}`, {
      display_name: 'Renamed',
    });
    expect(renamed.status).toBe(200);
    expect(reads).not.toContain('settings:platform:machine-access');
    // A grant by a tenant administrator: not refused outright, the always-enforced step-up is asked.
    const granted = await t.call(
      tenantAdmin.cookie,
      'POST',
      MGMT,
      body({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] })
    );
    expect(granted.status).toBe(201);
    expect(operations()).toContain('machine.protected_grant');
  });

  it('refuses an all-tenants machine that grants, and reads the setting once per request', async () => {
    const reads: string[] = [];
    const t = await setup({ SETTINGS: failingKv(reads) });
    const principal = t.addPrincipal({
      scopes: [{ mode: 'all' }],
      permissions: [READ, WRITE, DELETE],
    });
    const token = await t.tokenOf(principal, [READ, WRITE, DELETE]);
    const created = await t.callWithToken(token, 'POST', MGMT, body());
    expect(created.status).toBeGreaterThanOrEqual(400);
    expect(reads.filter((key) => key === 'settings:platform:machine-access').length).toBe(1);
  });
});

describe('admin invitations (and the code hand-off) of an all-tenants machine', () => {
  const INVITATIONS = '/api/admin/admin-invitations';
  const HANDOFF_PERMISSIONS = [
    'admin:admin_users:read',
    'admin:admin_users:write',
    'admin:admin_roles:write',
    'admin:admin_invitations:code_handoff',
  ];
  const invitationBody = (overrides: Record<string, unknown> = {}) => ({
    email: 'new.admin@example.com',
    role_id: 'role_handoff',
    code_delivery: 'response',
    ...overrides,
  });
  const count = (t: Awaited<ReturnType<typeof setup>>) =>
    (t.db.prepare('SELECT COUNT(*) AS n FROM admin_invitations').get() as { n: number }).n;

  async function handoffSetup() {
    const t = await setup({
      MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: PROTECTED,
      ADMIN_INVITATIONS_CODE_HANDOFF_ENABLED: 'true',
    });
    insertRole(t.db, {
      id: 'role_handoff',
      name: 'tenant_helper',
      permissions: ['admin:users:read'],
      hierarchy: 10,
    });
    // The same role, as the protected tenant's own, so that only the exclusion can refuse.
    t.db
      .prepare(
        `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, created_at, updated_at)
         VALUES ('role_handoff_p', ?, 'tenant_helper', '["admin:users:read"]', 10, 'custom', 0, ?, ?)`
      )
      .run(PROTECTED, Date.now(), Date.now());
    const principal = t.addPrincipal({
      scopes: [{ mode: 'all' }],
      permissions: HANDOFF_PERMISSIONS,
    });
    const token = await t.tokenOf(principal, HANDOFF_PERMISSIONS);
    return { t, token, principal };
  }

  it('creates a hand-off invitation for an unprotected tenant', async () => {
    const { t, token } = await handoffSetup();
    const created = await t.callWithToken(token, 'POST', INVITATIONS, invitationBody(), {
      'X-Tenant-Id': TENANT,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(typeof created.json.code).toBe('string');
    expect(count(t)).toBe(1);
  });

  it('refuses a protected tenant before anything is written, for a creation and a re-issue', async () => {
    const { t, token } = await handoffSetup();
    for (const [method, path, payload] of [
      ['POST', INVITATIONS, invitationBody({ role_id: 'role_handoff_p' })],
      ['POST', INVITATIONS, invitationBody({ role_id: 'role_handoff_p', code_delivery: 'email' })],
      ['POST', `${INVITATIONS}/inv_1/resend`, { code_delivery: 'response' }],
      ['DELETE', `${INVITATIONS}/inv_1`, undefined],
    ] as const) {
      const response = await t.callWithToken(token, method, path, payload, {
        'X-Tenant-Id': PROTECTED,
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.json.error).toBe('access_denied');
    }
    expect(count(t)).toBe(0);
  });

  it('refuses a body scope_id that does not match the request tenant, writing nothing', async () => {
    const { t, token } = await handoffSetup();
    const response = await t.callWithToken(
      token,
      'POST',
      INVITATIONS,
      invitationBody({ scope_type: 'tenant', scope_id: PROTECTED }),
      { 'X-Tenant-Id': TENANT }
    );
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('invalid_scope');
    expect(count(t)).toBe(0);
    // And a body tenant_id naming the protected tenant is refused by the authentication.
    const named = await t.callWithToken(
      token,
      'POST',
      INVITATIONS,
      invitationBody({ tenant_id: PROTECTED }),
      { 'X-Tenant-Id': TENANT }
    );
    expect(named.status).toBe(403);
    expect(count(t)).toBe(0);
  });

  it('is not refused for a principal that names the protected tenant itself', async () => {
    const { t } = await handoffSetup();
    const principal = t.addPrincipal({
      scopes: [{ mode: 'all' }, { mode: 'allow', tenant: PROTECTED }],
      permissions: HANDOFF_PERMISSIONS,
    });
    const token = await t.tokenOf(principal, HANDOFF_PERMISSIONS);
    const created = await t.callWithToken(
      token,
      'POST',
      INVITATIONS,
      invitationBody({ role_id: 'role_handoff_p' }),
      { 'X-Tenant-Id': PROTECTED }
    );
    expect(created.status).toBe(201);
  });
});
