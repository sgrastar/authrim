/**
 * Admin groups: `/api/admin/admin-groups`.
 *
 * A group gathers a tenant's administrators, and every member holds the roles given to the group
 * (for the tenant only). Adding a member or a grant hands roles out, so it is judged as granting
 * each of the group's roles directly would be (the caller must outrank the role, L2 step-up as
 * `admin.role.grant`). Taking a member, a grant or the group away, or shortening a grant, takes
 * roles away and is judged as removing the assignments would be (`admin.role.revoke`, and the
 * tenant must keep an administrator). Reading groups needs admin users read; every change needs
 * admin roles write, as a direct assignment does.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  AdminGroupRepository,
  AdminNoticeRepository,
  AdminRoleRepository,
  AdminUserRepository,
  adminAuthMiddleware,
  createErrorResponse,
  getTenantIdFromContext,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type AdminGroupGrantSnapshot,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { requireAdminStepUp } from '../../admin-step-up-gate';
import { callerOutranks, isScopeAllowedForRole, mayRemoveAssignment } from './admin-role-authority';
import {
  ensureTenantKeepsAdmin,
  lastTenantAdminResponse,
  tenantKeepsAdminGuard,
} from './last-tenant-admin';

type AdminGroupsEnv = { Bindings: Env; Variables: { adminAuth?: AdminAuthContext } };
type AnyContext = Context<AdminGroupsEnv>;

export const adminGroupsRouter = new Hono<AdminGroupsEnv>();

adminGroupsRouter.use(
  '*',
  adminAuthMiddleware({ requirePermissions: [ADMIN_PERMISSIONS.ADMIN_USERS_READ] })
);

const GROUP_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DISPLAY_NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

function adminAdapter(c: AnyContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

function auth(c: AnyContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function mayChangeGroups(authContext: AdminAuthContext): boolean {
  return hasAdminPermission(authContext.permissions || [], ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE);
}

function invalid(c: AnyContext, description: string): Response {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

/** The group's grants changed after the request was judged against them. */
function groupChanged(c: AnyContext): Response {
  return c.json(
    {
      error: 'admin_group_changed',
      error_description:
        'The group (its roles, members or a role’s end) changed while the request was being checked. Load the group again and retry.',
    },
    409
  );
}

async function audit(
  c: AnyContext,
  action: string,
  groupId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await writeAdminAuditLog(c, {
    action,
    resourceType: 'admin_group',
    resourceId: groupId,
    result: 'success',
    metadata,
  });
}

/**
 * A console notice to the tenant's administrators that a group now hands out more (or fewer)
 * roles. Best effort: the change stands on its own and is in the audit log either way.
 */
async function notice(
  adapter: DatabaseAdapter,
  tenantId: string,
  groupId: string,
  input: { messageKey: string; title: string; params: Record<string, unknown> }
): Promise<void> {
  try {
    await new AdminNoticeRepository(adapter).create({
      scope_type: 'tenant',
      tenant_id: tenantId,
      severity: 'caution',
      source: 'system',
      category: 'admin_group',
      message_key: input.messageKey,
      params: input.params,
      title: input.title,
      link: `/admin/team/groups/${encodeURIComponent(groupId)}`,
      required_permission: ADMIN_PERMISSIONS.ADMIN_USERS_READ,
      source_ref: groupId,
    });
  } catch {
    // The audit log has the change.
  }
}

/** Whether the caller outranks every role the group gives (none of them is above theirs). */
function outranksAll(authContext: AdminAuthContext, snapshot: AdminGroupGrantSnapshot): boolean {
  return snapshot.grants.every((grant) => callerOutranks(authContext, grant.hierarchy_level));
}

/** Whether the caller may take every role the group gives away from someone. */
function mayRemoveAll(authContext: AdminAuthContext, snapshot: AdminGroupGrantSnapshot): boolean {
  return snapshot.grants.every((grant) =>
    mayRemoveAssignment(authContext, 'tenant', grant.hierarchy_level)
  );
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

async function readJson(c: AnyContext): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A grant expiry from the body: a future epoch-millisecond time, or null for permanent. */
/** The latest time a JavaScript Date can hold, in epoch milliseconds. */
const MAX_DATE_MS = 8_640_000_000_000_000;

function readExpiry(value: unknown, now: number): number | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= now ||
    value > MAX_DATE_MS
  )
    return 'invalid';
  return value;
}

