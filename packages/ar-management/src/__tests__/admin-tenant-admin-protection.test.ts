import { describe, expect, it } from 'vitest';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';
import { adminUsersRouter } from '../routes/admin-management/admins';
import { isScopeAllowedForRole } from '../routes/admin-management/admin-role-authority';
import { ADMIN_ROLES } from '@authrim/ar-lib-core';
import {
  GLOBAL_SUPER_ADMIN,
  setupApp,
  signIn,
  type Assignment,
} from './helpers/admin-authority-fixture';

/**
 * A tenant keeps an administrator, and the standard roles are held where they belong. These run
 * the real admin-auth middleware and the real routers on the real Admin schema (with the `ar_`
 * roles the migration seeds).
 */

function setup() {
  return setupApp((app) => {
    app.route('/api/admin/admin-roles', adminRolesRouter);
    app.route('/api/admin/admins', adminUsersRouter);
  });
}

type Context = ReturnType<typeof setup>;

const TENANT_ADMIN: Assignment[] = [{ role: 'role_ar_tenant_admin', scope: 'tenant' }];
const GLOBAL_TENANT_ADMIN: Assignment[] = [{ role: 'role_ar_tenant_admin', scope: 'global' }];
const SUPPORT: Assignment[] = [{ role: 'role_ar_support', scope: 'tenant' }];

const assignmentOf = (userId: string) => `${userId}-assignment-0`;

function status(context: Context, userId: string): string {
  return (
    context.db.prepare('SELECT status FROM admin_users WHERE id = ?').get(userId) as {
      status: string;
    }
  ).status;
}

function assignmentCount(context: Context, userId: string): number {
  return (
    context.db
      .prepare('SELECT COUNT(*) AS n FROM admin_role_assignments WHERE admin_user_id = ?')
      .get(userId) as { n: number }
  ).n;
}

