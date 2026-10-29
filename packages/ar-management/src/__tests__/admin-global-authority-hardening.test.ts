import { describe, expect, it } from 'vitest';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';
import { adminUsersRouter } from '../routes/admin-management/admins';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';
import { machineAccessRouter } from '../routes/admin-management/machine-access';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  insertRole,
  setupApp,
  signIn,
} from './helpers/admin-authority-fixture';

/**
 * Operations that take effect for every tenant, or that make a global permission, are allowed only
 * on what the global assignments give. An Admin with a global assignment that is only a viewer and
 * the wildcard held for one tenant has the wildcard in `permissions` and the global scope in
 * `tenantScope`, and must not be able to use the two together.
 *
 * These run the real admin-auth middleware and the real routers on the real Admin schema.
 */

function setup() {
  return setupApp((app) => {
    app.route('/api/admin/admin-roles', adminRolesRouter);
    app.route('/api/admin/admins', adminUsersRouter);
    app.route('/api/admin/admin-invitations', adminInvitationsRouter);
    app.route('/api/admin/machine-access', machineAccessRouter);
  });
}

const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

describe('machine access: what a principal or credential may be given', () => {
  const principalBody = (overrides: Record<string, unknown> = {}) => ({
    client_id: `client-${Math.random().toString(36).slice(2)}`,
    display_name: 'Automation',
    principal_type: 'automation',
    permissions: ['admin:users:read'],
    tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
    ...overrides,
  });
  const credentialBody = (overrides: Record<string, unknown> = {}) => ({
    kid: `kid-${Math.random().toString(36).slice(2)}`,
    display_name: 'Key',
    alg: 'ES256',
    public_jwk: PUBLIC_JWK,
    ...overrides,
  });
  const principalCount = (context: ReturnType<typeof setup>) =>
    (
      context.db.prepare('SELECT COUNT(*) AS n FROM admin_machine_principals').get() as {
        n: number;
      }
    ).n;

  it('refuses an Admin whose wildcard is held for the tenant a principal with every permission over every tenant', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

    const created = await context.call(
      actor.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({ permissions: ['*'], tenant_scopes: [{ scope_mode: 'all' }] })
    );

    expect(created.status).toBe(400);
    expect(principalCount(context)).toBe(0);
  });

  it('refuses the same for another tenant, and for every tenant with a permission only the tenant holds', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

    const otherTenant = await context.call(
      actor.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({
        permissions: ['admin:settings:write'],
        tenant_scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-b' }],
      })
    );
    const everyTenant = await context.call(
      actor.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({
        permissions: ['admin:settings:write'],
        tenant_scopes: [{ scope_mode: 'all' }],
      })
    );

    expect(otherTenant.status).toBe(400);
    expect(everyTenant.status).toBe(400);
    expect(principalCount(context)).toBe(0);
  });

  it('refuses every tenant even for a permission the global assignment holds, when it holds no machine access', async () => {
    const context = setup();
    const actor = signIn(context.db, [
      { role: 'role_ar_viewer', scope: 'global' },
      { role: 'role_ar_super_admin', scope: 'tenant' },
    ]);
    // The viewer role does not hold machine access, so the global part cannot hand it out.
    const created = await context.call(
      actor.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({
        permissions: ['admin:users:read'],
        tenant_scopes: [{ scope_mode: 'all' }],
      })
    );

    expect(created.status).toBe(400);
  });

  it('refuses a key of its own on a principal that reaches every tenant, by create and by rotate', async () => {
    const context = setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principal = await context.call(
      global.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({ permissions: ['*'], tenant_scopes: [{ scope_mode: 'all' }] })
    );
    expect(principal.status).toBe(201);
    const principalId = principal.json.principal.id as string;
    const issued = await context.call(
      global.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials`,
      credentialBody({
        permissions: ['admin:users:read'],
        tenant_scopes: [{ scope_mode: 'all' }],
      })
    );
    expect(issued.status).toBe(201);

    const mixed = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const create = await context.call(
      mixed.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials`,
      credentialBody({ permissions: ['*'], tenant_scopes: [{ scope_mode: 'all' }] })
    );
    const createInheriting = await context.call(
      mixed.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials`,
      credentialBody({ tenant_scopes: [{ scope_mode: 'all' }] })
    );
    const rotate = await context.call(
      mixed.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials/${issued.json.credential.id}/rotate`,
      credentialBody()
    );
    const seen = await context.call(
      mixed.cookie,
      'GET',
      `/api/admin/machine-access/principals/${principalId}`
    );

    // A principal that reaches every tenant is not the Admin's to manage: it is not even visible.
    expect(create.status).toBe(400);
    expect(createInheriting.status).toBe(400);
    expect(rotate.status).toBe(404);
    expect(seen.status).toBe(404);
    const credentials = context.db
      .prepare('SELECT COUNT(*) AS n FROM admin_machine_credentials WHERE principal_id = ?')
      .get(principalId) as { n: number };
    expect(credentials.n).toBe(1);
  });

  it('refuses widening a tenant principal to every tenant, and a credential likewise', async () => {
    const context = setup();
    const mixed = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const principal = await context.call(
      mixed.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({ permissions: ['*'] })
    );
    // Everything for this tenant is the Admin's to give.
    expect(principal.status).toBe(201);
    const principalId = principal.json.principal.id as string;
    const credential = await context.call(
      mixed.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials`,
      credentialBody({
        permissions: ['*'],
        tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
      })
    );
    expect(credential.status).toBe(201);

    const widenPrincipal = await context.call(
      mixed.cookie,
      'PATCH',
      `/api/admin/machine-access/principals/${principalId}`,
      { tenant_scopes: [{ scope_mode: 'all' }] }
    );
    const widenCredential = await context.call(
      mixed.cookie,
      'PATCH',
      `/api/admin/machine-access/principals/${principalId}/credentials/${credential.json.credential.id}`,
      { tenant_scopes: [{ scope_mode: 'all' }] }
    );
    const otherTenant = await context.call(
      mixed.cookie,
      'PATCH',
      `/api/admin/machine-access/principals/${principalId}`,
      { tenant_scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-b' }] }
    );

    expect(widenPrincipal.status).toBe(400);
    expect(otherTenant.status).toBe(400);
    // A credential never reaches beyond its principal, so widening it changes nothing.
    expect(widenCredential.status).toBe(200);
    const scopes = context.db
      .prepare('SELECT scope_mode, tenant_id FROM admin_machine_principal_tenant_scopes')
      .all() as Array<{ scope_mode: string; tenant_id: string | null }>;
    expect(scopes).toEqual([{ scope_mode: 'allow', tenant_id: TENANT }]);
  });

  it('refuses a rotation that would take a principal of every tenant over, even for a key of the tenant only', async () => {
    const context = setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const principal = await context.call(
      global.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({ permissions: ['admin:users:read'], tenant_scopes: [{ scope_mode: 'all' }] })
    );
    const principalId = principal.json.principal.id as string;

    const mixed = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const issued = await context.call(
      mixed.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials`,
      credentialBody({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }] })
    );

    expect(issued.status).toBe(400);
  });

  it('still lets a global ar_super_admin create, widen and key a principal for every tenant', async () => {
    const context = setup();
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);

    const created = await context.call(
      global.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({ permissions: ['*'], tenant_scopes: [{ scope_mode: 'all' }] })
    );
    const principalId = created.json.principal.id as string;
    const keyed = await context.call(
      global.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials`,
      credentialBody({ permissions: ['*'], tenant_scopes: [{ scope_mode: 'all' }] })
    );
    const rotated = await context.call(
      global.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials/${keyed.json.credential.id}/rotate`,
      credentialBody()
    );
    const widened = await context.call(
      global.cookie,
      'PATCH',
      `/api/admin/machine-access/principals/${principalId}`,
      { tenant_scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-b' }] }
    );

    expect(created.status).toBe(201);
    expect(keyed.status).toBe(201);
    expect(rotated.status).toBe(201);
    expect(widened.status).toBe(200);
  });

  it('still lets a tenant-limited ar_super_admin manage machine access inside the tenant', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);

    const created = await context.call(
      actor.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({ permissions: ['admin:users:read'] })
    );
    const principalId = created.json.principal.id as string;
    const keyed = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/machine-access/principals/${principalId}/credentials`,
      credentialBody({
        permissions: ['admin:users:read'],
        tenant_scopes: [{ scope_mode: 'allow', tenant_id: TENANT }],
      })
    );
    const refused = await context.call(
      actor.cookie,
      'POST',
      '/api/admin/machine-access/principals',
      principalBody({ tenant_scopes: [{ scope_mode: 'all' }] })
    );

    expect(created.status).toBe(201);
    expect(keyed.status).toBe(201);
    expect(refused.status).toBe(400);
  });
});

describe('changing a role that a global assignment leads to', () => {
  it('refuses an Admin with the wildcard for the tenant a wildcard on a global read-only role', async () => {
    const context = setup();
    insertRole(context.db, {
      id: 'role_global_reader',
      name: 'global-reader',
      permissions: ['admin:users:read'],
      hierarchy: 5,
    });
    const actor = signIn(context.db, [
      { role: 'role_global_reader', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ]);

    const patched = await context.call(
      actor.cookie,
      'PATCH',
      '/api/admin/admin-roles/role_global_reader',
      { permissions: ['*'] }
    );

    expect(patched.status).toBe(403);
    const probe = await context.call(actor.cookie, 'GET', '/probe/tenant-a');
    expect(probe.json.globalPermissions).toEqual(['admin:users:read']);
  });

  it('refuses it through a role the global one inherits, and through a new inheritance', async () => {
    const context = setup();
    insertRole(context.db, {
      id: 'role_base',
      name: 'base',
      permissions: ['admin:users:read'],
      hierarchy: 4,
    });
    insertRole(context.db, {
      id: 'role_global_reader',
      name: 'global-reader',
      permissions: ['admin:clients:read'],
      hierarchy: 5,
      inheritsFrom: 'role_base',
    });
    insertRole(context.db, {
      id: 'role_loose',
      name: 'loose',
      permissions: ['admin:settings:write'],
      hierarchy: 3,
    });
    const actor = signIn(context.db, [
      { role: 'role_global_reader', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ]);

    const throughParent = await context.call(
      actor.cookie,
      'PATCH',
      '/api/admin/admin-roles/role_base',
      { permissions: ['*'] }
    );
    const newParent = await context.call(
      actor.cookie,
      'PATCH',
      '/api/admin/admin-roles/role_global_reader',
      { inherits_from: 'role_loose' }
    );

    expect(throughParent.status).toBe(403);
    expect(newParent.status).toBe(403);
    const probe = await context.call(actor.cookie, 'GET', '/probe/tenant-a');
    expect(probe.json.globalPermissions).toEqual(
      expect.arrayContaining(['admin:clients:read', 'admin:users:read'])
    );
    expect(probe.json.globalPermissions).not.toContain('*');
    expect(probe.json.globalPermissions).not.toContain('admin:settings:write');
  });

  it('refuses it while a global invitation for the role is pending', async () => {
    const context = setup();
    insertRole(context.db, {
      id: 'role_invited',
      name: 'invited',
      permissions: ['admin:users:read'],
      hierarchy: 5,
    });
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO admin_invitations (id, tenant_id, admin_user_id, email, pending_email_key, code_hash, status,
           admin_role_id, admin_role_name, scope_type, expires_at, last_sent_at, created_by, created_at, updated_at)
         VALUES ('invitation-1', ?, 'invited-user', 'invited@example.test', 'invited@example.test', 'hash',
           'pending', 'role_invited', 'invited', 'global', ?, ?, 'someone', ?, ?)`
      )
      .run(TENANT, now - 1000, now - 100_000, now, now);
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);

    const patched = await context.call(
      actor.cookie,
      'PATCH',
      '/api/admin/admin-roles/role_invited',
      { permissions: ['*'] }
    );

    expect(patched.status).toBe(403);
  });

  it('still lets a global ar_super_admin change such a role', async () => {
    const context = setup();
    insertRole(context.db, {
      id: 'role_global_reader',
      name: 'global-reader',
      permissions: ['admin:users:read'],
      hierarchy: 5,
    });
    const actor = signIn(context.db, [
      { role: 'role_global_reader', scope: 'global' },
      ...GLOBAL_SUPER_ADMIN,
    ]);

    const patched = await context.call(
      actor.cookie,
      'PATCH',
      '/api/admin/admin-roles/role_global_reader',
      { permissions: ['admin:users:read', 'admin:clients:read'] }
    );

    expect(patched.status).toBe(200);
  });

  it('still lets a tenant-limited ar_super_admin change a role that only the tenant uses', async () => {
    const context = setup();
    insertRole(context.db, {
      id: 'role_local',
      name: 'local',
      permissions: ['admin:users:read'],
      hierarchy: 5,
    });
    const actor = signIn(context.db, [
      { role: 'role_local', scope: 'tenant' },
      ...TENANT_SUPER_ADMIN,
    ]);

    const patched = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_local', {
      permissions: ['admin:users:read', 'admin:clients:read'],
      display_name: 'Local',
    });

    expect(patched.status).toBe(200);
  });
});

