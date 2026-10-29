import { describe, expect, it } from 'vitest';
import { adminAuthMiddleware, requireSystemAdmin } from '@authrim/ar-lib-core';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';
import { adminUsersRouter } from '../routes/admin-management/admins';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';
import { machineAccessRouter } from '../routes/admin-management/machine-access';
import { controlPlaneOperationsRouter } from '../routes/admin-management/control-plane-operations';
import {
  GLOBAL_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  createTokenKit,
  insertRole,
  setupApp,
  signIn,
  type Assignment,
} from './helpers/admin-authority-fixture';

/**
 * Review findings on the global-authority hardening. Each test reproduces the attack with the
 * assignments the review named, on the real admin-auth middleware, the real routers and the real
 * Admin schema (a SQLite that, like D1, has no rollback for a callback transaction and an atomic
 * `batch`).
 */

const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
const MACHINE_ACCESS = '/api/admin/machine-access';
const ROTATIONS = '/api/admin/platform/control-plane/lookup-hmac/rotations';

async function setup() {
  const kit = await createTokenKit();
  const context = setupApp((app) => {
    app.route('/api/admin/admin-roles', adminRolesRouter);
    app.route('/api/admin/admins', adminUsersRouter);
    app.route('/api/admin/admin-invitations', adminInvitationsRouter);
    app.route(MACHINE_ACCESS, machineAccessRouter);
    app.route('/api/admin/platform/control-plane', controlPlaneOperationsRouter);
    // The guard that settings, tombstones, runtime profiles and the like sit behind.
    app.get(
      '/guarded/system-admin',
      adminAuthMiddleware({ plane: 'tenant' }),
      requireSystemAdmin(),
      (c) => c.json({ ok: true })
    );
  }, kit.env);
  return { ...context, kit };
}
type Context = Awaited<ReturnType<typeof setup>>;

let sequence = 0;
const principalBody = (overrides: Record<string, unknown> = {}) => ({
  client_id: `client-${(sequence += 1)}`,
  display_name: 'Automation',
  principal_type: 'automation',
  permissions: ['admin:users:read'],
  tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
  ...overrides,
});
const credentialBody = (overrides: Record<string, unknown> = {}) => ({
  kid: `kid-${(sequence += 1)}`,
  display_name: 'Key',
  alg: 'ES256',
  public_jwk: PUBLIC_JWK,
  ...overrides,
});

/** A custom role the Admin holds globally next to the tenant's ar_super_admin. */
function insertMachineWriter(context: Context) {
  insertRole(context.db, {
    id: 'role_machine_writer',
    name: 'machine-writer',
    permissions: ['admin:machine_access:write'],
    hierarchy: 5,
  });
  return [{ role: 'role_machine_writer', scope: 'global' }, ...TENANT_SUPER_ADMIN] as Assignment[];
}

async function createPrincipal(context: Context, cookie: string, overrides = {}) {
  const created = await context.call(
    cookie,
    'POST',
    `${MACHINE_ACCESS}/principals`,
    principalBody(overrides)
  );
  expect(created.status).toBe(201);
  return created.json.principal.id as string;
}
async function createCredential(
  context: Context,
  cookie: string,
  principalId: string,
  overrides = {}
) {
  const created = await context.call(
    cookie,
    'POST',
    `${MACHINE_ACCESS}/principals/${principalId}/credentials`,
    credentialBody(overrides)
  );
  expect(created.status).toBe(201);
  return created.json.credential.id as string;
}
const credentialStatus = (context: Context, id: string) =>
  context.db
    .prepare('SELECT status, expires_at FROM admin_machine_credentials WHERE id = ?')
    .get(id) as { status: string; expires_at: number | null };

