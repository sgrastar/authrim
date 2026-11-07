import { describe, expect, it, vi } from 'vitest';

// These tests are about what groups give and take away: the step-up gate (tested on its own) lets
// the request through.
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: vi.fn(async () => null),
  refuseAdminFreshAuth: vi.fn(),
}));
import { adminGroupsRouter } from '../routes/admin-management/admin-groups';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';
import { adminSessionStatusHandler } from '../admin-session';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';
import { adminUsersRouter } from '../routes/admin-management/admins';
import {
  TENANT,
  TENANT_SUPER_ADMIN,
  insertRole,
  setupApp,
  signIn,
  type Assignment,
} from './helpers/admin-authority-fixture';

/**
 * Admin groups on the real Admin schema, the real admin-auth middleware and the real routers: a
 * member holds what the group gives as long as both exist, and every change is judged as giving
 * or taking those roles directly would be.
 */

const TENANT_ADMIN: Assignment[] = [{ role: 'role_ar_tenant_admin', scope: 'tenant' }];

function setup() {
  return setupApp((app) => {
    app.route('/api/admin/admin-groups', adminGroupsRouter);
    app.route('/api/admin/admins', adminUsersRouter);
    app.route('/api/admin/admin-roles', adminRolesRouter);
    app.route('/api/admin/admin-invitations', adminInvitationsRouter);
    app.get('/api/admin/me/session', adminSessionStatusHandler);
  });
}

type Context = ReturnType<typeof setup>;

async function rolesOf(context: Context, cookie: string): Promise<string[]> {
  const probe = await context.call(cookie, 'GET', `/probe/${TENANT}`);
  return probe.status === 200 ? ((probe.json.roles as string[]) ?? []) : [];
}

async function createGroup(context: Context, cookie: string, key = 'help-desk'): Promise<string> {
  const created = await context.call(cookie, 'POST', '/api/admin/admin-groups', {
    group_key: key,
    display_name: `Group ${key}`,
  });
  expect(created.status).toBe(201);
  return created.json.id as string;
}

async function grant(
  context: Context,
  cookie: string,
  groupId: string,
  roleId: string,
  expiresAt?: number | null
) {
  return context.call(cookie, 'POST', `/api/admin/admin-groups/${groupId}/role-grants`, {
    role_id: roleId,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  });
}

function addMember(context: Context, cookie: string, groupId: string, userId: string) {
  return context.call(cookie, 'PUT', `/api/admin/admin-groups/${groupId}/members/${userId}`);
}

/** A tenant whose only ar_tenant_admin holds it through a group; the caller is its super admin. */
async function onlyTenantAdminThroughGroup() {
  const context = setup();
  const owner = signIn(context.db, TENANT_SUPER_ADMIN);
  const member = signIn(context.db, []);
  const groupId = await createGroup(context, owner.cookie);
  expect((await grant(context, owner.cookie, groupId, 'role_ar_tenant_admin')).status).toBe(201);
  expect((await addMember(context, owner.cookie, groupId, member.userId)).status).toBe(201);
  const grantId = (
    context.db
      .prepare('SELECT id FROM admin_group_role_grants WHERE admin_group_id = ?')
      .get(groupId) as { id: string }
  ).id;
  return { context, owner, member, groupId, grantId };
}