describe('role hierarchy', () => {
  const writer = { role: 'role_writer', scope: 'tenant' as const };

  function withWriter() {
    const context = setup();
    insertRole(context.db, {
      id: 'role_writer',
      // Signing in takes one of the Admin roles by name; the permissions are the writer's own.
      name: 'ar_support',
      permissions: ['admin:admin_roles:read', 'admin:admin_roles:write', 'admin:users:read'],
      hierarchy: 50,
    });
    return context;
  }

  it('refuses changing a role that is not below the caller, whatever hierarchy the body asks for', async () => {
    const context = withWriter();
    insertRole(context.db, {
      id: 'role_peer',
      name: 'peer',
      permissions: ['admin:users:read'],
      hierarchy: 50,
    });
    insertRole(context.db, {
      id: 'role_above',
      name: 'above',
      permissions: ['admin:users:read'],
      hierarchy: 70,
    });
    insertRole(context.db, {
      id: 'role_below',
      name: 'below',
      permissions: ['admin:users:read'],
      hierarchy: 10,
    });
    const actor = signIn(context.db, [writer]);

    const peer = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_peer', {
      permissions: ['admin:users:read'],
    });
    const above = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_above', {
      description: 'edited',
    });
    const below = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_below', {
      description: 'edited',
      hierarchy_level: 20,
    });

    expect(peer.status).toBe(403);
    expect(above.status).toBe(403);
    expect(below.status).toBe(200);
  });

  it('refuses updating an assignment of a role that is not below the caller', async () => {
    const context = withWriter();
    insertRole(context.db, {
      id: 'role_above',
      name: 'above',
      permissions: ['admin:users:read'],
      hierarchy: 70,
    });
    const target = signIn(context.db, [{ role: 'role_above', scope: 'tenant' }]);
    const actor = signIn(context.db, [writer]);

    const updated = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admin-roles/role_above/assignments/${target.userId}-assignment-0`,
      { expires_at: Date.now() + 86_400_000 }
    );

    expect(updated.status).toBe(403);
  });

  it('lets the caller update an assignment of a role below it', async () => {
    const context = withWriter();
    insertRole(context.db, {
      id: 'role_below',
      name: 'below',
      permissions: ['admin:users:read'],
      hierarchy: 10,
    });
    const target = signIn(context.db, [{ role: 'role_below', scope: 'tenant' }]);
    const actor = signIn(context.db, [writer]);

    const updated = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admin-roles/role_below/assignments/${target.userId}-assignment-0`,
      { expires_at: Date.now() + 86_400_000 }
    );

    expect(updated.status).toBe(200);
  });
});