describe('1. a principal change is one atomic write', () => {
  it('leaves no global wildcard behind when a duplicate permission would break the write', async () => {
    const context = await setup();
    const actor = signIn(context.db, insertMachineWriter(context));
    // A global principal that holds only what the global assignment holds, and a key on it.
    const principalId = await createPrincipal(context, actor.cookie, {
      permissions: ['admin:machine_access:write'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const credentialId = await createCredential(context, actor.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });

    // Within the tenant the Admin holds the wildcard, so this change is allowed as a whole; the
    // duplicate would fail the second insert of '*'.
    const patched = await context.call(
      actor.cookie,
      'PATCH',
      `${MACHINE_ACCESS}/principals/${principalId}`,
      { permissions: ['*', '*'], tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] }
    );

    const grant = context.kit.grantOf(context.db, credentialId);
    expect(patched.status).toBe(200);
    expect(grant.permissions.includes('*') && grant.tenantScope.includes('*')).toBe(false);
    expect(grant.tenantScope).toEqual([TENANT]);
  });

  it('keeps the earlier permissions and scope when any part of the write fails', async () => {
    const context = await setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, actor.cookie);

    // An 'allow' scope without a tenant breaks a table check halfway through the writes.
    const { AdminMachineAccessRepository } = await import('@authrim/ar-lib-core');
    const repo = new AdminMachineAccessRepository(context.adapter);
    await expect(
      repo.updatePrincipalWithGrant(
        principalId,
        {},
        {
          permissions: ['*'],
          tenantScopes: [
            { scopeMode: 'all', tenantId: null },
            { scopeMode: 'allow', tenantId: null },
          ],
        }
      )
    ).rejects.toThrow();

    expect(await repo.getPrincipalPermissions(principalId)).toEqual(['admin:users:read']);
    expect(await repo.getPrincipalTenantScopes(principalId)).toEqual([
      { scopeMode: 'allow', tenantId: TENANT },
    ]);
  });

  it('creates a credential with its permissions and scope together, or not at all', async () => {
    const context = await setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, actor.cookie, { permissions: ['*'] });
    const { AdminMachineAccessRepository } = await import('@authrim/ar-lib-core');
    const repo = new AdminMachineAccessRepository(context.adapter);

    // Without its own rows a credential takes the whole principal, so the key must not exist
    // before they are written.
    await expect(
      repo.createCredentialWithGrant(
        {
          principalId,
          kid: 'half',
          publicJwkJson: JSON.stringify(PUBLIC_JWK),
          alg: 'ES256',
          displayName: 'Half',
        },
        {
          permissions: ['admin:users:read'],
          tenantScopes: [{ scopeMode: 'allow', tenantId: null }],
        }
      )
    ).rejects.toThrow();

    expect(await repo.listCredentials(principalId)).toEqual([]);
  });

  it('still lets the Admin change a principal inside the tenant', async () => {
    const context = await setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, actor.cookie);

    const patched = await context.call(
      actor.cookie,
      'PATCH',
      `${MACHINE_ACCESS}/principals/${principalId}`,
      { display_name: 'Renamed', permissions: ['admin:users:read', 'admin:clients:read'] }
    );

    expect(patched.status).toBe(200);
    expect(patched.json.principal.permissions).toEqual(['admin:clients:read', 'admin:users:read']);
  });
});

