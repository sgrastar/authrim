import { describe, expect, it } from 'vitest';
import type { AdminAuthContext } from '@authrim/ar-lib-core';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';
import {
  mayActOnAdminAccount,
  mayRemoveAssignment,
} from '../routes/admin-management/admin-role-authority';
import { adminUsersRouter } from '../routes/admin-management/admins';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT_SUPER_ADMIN,
  insertRole,
  setupApp,
  signIn,
  type Assignment,
} from './helpers/admin-authority-fixture';

/**
 * Acting on another Admin's account (changing, suspending, deleting, activating, unlocking it, or
 * removing a role it holds) when the account holds a global assignment, or a role above the
 * caller's own. `permissions` and `hierarchyLevel` add up what the caller holds for one tenant, so
 * a global viewer who is a super_admin of one tenant has the wildcard and the top hierarchy; such
 * an account is reached only with the permission and the hierarchy of the global assignments.
 *
 * These run the real admin-auth middleware and the real routers on the real Admin schema.
 */

function setup() {
  return setupApp((app) => {
    app.route('/api/admin/admin-roles', adminRolesRouter);
    app.route('/api/admin/admins', adminUsersRouter);
    app.route('/api/admin/admin-invitations', adminInvitationsRouter);
  });
}

type Context = ReturnType<typeof setup>;

const GLOBAL_VIEWER: Assignment[] = [{ role: 'role_viewer', scope: 'global' }];
const TENANT_VIEWER: Assignment[] = [{ role: 'role_viewer', scope: 'tenant' }];

function accountOf(context: Context, userId: string) {
  return context.db
    .prepare('SELECT status, is_active FROM admin_users WHERE id = ?')
    .get(userId) as { status: string; is_active: number };
}
function assignmentCount(context: Context, userId: string) {
  return (
    context.db
      .prepare('SELECT COUNT(*) AS n FROM admin_role_assignments WHERE admin_user_id = ?')
      .get(userId) as { n: number }
  ).n;
}

/** The ways an account is acted on, with the status each leaves the target in when it works. */
const ACTIONS: Array<{
  name: string;
  method: string;
  path: (id: string) => string;
  body?: unknown;
}> = [
  { name: 'update', method: 'PATCH', path: (id) => `/api/admin/admins/${id}`, body: { name: 'x' } },
  { name: 'suspend', method: 'POST', path: (id) => `/api/admin/admins/${id}/suspend` },
  { name: 'activate', method: 'POST', path: (id) => `/api/admin/admins/${id}/activate` },
  { name: 'unlock', method: 'POST', path: (id) => `/api/admin/admins/${id}/unlock` },
  { name: 'delete', method: 'DELETE', path: (id) => `/api/admin/admins/${id}` },
];