describe('what an admin group gives', () => {
  it('gives its roles to every member while both exist, and takes them back', async () => {
    const context = setup();
    const owner = signIn(context.db, TENANT_ADMIN);
    const member = signIn(context.db, [{ role: 'role_ar_viewer', scope: 'tenant' }]);
    const groupId = await createGroup(context, owner.cookie);

    expect((await grant(context, owner.cookie, groupId, 'role_ar_support')).status).toBe(201);
    expect(await rolesOf(context, member.cookie)).not.toContain('ar_support');

    expect((await addMember(context, owner.cookie, groupId, member.userId)).status).toBe(201);
    expect(await rolesOf(context, member.cookie)).toEqual(
      expect.arrayContaining(['ar_support', 'ar_viewer'])
    );

    // The admin's detail tells the group's role from their own.
    const detail = await context.call(owner.cookie, 'GET', `/api/admin/admins/${member.userId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.groups).toEqual([
      expect.objectContaining({ id: groupId, group_key: 'help-desk' }),
    ]);
    expect(detail.json.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ar_support', source: 'group', assignment_id: null }),
        expect.objectContaining({ name: 'ar_viewer', source: 'direct' }),
      ])
    );

    const removed = await context.call(
      owner.cookie,
      'DELETE',
      `/api/admin/admin-groups/${groupId}/members/${member.userId}`
    );
    expect(removed.status).toBe(200);
    expect(await rolesOf(context, member.cookie)).not.toContain('ar_support');

    // The tenant's administrators hear of each change that gives or takes roles away.
    const notices = context.db
      .prepare(
        "SELECT message_key FROM admin_notices WHERE category = 'admin_group' ORDER BY created_at, rowid"
      )
      .all() as Array<{ message_key: string }>;
    expect(notices.map((row) => row.message_key)).toEqual([
      'admin_group_role_granted',
      'admin_group_member_added',
      'admin_group_member_removed',
    ]);
  });

  it('stops giving a role when the grant is taken away, expires, or the group is deleted', async () => {
    const context = setup();
    const owner = signIn(context.db, TENANT_ADMIN);
    const member = signIn(context.db, [{ role: 'role_ar_viewer', scope: 'tenant' }]);
    const groupId = await createGroup(context, owner.cookie);
    const support = await grant(context, owner.cookie, groupId, 'role_ar_support');
    await addMember(context, owner.cookie, groupId, member.userId);
    expect(await rolesOf(context, member.cookie)).toContain('ar_support');

    // Expired (written past its end, as time would leave it)
    context.db
      .prepare('UPDATE admin_group_role_grants SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, String(support.json.id));
    expect(await rolesOf(context, member.cookie)).not.toContain('ar_support');
    context.db
      .prepare('UPDATE admin_group_role_grants SET expires_at = NULL WHERE id = ?')
      .run(String(support.json.id));
    expect(await rolesOf(context, member.cookie)).toContain('ar_support');

    const revoked = await context.call(
      owner.cookie,
      'DELETE',
      `/api/admin/admin-groups/${groupId}/role-grants/${support.json.id}`
    );
    expect(revoked.status).toBe(200);
    expect(await rolesOf(context, member.cookie)).not.toContain('ar_support');

    await grant(context, owner.cookie, groupId, 'role_ar_support');
    expect(await rolesOf(context, member.cookie)).toContain('ar_support');
    expect(
      (await context.call(owner.cookie, 'DELETE', `/api/admin/admin-groups/${groupId}`)).status
    ).toBe(200);
    expect(await rolesOf(context, member.cookie)).not.toContain('ar_support');
    expect(
      context.db.prepare('SELECT COUNT(*) AS n FROM admin_group_members').get() as { n: number }
    ).toEqual({ n: 0 });
  });

  it('shows the session what the admin holds now, own and through groups, to the millisecond', async () => {
    const context = setup();
    const owner = signIn(context.db, TENANT_ADMIN);
    const member = signIn(context.db, [{ role: 'role_ar_viewer', scope: 'tenant' }]);
    const groupId = await createGroup(context, owner.cookie);
    const support = await grant(context, owner.cookie, groupId, 'role_ar_support');
    await addMember(context, owner.cookie, groupId, member.userId);
    const now = Date.now();
    insertRole(context.db, {
      id: 'role_auditor_ended',
      name: 'auditor_ended',
      permissions: [],
      hierarchy: 5,
    });
    // An own assignment that ended a second ago (milliseconds, as assignments are stored): read
    // in seconds it would still look current.
    context.db
      .prepare(
        `INSERT INTO admin_role_assignments
           (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, expires_at, created_at)
         VALUES ('ended', ?, ?, 'role_auditor_ended', 'tenant', ?, ?, ?)`
      )
      .run(TENANT, member.userId, TENANT, now - 1_000, now);

    const current = await context.call(member.cookie, 'GET', '/api/admin/me/session');
    expect(current.status).toBe(200);
    expect(current.json.roles).toEqual(expect.arrayContaining(['ar_support', 'ar_viewer']));
    expect(current.json.roles).not.toContain('auditor_ended');
    expect(current.json.groups).toEqual([
      { id: groupId, group_key: 'help-desk', display_name: 'Group help-desk' },
    ]);

    // The group's grant ends a moment ago: gone from the session too.
    context.db
      .prepare('UPDATE admin_group_role_grants SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, String(support.json.id));
    const after = await context.call(member.cookie, 'GET', '/api/admin/me/session');
    expect(after.json.roles).not.toContain('ar_support');
  });

  it('never gives a role to an administrator of another tenant, whatever a row says', async () => {
    const context = setup();
    const owner = signIn(context.db, TENANT_ADMIN);
    const groupId = await createGroup(context, owner.cookie);
    await grant(context, owner.cookie, groupId, 'role_ar_support');
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
         VALUES ('outsider', 'tenant-b', 'outsider@example.test', 1, 'active', ?, ?)`
      )
      .run(now, now);

    expect((await addMember(context, owner.cookie, groupId, 'outsider')).status).toBe(404);

    // Written past the API (an import, a bug): the view still leaves it out.
    context.db
      .prepare(
        `INSERT INTO admin_group_members (id, tenant_id, admin_group_id, admin_user_id, created_at)
         VALUES ('m-outsider', ?, ?, 'outsider', ?)`
      )
      .run(TENANT, groupId, now);
    expect(
      context.db
        .prepare(
          "SELECT COUNT(*) AS n FROM admin_effective_role_assignments WHERE admin_user_id = 'outsider'"
        )
        .get()
    ).toEqual({ n: 0 });
  });
});