/** A tenant admin of another tenant: it must not count for this one. */
function otherTenantAdmin(context: Context) {
  context.db
    .prepare(
      `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
       VALUES ('other-admin', 'tenant-b', 'other@example.test', 1, 'active', 1, 1)`
    )
    .run();
  context.db
    .prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
       VALUES ('other-assignment', 'tenant-b', 'other-admin', 'role_ar_tenant_admin', 'tenant', 'tenant-b', 1)`
    )
    .run();
}

describe('the last tenant administrator', () => {
  it('cannot lose the role by removing its assignment', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const only = signIn(context.db, TENANT_ADMIN);

    const byUser = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${only.userId}/role-assignments/${assignmentOf(only.userId)}`
    );
    const byRole = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admin-roles/role_ar_tenant_admin/assignments/${assignmentOf(only.userId)}`
    );
    const byRoleId = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${only.userId}/roles/role_ar_tenant_admin`
    );

    expect([byUser.status, byRole.status, byRoleId.status]).toEqual([409, 409, 409]);
    expect(byUser.json.error).toBe('last_tenant_admin');
    expect(assignmentCount(context, only.userId)).toBe(1);
  });

  it('cannot be suspended or deleted', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const only = signIn(context.db, TENANT_ADMIN);

    const suspended = await context.call(
      root.cookie,
      'POST',
      `/api/admin/admins/${only.userId}/suspend`
    );
    const patched = await context.call(root.cookie, 'PATCH', `/api/admin/admins/${only.userId}`, {
      status: 'suspended',
    });
    const deleted = await context.call(root.cookie, 'DELETE', `/api/admin/admins/${only.userId}`);

    expect([suspended.status, patched.status, deleted.status]).toEqual([409, 409, 409]);
    expect(status(context, only.userId)).toBe('active');
  });

  it('cannot expire in the past through an assignment update', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const only = signIn(context.db, TENANT_ADMIN);

    const response = await context.call(
      root.cookie,
      'PATCH',
      `/api/admin/admin-roles/role_ar_tenant_admin/assignments/${assignmentOf(only.userId)}`,
      { expires_at: Date.now() - 1000 }
    );

    expect(response.status).toBe(409);
    expect(response.json.error).toBe('last_tenant_admin');
  });

  it('cannot be given an expiry later either: an assignment that ends by itself does not keep the tenant', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const only = signIn(context.db, TENANT_ADMIN);

    const response = await context.call(
      root.cookie,
      'PATCH',
      `/api/admin/admin-roles/role_ar_tenant_admin/assignments/${assignmentOf(only.userId)}`,
      { expires_at: Date.now() + 86_400_000 }
    );

    expect(response.status).toBe(409);
    expect(response.json.error).toBe('last_tenant_admin');
  });

  it('is not kept by a tenant administrator whose assignment expires, and a second permanent one allows the change', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const permanent = signIn(context.db, TENANT_ADMIN);
    const temporary = signIn(context.db, TENANT_ADMIN);
    context.db
      .prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE admin_user_id = ?')
      .run(Date.now() + 86_400_000, temporary.userId);

    const refused = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${permanent.userId}/role-assignments/${assignmentOf(permanent.userId)}`
    );
    context.db
      .prepare('UPDATE admin_role_assignments SET expires_at = NULL WHERE admin_user_id = ?')
      .run(temporary.userId);
    const allowed = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${permanent.userId}/role-assignments/${assignmentOf(permanent.userId)}`
    );

    expect(refused.status).toBe(409);
    expect(allowed.status).toBe(200);
  });

  it('also keeps the only administrator whose assignment has an expiry', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const temporary = signIn(context.db, TENANT_ADMIN);
    context.db
      .prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE admin_user_id = ?')
      .run(Date.now() + 86_400_000, temporary.userId);

    const removed = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${temporary.userId}/role-assignments/${assignmentOf(temporary.userId)}`
    );
    const suspended = await context.call(
      root.cookie,
      'POST',
      `/api/admin/admins/${temporary.userId}/suspend`
    );

    expect([removed.status, suspended.status]).toEqual([409, 409]);
    expect(removed.json.error).toBe('last_tenant_admin');
  });

  it('lets the only expiring administrator be extended, but not sent back in time', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const temporary = signIn(context.db, TENANT_ADMIN);
    context.db
      .prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE admin_user_id = ?')
      .run(Date.now() + 86_400_000, temporary.userId);
    const url = `/api/admin/admin-roles/role_ar_tenant_admin/assignments/${assignmentOf(temporary.userId)}`;

    const extended = await context.call(root.cookie, 'PATCH', url, {
      expires_at: Date.now() + 2 * 86_400_000,
    });
    const ended = await context.call(root.cookie, 'PATCH', url, { expires_at: Date.now() - 1000 });

    expect(extended.status).toBe(200);
    expect(ended.status).toBe(409);
  });

  it('cannot be locked out through a status change, and only active or suspended are accepted', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const only = signIn(context.db, TENANT_ADMIN);

    const locked = await context.call(root.cookie, 'PATCH', `/api/admin/admins/${only.userId}`, {
      status: 'locked',
    });
    const junk = await context.call(root.cookie, 'PATCH', `/api/admin/admins/${only.userId}`, {
      status: 'banned',
    });

    expect(locked.status).toBe(400);
    expect(junk.status).toBe(400);
    expect(status(context, only.userId)).toBe('active');
  });

  it('can be removed once another active tenant administrator remains, and not the next one', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const first = signIn(context.db, TENANT_ADMIN);
    const second = signIn(context.db, TENANT_ADMIN);

    const removed = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${first.userId}/role-assignments/${assignmentOf(first.userId)}`
    );
    const refused = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${second.userId}/role-assignments/${assignmentOf(second.userId)}`
    );

    expect(removed.status).toBe(200);
    expect(refused.status).toBe(409);
    expect(assignmentCount(context, first.userId)).toBe(0);
    expect(assignmentCount(context, second.userId)).toBe(1);
  });

  it('counts a global tenant administrator of the tenant, and not a suspended one', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const scoped = signIn(context.db, TENANT_ADMIN);
    const global = signIn(context.db, GLOBAL_TENANT_ADMIN);
    context.db
      .prepare("UPDATE admin_users SET status = 'suspended' WHERE id = ?")
      .run(global.userId);

    // The global one is suspended, so the scoped one is the last.
    expect(
      (
        await context.call(
          root.cookie,
          'DELETE',
          `/api/admin/admins/${scoped.userId}/role-assignments/${assignmentOf(scoped.userId)}`
        )
      ).status
    ).toBe(409);

    context.db.prepare("UPDATE admin_users SET status = 'active' WHERE id = ?").run(global.userId);
    expect(
      (
        await context.call(
          root.cookie,
          'DELETE',
          `/api/admin/admins/${scoped.userId}/role-assignments/${assignmentOf(scoped.userId)}`
        )
      ).status
    ).toBe(200);
  });

  it('does not count a tenant administrator of another tenant', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const only = signIn(context.db, TENANT_ADMIN);
    otherTenantAdmin(context);

    const response = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${only.userId}/role-assignments/${assignmentOf(only.userId)}`
    );

    expect(response.status).toBe(409);
  });

  it('does not stop changes to other roles, or a tenant that has no tenant administrator', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const help = signIn(context.db, SUPPORT);

    const suspended = await context.call(
      root.cookie,
      'POST',
      `/api/admin/admins/${help.userId}/suspend`
    );
    const removed = await context.call(
      root.cookie,
      'DELETE',
      `/api/admin/admins/${help.userId}/role-assignments/${assignmentOf(help.userId)}`
    );

    expect([suspended.status, removed.status]).toEqual([200, 200]);
  });
});