describe('acting on an account that holds a global assignment', () => {
  for (const action of ACTIONS) {
    it(`refuses ${action.name} by an Admin whose global assignment is only a viewer`, async () => {
      const context = setup();
      // A second global super_admin, so the last-administrator guard is not what answers.
      signIn(context.db, GLOBAL_SUPER_ADMIN);
      const target = signIn(context.db, GLOBAL_SUPER_ADMIN);
      const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

      const response = await context.call(
        actor.cookie,
        action.method,
        action.path(target.userId),
        action.body
      );

      expect(response.status).toBe(403);
      expect(accountOf(context, target.userId)).toEqual({ status: 'active', is_active: 1 });
    });

    it(`refuses ${action.name} of a global viewer by a super_admin of the tenant only`, async () => {
      const context = setup();
      const target = signIn(context.db, GLOBAL_VIEWER);
      const actor = signIn(context.db, TENANT_SUPER_ADMIN);

      const response = await context.call(
        actor.cookie,
        action.method,
        action.path(target.userId),
        action.body
      );

      expect(response.status).toBe(403);
      expect(accountOf(context, target.userId)).toEqual({ status: 'active', is_active: 1 });
    });
  }

  it('lets a global super_admin suspend, activate, update and delete such accounts', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const peer = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const viewer = signIn(context.db, GLOBAL_VIEWER);

    const suspended = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${peer.userId}/suspend`
    );
    const activated = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${peer.userId}/activate`
    );
    const updated = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admins/${viewer.userId}`,
      {
        name: 'Renamed',
      }
    );
    const deleted = await context.call(
      actor.cookie,
      'DELETE',
      `/api/admin/admins/${viewer.userId}`
    );

    expect([suspended.status, activated.status, updated.status, deleted.status]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(accountOf(context, peer.userId).status).toBe('active');
    expect(accountOf(context, viewer.userId).is_active).toBe(0);
  });
});

describe('acting on an account that outranks the caller within the tenant', () => {
  function withManager() {
    const context = setup();
    insertRole(context.db, {
      id: 'role_manager',
      // Signing in takes one of the Admin roles by name; the permissions are the manager's own.
      name: 'support',
      permissions: [
        'admin:admin_users:read',
        'admin:admin_users:write',
        'admin:admin_users:delete',
        'admin:admin_roles:write',
      ],
      hierarchy: 50,
    });
    return context;
  }
  const manager: Assignment = { role: 'role_manager', scope: 'tenant' };

  it('refuses a manager on a tenant super_admin, and lets it manage a viewer', async () => {
    const context = withManager();
    const above = signIn(context.db, TENANT_SUPER_ADMIN);
    const below = signIn(context.db, TENANT_VIEWER);
    const actor = signIn(context.db, [manager]);

    const refused = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${above.userId}/suspend`
    );
    const allowed = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${below.userId}/suspend`
    );

    expect(refused.status).toBe(403);
    expect(accountOf(context, above.userId).status).toBe('active');
    expect(allowed.status).toBe(200);
    expect(accountOf(context, below.userId).status).toBe('suspended');
  });

  it('lets a super_admin of the tenant act on another super_admin of the tenant', async () => {
    const context = setup();
    const peer = signIn(context.db, TENANT_SUPER_ADMIN);
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);

    const response = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${peer.userId}/suspend`
    );

    expect(response.status).toBe(200);
  });

  it('keeps the rules for acting on oneself', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

    const suspend = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${actor.userId}/suspend`
    );
    const rename = await context.call(actor.cookie, 'PATCH', `/api/admin/admins/${actor.userId}`, {
      name: 'Me',
    });

    expect(suspend.status).toBe(403);
    expect(rename.status).toBe(200);
  });
});

describe('removing a role assignment', () => {
  /** The three ways to remove one, for a target's first assignment. */
  function removals(userId: string, roleId: string) {
    const assignmentId = `${userId}-assignment-0`;
    return [
      `/api/admin/admins/${userId}/role-assignments/${assignmentId}`,
      `/api/admin/admin-roles/${roleId}/assignments/${assignmentId}`,
      `/api/admin/admins/${userId}/roles/${roleId}`,
    ];
  }

  it('refuses removing a global assignment by an Admin whose global assignment is only a viewer', async () => {
    const context = setup();
    signIn(context.db, GLOBAL_SUPER_ADMIN);
    const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

    for (const [index, role] of ['role_viewer', 'role_super_admin'].entries()) {
      const target = signIn(context.db, [{ role, scope: 'global' }]);
      for (const path of removals(target.userId, role)) {
        const response = await context.call(actor.cookie, 'DELETE', path);
        expect(response.status, `${role} ${path} (${index})`).toBe(403);
      }
      expect(assignmentCount(context, target.userId)).toBe(1);
    }
  });

  it('lets a global super_admin remove a global assignment, by each route', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_SUPER_ADMIN);
    // Another super_admin, so the last-administrator guard is not what answers.
    signIn(context.db, GLOBAL_SUPER_ADMIN);

    for (const [index] of [0, 1, 2].entries()) {
      const target = signIn(context.db, GLOBAL_VIEWER);
      const path = removals(target.userId, 'role_viewer')[index];
      const response = await context.call(actor.cookie, 'DELETE', path);
      expect(response.status, path).toBe(200);
      expect(assignmentCount(context, target.userId)).toBe(0);
    }
  });

  it('refuses removing a role above the caller from a tenant assignment, and lets a super_admin of the tenant remove one', async () => {
    const context = setup();
    insertRole(context.db, {
      id: 'role_manager',
      name: 'support',
      permissions: ['admin:admin_users:read', 'admin:admin_roles:write'],
      hierarchy: 50,
    });
    const above = signIn(context.db, TENANT_SUPER_ADMIN);
    const manager = signIn(context.db, [{ role: 'role_manager', scope: 'tenant' }]);
    const superAdmin = signIn(context.db, TENANT_SUPER_ADMIN);
    const viewer = signIn(context.db, TENANT_VIEWER);

    for (const path of removals(above.userId, 'role_super_admin')) {
      const response = await context.call(manager.cookie, 'DELETE', path);
      expect(response.status, path).toBe(403);
    }
    expect(assignmentCount(context, above.userId)).toBe(1);

    const removed = await context.call(
      superAdmin.cookie,
      'DELETE',
      removals(viewer.userId, 'role_viewer')[0]
    );
    expect(removed.status).toBe(200);
    expect(assignmentCount(context, viewer.userId)).toBe(0);
  });
});

describe('moving a global assignment to a tenant', () => {
  it('is judged as removing the global assignment', async () => {
    const context = setup();
    signIn(context.db, GLOBAL_SUPER_ADMIN);
    const target = signIn(context.db, [{ role: 'role_viewer', scope: 'global' }]);
    const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

    const response = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admin-roles/role_viewer/assignments/${target.userId}-assignment-0`,
      { scope_type: 'tenant' }
    );

    expect(response.status).toBe(403);
    const row = context.db
      .prepare('SELECT scope_type FROM admin_role_assignments WHERE admin_user_id = ?')
      .get(target.userId) as { scope_type: string };
    expect(row.scope_type).toBe('global');
  });

  it('is allowed to a global super_admin', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const target = signIn(context.db, [{ role: 'role_viewer', scope: 'global' }]);

    const response = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admin-roles/role_viewer/assignments/${target.userId}-assignment-0`,
      { scope_type: 'tenant' }
    );

    expect(response.status).toBe(200);
  });
});

describe('revoking an invitation', () => {
  function invite(context: Context, scopeType: 'global' | 'tenant', roleName: string) {
    const now = Date.now();
    const id = `invitation-${scopeType}-${roleName}`;
    context.db
      .prepare(
        `INSERT INTO admin_invitations (id, tenant_id, admin_user_id, email, pending_email_key,
           code_hash, status, admin_role_id, admin_role_name, scope_type, expires_at, last_sent_at,
           created_by, created_at, updated_at)
         VALUES (?, 'tenant-a', ?, ?, ?, 'hash', 'pending', ?, ?, ?, ?, ?, 'x', ?, ?)`
      )
      .run(
        id,
        `invited-${id}`,
        `${id}@example.test`,
        `${id}@example.test`,
        `role_${roleName}`,
        roleName,
        scopeType,
        now + 3_600_000,
        now,
        now,
        now
      );
    return id;
  }
  const statusOf = (context: Context, id: string) =>
    (
      context.db.prepare('SELECT status FROM admin_invitations WHERE id = ?').get(id) as {
        status: string;
      }
    ).status;

  it('needs the wildcard from a global assignment for a global invitation', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const id = invite(context, 'global', 'super_admin');

    const response = await context.call(
      actor.cookie,
      'DELETE',
      `/api/admin/admin-invitations/${id}`
    );

    expect(response.status).toBe(403);
    expect(statusOf(context, id)).toBe('pending');
  });

  it('lets a global super_admin revoke it, and a super_admin of the tenant revoke a tenant one', async () => {
    const context = setup();
    const globalActor = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const tenantActor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const globalInvitation = invite(context, 'global', 'viewer');
    const tenantInvitation = invite(context, 'tenant', 'viewer');

    const first = await context.call(
      globalActor.cookie,
      'DELETE',
      `/api/admin/admin-invitations/${globalInvitation}`
    );
    const second = await context.call(
      tenantActor.cookie,
      'DELETE',
      `/api/admin/admin-invitations/${tenantInvitation}`
    );

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(statusOf(context, globalInvitation)).toBe('revoked');
    expect(statusOf(context, tenantInvitation)).toBe('revoked');
  });

  it('answers 404 for an invitation that is not pending', async () => {
    const context = setup();
    const actor = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const response = await context.call(
      actor.cookie,
      'DELETE',
      '/api/admin/admin-invitations/nope'
    );
    expect(response.status).toBe(404);
  });
});

describe('a machine token, which has no hierarchy', () => {
  const machine = (permissions: string[], scope: string[]): AdminAuthContext =>
    ({
      userId: 'amp_1',
      authMethod: 'machine_access_token',
      roles: [],
      permissions,
      hierarchyLevel: 0,
      globalRoles: [],
      globalPermissions: scope.includes('*') ? permissions : [],
      globalHierarchyLevel: 0,
      tenantScope: scope,
      tenantId: 'tenant-a',
    }) as unknown as AdminAuthContext;

  it('is measured by its permission alone when it holds it for every tenant', () => {
    const global = machine(['admin:*'], ['*']);
    expect(
      mayActOnAdminAccount(
        global,
        { hasGlobalAssignment: false, highestLevel: 20 },
        'admin:admin_users:write'
      )
    ).toBe(true);
    expect(
      mayActOnAdminAccount(
        global,
        { hasGlobalAssignment: true, highestLevel: 100 },
        'admin:admin_users:write'
      )
    ).toBe(true);
    expect(mayRemoveAssignment(global, 'global', 80)).toBe(true);
    expect(mayRemoveAssignment(global, 'tenant', 20)).toBe(true);
  });

  it('outranks nothing when it is limited to a tenant, so issuing one is no way around the hierarchy', () => {
    const tenantOnly = machine(['admin:*'], ['tenant-a']);
    expect(
      mayActOnAdminAccount(
        tenantOnly,
        { hasGlobalAssignment: false, highestLevel: 100 },
        'admin:admin_users:write'
      )
    ).toBe(false);
    expect(
      mayActOnAdminAccount(
        tenantOnly,
        { hasGlobalAssignment: true, highestLevel: 20 },
        'admin:admin_users:write'
      )
    ).toBe(false);
    expect(mayRemoveAssignment(tenantOnly, 'tenant', 100)).toBe(false);
    expect(mayRemoveAssignment(tenantOnly, 'global', 20)).toBe(false);
  });

  it('still needs the permission for every tenant to reach a global account', () => {
    const narrow = machine(['admin:admin_users:read'], ['*']);
    const target = { hasGlobalAssignment: true, highestLevel: 20 };
    expect(mayActOnAdminAccount(narrow, target, 'admin:admin_users:write')).toBe(false);
  });
});