describe('2. the machine bypass of the system-admin guard needs a global token', () => {
  it('refuses a token limited to the tenant that holds admin:*, and lets a global one through', async () => {
    const context = await setup();
    const local = signIn(context.db, TENANT_SUPER_ADMIN);
    const localPrincipal = await createPrincipal(context, local.cookie, {
      permissions: ['admin:*'],
    });
    const localCredential = await createCredential(context, local.cookie, localPrincipal, {
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
    });
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const globalPrincipal = await createPrincipal(context, global.cookie, {
      permissions: ['admin:*'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const globalCredential = await createCredential(context, global.cookie, globalPrincipal, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });

    const localToken = await context.kit.mint(context.db, localCredential, ['admin:*']);
    const globalToken = await context.kit.mint(context.db, globalCredential, ['admin:*']);
    const byLocal = await context.callWithToken(localToken, 'GET', '/guarded/system-admin');
    const byGlobal = await context.callWithToken(globalToken, 'GET', '/guarded/system-admin');

    expect(byLocal.status).toBe(403);
    expect(byGlobal.status).toBe(200);
  });
});

describe('3. control plane permissions of a machine token', () => {
  it('refuses a token limited to the tenant that holds the rotate permission', async () => {
    const context = await setup();
    const mixed = signIn(context.db, [
      { role: 'role_ar_viewer', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ]);
    const principalId = await createPrincipal(context, mixed.cookie, {
      permissions: ['admin:control_plane:rotate'],
    });
    const credentialId = await createCredential(context, mixed.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
    });
    const token = await context.kit.mint(context.db, credentialId, ['admin:control_plane:rotate']);

    const rotation = await context.callWithToken(token, 'POST', ROTATIONS, {});

    // Past the authority check the route finds no Control binding to ask: 503, not 403.
    expect(rotation.status).toBe(403);
  });

  it('lets a global token with the permission through, and so the setup tool the bootstrap made', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const globalPrincipal = await createPrincipal(context, global.cookie, {
      permissions: ['admin:control_plane:rotate'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const globalCredential = await createCredential(context, global.cookie, globalPrincipal, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    // What the setup bootstrap writes: a fixed principal ID, limited to the default tenant.
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES ('amp_authrim_setup', 'authrim-setup', 'Authrim Setup Tool', 'setup_tool', 'active',
           'authrim:admin-api', 600, ?, ?)`
      )
      .run(now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at)
         VALUES ('amk_setup', 'amp_authrim_setup', 'setup', '{}', 'ES256', 'Setup', 'active', ?, ?)`
      )
      .run(now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
         VALUES ('amp_authrim_setup', 'admin:control_plane:rotate', ?)`
      )
      .run(now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
         VALUES ('amp_authrim_setup', 'allow', ?, ?)`
      )
      .run(TENANT, now);

    const byGlobal = await context.callWithToken(
      await context.kit.mint(context.db, globalCredential, ['admin:control_plane:rotate']),
      'POST',
      ROTATIONS,
      {}
    );
    const bySetup = await context.callWithToken(
      await context.kit.mint(context.db, 'amk_setup', ['admin:control_plane:rotate']),
      'POST',
      ROTATIONS,
      {}
    );

    expect(byGlobal.status).toBe(503);
    expect(bySetup.status).toBe(503);
  });

  it('does not take a principal made through the Admin API for the setup tool the bootstrap wrote', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    // A platform administrator may create a principal of that type; its ID is generated, so it is
    // not the bootstrap's, and limited to a tenant it holds nothing for the control plane.
    const principalId = await createPrincipal(context, global.cookie, {
      client_id: 'authrim-setup',
      principal_type: 'setup_tool',
      permissions: ['admin:control_plane:rotate'],
    });
    const credentialId = await createCredential(context, global.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
    });

    const rotation = await context.callWithToken(
      await context.kit.mint(context.db, credentialId, ['admin:control_plane:rotate']),
      'POST',
      ROTATIONS,
      {}
    );

    expect(rotation.status).toBe(403);
  });

  it('does not let an Admin of the tenant create the setup tool principal', async () => {
    const context = await setup();
    const local = signIn(context.db, TENANT_SUPER_ADMIN);
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);

    const asSetup = await context.call(
      local.cookie,
      'POST',
      `${MACHINE_ACCESS}/principals`,
      principalBody({ client_id: 'authrim-setup', principal_type: 'setup_tool' })
    );
    const internal = await context.call(
      local.cookie,
      'POST',
      `${MACHINE_ACCESS}/principals`,
      principalBody({ principal_type: 'internal_service' })
    );
    const byGlobal = await context.call(
      global.cookie,
      'POST',
      `${MACHINE_ACCESS}/principals`,
      principalBody({ principal_type: 'internal_service' })
    );

    expect(asSetup.status).toBe(400);
    expect(internal.status).toBe(400);
    expect(byGlobal.status).toBe(201);
  });
});

describe('4. rotation does not bring a revoked credential back', () => {
  it('refuses to rotate a revoked or expired credential and leaves it revoked', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principalId = await createPrincipal(context, global.cookie, {
      permissions: ['*'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const oldCredential = await createCredential(context, global.cookie, principalId, {
      permissions: ['*'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const revoked = await context.call(
      global.cookie,
      'POST',
      `${MACHINE_ACCESS}/principals/${principalId}/credentials/${oldCredential}/emergency-revoke`,
      {}
    );
    expect(revoked.status).toBe(200);

    const actor = signIn(context.db, insertMachineWriter(context));
    const rotated = await context.call(
      actor.cookie,
      'POST',
      `${MACHINE_ACCESS}/principals/${principalId}/credentials/${oldCredential}/rotate`,
      credentialBody({
        permissions: ['admin:machine_access:write'],
        tenant_scopes: [{ scope_mode: 'all' }],
      })
    );

    expect(rotated.status).not.toBe(201);
    expect(credentialStatus(context, oldCredential).status).toBe('revoked');
    const stale = await context.callWithToken(
      await context.kit.mint(context.db, oldCredential, ['admin:users:read']),
      'GET',
      '/probe/tenant-a'
    );
    expect(stale.status).toBe(401);
  });

  it('rotates a live credential without extending how long the old one lasts', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principalId = await createPrincipal(context, global.cookie, {
      permissions: ['admin:users:read'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const soon = Date.now() + 120_000;
    const oldCredential = await createCredential(context, global.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'all' }],
      expires_at: soon,
    });

    const rotated = await context.call(
      global.cookie,
      'POST',
      `${MACHINE_ACCESS}/principals/${principalId}/credentials/${oldCredential}/rotate`,
      credentialBody({ overlap_seconds: 3600, tenant_scopes: [{ scope_mode: 'all' }] })
    );

    expect(rotated.status).toBe(201);
    const old = credentialStatus(context, oldCredential);
    expect(old.status).toBe('rotating');
    expect(old.expires_at).toBeLessThanOrEqual(soon);
  });
});

describe('5. the hierarchy that counts for a global role is the global one', () => {
  function globalWriterAndViewer(context: Context, level = 5) {
    insertRole(context.db, {
      id: 'role_roles_writer',
      name: 'roles-writer',
      permissions: ['admin:admin_roles:read', 'admin:admin_roles:write'],
      hierarchy: level,
    });
    return [
      { role: 'role_ar_viewer', scope: 'global' },
      { role: 'role_roles_writer', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ] as Assignment[];
  }

  it('refuses raising the hierarchy of a role that is held globally past what the global roles reach', async () => {
    const context = await setup();
    const actor = signIn(context.db, globalWriterAndViewer(context));

    const raised = await context.call(
      actor.cookie,
      'PATCH',
      '/api/admin/admin-roles/role_roles_writer',
      { hierarchy_level: 99 }
    );
    const within = await context.call(
      actor.cookie,
      'PATCH',
      '/api/admin/admin-roles/role_roles_writer',
      { hierarchy_level: 10 }
    );

    expect(raised.status).toBe(403);
    expect(within.status).toBe(200);
    const probe = await context.call(actor.cookie, 'GET', '/probe/tenant-a');
    expect(probe.json.globalHierarchyLevel).toBe(20);
  });

  it('defines the global hierarchy as the highest among the global assignments', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const mixed = signIn(context.db, globalWriterAndViewer(context));
    const local = signIn(context.db, TENANT_SUPER_ADMIN);

    expect((await context.call(global.cookie, 'GET', '/probe/tenant-a')).json).toMatchObject({
      hierarchyLevel: 100,
      globalHierarchyLevel: 100,
    });
    expect((await context.call(mixed.cookie, 'GET', '/probe/tenant-a')).json).toMatchObject({
      hierarchyLevel: 100,
      globalHierarchyLevel: 20,
    });
    expect((await context.call(local.cookie, 'GET', '/probe/tenant-a')).json).toMatchObject({
      hierarchyLevel: 100,
      globalHierarchyLevel: 0,
    });
  });

  it('refuses a global assignment of a role above the global hierarchy, even with the wildcard', async () => {
    const context = await setup();
    insertRole(context.db, {
      id: 'role_global_all',
      name: 'global-all',
      permissions: ['*'],
      hierarchy: 30,
    });
    insertRole(context.db, {
      id: 'role_mid',
      name: 'mid',
      permissions: ['admin:users:read'],
      hierarchy: 50,
    });
    insertRole(context.db, {
      id: 'role_low',
      name: 'low',
      permissions: ['admin:users:read'],
      hierarchy: 10,
    });
    const actor = signIn(context.db, [
      { role: 'role_global_all', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ]);
    const target = signIn(context.db, [{ role: 'role_ar_viewer', scope: 'tenant' }]);
    const assign = (role: string) =>
      context.call(actor.cookie, 'POST', `/api/admin/admin-roles/${role}/assignments`, {
        admin_user_id: target.userId,
        scope_type: 'global',
      });
    const viaUserRoute = (role: string) =>
      context.call(actor.cookie, 'POST', `/api/admin/admins/${target.userId}/roles`, {
        role_id: role,
        scope_type: 'global',
      });

    expect((await assign('role_mid')).status).toBe(403);
    expect((await viaUserRoute('role_mid')).status).toBe(403);
    expect((await assign('role_low')).status).toBe(201);
    // Inside the tenant the merged hierarchy still counts.
    const local = await context.call(
      actor.cookie,
      'POST',
      '/api/admin/admin-roles/role_mid/assignments',
      { admin_user_id: target.userId, scope_type: 'tenant' }
    );
    expect(local.status).toBe(201);
  });

  it('refuses widening an assignment of a role above the global hierarchy to global', async () => {
    const context = await setup();
    insertRole(context.db, {
      id: 'role_global_all',
      name: 'global-all',
      permissions: ['*'],
      hierarchy: 30,
    });
    insertRole(context.db, {
      id: 'role_mid',
      name: 'mid',
      permissions: ['admin:users:read'],
      hierarchy: 50,
    });
    const actor = signIn(context.db, [
      { role: 'role_global_all', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ]);
    const target = signIn(context.db, [{ role: 'role_mid', scope: 'tenant' }]);

    const widened = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admin-roles/role_mid/assignments/${target.userId}-assignment-0`,
      { scope_type: 'global' }
    );

    expect(widened.status).toBe(403);
    const global = context.db
      .prepare("SELECT COUNT(*) AS n FROM admin_role_assignments WHERE scope_type = 'global'")
      .get() as { n: number };
    expect(global.n).toBe(1);
  });

  it('refuses a global invitation for a role above the global hierarchy', async () => {
    const context = await setup();
    insertRole(context.db, {
      id: 'role_global_all',
      name: 'global-all',
      permissions: ['*'],
      hierarchy: 30,
    });
    insertRole(context.db, {
      id: 'role_mid',
      name: 'mid',
      permissions: ['admin:users:read'],
      hierarchy: 50,
    });
    const actor = signIn(context.db, [
      { role: 'role_global_all', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ]);

    const invited = await context.call(actor.cookie, 'POST', '/api/admin/admin-invitations', {
      email: 'new@example.test',
      role_id: 'role_mid',
      scope_type: 'global',
    });

    expect(invited.status).toBe(403);
  });

  it('still lets a global ar_super_admin change and assign global roles below it', async () => {
    const context = await setup();
    insertRole(context.db, {
      id: 'role_low',
      name: 'low',
      permissions: ['admin:users:read'],
      hierarchy: 10,
    });
    const actor = signIn(context.db, [
      { role: 'role_low', scope: 'global' },
      ...GLOBAL_SUPER_ADMIN,
    ]);

    const raised = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_low', {
      hierarchy_level: 60,
    });

    expect(raised.status).toBe(200);
  });
});

describe('7. a credential is managed by the scope it ends up with', () => {
  it('manages a credential widened beyond its principal by what it reaches, not by what it asks', async () => {
    const context = await setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, actor.cookie);
    const widen = async () => {
      const credentialId = await createCredential(context, actor.cookie, principalId);
      const widened = await context.call(
        actor.cookie,
        'PATCH',
        `${MACHINE_ACCESS}/principals/${principalId}/credentials/${credentialId}`,
        { tenant_scopes: [{ scope_mode: 'all' }] }
      );
      expect(widened.status).toBe(200);
      // It still reaches the tenant only.
      expect(context.kit.grantOf(context.db, credentialId).tenantScope).toEqual([TENANT]);
      return credentialId;
    };

    const forPatch = await widen();
    const forRotate = await widen();
    const forRevoke = await widen();
    const forDelete = await widen();
    const base = `${MACHINE_ACCESS}/principals/${principalId}/credentials`;

    const patched = await context.call(actor.cookie, 'PATCH', `${base}/${forPatch}`, {
      display_name: 'Renamed',
    });
    const rotated = await context.call(
      actor.cookie,
      'POST',
      `${base}/${forRotate}/rotate`,
      credentialBody()
    );
    const revoked = await context.call(
      actor.cookie,
      'POST',
      `${base}/${forRevoke}/emergency-revoke`,
      {}
    );
    const deleted = await context.call(actor.cookie, 'DELETE', `${base}/${forDelete}`);

    expect(patched.status).toBe(200);
    expect(rotated.status).toBe(201);
    expect(revoked.status).toBe(200);
    expect(deleted.status).toBe(200);
  });

  it('still hides a credential whose principal reaches beyond the tenant', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principalId = await createPrincipal(context, global.cookie, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const credentialId = await createCredential(context, global.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const local = signIn(context.db, TENANT_SUPER_ADMIN);

    const patched = await context.call(
      local.cookie,
      'PATCH',
      `${MACHINE_ACCESS}/principals/${principalId}/credentials/${credentialId}`,
      { display_name: 'Taken' }
    );

    expect(patched.status).toBe(404);
  });
});

const principalGrant = (context: Context, principalId: string) => ({
  permissions: (
    context.db
      .prepare('SELECT permission FROM admin_machine_principal_permissions WHERE principal_id = ?')
      .all(principalId) as Array<{ permission: string }>
  ).map((row) => row.permission),
  scopes: (
    context.db
      .prepare(
        'SELECT scope_mode, tenant_id FROM admin_machine_principal_tenant_scopes WHERE principal_id = ?'
      )
      .all(principalId) as Array<{ scope_mode: string; tenant_id: string | null }>
  ).map((row) => row.scope_mode),
});

describe('8. two changes that were each allowed do not add up to more (revision check)', () => {
  it('refuses the write that was authorized against a state another change has since replaced', async () => {
    const context = await setup();
    const actor = signIn(context.db, insertMachineWriter(context));
    const principalId = await createPrincipal(context, actor.cookie, {
      permissions: ['admin:machine_access:write'],
    });
    const credentialId = await createCredential(context, actor.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const base = `${MACHINE_ACCESS}/principals/${principalId}`;

    // The wildcard is allowed alone, as the tenant's; the global scope is allowed alone, for what
    // the global assignment holds. Written together they would be a global wildcard.
    let second: Awaited<ReturnType<Context['call']>> | undefined;
    context.hooks.beforeBatch = async () => {
      second = await context.call(actor.cookie, 'PATCH', base, {
        tenant_scopes: [{ scope_mode: 'all' }],
      });
    };
    const first = await context.call(actor.cookie, 'PATCH', base, { permissions: ['*'] });

    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    const grant = context.kit.grantOf(context.db, credentialId);
    expect(grant.permissions.includes('*') && grant.tenantScope.includes('*')).toBe(false);
    expect(principalGrant(context, principalId).permissions).toEqual([
      'admin:machine_access:write',
    ]);
  });

  it('notices a change made behind the repository too, by the permissions and scopes themselves', async () => {
    const context = await setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, actor.cookie);

    // A row written straight into the table: the row's updated_at does not move.
    context.hooks.beforeBatch = async () => {
      context.db
        .prepare(
          `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
           VALUES (?, 'admin:clients:write', ?)`
        )
        .run(principalId, Date.now());
    };
    const stale = await context.call(
      actor.cookie,
      'PATCH',
      `${MACHINE_ACCESS}/principals/${principalId}`,
      { display_name: 'Renamed' }
    );

    expect(stale.status).toBe(409);
  });

  it('applies the same check to a credential change and to the principal it sits on', async () => {
    const context = await setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, actor.cookie);
    const credentialId = await createCredential(context, actor.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
    });
    const credentialPath = `${MACHINE_ACCESS}/principals/${principalId}/credentials/${credentialId}`;

    context.hooks.beforeBatch = async () => {
      await context.call(actor.cookie, 'PATCH', `${MACHINE_ACCESS}/principals/${principalId}`, {
        permissions: ['admin:clients:read'],
      });
    };
    const stale = await context.call(actor.cookie, 'PATCH', credentialPath, {
      display_name: 'Renamed',
    });
    const fresh = await context.call(actor.cookie, 'PATCH', credentialPath, {
      display_name: 'Renamed',
    });

    expect(stale.status).toBe(409);
    expect(fresh.status).toBe(200);
  });

  it('does not let a rotation bring back a credential revoked after the rotation read it', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principalId = await createPrincipal(context, global.cookie, {
      permissions: ['*'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const oldCredential = await createCredential(context, global.cookie, principalId, {
      permissions: ['*'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const base = `${MACHINE_ACCESS}/principals/${principalId}/credentials/${oldCredential}`;

    context.hooks.beforeBatch = async () => {
      const revoked = await context.call(global.cookie, 'POST', `${base}/emergency-revoke`, {});
      expect(revoked.status).toBe(200);
    };
    const rotated = await context.call(global.cookie, 'POST', `${base}/rotate`, credentialBody());

    expect(rotated.status).toBe(409);
    expect(credentialStatus(context, oldCredential).status).toBe('revoked');
    const keys = context.db
      .prepare('SELECT COUNT(*) AS n FROM admin_machine_credentials WHERE principal_id = ?')
      .get(principalId) as { n: number };
    expect(keys.n).toBe(1);
  });

  it('refuses an enable and a disable decided on a state that has changed', async () => {
    const context = await setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, actor.cookie);

    context.hooks.beforeBatch = async () => {
      await context.call(actor.cookie, 'PATCH', `${MACHINE_ACCESS}/principals/${principalId}`, {
        permissions: ['admin:clients:read'],
      });
    };
    const disabled = await context.call(
      actor.cookie,
      'POST',
      `${MACHINE_ACCESS}/principals/${principalId}/disable`,
      {}
    );

    expect(disabled.status).toBe(409);
  });
});

describe('9. the principals that act for the platform are the platform administrators', () => {
  const insertSetupPrincipal = (context: Context) => {
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES ('amp_authrim_setup', 'authrim-setup', 'Authrim Setup Tool', 'setup_tool', 'active',
           'authrim:admin-api', 600, ?, ?)`
      )
      .run(now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at)
         VALUES ('amk_setup', 'amp_authrim_setup', 'setup', '{}', 'ES256', 'Setup', 'active', ?, ?)`
      )
      .run(now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
         VALUES ('amp_authrim_setup', 'admin:control_plane:rotate', ?)`
      )
      .run(now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
         VALUES ('amp_authrim_setup', 'allow', ?, ?)`
      )
      .run(TENANT, now);
  };
  const SETUP = `${MACHINE_ACCESS}/principals/amp_authrim_setup`;

  it('does not let an Admin of the tenant add a key to the setup tool, so no token takes its identity', async () => {
    const context = await setup();
    insertSetupPrincipal(context);
    const local = signIn(context.db, TENANT_SUPER_ADMIN);

    const added = await context.call(
      local.cookie,
      'POST',
      `${SETUP}/credentials`,
      credentialBody({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] })
    );

    expect(added.status).not.toBe(201);
    const keys = context.db
      .prepare(
        "SELECT COUNT(*) AS n FROM admin_machine_credentials WHERE principal_id = 'amp_authrim_setup'"
      )
      .get() as { n: number };
    expect(keys.n).toBe(1);
  });

  it('refuses every other change to the setup tool by an Admin of the tenant', async () => {
    const context = await setup();
    insertSetupPrincipal(context);
    const local = signIn(context.db, TENANT_SUPER_ADMIN);
    const attempts: Array<[string, string, unknown]> = [
      ['PATCH', SETUP, { permissions: ['admin:control_plane:read'] }],
      ['POST', `${SETUP}/disable`, {}],
      ['POST', `${SETUP}/enable`, {}],
      ['DELETE', SETUP, undefined],
      [
        'PATCH',
        `${SETUP}/credentials/amk_setup`,
        { display_name: 'x', expires_at: Date.now() + 1e6 },
      ],
      ['POST', `${SETUP}/credentials/amk_setup/rotate`, credentialBody()],
      ['POST', `${SETUP}/credentials/amk_setup/emergency-revoke`, {}],
      ['DELETE', `${SETUP}/credentials/amk_setup`, undefined],
    ];

    for (const [method, path, body] of attempts) {
      const response = await context.call(local.cookie, method, path, body);
      expect([method, path, response.status < 400]).toEqual([method, path, false]);
    }
    const state = context.db
      .prepare("SELECT status FROM admin_machine_principals WHERE id = 'amp_authrim_setup'")
      .get() as { status: string };
    expect(state.status).toBe('active');
    expect(credentialStatus(context, 'amk_setup').status).toBe('active');
  });

  it('gives a platform principal only what the global assignments hold, not what the tenant holds', async () => {
    const context = await setup();
    insertSetupPrincipal(context);
    // The Admin may write machine access globally, and holds the wildcard for the tenant.
    const actor = signIn(context.db, insertMachineWriter(context));

    const added = await context.call(
      actor.cookie,
      'POST',
      `${SETUP}/credentials`,
      credentialBody({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] })
    );

    expect(added.status).toBe(400);
  });

  it('keeps the setup tool manageable by a platform administrator', async () => {
    const context = await setup();
    insertSetupPrincipal(context);
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);

    const added = await context.call(
      global.cookie,
      'POST',
      `${SETUP}/credentials`,
      credentialBody({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] })
    );
    const disabled = await context.call(global.cookie, 'POST', `${SETUP}/disable`, {});

    expect(added.status).toBe(201);
    expect(disabled.status).toBe(200);
  });
});

describe('10. enabling a principal needs the authority to give what it holds', () => {
  it('refuses an Admin to bring back a global wildcard principal it could not have made', async () => {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principalId = await createPrincipal(context, global.cookie, {
      permissions: ['*'],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const base = `${MACHINE_ACCESS}/principals/${principalId}`;
    expect((await context.call(global.cookie, 'POST', `${base}/disable`, {})).status).toBe(200);

    const actor = signIn(context.db, insertMachineWriter(context));
    const enabled = await context.call(actor.cookie, 'POST', `${base}/enable`, {});
    const asGlobal = await context.call(global.cookie, 'POST', `${base}/enable`, {});

    expect(enabled.status).toBe(400);
    expect(asGlobal.status).toBe(200);
    const row = context.db
      .prepare('SELECT status FROM admin_machine_principals WHERE id = ?')
      .get(principalId) as { status: string };
    expect(row.status).toBe('active');
  });

  it('still lets an Admin of the tenant enable its own principal', async () => {
    const context = await setup();
    const local = signIn(context.db, TENANT_SUPER_ADMIN);
    const principalId = await createPrincipal(context, local.cookie, { permissions: ['*'] });
    const base = `${MACHINE_ACCESS}/principals/${principalId}`;

    expect((await context.call(local.cookie, 'POST', `${base}/disable`, {})).status).toBe(200);
    expect((await context.call(local.cookie, 'POST', `${base}/enable`, {})).status).toBe(200);
  });
});

describe('11. a token is decided on one consistent state of the principal and credential', () => {
  /** L: the wildcard for the tenant. G: only what the global assignment holds, for every tenant. */
  async function lAndG() {
    const context = await setup();
    const actor = signIn(context.db, insertMachineWriter(context));
    const principalId = await createPrincipal(context, actor.cookie, { permissions: ['*'] });
    const credentialId = await createCredential(context, actor.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const toG = () =>
      context.call(actor.cookie, 'PATCH', `${MACHINE_ACCESS}/principals/${principalId}`, {
        permissions: ['admin:machine_access:write'],
        tenant_scopes: [{ scope_mode: 'all' }],
      });
    return { context, actor, principalId, credentialId, toG };
  }

  it('does not accept a global wildcard that the stored state never held', async () => {
    const { context, credentialId, toG } = await lAndG();
    // What a token endpoint that read L's permissions and G's scope would sign.
    const forged = await context.kit.sign(context.db, credentialId, ['*'], ['*']);

    // The change from L to G lands between the reads of the permissions and of the scopes.
    context.hooks.beforeQuery = {
      // Only a read of the scopes on their own: the snapshot is one statement, with nothing to
      // interleave.
      match: /admin_machine_principal_tenant_scopes\s+WHERE principal_id = \?/,
      run: async () => {
        expect((await toG()).status).toBe(200);
      },
    };
    const response = await context.callWithToken(forged, 'GET', '/probe/tenant-a');

    expect(response.status).toBe(401);
  });

  it('accepts a token the state it was read in does hold', async () => {
    const { context, credentialId, toG } = await lAndG();
    const local = await context.kit.sign(context.db, credentialId, ['*'], [TENANT]);
    expect((await context.callWithToken(local, 'GET', '/probe/tenant-a')).status).toBe(200);

    expect((await toG()).status).toBe(200);
    const global = await context.kit.sign(
      context.db,
      credentialId,
      ['admin:machine_access:write'],
      ['*']
    );
    const accepted = await context.callWithToken(global, 'GET', '/probe/tenant-a');
    expect(accepted.status).toBe(200);
    expect(accepted.json.globalPermissions).toEqual(['admin:machine_access:write']);
  });
});

describe('12. issuing tokens does not stand in the way of revoking, rotating or deleting', () => {
  async function liveCredential() {
    const context = await setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principalId = await createPrincipal(context, global.cookie, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const credentialId = await createCredential(context, global.cookie, principalId, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const { AdminMachineAccessRepository } = await import('@authrim/ar-lib-core');
    const repo = new AdminMachineAccessRepository(context.adapter);
    // A token endpoint noting that the key was used, between the Admin's read and write.
    const issueToken = () => {
      context.hooks.beforeBatch = async () => {
        await repo.updateCredentialLastUsed({ credentialId, ipAddress: '203.0.113.1' });
      };
    };
    return {
      context,
      global,
      issueToken,
      base: `${MACHINE_ACCESS}/principals/${principalId}/credentials/${credentialId}`,
      credentialId,
    };
  }

  it('revokes in an emergency while the key is used', async () => {
    const { context, global, issueToken, base, credentialId } = await liveCredential();
    issueToken();

    const revoked = await context.call(global.cookie, 'POST', `${base}/emergency-revoke`, {});

    expect(revoked.status).toBe(200);
    expect(credentialStatus(context, credentialId).status).toBe('revoked');
  });

  it('rotates and deletes while the key is used', async () => {
    const { context, global, issueToken, base, credentialId } = await liveCredential();
    issueToken();
    const rotated = await context.call(global.cookie, 'POST', `${base}/rotate`, credentialBody());
    expect(rotated.status).toBe(201);

    issueToken();
    const deleted = await context.call(global.cookie, 'DELETE', base);
    expect(deleted.status).toBe(200);
    expect(credentialStatus(context, credentialId).status).toBe('revoked');
  });
});

describe('13. the agent paths limit a grant by one snapshot of the machine principal', () => {
  it('reads the principal and the credential as stored, in one statement', async () => {
    const context = await setup();
    const actor = signIn(context.db, insertMachineWriter(context));
    // R: clients:read in tenant-b. The credential is allowed in tenant-a and tenant-b.
    const principalId = await createPrincipal(context, actor.cookie, {
      permissions: ['admin:machine_access:write'],
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-b' }],
    });
    const credentialId = await createCredential(context, actor.cookie, principalId, {
      tenant_scopes: [
        { scope_mode: 'allow', tenant_id: TENANT },
        { scope_mode: 'allow', tenant_id: 'tenant-b' },
      ],
    });
    const { AdminMachineAccessRepository } = await import('@authrim/ar-lib-core');
    const repo = new AdminMachineAccessRepository(context.adapter);

    const forB = await repo.resolveTenantMachineLimit('tenant-b', principalId, credentialId);
    const forA = await repo.resolveTenantMachineLimit(TENANT, principalId, credentialId);
    const principalOnly = await repo.resolveTenantMachineLimit('tenant-b', principalId);

    expect(forB?.permissions).toEqual(['admin:machine_access:write']);
    // The principal is not allowed in tenant-a, whatever its credential says.
    expect(forA).toBeNull();
    expect(principalOnly?.principal.id).toBe(principalId);
    expect(principalOnly?.credential).toBeNull();
    expect(await repo.resolveTenantMachineLimit('tenant-b', 'missing')).toBeNull();
    // A scope of `all` has no explicit tenant, so it gives no limit for the agent paths.
    await context.call(actor.cookie, 'PATCH', `${MACHINE_ACCESS}/principals/${principalId}`, {
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    expect(await repo.resolveTenantMachineLimit('tenant-b', principalId, credentialId)).toBeNull();
  });
});