describe('where the standard roles are given', () => {
  it('holds ar_super_admin through a global assignment only', () => {
    expect(isScopeAllowedForRole(ADMIN_ROLES.SUPER_ADMIN, 'global')).toBe(true);
    expect(isScopeAllowedForRole(ADMIN_ROLES.SUPER_ADMIN, 'tenant')).toBe(false);
    expect(isScopeAllowedForRole(ADMIN_ROLES.SUPER_ADMIN, 'org')).toBe(false);
    for (const role of [ADMIN_ROLES.TENANT_ADMIN, ADMIN_ROLES.SUPPORT, ADMIN_ROLES.VIEWER]) {
      expect(isScopeAllowedForRole(role, 'tenant')).toBe(true);
      expect(isScopeAllowedForRole(role, 'global')).toBe(true);
      expect(isScopeAllowedForRole(role, 'org')).toBe(false);
    }
    expect(isScopeAllowedForRole('helpdesk', 'tenant')).toBe(true);
  });

  it('does not let even a global super admin give ar_super_admin to another account here', async () => {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const person = signIn(context.db, SUPPORT);

    const response = await context.call(
      root.cookie,
      'POST',
      `/api/admin/admins/${person.userId}/roles`,
      { role_id: 'role_ar_super_admin', scope_type: 'global' }
    );

    // A role is given only from below the giver's own level; a peer super admin is invited.
    expect(response.status).toBe(403);
  });

  it('lets a tenant administrator give ar_support and ar_viewer, and nothing at or above its own level', async () => {
    const context = setup();
    const admin = signIn(context.db, TENANT_ADMIN);
    const person = signIn(context.db, SUPPORT);
    const give = (roleId: string, scope = 'tenant') =>
      context.call(admin.cookie, 'POST', `/api/admin/admins/${person.userId}/roles`, {
        role_id: roleId,
        scope_type: scope,
      });

    expect((await give('role_ar_viewer')).status).toBe(201);
    expect((await give('role_ar_tenant_admin')).status).toBe(403);
    expect((await give('role_ar_super_admin', 'global')).status).toBe(403);
    expect((await give('role_ar_viewer', 'global')).status).toBe(403);
  });

  it('does not let a custom role take the reserved prefix, and lets a tenant administrator make others', async () => {
    const context = setup();
    const admin = signIn(context.db, TENANT_ADMIN);
    const create = (name: string) =>
      context.call(admin.cookie, 'POST', '/api/admin/admin-roles', {
        name,
        permissions: ['admin:users:read'],
        hierarchy_level: 10,
      });

    expect((await create('ar_helpdesk')).status).toBe(400);
    expect((await create('AR_Helpdesk')).status).toBe(400);
    expect((await create('helpdesk')).status).toBe(201);
  });
});