describe('inherits_from', () => {
  function withWriter() {
    const context = setup();
    insertRole(context.db, {
      id: 'role_writer',
      // Signing in takes one of the Admin roles by name; the permissions are the writer's own.
      name: 'ar_support',
      permissions: ['admin:admin_roles:read', 'admin:admin_roles:write', 'admin:users:read'],
      hierarchy: 50,
    });
    return context;
  }
  const writer = { role: 'role_writer', scope: 'tenant' as const };

  it('refuses a role that inherits ar_super_admin, at creation and by update', async () => {
    const context = withWriter();
    insertRole(context.db, {
      id: 'role_plain',
      name: 'plain',
      permissions: ['admin:users:read'],
      hierarchy: 5,
    });
    const actor = signIn(context.db, [writer]);

    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'sneaky',
      permissions: [],
      hierarchy_level: 5,
      inherits_from: 'role_ar_super_admin',
    });
    const updated = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_plain', {
      inherits_from: 'role_ar_super_admin',
    });

    expect(created.status).toBe(403);
    expect(updated.status).toBe(403);
  });

  it('refuses a parent that holds more than the caller or is not below it, or that the tenant cannot see', async () => {
    const context = withWriter();
    insertRole(context.db, {
      id: 'role_rich',
      name: 'rich',
      permissions: ['admin:settings:write'],
      hierarchy: 5,
    });
    insertRole(context.db, {
      id: 'role_high',
      name: 'high',
      permissions: ['admin:users:read'],
      hierarchy: 60,
    });
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, created_at, updated_at)
         VALUES ('role_foreign', 'other-tenant', 'foreign', '[]', 1, 'custom', 0, ?, ?)`
      )
      .run(now, now);
    const actor = signIn(context.db, [writer]);
    const create = (parent: string) =>
      context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
        name: `child-of-${parent}`,
        permissions: [],
        hierarchy_level: 5,
        inherits_from: parent,
      });

    const rich = await create('role_rich');
    const high = await create('role_high');
    const foreign = await create('role_foreign');
    const missing = await create('role_missing');

    expect(rich.status).toBe(403);
    expect(high.status).toBe(403);
    expect(foreign.status).toBe(400);
    expect(missing.status).toBe(400);
  });

  it('refuses a cycle', async () => {
    const context = withWriter();
    insertRole(context.db, {
      id: 'role_one',
      name: 'one',
      permissions: ['admin:users:read'],
      hierarchy: 5,
    });
    insertRole(context.db, {
      id: 'role_two',
      name: 'two',
      permissions: ['admin:users:read'],
      hierarchy: 5,
      inheritsFrom: 'role_one',
    });
    const actor = signIn(context.db, [writer]);

    const self = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_one', {
      inherits_from: 'role_one',
    });
    const loop = await context.call(actor.cookie, 'PATCH', '/api/admin/admin-roles/role_one', {
      inherits_from: 'role_two',
    });

    expect(self.status).toBe(400);
    expect(loop.status).toBe(400);
  });

  it('lets the caller inherit a visible role below it that holds only what the caller holds', async () => {
    const context = withWriter();
    insertRole(context.db, {
      id: 'role_small',
      name: 'small',
      permissions: ['admin:users:read'],
      hierarchy: 5,
    });
    const actor = signIn(context.db, [writer]);

    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'child',
      permissions: ['admin:users:read'],
      hierarchy_level: 5,
      inherits_from: 'role_small',
    });
    const system = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'child-of-viewer',
      permissions: [],
      hierarchy_level: 5,
      inherits_from: 'role_ar_viewer',
    });

    expect(created.status).toBe(201);
    expect(created.json.inherits_from).toBe('role_small');
    // The viewer reads settings and clients, which the writer does not hold.
    expect(system.status).toBe(403);
  });

  it('does not let a custom role carry the name of a system role', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);

    // The reserved prefix is the standard roles' alone: Admin checks read their names as authority.
    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'ar_super_admin',
      permissions: [],
      hierarchy_level: 1,
    });
    const admin = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'AR_Anything',
      permissions: [],
      hierarchy_level: 1,
    });

    const free = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'auditors',
      permissions: [],
      hierarchy_level: 1,
    });

    expect(created.status).toBe(400);
    expect(admin.status).toBe(400);
    expect(free.status).toBe(201);
  });
});

describe('bringing a global invitation back', () => {
  const insertInvitation = (
    context: ReturnType<typeof setup>,
    input: { id: string; roleId: string; roleName: string; scope: 'global' | 'tenant' }
  ) => {
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO admin_invitations (id, tenant_id, admin_user_id, email, pending_email_key, code_hash, status,
           admin_role_id, admin_role_name, scope_type, scope_id, expires_at, last_sent_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'hash', 'pending', ?, ?, ?, ?, ?, ?, 'someone', ?, ?)`
      )
      .run(
        input.id,
        TENANT,
        `user-${input.id}`,
        `${input.id}@example.test`,
        `${input.id}@example.test`,
        input.roleId,
        input.roleName,
        input.scope,
        input.scope === 'tenant' ? TENANT : null,
        now - 1000,
        now - 100_000,
        now,
        now
      );
  };
  const expiryOf = (context: ReturnType<typeof setup>, id: string) =>
    (
      context.db.prepare('SELECT expires_at FROM admin_invitations WHERE id = ?').get(id) as {
        expires_at: number;
      }
    ).expires_at;

  it('refuses a resend of an expired global or ar_super_admin invitation without the wildcard from a global assignment', async () => {
    const context = setup();
    insertInvitation(context, {
      id: 'global-invitation',
      roleId: 'role_ar_support',
      roleName: 'support',
      scope: 'global',
    });
    insertInvitation(context, {
      id: 'super-invitation',
      roleId: 'role_ar_super_admin',
      roleName: 'ar_super_admin',
      scope: 'global',
    });
    const before = expiryOf(context, 'global-invitation');
    const mixed = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const local = signIn(context.db, TENANT_SUPER_ADMIN);

    for (const actor of [mixed, local]) {
      for (const id of ['global-invitation', 'super-invitation']) {
        const resent = await context.call(
          actor.cookie,
          'POST',
          `/api/admin/admin-invitations/${id}/resend`
        );
        expect(resent.status).toBe(403);
      }
    }
    expect(expiryOf(context, 'global-invitation')).toBe(before);
  });

  it('lets a global ar_super_admin resend it, and a tenant-limited ar_super_admin resend a tenant invitation', async () => {
    const context = setup();
    insertInvitation(context, {
      id: 'global-invitation',
      roleId: 'role_ar_support',
      roleName: 'support',
      scope: 'global',
    });
    insertInvitation(context, {
      id: 'tenant-invitation',
      roleId: 'role_ar_support',
      roleName: 'support',
      scope: 'tenant',
    });
    const global = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const local = signIn(context.db, TENANT_SUPER_ADMIN);

    const byGlobal = await context.call(
      global.cookie,
      'POST',
      '/api/admin/admin-invitations/global-invitation/resend'
    );
    const byLocal = await context.call(
      local.cookie,
      'POST',
      '/api/admin/admin-invitations/tenant-invitation/resend'
    );

    // The invitation is renewed; whether the e-mail then goes out depends on the environment.
    expect(byGlobal.status).not.toBe(403);
    expect(byLocal.status).not.toBe(403);
    expect(expiryOf(context, 'global-invitation')).toBeGreaterThan(Date.now());
    expect(expiryOf(context, 'tenant-invitation')).toBeGreaterThan(Date.now());
  });
});