/** GET / — the tenant's groups with their member and grant counts. */
adminGroupsRouter.get('/', async (c) => {
  try {
    const groups = await new AdminGroupRepository(
      adminAdapter(c),
      getTenantIdFromContext(c)
    ).list();
    return c.json({ items: groups, total: groups.length });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** POST / — a new, empty group. It gives nothing until a role is granted to it. */
adminGroupsRouter.post('/', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const body = await readJson(c);
  const groupKey = readText(body?.group_key);
  const displayName = readText(body?.display_name);
  const description = body?.description === null ? null : readText(body?.description);
  if (!groupKey || !GROUP_KEY_PATTERN.test(groupKey)) {
    return invalid(c, 'group_key must be 1-64 lowercase letters, digits, "-" or "_".');
  }
  if (!displayName || displayName.length > DISPLAY_NAME_MAX) {
    return invalid(c, `display_name must be 1-${DISPLAY_NAME_MAX} characters.`);
  }
  if (description !== undefined && description !== null && description.length > DESCRIPTION_MAX) {
    return invalid(c, `description must be at most ${DESCRIPTION_MAX} characters.`);
  }
  try {
    const tenantId = getTenantIdFromContext(c);
    const group = await new AdminGroupRepository(adminAdapter(c), tenantId).create({
      groupKey,
      displayName,
      description: description || null,
      createdBy: authContext.userId,
    });
    if (!group) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    await audit(c, 'admin.group.created', group.id, {
      group_key: group.group_key,
      display_name: group.display_name,
    });
    return c.json(group, 201);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** GET /:id — the group with its members and grants. */
adminGroupsRouter.get('/:id', async (c) => {
  try {
    const groups = new AdminGroupRepository(adminAdapter(c), getTenantIdFromContext(c));
    const group = await groups.get(c.req.param('id'));
    if (!group) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const [members, grants] = await Promise.all([
      groups.listMembers(group.id),
      groups.listGrants(group.id),
    ]);
    return c.json({ ...group, members, grants });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** PATCH /:id — rename or re-describe the group (its key stays). Changes no one's roles. */
adminGroupsRouter.patch('/:id', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const body = await readJson(c);
  if (!body) return invalid(c, 'A JSON object is required.');
  if ('group_key' in body) return invalid(c, 'group_key cannot be changed.');
  const displayName = 'display_name' in body ? readText(body.display_name) : undefined;
  const description =
    'description' in body
      ? body.description === null
        ? null
        : readText(body.description)
      : undefined;
  if ('display_name' in body && (!displayName || displayName.length > DISPLAY_NAME_MAX)) {
    return invalid(c, `display_name must be 1-${DISPLAY_NAME_MAX} characters.`);
  }
  if ('description' in body && description === undefined) {
    return invalid(c, 'description must be a string or null.');
  }
  if (typeof description === 'string' && description.length > DESCRIPTION_MAX) {
    return invalid(c, `description must be at most ${DESCRIPTION_MAX} characters.`);
  }
  try {
    const groups = new AdminGroupRepository(adminAdapter(c), getTenantIdFromContext(c));
    const before = await groups.get(c.req.param('id'));
    if (!before) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const group = await groups.update(before.id, {
      displayName,
      description: description === '' ? null : description,
    });
    if (!group) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    await audit(c, 'admin.group.updated', group.id, {
      display_name: group.display_name,
      previous_display_name: before.display_name,
    });
    return c.json(group);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** DELETE /:id — the group, its members and its grants: every member loses what it gave. */
adminGroupsRouter.delete('/:id', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  try {
    const adapter = adminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const groups = new AdminGroupRepository(adapter, tenantId);
    const groupId = c.req.param('id');
    const group = await groups.get(groupId);
    const snapshot = await groups.grantSnapshot(groupId);
    if (!group || !snapshot) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    if (!mayRemoveAll(authContext, snapshot)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    const refusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, { adminGroupId: groupId });
    if (refusal) return refusal;

    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: 'admin.role.revoke',
      targetTenantId: tenantId,
      targetIds: [groupId],
      params: { admin_group: groupId, change: 'delete' },
    });
    if (stepUpRefused) return stepUpRefused;

    const removed = await groups.delete(
      groupId,
      snapshot.revision,
      tenantKeepsAdminGuard(tenantId, { adminGroupId: groupId })
    );
    if (!removed) {
      const now = await groups.get(groupId);
      if (!now) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      return now.revision !== snapshot.revision ? groupChanged(c) : lastTenantAdminResponse(c);
    }
    await audit(c, 'admin.group.deleted', groupId, {
      group_key: group.group_key,
      display_name: group.display_name,
      roles: snapshot.grants.map((grant) => grant.admin_role_id),
    });
    if (snapshot.grants.length > 0) {
      await notice(adapter, tenantId, groupId, {
        messageKey: 'admin_group_deleted',
        title: `Admin group ${group.display_name} was deleted`,
        params: { group: group.display_name },
      });
    }
    return c.json({ success: true });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** GET /:id/members */
adminGroupsRouter.get('/:id/members', async (c) => {
  try {
    const groups = new AdminGroupRepository(adminAdapter(c), getTenantIdFromContext(c));
    const group = await groups.get(c.req.param('id'));
    if (!group) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const members = await groups.listMembers(group.id);
    return c.json({ items: members, total: members.length });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PUT /:id/members/:adminUserId — add one of the tenant's administrators. They get every role
 * the group gives, so the caller must outrank each of them.
 */
adminGroupsRouter.put('/:id/members/:adminUserId', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  try {
    const adapter = adminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const groups = new AdminGroupRepository(adapter, tenantId);
    const groupId = c.req.param('id');
    const adminUserId = c.req.param('adminUserId');
    const [group, user] = await Promise.all([
      groups.get(groupId),
      new AdminUserRepository(adapter).findByTenantAndId(tenantId, adminUserId),
    ]);
    if (!group || !user) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    if (await groups.getMembership(groupId, adminUserId)) {
      return c.json({ success: true, added: false });
    }
    // Read once, revision and grants together: the INSERT holds the caller to this version.
    const snapshot = await groups.grantSnapshot(groupId);
    if (!snapshot) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    if (!outranksAll(authContext, snapshot)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: 'admin.role.grant',
      targetTenantId: tenantId,
      targetIds: [adminUserId, groupId],
      params: { admin_group: groupId, revision: snapshot.revision },
    });
    if (stepUpRefused) return stepUpRefused;

    const result = await groups.addMember({
      groupId,
      adminUserId,
      addedBy: authContext.userId,
      expectedRevision: snapshot.revision,
    });
    if (result === 'exists') return c.json({ success: true, added: false });
    if (result === 'changed') return groupChanged(c);

    await audit(c, 'admin.group.member.added', groupId, {
      admin_user_id: adminUserId,
      revision: snapshot.revision,
      roles: snapshot.grants.map((grant) => grant.admin_role_id),
    });
    if (snapshot.grants.length > 0) {
      await notice(adapter, tenantId, groupId, {
        messageKey: 'admin_group_member_added',
        title: `${user.email} was added to admin group ${group.display_name}`,
        params: { email: user.email, group: group.display_name },
      });
    }
    return c.json({ success: true, added: true }, 201);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** DELETE /:id/members/:adminUserId — they lose what the group gave them. */
adminGroupsRouter.delete('/:id/members/:adminUserId', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  try {
    const adapter = adminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const groups = new AdminGroupRepository(adapter, tenantId);
    const groupId = c.req.param('id');
    const adminUserId = c.req.param('adminUserId');
    const [membership, snapshot] = await Promise.all([
      groups.getMembership(groupId, adminUserId),
      groups.grantSnapshot(groupId),
    ]);
    if (!membership || !snapshot) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!mayRemoveAll(authContext, snapshot)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    const exclusion = { groupMemberId: membership.id };
    const refusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, exclusion);
    if (refusal) return refusal;

    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: 'admin.role.revoke',
      targetTenantId: tenantId,
      targetIds: [adminUserId, groupId],
      params: { admin_group: groupId },
    });
    if (stepUpRefused) return stepUpRefused;

    const removed = await groups.removeMember(
      groupId,
      membership.id,
      snapshot.revision,
      tenantKeepsAdminGuard(tenantId, exclusion)
    );
    if (!removed) {
      // Gone, replaced by a new membership, judged against grants that changed since, or the
      // last administrator by the time the write ran.
      const [current, latest] = await Promise.all([
        groups.getMembership(groupId, adminUserId),
        groups.grantSnapshot(groupId),
      ]);
      if (!current || !latest)
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      return current.id !== membership.id || latest.revision !== snapshot.revision
        ? groupChanged(c)
        : lastTenantAdminResponse(c);
    }
    await audit(c, 'admin.group.member.removed', groupId, {
      admin_user_id: adminUserId,
      roles: snapshot.grants.map((grant) => grant.admin_role_id),
    });
    if (snapshot.grants.length > 0) {
      const [group, user] = await Promise.all([
        groups.get(groupId),
        new AdminUserRepository(adapter).findByTenantAndId(tenantId, adminUserId),
      ]);
      await notice(adapter, tenantId, groupId, {
        messageKey: 'admin_group_member_removed',
        title: `${user?.email ?? adminUserId} was removed from admin group ${group?.display_name ?? groupId}`,
        params: { email: user?.email ?? adminUserId, group: group?.display_name ?? groupId },
      });
    }
    return c.json({ success: true });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** GET /:id/role-grants */
adminGroupsRouter.get('/:id/role-grants', async (c) => {
  try {
    const groups = new AdminGroupRepository(adminAdapter(c), getTenantIdFromContext(c));
    const group = await groups.get(c.req.param('id'));
    if (!group) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const grants = await groups.listGrants(group.id);
    return c.json({ items: grants, total: grants.length });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /:id/role-grants — give the group a role for the tenant: every member gets it. Judged as
 * granting the role directly. The platform role is not given through groups.
 */
adminGroupsRouter.post('/:id/role-grants', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const body = await readJson(c);
  const roleId = readText(body?.role_id);
  const now = Date.now();
  const expiresAt = readExpiry(body?.expires_at, now);
  if (!roleId) return invalid(c, 'role_id is required.');
  if (expiresAt === 'invalid') {
    return invalid(c, 'expires_at must be a future time in epoch milliseconds, or null.');
  }
  try {
    const adapter = adminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const groups = new AdminGroupRepository(adapter, tenantId);
    const groupId = c.req.param('id');
    const [group, role, snapshot] = await Promise.all([
      groups.get(groupId),
      new AdminRoleRepository(adapter).getRole(roleId),
      groups.grantSnapshot(groupId),
    ]);
    if (!group || !snapshot) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    if (
      !role ||
      (role.tenant_id !== tenantId && !(role.tenant_id === 'default' && role.is_system))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    // A group gives tenant roles only; the super admin is held through a global assignment.
    if (!isScopeAllowedForRole(role.name, 'tenant')) {
      return invalid(c, 'This role cannot be given through a group.');
    }
    if (!callerOutranks(authContext, role.hierarchy_level)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    if (snapshot.grants.some((grant) => grant.admin_role_id === roleId)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: 'admin.role.grant',
      targetTenantId: tenantId,
      targetIds: [groupId, roleId],
      params: { admin_group: groupId, role: roleId, expires_at: expiresAt },
    });
    if (stepUpRefused) return stepUpRefused;

    const result = await groups.addGrant({
      groupId,
      roleId,
      expiresAt,
      assignedBy: authContext.userId,
      expectedRevision: snapshot.revision,
    });
    if (!result.grant) {
      return result.reason === 'exists'
        ? createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT)
        : groupChanged(c);
    }
    await audit(c, 'admin.group.role.granted', groupId, {
      grant_id: result.grant.id,
      role_id: roleId,
      role_name: role.name,
      expires_at: expiresAt,
    });
    await notice(adapter, tenantId, groupId, {
      messageKey: 'admin_group_role_granted',
      title: `Admin group ${group.display_name} now gives ${role.display_name || role.name}`,
      params: { group: group.display_name, role: role.display_name || role.name },
    });
    return c.json(result.grant, 201);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /:id/role-grants/:grantId — change a grant's expiry. Later, or none, gives the role for
 * longer (judged as granting it); earlier takes it away sooner (judged as removing it).
 */
adminGroupsRouter.patch('/:id/role-grants/:grantId', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const body = await readJson(c);
  const now = Date.now();
  if (!body || !('expires_at' in body)) return invalid(c, 'expires_at is required (or null).');
  const expiresAt = readExpiry(body.expires_at, now);
  if (expiresAt === 'invalid') {
    return invalid(c, 'expires_at must be a future time in epoch milliseconds, or null.');
  }
  try {
    const adapter = adminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const groups = new AdminGroupRepository(adapter, tenantId);
    const groupId = c.req.param('id');
    const grant = await groups.getGrant(groupId, c.req.param('grantId'));
    if (!grant) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    if (grant.expires_at === expiresAt) return c.json(grant);

    const longer =
      expiresAt === null || (grant.expires_at !== null && expiresAt > grant.expires_at);
    if (longer) {
      if (!callerOutranks(authContext, grant.hierarchy_level)) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    } else {
      if (!mayRemoveAssignment(authContext, 'tenant', grant.hierarchy_level)) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }
    // Only an earlier end can leave the tenant without an administrator.
    const exclusion = longer ? null : { groupGrantId: grant.id, newExpiresAt: expiresAt };
    if (exclusion) {
      const refusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, exclusion);
      if (refusal) return refusal;
    }

    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: longer ? 'admin.role.grant' : 'admin.role.revoke',
      targetTenantId: tenantId,
      targetIds: [groupId, grant.admin_role_id],
      params: { admin_group: groupId, grant: grant.id, expires_at: expiresAt },
    });
    if (stepUpRefused) return stepUpRefused;

    const updated = await groups.updateGrantExpiry(
      groupId,
      grant.id,
      expiresAt,
      grant.expires_at,
      exclusion ? tenantKeepsAdminGuard(tenantId, exclusion) : undefined
    );
    if (!updated) {
      const current = await groups.getGrant(groupId, grant.id);
      if (!current) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      return current.expires_at !== grant.expires_at ? groupChanged(c) : lastTenantAdminResponse(c);
    }
    await audit(c, 'admin.group.role.expiry_changed', groupId, {
      grant_id: grant.id,
      role_id: grant.admin_role_id,
      expires_at: expiresAt,
      previous_expires_at: grant.expires_at,
    });
    const changedGroup = await groups.get(groupId);
    await notice(adapter, tenantId, groupId, {
      messageKey: 'admin_group_role_expiry_changed',
      title: `Admin group ${changedGroup?.display_name ?? groupId} gives ${grant.role_display_name || grant.role_name} ${
        expiresAt === null ? 'without an end' : `until ${new Date(expiresAt).toISOString()}`
      }`,
      params: {
        group: changedGroup?.display_name ?? groupId,
        role: grant.role_display_name || grant.role_name,
        expires_at: expiresAt,
      },
    });
    return c.json(await groups.getGrant(groupId, grant.id));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/** DELETE /:id/role-grants/:grantId — every member loses the role (unless held otherwise). */
adminGroupsRouter.delete('/:id/role-grants/:grantId', async (c) => {
  const authContext = auth(c);
  if (!mayChangeGroups(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  try {
    const adapter = adminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const groups = new AdminGroupRepository(adapter, tenantId);
    const groupId = c.req.param('id');
    const grant = await groups.getGrant(groupId, c.req.param('grantId'));
    if (!grant) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    if (!mayRemoveAssignment(authContext, 'tenant', grant.hierarchy_level)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    const exclusion = { groupGrantId: grant.id };
    const refusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, exclusion);
    if (refusal) return refusal;

    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: 'admin.role.revoke',
      targetTenantId: tenantId,
      targetIds: [groupId, grant.admin_role_id],
      params: { admin_group: groupId, grant: grant.id },
    });
    if (stepUpRefused) return stepUpRefused;

    const removed = await groups.removeGrant(
      groupId,
      grant.id,
      tenantKeepsAdminGuard(tenantId, exclusion)
    );
    if (!removed) {
      return (await groups.getGrant(groupId, grant.id))
        ? lastTenantAdminResponse(c)
        : createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    await audit(c, 'admin.group.role.revoked', groupId, {
      grant_id: grant.id,
      role_id: grant.admin_role_id,
      role_name: grant.role_name,
    });
    const revokedFrom = await groups.get(groupId);
    await notice(adapter, tenantId, groupId, {
      messageKey: 'admin_group_role_revoked',
      title: `Admin group ${revokedFrom?.display_name ?? groupId} no longer gives ${grant.role_display_name || grant.role_name}`,
      params: {
        group: revokedFrom?.display_name ?? groupId,
        role: grant.role_display_name || grant.role_name,
      },
    });
    return c.json({ success: true });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});
