import { describe, expect, it, vi } from 'vitest';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';
import { adminUsersRouter } from '../routes/admin-management/admins';
import { isScopeAllowedForRole } from '../routes/admin-management/admin-role-authority';
import {
  ADMIN_ROLES,
  AdminRoleAssignmentRepository,
  AdminUserRepository,
} from '@authrim/ar-lib-core';
import { tenantKeepsAdminGuard } from '../routes/admin-management/last-tenant-admin';
import {
  platformAdminKeptGuard,
  roleKeepsHolderGuard,
} from '../routes/admin-management/last-platform-admin';
import {
  GLOBAL_SUPER_ADMIN,
  TENANT,
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

/**
 * D1 has no interactive transaction, so the check before a change and the change are separate
 * statements. Each of these runs the second request between the first one's check and its write:
 * the first must not go on to take the tenant's other administrator away.
 */
describe('two changes that each leave one tenant administrator', () => {
  type Call = () => Promise<{ status: number; json: Record<string, unknown> }>;

  /** Runs `second` completely between `first`'s reads and the write that matches `write`. */
  async function race(context: Context, write: RegExp, first: Call, second: Call) {
    const during: Array<Awaited<ReturnType<Call>>> = [];
    context.hooks.beforeExecute = {
      match: write,
      run: async () => {
        during.push(await second());
      },
    };
    const firstResult = await first();
    // The second request ran, exactly once, before the first one wrote.
    expect(during).toHaveLength(1);
    return { first: firstResult, second: during[0] };
  }

  function twoAdmins() {
    const context = setup();
    const root = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const a = signIn(context.db, TENANT_ADMIN);
    const b = signIn(context.db, TENANT_ADMIN);
    const base = '/api/admin/admins';
    const suspend =
      (userId: string): Call =>
      () =>
        context.call(root.cookie, 'POST', `${base}/${userId}/suspend`);
    const patchSuspend =
      (userId: string): Call =>
      () =>
        context.call(root.cookie, 'PATCH', `${base}/${userId}`, { status: 'suspended' });
    const deleteAccount =
      (userId: string): Call =>
      () =>
        context.call(root.cookie, 'DELETE', `${base}/${userId}`);
    const removeAssignment =
      (userId: string): Call =>
      () =>
        context.call(
          root.cookie,
          'DELETE',
          `${base}/${userId}/role-assignments/${assignmentOf(userId)}`
        );
    const removeRole =
      (userId: string): Call =>
      () =>
        context.call(root.cookie, 'DELETE', `${base}/${userId}/roles/role_ar_tenant_admin`);
    const removeFromRole =
      (userId: string): Call =>
      () =>
        context.call(
          root.cookie,
          'DELETE',
          `/api/admin/admin-roles/role_ar_tenant_admin/assignments/${assignmentOf(userId)}`
        );
    const expire =
      (userId: string, expiresAt: number): Call =>
      () =>
        context.call(
          root.cookie,
          'PATCH',
          `/api/admin/admin-roles/role_ar_tenant_admin/assignments/${assignmentOf(userId)}`,
          { expires_at: expiresAt }
        );
    return {
      context,
      a,
      b,
      suspend,
      patchSuspend,
      deleteAccount,
      removeAssignment,
      removeRole,
      removeFromRole,
      expire,
    };
  }

  /** Active accounts that still hold the tenant administrator role. */
  function remaining(context: Context): number {
    return (
      context.db
        .prepare(
          `SELECT COUNT(DISTINCT au.id) AS n
             FROM admin_role_assignments ra
             JOIN admin_users au ON au.id = ra.admin_user_id
            WHERE ra.admin_role_id = 'role_ar_tenant_admin'
              AND au.is_active = 1 AND au.status = 'active'
              AND (ra.expires_at IS NULL OR ra.expires_at > ?)`
        )
        .get(Date.now()) as { n: number }
    ).n;
  }

  const SUSPEND = /UPDATE admin_users SET status = 'suspended'/;
  const UPDATE_USER = /^\s*UPDATE admin_users SET/;
  const DELETE_ASSIGNMENT = /DELETE FROM admin_role_assignments/;
  const UPDATE_ASSIGNMENT = /UPDATE admin_role_assignments SET/;

  it('lets only one of two suspensions through', async () => {
    const t = twoAdmins();

    const result = await race(t.context, SUSPEND, t.suspend(t.a.userId), t.suspend(t.b.userId));

    expect(result.second.status).toBe(200);
    expect(result.first.status).toBe(409);
    expect(result.first.json.error).toBe('last_tenant_admin');
    expect(status(t.context, t.a.userId)).toBe('active');
    expect(status(t.context, t.b.userId)).toBe('suspended');
    expect(remaining(t.context)).toBe(1);
  });

  it('lets only one of a suspension through a status change and a removed assignment', async () => {
    const t = twoAdmins();

    const result = await race(
      t.context,
      UPDATE_USER,
      t.patchSuspend(t.a.userId),
      t.removeAssignment(t.b.userId)
    );

    expect(result.second.status).toBe(200);
    expect(result.first.status).toBe(409);
    expect(result.first.json.error).toBe('last_tenant_admin');
    expect(status(t.context, t.a.userId)).toBe('active');
    expect(remaining(t.context)).toBe(1);
  });

  it('lets only one of a deletion and a role removal through', async () => {
    const t = twoAdmins();

    const result = await race(
      t.context,
      UPDATE_USER,
      t.deleteAccount(t.a.userId),
      t.removeRole(t.b.userId)
    );

    expect(result.second.status).toBe(200);
    expect(result.first.status).toBe(409);
    expect(result.first.json.error).toBe('last_tenant_admin');
    expect(remaining(t.context)).toBe(1);
  });

  it('lets only one of two removed assignments through, by account and by role', async () => {
    const t = twoAdmins();

    const result = await race(
      t.context,
      DELETE_ASSIGNMENT,
      t.removeAssignment(t.a.userId),
      t.removeFromRole(t.b.userId)
    );

    expect(result.second.status).toBe(200);
    expect(result.first.status).toBe(409);
    expect(result.first.json.error).toBe('last_tenant_admin');
    expect(assignmentCount(t.context, t.a.userId)).toBe(1);
    expect(remaining(t.context)).toBe(1);

    // The same through the role removal route of the account.
    const again = twoAdmins();
    const byRole = await race(
      again.context,
      DELETE_ASSIGNMENT,
      again.removeRole(again.a.userId),
      again.removeFromRole(again.b.userId)
    );
    expect(byRole.second.status).toBe(200);
    expect(byRole.first.status).toBe(409);
    expect(remaining(again.context)).toBe(1);
  });

  it('lets only one of two assignments be given an end through', async () => {
    const t = twoAdmins();
    const past = Date.now() - 1000;

    const result = await race(
      t.context,
      UPDATE_ASSIGNMENT,
      t.expire(t.a.userId, past),
      t.expire(t.b.userId, past)
    );

    expect(result.second.status).toBe(200);
    expect(result.first.status).toBe(409);
    expect(result.first.json.error).toBe('last_tenant_admin');
    expect(remaining(t.context)).toBe(1);
  });

  it('keeps a permanent administrator when the other one gains an expiry in the meantime', async () => {
    const t = twoAdmins();
    const later = Date.now() + 86_400_000;

    const result = await race(
      t.context,
      UPDATE_ASSIGNMENT,
      t.expire(t.a.userId, later),
      t.expire(t.b.userId, later)
    );

    // Each is still current, but the tenant must not end up with only ones that expire.
    expect(result.second.status).toBe(200);
    expect(result.first.status).toBe(409);
    const permanent = t.context.db
      .prepare(
        'SELECT COUNT(*) AS n FROM admin_role_assignments WHERE expires_at IS NULL AND admin_role_id = ?'
      )
      .get('role_ar_tenant_admin') as { n: number };
    expect(permanent.n).toBe(1);
  });

  it('guards a suspension even when the account was read as suspended before it was re-activated', async () => {
    const t = twoAdmins();
    t.context.db
      .prepare("UPDATE admin_users SET status = 'suspended' WHERE id = ?")
      .run(t.b.userId);

    // The request reads B as suspended; before it writes, B is active again and A is suspended.
    t.context.hooks.beforeExecute = {
      match: UPDATE_USER,
      run: async () => {
        t.context.db
          .prepare("UPDATE admin_users SET status = 'active' WHERE id = ?")
          .run(t.b.userId);
        t.context.db
          .prepare("UPDATE admin_users SET status = 'suspended' WHERE id = ?")
          .run(t.a.userId);
      },
    };
    const response = await t.patchSuspend(t.b.userId)();

    expect(response.status).toBe(409);
    expect(response.json.error).toBe('last_tenant_admin');
    expect(status(t.context, t.b.userId)).toBe('active');
    expect(remaining(t.context)).toBe(1);
  });

  it('answers 404, not 409, when the assignment is gone by the time the write runs', async () => {
    const t = twoAdmins();
    t.context.hooks.beforeExecute = {
      match: DELETE_ASSIGNMENT,
      run: async () => {
        t.context.db
          .prepare('DELETE FROM admin_role_assignments WHERE id = ?')
          .run(assignmentOf(t.a.userId));
      },
    };

    const response = await t.removeAssignment(t.a.userId)();

    expect(response.status).toBe(404);
    expect(remaining(t.context)).toBe(1);
  });

  it('judges what has expired when the write runs, not when the request was made', async () => {
    const t = twoAdmins();
    // Neither is permanent, so only "a current administrator remains" is in question: A ends
    // tomorrow, and B has ended by the clock of the database.
    const expire = (userId: string, at: number) =>
      t.context.db
        .prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE admin_user_id = ?')
        .run(at, userId);
    expire(t.a.userId, Date.now() + 86_400_000);
    expire(t.b.userId, Date.now() - 1000);
    // The request, built a little earlier, still reckons B as current.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10_000);
    const guard = tenantKeepsAdminGuard(TENANT, { adminUserId: t.a.userId });
    clock.mockRestore();

    const suspended = await new AdminUserRepository(t.context.adapter).suspendAccount(
      t.a.userId,
      guard
    );

    expect(suspended).toBe(false);
    expect(status(t.context, t.a.userId)).toBe('active');
  });

  it('judges a new expiry against the clock of the database when the write runs', async () => {
    const t = twoAdmins();
    const expire = (userId: string, at: number) =>
      t.context.db
        .prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE admin_user_id = ?')
        .run(at, userId);
    // Neither is permanent; B is the other current administrator, and it is suspended meanwhile.
    expire(t.a.userId, Date.now() + 86_400_000);
    expire(t.b.userId, Date.now() + 86_400_000);
    // A is given an expiry that was still to come when the request was made, and is over by the write.
    const newExpiry = Date.now() + 5;
    const guard = tenantKeepsAdminGuard(TENANT, {
      assignmentId: assignmentOf(t.a.userId),
      stillCurrent: true,
      newExpiresAt: newExpiry,
    });
    t.context.db
      .prepare("UPDATE admin_users SET status = 'suspended' WHERE id = ?")
      .run(t.b.userId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updated = await new AdminRoleAssignmentRepository(
      t.context.adapter,
      TENANT
    ).updateAssignment(assignmentOf(t.a.userId), { expires_at: newExpiry }, guard);

    expect(updated).toBeNull();
    expect(
      (
        t.context.db
          .prepare('SELECT expires_at FROM admin_role_assignments WHERE id = ?')
          .get(assignmentOf(t.a.userId)) as { expires_at: number }
      ).expires_at
    ).toBeGreaterThan(newExpiry);
  });

  it('counts an assignment that ended within the current second as ended', async () => {
    const t = twoAdmins();
    // B ended a few milliseconds ago, in the same second as now unless the second just turned.
    t.context.db
      .prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE admin_user_id = ?')
      .run(Date.now() - 5, t.b.userId);
    t.context.db
      .prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE admin_user_id = ?')
      .run(Date.now() + 86_400_000, t.a.userId);

    const suspended = await new AdminUserRepository(t.context.adapter).suspendAccount(
      t.a.userId,
      tenantKeepsAdminGuard(TENANT, { adminUserId: t.a.userId })
    );

    expect(suspended).toBe(false);
  });

  it('still answers 404 for a write that finds nothing, not 409', async () => {
    const t = twoAdmins();
    const gone = await t.context.call(
      signIn(t.context.db, GLOBAL_SUPER_ADMIN).cookie,
      'DELETE',
      `/api/admin/admins/${t.a.userId}/role-assignments/missing`
    );

    expect(gone.status).toBe(404);
  });
});

describe('the last platform administrator under the same race', () => {
  it('lets only one of two removals of the platform role through', async () => {
    const context = setup();
    const first = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const second = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const repository = new AdminRoleAssignmentRepository(context.adapter, TENANT);
    const guard = roleKeepsHolderGuard(TENANT, 'role_ar_super_admin', true);

    // Both were told "one other remains" before either wrote; the write decides.
    const removedFirst = await repository.removeAssignmentById(assignmentOf(first.userId), guard);
    const removedSecond = await repository.removeAssignmentById(assignmentOf(second.userId), guard);

    expect([removedFirst, removedSecond]).toEqual([true, false]);
    expect(assignmentCount(context, second.userId)).toBe(1);
  });

  it('lets only one of two suspensions of a platform administrator through', async () => {
    const context = setup();
    const first = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const second = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const repository = new AdminUserRepository(context.adapter);

    const suspendedFirst = await repository.suspendAccount(
      first.userId,
      platformAdminKeptGuard(TENANT, first.userId)
    );
    const suspendedSecond = await repository.suspendAccount(
      second.userId,
      platformAdminKeptGuard(TENANT, second.userId)
    );

    expect([suspendedFirst, suspendedSecond]).toEqual([true, false]);
    expect(status(context, first.userId)).toBe('suspended');
    expect(status(context, second.userId)).toBe('active');
  });

  it('lets only one of two platform administrators suspend the other through the routes', async () => {
    const context = setup();
    const first = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const second = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const third = signIn(context.db, GLOBAL_SUPER_ADMIN);
    context.db
      .prepare("UPDATE admin_users SET status = 'suspended' WHERE id = ?")
      .run(third.userId);
    const suspend = (cookie: string, userId: string) =>
      context.call(cookie, 'POST', `/api/admin/admins/${userId}/suspend`);

    // Each sees "the other is active" before the other one's write.
    context.hooks.beforeExecute = {
      match: /UPDATE admin_users SET status = 'suspended'/,
      run: async () => {
        expect((await suspend(second.cookie, first.userId)).status).toBe(200);
      },
    };
    const refused = await suspend(first.cookie, second.userId);

    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('last_platform_admin');
    expect(status(context, second.userId)).toBe('active');
    expect(status(context, first.userId)).toBe('suspended');
  });

  it('does not stop an account that is not a platform administrator', async () => {
    const context = setup();
    const only = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const help = signIn(context.db, SUPPORT);
    const repository = new AdminUserRepository(context.adapter);

    expect(
      await repository.suspendAccount(help.userId, platformAdminKeptGuard(TENANT, help.userId))
    ).toBe(true);
    expect(
      await repository.suspendAccount(only.userId, platformAdminKeptGuard(TENANT, only.userId))
    ).toBe(false);
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