describe('who may change a group', () => {
  it('holds giving roles through a group to the hierarchy, as giving them directly', async () => {
    const context = setup();
    const tenantAdmin = signIn(context.db, TENANT_ADMIN);
    const superAdmin = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    const groupId = await createGroup(context, tenantAdmin.cookie);

    // A tenant admin cannot give their own role through a group, nor add anyone to a group that
    // gives it.
    expect((await grant(context, tenantAdmin.cookie, groupId, 'role_ar_tenant_admin')).status).toBe(
      403
    );
    expect((await grant(context, superAdmin.cookie, groupId, 'role_ar_tenant_admin')).status).toBe(
      201
    );
    expect((await addMember(context, tenantAdmin.cookie, groupId, target.userId)).status).toBe(403);
    expect((await addMember(context, tenantAdmin.cookie, groupId, tenantAdmin.userId)).status).toBe(
      403
    );
    expect(await rolesOf(context, target.cookie)).toEqual([]);

    // The platform role is held through a global assignment only.
    expect((await grant(context, superAdmin.cookie, groupId, 'role_ar_super_admin')).status).toBe(
      400
    );
    // An end no date can hold is refused before anything changes.
    expect(
      (await grant(context, superAdmin.cookie, groupId, 'role_ar_support', Number.MAX_SAFE_INTEGER))
        .status
    ).toBe(400);
  });

  it('refuses a member judged against grants that changed before the member was added', async () => {
    const context = setup();
    const tenantAdmin = signIn(context.db, TENANT_ADMIN);
    const superAdmin = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    const groupId = await createGroup(context, tenantAdmin.cookie);
    await grant(context, tenantAdmin.cookie, groupId, 'role_ar_support');

    // Between the tenant admin's check (support only) and their write, the super admin gives the
    // group a role the tenant admin could not give.
    context.hooks.beforeExecute = {
      match: /INSERT INTO admin_group_members/u,
      run: async () => {
        expect(
          (await grant(context, superAdmin.cookie, groupId, 'role_ar_tenant_admin')).status
        ).toBe(201);
      },
    };
    const added = await addMember(context, tenantAdmin.cookie, groupId, target.userId);

    expect(added.status).toBe(409);
    expect(added.json.error).toBe('admin_group_changed');
    expect(await rolesOf(context, target.cookie)).toEqual([]);
  });

  it("lets only someone who could give a group's roles bring back an invitation into it", async () => {
    const context = setup();
    const tenantAdmin = signIn(context.db, TENANT_ADMIN);
    const superAdmin = signIn(context.db, TENANT_SUPER_ADMIN);
    const groupId = await createGroup(context, superAdmin.cookie);
    await grant(context, superAdmin.cookie, groupId, 'role_ar_tenant_admin');

    // The tenant admin cannot name the group, which gives their own role.
    const refused = await context.call(tenantAdmin.cookie, 'POST', '/api/admin/admin-invitations', {
      email: 'refused@example.test',
      role_id: 'role_ar_viewer',
      group_ids: [groupId],
    });
    expect(refused.status).toBe(403);

    // Written (no mail is configured here, so delivery reports failure)
    const invited = await context.call(superAdmin.cookie, 'POST', '/api/admin/admin-invitations', {
      email: 'invited@example.test',
      role_id: 'role_ar_viewer',
      group_ids: [groupId],
    });
    expect([201, 502]).toContain(invited.status);
    expect(context.db.prepare('SELECT admin_group_id FROM admin_invitation_groups').all()).toEqual([
      { admin_group_id: groupId },
    ]);
    const invitationId = (
      context.db
        .prepare("SELECT id FROM admin_invitations WHERE email = 'invited@example.test'")
        .get() as { id: string }
    ).id;

    // Nor bring the super admin's invitation back.
    const resent = await context.call(
      tenantAdmin.cookie,
      'POST',
      `/api/admin/admin-invitations/${invitationId}/resend`
    );
    expect(resent.status).toBe(403);
    const resentBySuperAdmin = await context.call(
      superAdmin.cookie,
      'POST',
      `/api/admin/admin-invitations/${invitationId}/resend`
    );
    expect([200, 502]).toContain(resentBySuperAdmin.status);
  });

  it('keeps a role a group gives when its custom role would be deleted', async () => {
    const context = setup();
    const owner = signIn(context.db, TENANT_SUPER_ADMIN);
    insertRole(context.db, {
      id: 'role_auditor',
      name: 'auditor',
      permissions: ['admin:admin_audit:read'],
      hierarchy: 10,
    });
    const groupId = await createGroup(context, owner.cookie);
    expect((await grant(context, owner.cookie, groupId, 'role_auditor')).status).toBe(201);

    // No member yet: the group still gives the role, so it is not deleted from under it.
    const deleted = await context.call(
      owner.cookie,
      'DELETE',
      '/api/admin/admin-roles/role_auditor'
    );
    expect(deleted.status).toBe(409);
    expect(
      context.db.prepare("SELECT COUNT(*) AS n FROM admin_roles WHERE id = 'role_auditor'").get()
    ).toEqual({ n: 1 });
  });
});

describe('changes that meet a concurrent one', () => {
  it('removes only the membership that was checked, not a later one of the same admin', async () => {
    const { context, owner, member, groupId } = await onlyTenantAdminThroughGroup();
    const second = signIn(context.db, []);
    await addMember(context, owner.cookie, groupId, second.userId);

    // Checked with the member's first membership; meanwhile it is ended and a new one made, and
    // the other administrator leaves.
    context.hooks.beforeExecute = {
      match: /DELETE FROM admin_group_members/u,
      run: async () => {
        context.db
          .prepare('DELETE FROM admin_group_members WHERE admin_user_id = ?')
          .run(member.userId);
        context.db
          .prepare(
            `INSERT INTO admin_group_members (id, tenant_id, admin_group_id, admin_user_id, created_at)
             VALUES ('replacement', ?, ?, ?, ?)`
          )
          .run(TENANT, groupId, member.userId, Date.now());
        context.db
          .prepare('DELETE FROM admin_group_members WHERE admin_user_id = ?')
          .run(second.userId);
      },
    };
    const removed = await context.call(
      owner.cookie,
      'DELETE',
      `/api/admin/admin-groups/${groupId}/members/${member.userId}`
    );

    expect(removed.status).toBe(409);
    expect(await rolesOf(context, member.cookie)).toContain('ar_tenant_admin');
  });

  it('refuses an expiry change judged against an end that changed meanwhile', async () => {
    const { context, owner, member, groupId, grantId } = await onlyTenantAdminThroughGroup();
    const soon = Date.now() + 60_000;
    context.db
      .prepare('UPDATE admin_group_role_grants SET expires_at = ? WHERE id = ?')
      .run(soon, grantId);

    // Judged as making it longer (no guard needed); meanwhile it became permanent, which this
    // would turn back into one that ends.
    context.hooks.beforeBatch = async () => {
      context.db
        .prepare('UPDATE admin_group_role_grants SET expires_at = NULL WHERE id = ?')
        .run(grantId);
    };
    const changed = await context.call(
      owner.cookie,
      'PATCH',
      `/api/admin/admin-groups/${groupId}/role-grants/${grantId}`,
      { expires_at: soon + 60_000 }
    );

    expect(changed.status).toBe(409);
    expect(changed.json.error).toBe('admin_group_changed');
    expect(
      context.db.prepare('SELECT expires_at FROM admin_group_role_grants WHERE id = ?').get(grantId)
    ).toEqual({ expires_at: null });
    expect(await rolesOf(context, member.cookie)).toContain('ar_tenant_admin');
  });

  it('refuses removing a group or a member judged before a higher role was granted', async () => {
    const context = setup();
    const tenantAdmin = signIn(context.db, TENANT_ADMIN);
    const superAdmin = signIn(context.db, TENANT_SUPER_ADMIN);
    const member = signIn(context.db, []);
    insertRole(context.db, { id: 'role_high', name: 'high', permissions: [], hierarchy: 95 });
    const groupId = await createGroup(context, tenantAdmin.cookie);
    await grant(context, tenantAdmin.cookie, groupId, 'role_ar_support');
    await addMember(context, tenantAdmin.cookie, groupId, member.userId);

    for (const [match, method, path] of [
      [
        /DELETE FROM admin_group_members/u,
        'DELETE',
        `/api/admin/admin-groups/${groupId}/members/${member.userId}`,
      ],
      [/DELETE FROM admin_groups/u, 'DELETE', `/api/admin/admin-groups/${groupId}`],
    ] as const) {
      context.hooks.beforeExecute = {
        match,
        run: async () => {
          const high = await grant(context, superAdmin.cookie, groupId, 'role_high');
          expect(high.status).toBe(201);
        },
      };
      const removed = await context.call(tenantAdmin.cookie, method, path);
      expect(removed.status).toBe(409);
      expect(removed.json.error).toBe('admin_group_changed');
      // The super admin takes the high role away again for the next round.
      const highGrant = context.db
        .prepare("SELECT id FROM admin_group_role_grants WHERE admin_role_id = 'role_high'")
        .get() as { id: string };
      await context.call(
        superAdmin.cookie,
        'DELETE',
        `/api/admin/admin-groups/${groupId}/role-grants/${highGrant.id}`
      );
    }
    expect(await rolesOf(context, member.cookie)).toContain('ar_support');
  });
});

describe('the last tenant administrator, held through a group', () => {
  it('may be given an earlier end, still to come, when no administrator is permanent', async () => {
    const { context, owner, member, groupId, grantId } = await onlyTenantAdminThroughGroup();
    const later = Date.now() + 3_600_000;
    context.db
      .prepare('UPDATE admin_group_role_grants SET expires_at = ? WHERE id = ?')
      .run(later, grantId);

    const shortened = await context.call(
      owner.cookie,
      'PATCH',
      `/api/admin/admin-groups/${groupId}/role-grants/${grantId}`,
      { expires_at: later - 1_800_000 }
    );

    expect(shortened.status).toBe(200);
    expect(await rolesOf(context, member.cookie)).toContain('ar_tenant_admin');
  });

  it('cannot be removed from the group, nor the grant or the group taken away', async () => {
    const { context, owner, member, groupId, grantId } = await onlyTenantAdminThroughGroup();

    const leave = await context.call(
      owner.cookie,
      'DELETE',
      `/api/admin/admin-groups/${groupId}/members/${member.userId}`
    );
    const revoke = await context.call(
      owner.cookie,
      'DELETE',
      `/api/admin/admin-groups/${groupId}/role-grants/${grantId}`
    );
    const shorten = await context.call(
      owner.cookie,
      'PATCH',
      `/api/admin/admin-groups/${groupId}/role-grants/${grantId}`,
      { expires_at: Date.now() + 60_000 }
    );
    const remove = await context.call(owner.cookie, 'DELETE', `/api/admin/admin-groups/${groupId}`);
    const suspend = await context.call(
      owner.cookie,
      'POST',
      `/api/admin/admins/${member.userId}/suspend`
    );

    for (const response of [leave, revoke, shorten, remove, suspend]) {
      expect(response.status).toBe(409);
      expect(response.json.error).toBe('last_tenant_admin');
    }
    expect(await rolesOf(context, member.cookie)).toContain('ar_tenant_admin');
  });

  it('lets the admin lose their own assignment while the group keeps them an administrator', async () => {
    const { context, owner, member } = await onlyTenantAdminThroughGroup();
    context.db
      .prepare(
        `INSERT INTO admin_role_assignments
           (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
         VALUES ('own-tenant-admin', ?, ?, 'role_ar_tenant_admin', 'tenant', ?, ?)`
      )
      .run(TENANT, member.userId, TENANT, Date.now());

    const removed = await context.call(
      owner.cookie,
      'DELETE',
      `/api/admin/admins/${member.userId}/roles/role_ar_tenant_admin`
    );

    expect(removed.status).toBe(200);
    expect(await rolesOf(context, member.cookie)).toContain('ar_tenant_admin');
  });

  it('lets only one of two concurrent removals leave the tenant without an administrator', async () => {
    const { context, owner, member, groupId } = await onlyTenantAdminThroughGroup();
    const second = signIn(context.db, []);
    expect((await addMember(context, owner.cookie, groupId, second.userId)).status).toBe(201);

    let inner: Awaited<ReturnType<Context['call']>> | undefined;
    context.hooks.beforeExecute = {
      match: /DELETE FROM admin_group_members/u,
      run: async () => {
        inner = await context.call(
          owner.cookie,
          'DELETE',
          `/api/admin/admin-groups/${groupId}/members/${second.userId}`
        );
      },
    };
    const outer = await context.call(
      owner.cookie,
      'DELETE',
      `/api/admin/admin-groups/${groupId}/members/${member.userId}`
    );

    expect(inner?.status).toBe(200);
    expect(outer.status).toBe(409);
    expect(await rolesOf(context, member.cookie)).toContain('ar_tenant_admin');
  });
});
