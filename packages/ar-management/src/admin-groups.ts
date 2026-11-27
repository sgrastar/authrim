/**
 * End-user group Admin API
 *
 * - Groups of the tenant (definitions and the nesting of groups)
 * - Memberships: who is in a group (kept in the subject's account database)
 * - The roles granted to a group (kept with the group definitions)
 * - A user's groups
 *
 * The group definitions and the roles granted to a group are in the tenant metadata database, a
 * membership is in the account database of its subject (see rbac-account-stores.ts). Every write
 * that gives or takes away roles through a group goes through the delegation guards of
 * group-role-management.ts, the same ones that guard a direct grant.
 */

import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  MergedPageTooDeepError,
  bumpTenantRBACCacheVersion,
  countGroupMembers,
  createErrorResponse,
  createGroup,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  escapeLikePattern,
  getLogger,
  getTenantIdFromContext,
  groupParentCondition,
  groupsCarryingRoles,
  subtreeHasSelfWritableDynamicGroup,
  invalidateSubjectRBACCache,
  isUniqueConstraintError,
  listGroupMembersPage,
  loadTenantRoles,
  lockGroupCatalog,
  rbacIdBatches,
  resolveSubjectGroups,
  revokeManualGroupMemberships,
  writeGroupRoleGrant,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { isInactiveAccountRouteError } from './account-route-errors';
import { recordAdminOperationAudit } from './admin-operation-audit';
import {
  createAdaptersFromContext,
  listPage,
  pageTooDeep,
  rbacDatabasesFromContext,
  resolveSubjectAccount,
  runtimeUserExists,
  subjectAccountForRevocation,
  subjectContacts,
  toMilliseconds,
} from './admin-rbac';
import {
  adminRemoveGroupRole,
  adminUpsertGroupMembership,
  assertDelegableRole,
  canManageGroupMembership,
  isRoleAssignable,
} from './group-role-management';
import { tenantRBACStores, type TenantRBACStores } from './rbac-account-stores';

type GroupContext = Context<{ Bindings: Env }>;

const GROUP_KINDS = ['static', 'dynamic', 'scim', 'provisioned'] as const;
const GROUP_LIFECYCLE_STATES = ['active', 'inactive'] as const;
const ROLE_SCOPE_TYPES = ['global', 'tenant', 'group', 'resource'] as const;
const GROUP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PARENT_CHAIN = 16;

function adminAuthOf(c: GroupContext): AdminAuthContext | null {
  return (
    (c as unknown as { get(name: string): AdminAuthContext | undefined }).get('adminAuth') ?? null
  );
}

function failure(
  c: GroupContext,
  status: 400 | 404 | 409 | 500,
  error: string,
  description: string
) {
  return c.json({ error, error_description: description }, status);
}

const notFound = (c: GroupContext) =>
  failure(c, 404, 'not_found', 'The requested resource was not found');
const invalid = (c: GroupContext, description: string) =>
  failure(c, 400, 'invalid_request', description);
const forbidden = (c: GroupContext) =>
  createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

function serverError(c: GroupContext, action: string, error: unknown, description: string) {
  getLogger(c)
    .module('ADMIN-GROUPS')
    .error(description, { action }, error as Error);
  return failure(c, 500, 'server_error', description);
}

/** Errors the delegation guards and the shared writers throw, as responses. */
function knownGroupError(c: GroupContext, error: unknown) {
  if (error instanceof MergedPageTooDeepError) return pageTooDeep(c);
  const message = error instanceof Error ? error.message : '';
  switch (message) {
    case 'role_delegation_denied':
      return forbidden(c);
    case 'group_not_found':
    case 'group_or_role_not_found':
      return notFound(c);
    case 'role_not_assignable':
      return invalid(c, 'The role cannot be assigned');
    case 'invalid_group_parent':
    case 'group_not_found_or_invalid_parent':
      return invalid(c, 'parent_group_id must name an existing group that does not form a loop');
    case 'group_managed_by_service_group':
      return failure(
        c,
        409,
        'group_managed_by_service_group',
        'The group is a service group: change its state, parent or existence through the service group rules'
      );
    case 'group_self_writable_attribute':
      return failure(
        c,
        400,
        'group_self_writable_attribute',
        'A service group below this group is decided by an attribute users can set themselves: it cannot carry roles'
      );
    default:
      return null;
  }
}

interface GroupRow {
  id: string;
  tenant_id: string;
  group_key: string;
  display_name: string;
  description: string | null;
  parent_group_id: string | null;
  lifecycle_state: string;
  kind: string;
  external_id: string | null;
  rule_revision: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

/** A group the service-group catalog owns (canonical.ts): its state and existence follow the rules. */
function catalogOwned(group: Pick<GroupRow, 'id' | 'kind' | 'group_key'>) {
  // Exactly the catalog's own key (canonical.ts: `dynamic:<id>`), not any `dynamic:` key.
  return group.kind === 'dynamic' && group.group_key === `dynamic:${group.id}`;
}

const GROUP_COLUMNS = `id, tenant_id, group_key, display_name, description, parent_group_id,
  lifecycle_state, kind, external_id, rule_revision, metadata_json, created_at, updated_at`;

function parseMetadata(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function presentGroup(row: GroupRow, memberCount?: number) {
  return {
    id: row.id,
    group_key: row.group_key,
    display_name: row.display_name,
    description: row.description,
    parent_group_id: row.parent_group_id,
    lifecycle_state: row.lifecycle_state,
    kind: row.kind,
    external_id: row.external_id,
    rule_revision: num(row.rule_revision),
    metadata: parseMetadata(row.metadata_json),
    created_at: toMilliseconds(num(row.created_at)),
    updated_at: toMilliseconds(num(row.updated_at)),
    ...(memberCount === undefined ? {} : { member_count: memberCount }),
  };
}

type Reader = Pick<DatabaseAdapter, 'query' | 'queryOne'>;

function findGroup(metadata: Reader, tenantId: string, id: string) {
  return metadata.queryOne<GroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM "groups" WHERE tenant_id = ? AND id = ?`,
    [tenantId, id]
  );
}

async function loadGroupNames(metadata: DatabaseAdapter, tenantId: string, ids: Iterable<string>) {
  const found = new Map<string, Pick<GroupRow, 'id' | 'group_key' | 'display_name'>>();
  for (const batch of rbacIdBatches(ids)) {
    const rows = await metadata.query<Pick<GroupRow, 'id' | 'group_key' | 'display_name'>>(
      `SELECT id, group_key, display_name FROM "groups"
        WHERE tenant_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
      [tenantId, ...batch]
    );
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

/** The parent, its parent and so on, nearest first; a loop or a very deep chain ends the walk. */
async function parentChain(metadata: Reader, tenantId: string, group: GroupRow) {
  const chain: GroupRow[] = [];
  const seen = new Set([group.id]);
  let parentId = group.parent_group_id;
  while (parentId && !seen.has(parentId) && chain.length < MAX_PARENT_CHAIN) {
    const parent = await findGroup(metadata, tenantId, parentId);
    if (!parent) break;
    chain.push(parent);
    seen.add(parent.id);
    parentId = parent.parent_group_id;
  }
  return chain;
}

/** Unix seconds above this are milliseconds (the year 2286 in seconds). */
const MAX_UNIX_SECONDS = 10_000_000_000;

function optionalSeconds(value: unknown, field: string): number | null | string {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_UNIX_SECONDS
  )
    return `${field} must be an integer in Unix seconds (0 to ${MAX_UNIX_SECONDS}); milliseconds are not accepted`;
  return value;
}

/** A number column as read: PostgreSQL returns BIGINT as a string. Null when absent or unsafe. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readJson<T>(c: GroupContext): Promise<T | null> {
  try {
    const body = await c.req.json<T>();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** The membership conditions of `resolveSubjectGroups`, for a row as read. */
function membershipHolds(
  row: {
    lifecycle_state: string;
    starts_at: unknown;
    expires_at: unknown;
    stale_after: unknown;
  },
  now: number
) {
  const startsAt = num(row.starts_at);
  const expiresAt = num(row.expires_at);
  const staleAfter = num(row.stale_after);
  return (
    row.lifecycle_state === 'active' &&
    (startsAt === null || startsAt <= now) &&
    (expiresAt === null || expiresAt > now) &&
    (staleAfter === null || staleAfter > now)
  );
}

/**
 * Resolves the account of a subject onto the request. Null when the tenant has none; an account
 * that is not active (suspended, locked, being deleted) answers 409 through `inactive`.
 */
async function subjectAccountOrRefusal(
  c: GroupContext,
  subjectId: string
): Promise<{ found: boolean; inactive: boolean }> {
  try {
    return { found: await resolveSubjectAccount(c, subjectId), inactive: false };
  } catch (error) {
    if (isInactiveAccountRouteError(error)) return { found: false, inactive: true };
    throw error;
  }
}

const accountInactive = (c: GroupContext) =>
  failure(c, 409, 'conflict', 'The account is not active (suspended, locked or being deleted)');

/**
 * Whether the operator is, through their own memberships, at or above the group (the group is one
 * of the groups they are in or an ancestor of one) or below it (the group is a descendant of one
 * of those). Such an operator would be handing roles to themselves. States of groups are
 * ignored: reactivating a group the operator is in is the case that matters. An operator without a
 * membership in this tenant (no account here) holds nothing.
 */
async function operatorGroups(
  stores: TenantRBACStores,
  tenantId: string,
  auth: AdminAuthContext | null
) {
  const direct = new Set<string>();
  if (!auth?.userId) return direct;
  const now = Math.floor(Date.now() / 1000);
  for (const account of stores.accounts) {
    const rows = await account.query<{
      group_id: string;
      lifecycle_state: string;
      starts_at: unknown;
      expires_at: unknown;
      stale_after: unknown;
    }>(
      `SELECT group_id, lifecycle_state, starts_at, expires_at, stale_after FROM group_memberships
        WHERE tenant_id = ? AND subject_id = ?`,
      [tenantId, auth.userId]
    );
    // A scheduled membership (starts later) counts: it would give the roles once it starts.
    for (const row of rows) {
      const expiresAt = num(row.expires_at);
      const staleAfter = num(row.stale_after);
      if (
        row.lifecycle_state === 'active' &&
        (expiresAt === null || expiresAt > now) &&
        (staleAfter === null || staleAfter > now)
      )
        direct.add(row.group_id);
    }
  }
  return direct;
}

/** The check of `operatorGroups` against a group; reads the group definitions through `metadata`. */
async function touchesGroup(
  metadata: Reader,
  tenantId: string,
  direct: ReadonlySet<string>,
  group: GroupRow
) {
  if (!direct.size) return false;
  // The operator's groups and their ancestors, whatever the state of a group.
  const held = new Set(direct);
  let frontier = [...direct];
  for (let depth = 0; depth < MAX_PARENT_CHAIN && frontier.length; depth++) {
    const next = new Set<string>();
    for (const batch of rbacIdBatches(frontier)) {
      const rows = await metadata.query<{ parent_group_id: string | null }>(
        `SELECT parent_group_id FROM "groups"
          WHERE tenant_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
        [tenantId, ...batch]
      );
      for (const row of rows)
        if (row.parent_group_id && !held.has(row.parent_group_id)) next.add(row.parent_group_id);
    }
    for (const id of next) held.add(id);
    frontier = [...next];
  }
  // One of the operator's groups or an ancestor of one (held), or a descendant of one of their
  // groups. A sibling that only shares a parent with the operator's group is neither.
  if (held.has(group.id)) return true;
  const ancestors = await parentChain(metadata, tenantId, group);
  return ancestors.some((node) => direct.has(node.id));
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function pagination(page: number, limit: number, total: number) {
  const totalPages = Math.ceil(total / limit);
  return { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

// =============================================================================
// Groups
// =============================================================================

/** GET /api/admin/groups */
export async function adminGroupsListHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const { page, limit, offset } = listPage(c);
    const stores = await tenantRBACStores(c, tenantId);
    const where = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    const q = c.req.query('q')?.trim();
    if (q) {
      const pattern = `%${escapeLikePattern(q)}%`;
      where.push("(group_key LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    const kind = c.req.query('kind');
    if (kind) {
      if (!(GROUP_KINDS as readonly string[]).includes(kind)) return invalid(c, 'Invalid kind');
      where.push('kind = ?');
      params.push(kind);
    }
    const lifecycle = c.req.query('lifecycle_state');
    if (lifecycle) {
      if (!(GROUP_LIFECYCLE_STATES as readonly string[]).includes(lifecycle))
        return invalid(c, 'Invalid lifecycle_state');
      where.push('lifecycle_state = ?');
      params.push(lifecycle);
    }
    // An exact parent; `null` (the word) means the root groups.
    const parent = c.req.query('parent_group_id');
    if (parent !== undefined && parent !== '') {
      if (parent === 'null') where.push('parent_group_id IS NULL');
      else {
        where.push('parent_group_id = ?');
        params.push(parent);
      }
    }
    const condition = where.join(' AND ');
    const [totalRow, rows] = await Promise.all([
      stores.metadata.queryOne<{ count: number | null }>(
        `SELECT COUNT(*) AS count FROM "groups" WHERE ${condition}`,
        params
      ),
      stores.metadata.query<GroupRow>(
        `SELECT ${GROUP_COLUMNS} FROM "groups" WHERE ${condition}
          ORDER BY group_key ASC, id ASC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
    ]);
    const counts = await countGroupMembers(
      stores.accounts,
      tenantId,
      rows.map((row) => row.id)
    );
    const total = Number(totalRow?.count ?? 0);
    return c.json({
      groups: rows.map((row) => presentGroup(row, counts.get(row.id) ?? 0)),
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    return (
      knownGroupError(c, error) ?? serverError(c, 'list_groups', error, 'Failed to list groups')
    );
  }
}

/** POST /api/admin/groups */
export async function adminGroupCreateHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const body = await readJson<{
      group_key?: unknown;
      display_name?: unknown;
      description?: unknown;
      parent_group_id?: unknown;
      kind?: unknown;
      metadata?: unknown;
    }>(c);
    if (!body) return invalid(c, 'A JSON object body is required');
    if (typeof body.group_key !== 'string' || !GROUP_KEY_PATTERN.test(body.group_key))
      return invalid(
        c,
        'group_key is required: letters, digits and . _ : - (up to 128 characters, starting with a letter or digit)'
      );
    if (!present(body.display_name) || body.display_name.length > 200)
      return invalid(c, 'display_name is required (up to 200 characters)');
    if (body.description != null && typeof body.description !== 'string')
      return invalid(c, 'description must be a string');
    if (body.parent_group_id != null && !present(body.parent_group_id))
      return invalid(c, 'parent_group_id must be a group id');
    const kind = body.kind ?? 'static';
    if (typeof kind !== 'string' || !(GROUP_KINDS as readonly string[]).includes(kind))
      return invalid(c, `kind must be one of: ${GROUP_KINDS.join(', ')}`);
    if (
      body.metadata != null &&
      (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
    )
      return invalid(c, 'metadata must be an object');

    const stores = await tenantRBACStores(c, tenantId);
    let id: string;
    try {
      id = await createGroup(stores.metadata, tenantId, {
        groupKey: body.group_key,
        displayName: body.display_name.trim(),
        description: body.description ?? null,
        parentGroupId: body.parent_group_id ?? null,
        kind: kind as (typeof GROUP_KINDS)[number],
        metadataJson: body.metadata ? JSON.stringify(body.metadata) : null,
      });
    } catch (error) {
      if (isUniqueConstraintError(error))
        return failure(c, 409, 'conflict', 'A group with this group_key already exists');
      throw error;
    }
    await recordAdminOperationAudit(c, {
      action: 'group.created',
      resourceType: 'group',
      resourceId: id,
      metadata: {
        group_key: body.group_key,
        kind,
        parent_group_id: body.parent_group_id ?? null,
      },
    });
    const created = await findGroup(stores.metadata, tenantId, id);
    return c.json({ group: created ? presentGroup(created, 0) : { id } }, 201);
  } catch (error) {
    return (
      knownGroupError(c, error) ?? serverError(c, 'create_group', error, 'Failed to create group')
    );
  }
}

/** GET /api/admin/groups/:id */
export async function adminGroupGetHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const stores = await tenantRBACStores(c, tenantId);
    const group = await findGroup(stores.metadata, tenantId, groupId);
    if (!group) return notFound(c);
    const [chain, counts, roles, canManage] = await Promise.all([
      parentChain(stores.metadata, tenantId, group),
      countGroupMembers(stores.accounts, tenantId, [groupId]),
      groupRoleRows(stores.metadata, tenantId, groupId),
      // What member add and remove ask of this caller: the write permission (their route gate)
      // and the delegation guard.
      hasAdminPermission(adminAuthOf(c)?.permissions ?? [], ADMIN_PERMISSIONS.GROUPS_WRITE)
        ? canManageGroupMembership(stores.metadata, tenantId, adminAuthOf(c), groupId)
        : false,
    ]);
    return c.json({
      group: {
        ...presentGroup(group, counts.get(groupId) ?? 0),
        can_manage_membership: canManage,
        parent_chain: chain.map((parent) => ({
          id: parent.id,
          group_key: parent.group_key,
          display_name: parent.display_name,
          lifecycle_state: parent.lifecycle_state,
        })),
        roles,
      },
    });
  } catch (error) {
    return knownGroupError(c, error) ?? serverError(c, 'get_group', error, 'Failed to get group');
  }
}

const UPDATABLE_GROUP_FIELDS = new Set([
  'display_name',
  'description',
  'parent_group_id',
  'lifecycle_state',
  'metadata',
]);

/** PUT /api/admin/groups/:id */
export async function adminGroupUpdateHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const auth = adminAuthOf(c);
    const body = await readJson<{
      display_name?: unknown;
      description?: unknown;
      parent_group_id?: unknown;
      lifecycle_state?: unknown;
      metadata?: unknown;
    }>(c);
    if (!body) return invalid(c, 'A JSON object body is required');
    const unknownKey = Object.keys(body).find((key) => !UPDATABLE_GROUP_FIELDS.has(key));
    if (unknownKey !== undefined) return invalid(c, `Unknown field: ${unknownKey}`);
    if (
      body.display_name === undefined &&
      body.description === undefined &&
      body.parent_group_id === undefined &&
      body.lifecycle_state === undefined &&
      body.metadata === undefined
    )
      return invalid(
        c,
        'At least one of display_name, description, parent_group_id, lifecycle_state, metadata is required'
      );
    if (
      body.display_name !== undefined &&
      (!present(body.display_name) || body.display_name.length > 200)
    )
      return invalid(c, 'display_name must be a non-empty string (up to 200 characters)');
    if (body.description != null && typeof body.description !== 'string')
      return invalid(c, 'description must be a string');
    if (body.parent_group_id != null && !present(body.parent_group_id))
      return invalid(c, 'parent_group_id must be a group id or null');
    if (
      body.lifecycle_state !== undefined &&
      !(GROUP_LIFECYCLE_STATES as readonly unknown[]).includes(body.lifecycle_state)
    )
      return invalid(c, `lifecycle_state must be one of: ${GROUP_LIFECYCLE_STATES.join(', ')}`);
    if (
      body.metadata != null &&
      (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
    )
      return invalid(c, 'metadata must be an object or null');

    const stores = await tenantRBACStores(c, tenantId);
    const metadata = stores.metadata;
    // Read outside the transaction: the account databases may be the metadata database itself,
    // whose connection a PostgreSQL transaction leases.
    const operatorDirect = await operatorGroups(stores, tenantId, auth);

    // The lock, the reads, every delegation check and the write are one transaction. PostgreSQL
    // serialises group changes with the catalog lock; D1 runs the statements of a transaction one
    // by one, so there the lock does nothing and the read state kept in the WHERE below only
    // narrows the window between the checks and the write, it does not close it.
    const outcome = await metadata.transaction(async (tx) => {
      await lockGroupCatalog(tx, tenantId, metadata.getType());
      const group = await findGroup(tx, tenantId, groupId);
      if (!group) return { kind: 'not_found' as const };

      // Changing the state or the parent changes the roles of every member below the group: it
      // needs the same authority as adding a member to a group that carries roles. A state that
      // is already the group's is not written.
      const lifecycleChanged =
        body.lifecycle_state !== undefined && body.lifecycle_state !== group.lifecycle_state;
      const newParent =
        body.parent_group_id === undefined
          ? undefined
          : ((body.parent_group_id as string | null) ?? null);
      const parentChanged = newParent !== undefined && newParent !== group.parent_group_id;
      if (catalogOwned(group) && (lifecycleChanged || parentChanged))
        throw new Error('group_managed_by_service_group');
      // Moving the group under a parent that carries roles hands those roles to every group below
      // it: not when a service group there is decided by an attribute users set themselves.
      // Checked under the catalog lock (PostgreSQL); on D1 it narrows the window only.
      if (
        parentChanged &&
        newParent &&
        (await groupsCarryingRoles(tx, tenantId, [newParent])).size &&
        (await subtreeHasSelfWritableDynamicGroup(tx, tenantId, groupId))
      )
        throw new Error('group_self_writable_attribute');

      // Every delegation check runs before anything is written.
      if (lifecycleChanged && !(await canManageGroupMembership(tx, tenantId, auth, groupId)))
        return { kind: 'forbidden' as const };
      if (
        parentChanged &&
        (!(await canManageGroupMembership(tx, tenantId, auth, groupId)) ||
          (newParent && !(await canManageGroupMembership(tx, tenantId, auth, newParent))))
      )
        return { kind: 'forbidden' as const };
      // Reactivating or moving a group the operator is part of could hand roles to themselves.
      if (
        ((lifecycleChanged && body.lifecycle_state === 'active') || parentChanged) &&
        (await touchesGroup(tx, tenantId, operatorDirect, group))
      )
        return { kind: 'forbidden' as const };

      const columns: Array<[string, unknown]> = [];
      if (body.display_name !== undefined)
        columns.push(['display_name', (body.display_name as string).trim()]);
      if (body.description !== undefined) columns.push(['description', body.description ?? null]);
      if (lifecycleChanged) columns.push(['lifecycle_state', body.lifecycle_state]);
      if (parentChanged) columns.push(['parent_group_id', newParent]);
      if (body.metadata !== undefined)
        columns.push(['metadata_json', body.metadata ? JSON.stringify(body.metadata) : null]);

      // One statement sets everything, and only while the state and the parent read above still
      // hold: a concurrent change is a 409, never a mix of two requests.
      const parentCheck = groupParentCondition(tenantId, parentChanged ? newParent! : null, {
        id: groupId,
      });
      const guards: string[] = [];
      const guardParams: unknown[] = [];
      if (lifecycleChanged) {
        guards.push('lifecycle_state = ?');
        guardParams.push(group.lifecycle_state);
      }
      if (lifecycleChanged || parentChanged) {
        if (group.parent_group_id === null) guards.push('parent_group_id IS NULL');
        else {
          guards.push('parent_group_id = ?');
          guardParams.push(group.parent_group_id);
        }
      }
      const written = await tx.execute(
        `UPDATE "groups" SET ${[...columns.map(([name]) => `${name} = ?`), 'updated_at = ?'].join(', ')}
          WHERE tenant_id = ? AND id = ?${guards.map((guard) => ` AND ${guard}`).join('')} AND ${parentCheck.sql}`,
        [
          ...columns.map(([, value]) => value),
          Date.now(),
          tenantId,
          groupId,
          ...guardParams,
          ...parentCheck.params,
        ]
      );
      if (!written.rowsAffected) {
        const current = await findGroup(tx, tenantId, groupId);
        if (!current) return { kind: 'not_found' as const };
        if (
          (lifecycleChanged && current.lifecycle_state !== group.lifecycle_state) ||
          ((lifecycleChanged || parentChanged) && current.parent_group_id !== group.parent_group_id)
        )
          return { kind: 'conflict' as const };
        return { kind: 'invalid_parent' as const };
      }
      return { kind: 'ok' as const, group, lifecycleChanged, parentChanged };
    });
    if (outcome.kind === 'not_found') return notFound(c);
    if (outcome.kind === 'forbidden') return forbidden(c);
    if (outcome.kind === 'conflict')
      return failure(
        c,
        409,
        'group_version_conflict',
        'The group changed meanwhile: read it again and retry'
      );
    if (outcome.kind === 'invalid_parent')
      return invalid(c, 'parent_group_id must name an existing group that does not form a loop');

    // After every successful update, a same-value one included: a retry of a request whose bump
    // failed then completes it.
    if (c.env.REBAC_CACHE) await bumpTenantRBACCacheVersion(c.env.REBAC_CACHE, tenantId);

    await recordAdminOperationAudit(c, {
      action: 'group.updated',
      resourceType: 'group',
      resourceId: groupId,
      metadata: {
        group_key: outcome.group.group_key,
        display_name_changed: body.display_name !== undefined,
        description_changed: body.description !== undefined,
        parent_changed: outcome.parentChanged,
        lifecycle_state: outcome.lifecycleChanged ? body.lifecycle_state : undefined,
        metadata_changed: body.metadata !== undefined,
      },
    });
    const updated = await findGroup(metadata, tenantId, groupId);
    return c.json({ group: updated ? presentGroup(updated) : { id: groupId } });
  } catch (error) {
    return (
      knownGroupError(c, error) ?? serverError(c, 'update_group', error, 'Failed to update group')
    );
  }
}

/**
 * DELETE /api/admin/groups/:id
 *
 * The group's memberships are in every account database and its definition in the metadata
 * database, so the delete is several writes. Progress is not persisted: a request that failed
 * part way is repeated, and the repeat finds the definition gone with memberships or grants left
 * (answer 204 after cleaning them up). The tenant version is bumped once before the first write;
 * once the rows are gone each former member's cached claims are dropped. A failure of that or of
 * the audit write after the rows are gone is logged and the delete still counts as done.
 */
export async function adminGroupDeleteHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const stores = await tenantRBACStores(c, tenantId);
    const cache = c.env.REBAC_CACHE;
    const group = await findGroup(stores.metadata, tenantId, groupId);
    // A service group is deleted by removing it from the service group rules.
    if (group && catalogOwned(group)) throw new Error('group_managed_by_service_group');
    if (!group) {
      // A retry after a partial failure: clean up what is left of the group.
      const leftoverGrants = Number(
        (
          await stores.metadata.queryOne<{ count: number | null }>(
            'SELECT COUNT(*) AS count FROM group_role_assignments WHERE tenant_id = ? AND group_id = ?',
            [tenantId, groupId]
          )
        )?.count ?? 0
      );
      const subjects = await groupMemberSubjects(stores, tenantId, groupId);
      if (!leftoverGrants && !subjects.size) return notFound(c);
      if (cache) await bumpTenantRBACCacheVersion(cache, tenantId);
      await removeGroupRows(stores, tenantId, groupId);
      await invalidateSubjectsQuietly(c, cache, tenantId, subjects);
      return c.body(null, 204);
    }
    // The child check, the scope-reference check, the delegation check and the switch to inactive
    // are one transaction that first takes the catalog lock, so on PostgreSQL they serialise with
    // role grants and reparents. On D1 the statements still run one by one: this narrows the
    // window, it does not close it.
    const auth = adminAuthOf(c);
    const metadata = stores.metadata;
    const gate = await metadata.transaction(async (tx) => {
      await lockGroupCatalog(tx, tenantId, metadata.getType());
      const children = await tx.queryOne<{ count: number | null }>(
        'SELECT COUNT(*) AS count FROM "groups" WHERE tenant_id = ? AND parent_group_id = ?',
        [tenantId, groupId]
      );
      if (Number(children?.count ?? 0) > 0) return 'children' as const;
      // A role granted to another group with this group as its scope would keep applying to a
      // scope that no longer exists. Direct role assignments with that scope are on the account
      // shards and are not checked here (a recorded follow-up).
      const scopedGrants = await tx.queryOne<{ count: number | null }>(
        "SELECT COUNT(*) AS count FROM group_role_assignments WHERE tenant_id = ? AND scope_type = 'group' AND scope_target = ?",
        [tenantId, `group:${groupId}`]
      );
      if (Number(scopedGrants?.count ?? 0) > 0) return 'scoped' as const;
      if (!(await canManageGroupMembership(tx, tenantId, auth, groupId)))
        return 'forbidden' as const;
      // The group goes inactive first (effective roles stop at an inactive group), then the
      // tenant version is bumped; only after a successful bump are the memberships, the grants
      // and the definition removed. If the bump fails the answer is 500 and the group stays
      // inactive: a retry finds an inactive group with the same id and resumes from here.
      await tx.execute(
        `UPDATE "groups" SET lifecycle_state = 'inactive', updated_at = ? WHERE tenant_id = ? AND id = ?`,
        [Date.now(), tenantId, groupId]
      );
      return 'ok' as const;
    });
    if (gate === 'children')
      return failure(
        c,
        409,
        'group_has_children',
        'The group has child groups: move or delete them first'
      );
    if (gate === 'scoped')
      return failure(
        c,
        409,
        'group_referenced_as_scope',
        'A role granted to a group has this group as its scope: remove that grant first'
      );
    if (gate === 'forbidden') return forbidden(c);
    if (cache) await bumpTenantRBACCacheVersion(cache, tenantId);
    const subjects = await groupMemberSubjects(stores, tenantId, groupId);
    // Memberships first (each account database), then what the group grants, then the group:
    // a failure part way leaves a group with fewer members, never members of a missing group.
    await removeGroupRows(stores, tenantId, groupId);
    await stores.metadata.execute('DELETE FROM "groups" WHERE tenant_id = ? AND id = ?', [
      tenantId,
      groupId,
    ]);
    await invalidateSubjectsQuietly(c, cache, tenantId, subjects);
    try {
      await recordAdminOperationAudit(c, {
        action: 'group.deleted',
        resourceType: 'group',
        resourceId: groupId,
        metadata: { group_key: group.group_key, kind: group.kind },
      });
    } catch (error) {
      getLogger(c)
        .module('ADMIN-GROUPS')
        .warn('Group deleted but the audit record was not written', {
          action: 'delete_group',
          groupId,
          error: error instanceof Error ? error.message : 'unknown',
        });
    }
    return c.json({ success: true, message: 'Group deleted successfully' });
  } catch (error) {
    return (
      knownGroupError(c, error) ?? serverError(c, 'delete_group', error, 'Failed to delete group')
    );
  }
}

/** The distinct subjects with a membership row in the group, in every account database. */
async function groupMemberSubjects(stores: TenantRBACStores, tenantId: string, groupId: string) {
  const subjects = new Set<string>();
  for (const account of stores.accounts)
    for (const row of await account.query<{ subject_id: string }>(
      'SELECT DISTINCT subject_id FROM group_memberships WHERE tenant_id = ? AND group_id = ?',
      [tenantId, groupId]
    ))
      subjects.add(row.subject_id);
  return subjects;
}

/** Drops the cached claims of each subject; a failure is logged, the rows are already gone. */
async function invalidateSubjectsQuietly(
  c: GroupContext,
  cache: Env['REBAC_CACHE'],
  tenantId: string,
  subjects: ReadonlySet<string>
) {
  if (!cache) return;
  let failed = 0;
  for (const subjectId of subjects) {
    try {
      await invalidateSubjectRBACCache(cache, tenantId, subjectId);
    } catch {
      failed += 1;
    }
  }
  if (failed)
    getLogger(c)
      .module('ADMIN-GROUPS')
      .warn('Cached claims of former group members were not all dropped', {
        action: 'delete_group',
        failed,
      });
}

async function removeGroupRows(stores: TenantRBACStores, tenantId: string, groupId: string) {
  for (const account of stores.accounts)
    await account.execute('DELETE FROM group_memberships WHERE tenant_id = ? AND group_id = ?', [
      tenantId,
      groupId,
    ]);
  await stores.metadata.execute(
    'DELETE FROM group_role_assignments WHERE tenant_id = ? AND group_id = ?',
    [tenantId, groupId]
  );
  // Resource permissions granted to the group go with it (a retry deletes what is left).
  await stores.metadata.execute(
    "DELETE FROM resource_permissions WHERE tenant_id = ? AND subject_type = 'group' AND subject_id = ?",
    [tenantId, groupId]
  );
}

// =============================================================================
// Members
// =============================================================================

function presentMembership(
  row: {
    subject_id: string;
    assignment_source: string;
    source_ref: string;
    lifecycle_state: string;
    starts_at: unknown;
    expires_at: unknown;
    stale_after: unknown;
    created_at: unknown;
  },
  now: number
) {
  return {
    subject_id: row.subject_id,
    assignment_source: row.assignment_source,
    source_ref: row.source_ref || null,
    lifecycle_state: row.lifecycle_state,
    starts_at: num(row.starts_at),
    expires_at: num(row.expires_at),
    stale_after: num(row.stale_after),
    joined_at: toMilliseconds(num(row.created_at)),
    // Whether the row counts as a membership now (the conditions of effective membership).
    effective: membershipHolds(row, now),
  };
}

/** GET /api/admin/groups/:id/members */
export async function adminGroupMembersListHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const { page, limit, offset } = listPage(c);
    const stores = await tenantRBACStores(c, tenantId);
    if (!(await findGroup(stores.metadata, tenantId, groupId))) return notFound(c);
    const now = Math.floor(Date.now() / 1000);
    const { total, items } = await listGroupMembersPage(stores.accounts, tenantId, groupId, {
      limit,
      offset,
    });
    const contacts = await subjectContacts(
      c,
      stores,
      tenantId,
      items.map(({ row }) => row.subject_id)
    );
    return c.json({
      members: items.map(({ row }) => ({
        ...presentMembership(row, now),
        user_email: contacts.get(row.subject_id)?.email ?? null,
        user_name: contacts.get(row.subject_id)?.name ?? null,
      })),
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    return (
      knownGroupError(c, error) ??
      serverError(c, 'list_group_members', error, 'Failed to list group members')
    );
  }
}

/** POST /api/admin/groups/:id/members */
export async function adminGroupMemberAddHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const body = await readJson<{
      subject_id?: unknown;
      starts_at?: unknown;
      expires_at?: unknown;
    }>(c);
    if (!body) return invalid(c, 'A JSON object body is required');
    if (!present(body.subject_id)) return invalid(c, 'subject_id is required');
    const startsAt = optionalSeconds(body.starts_at, 'starts_at');
    const expiresAt = optionalSeconds(body.expires_at, 'expires_at');
    if (typeof startsAt === 'string') return invalid(c, startsAt);
    if (typeof expiresAt === 'string') return invalid(c, expiresAt);
    if (startsAt !== null && expiresAt !== null && startsAt >= expiresAt)
      return invalid(c, 'expires_at must be after starts_at');
    const subjectId = body.subject_id;

    const metadata = (await tenantRBACStores(c, tenantId)).metadata;
    if (!(await findGroup(metadata, tenantId, groupId))) return notFound(c);
    const resolvedAccount = await subjectAccountOrRefusal(c, subjectId);
    if (resolvedAccount.inactive) return accountInactive(c);
    if (!resolvedAccount.found) return notFound(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, subjectId)))
      return notFound(c);

    await adminUpsertGroupMembership(
      adminAuthOf(c),
      rbacDatabasesFromContext(c, coreAdapter),
      tenantId,
      subjectId,
      { groupId, source: 'manual', startsAt, expiresAt },
      c.env.REBAC_CACHE
    );
    await recordAdminOperationAudit(c, {
      action: 'group.member_added',
      resourceType: 'group',
      resourceId: groupId,
      metadata: { subject_id: subjectId, starts_at: startsAt, expires_at: expiresAt },
    });
    return c.json(
      {
        success: true,
        message: 'Member added successfully',
        membership: {
          group_id: groupId,
          subject_id: subjectId,
          assignment_source: 'manual',
          starts_at: startsAt,
          expires_at: expiresAt,
        },
      },
      201
    );
  } catch (error) {
    return (
      knownGroupError(c, error) ??
      serverError(c, 'add_group_member', error, 'Failed to add group member')
    );
  }
}

/** DELETE /api/admin/groups/:id/members/:subjectId (manual memberships only) */
export async function adminGroupMemberRemoveHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const subjectId = c.req.param('subjectId')!;
    const auth = adminAuthOf(c);
    const metadata = (await tenantRBACStores(c, tenantId)).metadata;
    if (!(await findGroup(metadata, tenantId, groupId))) return notFound(c);
    // A suspended or locked account's membership can still be taken away.
    const account = await subjectAccountForRevocation(c, tenantId, subjectId);
    if (!account) return notFound(c);
    if (auth?.userId === subjectId) return forbidden(c);
    if (!(await canManageGroupMembership(metadata, tenantId, auth, groupId))) return forbidden(c);

    const rows = await account.query<{ assignment_source: string; source_ref: string }>(
      `SELECT assignment_source, source_ref FROM group_memberships
        WHERE tenant_id = ? AND group_id = ? AND subject_id = ?`,
      [tenantId, groupId, subjectId]
    );
    if (!rows.length) return notFound(c);
    const manual = rows.filter((row) => row.assignment_source === 'manual');
    if (!manual.length)
      return failure(
        c,
        409,
        'membership_other_source',
        'The membership comes from another source (SCIM, a rule, a dynamic group or an invitation) and cannot be removed here'
      );
    // Every manual row (whatever its source_ref) in one statement, the cache dropped once.
    await revokeManualGroupMemberships(
      { metadata, account },
      tenantId,
      subjectId,
      groupId,
      c.env.REBAC_CACHE
    );
    await recordAdminOperationAudit(c, {
      action: 'group.member_removed',
      resourceType: 'group',
      resourceId: groupId,
      metadata: { subject_id: subjectId, other_sources_remain: rows.length > manual.length },
    });
    return c.json({ success: true, message: 'Member removed successfully' });
  } catch (error) {
    return (
      knownGroupError(c, error) ??
      serverError(c, 'remove_group_member', error, 'Failed to remove group member')
    );
  }
}

// =============================================================================
// Roles granted to a group
// =============================================================================

interface GroupRoleRow {
  id: string;
  role_id: string;
  scope_type: string;
  scope_target: string;
  expires_at: number | null;
  assigned_by: string | null;
  created_at: number;
}

async function groupRoleRows(metadata: DatabaseAdapter, tenantId: string, groupId: string) {
  const rows = await metadata.query<GroupRoleRow>(
    `SELECT id, role_id, scope_type, scope_target, expires_at, assigned_by, created_at
       FROM group_role_assignments WHERE tenant_id = ? AND group_id = ?
      ORDER BY created_at ASC, scope_type ASC, scope_target ASC, id ASC`,
    [tenantId, groupId]
  );
  const roles = await loadTenantRoles(
    metadata,
    tenantId,
    rows.map((row) => row.role_id)
  );
  return rows.map((row) => {
    const role = roles.get(row.role_id);
    return {
      id: row.id,
      role_id: row.role_id,
      role_name: role?.name ?? null,
      role_display_name: role?.display_name ?? null,
      scope_type: row.scope_type,
      scope_target: row.scope_target,
      expires_at: num(row.expires_at),
      assigned_by: row.assigned_by,
      created_at: toMilliseconds(num(row.created_at)),
    };
  });
}

/** GET /api/admin/groups/:id/roles */
export async function adminGroupRolesListHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const metadata = (await tenantRBACStores(c, tenantId)).metadata;
    if (!(await findGroup(metadata, tenantId, groupId))) return notFound(c);
    return c.json({ group_id: groupId, roles: await groupRoleRows(metadata, tenantId, groupId) });
  } catch (error) {
    return (
      knownGroupError(c, error) ??
      serverError(c, 'list_group_roles', error, 'Failed to list group roles')
    );
  }
}

/** POST /api/admin/groups/:id/roles */
export async function adminGroupRoleAssignHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const body = await readJson<{
      role_id?: unknown;
      scope_type?: unknown;
      scope_target?: unknown;
      expires_at?: unknown;
    }>(c);
    if (!body) return invalid(c, 'A JSON object body is required');
    if (!present(body.role_id)) return invalid(c, 'role_id is required');
    const scopeType = body.scope_type ?? 'global';
    if (
      typeof scopeType !== 'string' ||
      !(ROLE_SCOPE_TYPES as readonly string[]).includes(scopeType)
    )
      return invalid(c, `scope_type must be one of: ${ROLE_SCOPE_TYPES.join(', ')}`);
    if (body.scope_target != null && typeof body.scope_target !== 'string')
      return invalid(c, 'scope_target must be a string');
    const scopeTarget = body.scope_target ?? '';
    // The targets `roleAssignmentHolds` reads: none for global, empty or this tenant for tenant,
    // `group:<id>` for group, `resource:<type>:<id>` or `resource:<id>` for resource.
    if (scopeType === 'global' && scopeTarget !== '')
      return invalid(c, 'scope_target must be empty for global scope');
    if (scopeType === 'tenant' && scopeTarget !== '' && scopeTarget !== tenantId)
      return invalid(c, 'scope_target must be empty or the tenant id for tenant scope');
    if (scopeType === 'group' && !/^group:[^\s:]+$/.test(scopeTarget))
      return invalid(c, 'scope_target must be group:<group id> for group scope');
    if (scopeType === 'resource' && !/^resource:[^\s:]+(?::[^\s:]+)?$/.test(scopeTarget))
      return invalid(
        c,
        'scope_target must be resource:<type>:<id> or resource:<id> for resource scope'
      );
    const expiresAt = optionalSeconds(body.expires_at, 'expires_at');
    if (typeof expiresAt === 'string') return invalid(c, expiresAt);
    if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000))
      return invalid(c, 'expires_at must be in the future');

    const auth = adminAuthOf(c);
    const stores = await tenantRBACStores(c, tenantId);
    const metadata = stores.metadata;
    // Read outside the transaction: the account databases may be the metadata database itself,
    // whose connection a PostgreSQL transaction leases.
    const operatorDirect = await operatorGroups(stores, tenantId, auth);
    // The lock, the ancestry reads, the checks and the grant are one transaction, so on PostgreSQL
    // a grant serialises with a reparent. On D1 the statements still run one by one: this narrows
    // the window between the checks and the write, it does not close it.
    const outcome = await metadata.transaction(async (tx) => {
      await lockGroupCatalog(tx, tenantId, metadata.getType());
      const group = await findGroup(tx, tenantId, groupId);
      if (!group) return { kind: 'not_found' as const };
      // A role on the group reaches every group below it: not when a service group there is
      // decided by an attribute users set themselves (checked under the same lock).
      if (await subtreeHasSelfWritableDynamicGroup(tx, tenantId, groupId))
        throw new Error('group_self_writable_attribute');
      if (scopeType === 'group' && !(await findGroup(tx, tenantId, scopeTarget.slice(6))))
        return { kind: 'invalid_scope' as const };
      const role = await tx.queryOne<{
        id: string;
        name: string;
        grant_tier: number;
        is_assignable: number | boolean | null;
      }>('SELECT id, name, grant_tier, is_assignable FROM roles WHERE tenant_id = ? AND id = ?', [
        tenantId,
        body.role_id,
      ]);
      if (!role) return { kind: 'not_found' as const };
      // An operator cannot grant roles to a group they are part of (or sit under or above).
      if (await touchesGroup(tx, tenantId, operatorDirect, group))
        return { kind: 'forbidden' as const };
      assertDelegableRole(auth, role);
      // 0 in SQLite/D1, false in PostgreSQL
      if (!isRoleAssignable(role)) return { kind: 'not_assignable' as const };
      await writeGroupRoleGrant(tx, tenantId, {
        groupId,
        roleId: role.id,
        scopeType: scopeType as (typeof ROLE_SCOPE_TYPES)[number],
        scopeTarget,
        expiresAt,
        assignedBy: auth?.userId ?? null,
      });
      return { kind: 'ok' as const, role };
    });
    if (outcome.kind === 'not_found') return notFound(c);
    if (outcome.kind === 'forbidden') return forbidden(c);
    if (outcome.kind === 'invalid_scope')
      return invalid(c, 'scope_target names a group the tenant does not have');
    if (outcome.kind === 'not_assignable') return invalid(c, 'The role cannot be assigned');
    const role = outcome.role;
    // A role granted to a group reaches every member: the tenant's cached claims are all stale.
    if (c.env.REBAC_CACHE) await bumpTenantRBACCacheVersion(c.env.REBAC_CACHE, tenantId);
    await recordAdminOperationAudit(c, {
      action: 'group.role_assigned',
      resourceType: 'group',
      resourceId: groupId,
      metadata: {
        role_id: role.id,
        role_name: role.name,
        scope_type: scopeType,
        scope_target: scopeTarget,
        expires_at: expiresAt,
      },
    });
    return c.json(
      {
        success: true,
        message: 'Role granted to the group successfully',
        assignment: {
          group_id: groupId,
          role_id: role.id,
          role_name: role.name,
          scope_type: scopeType,
          scope_target: scopeTarget,
          expires_at: expiresAt,
        },
      },
      201
    );
  } catch (error) {
    return (
      knownGroupError(c, error) ??
      serverError(c, 'assign_group_role', error, 'Failed to grant the role to the group')
    );
  }
}

/** DELETE /api/admin/groups/:id/roles/:roleId?scope_type=&scope_target= */
export async function adminGroupRoleRemoveHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const groupId = c.req.param('id')!;
    const roleId = c.req.param('roleId')!;
    const scopeType = c.req.query('scope_type') ?? 'global';
    if (!(ROLE_SCOPE_TYPES as readonly string[]).includes(scopeType))
      return invalid(c, `scope_type must be one of: ${ROLE_SCOPE_TYPES.join(', ')}`);
    const scopeTarget = c.req.query('scope_target') ?? '';
    const metadata = (await tenantRBACStores(c, tenantId)).metadata;
    // Idempotent: a grant that is already gone answers 200 too, and the version is bumped either
    // way, so a retry after a failed bump completes the invalidation.
    if (!(await findGroup(metadata, tenantId, groupId))) return notFound(c);

    await adminRemoveGroupRole(
      metadata,
      tenantId,
      adminAuthOf(c),
      {
        groupId,
        roleId,
        scopeType: scopeType as (typeof ROLE_SCOPE_TYPES)[number],
        scopeTarget,
      },
      c.env.REBAC_CACHE
    );
    await recordAdminOperationAudit(c, {
      action: 'group.role_removed',
      resourceType: 'group',
      resourceId: groupId,
      metadata: { role_id: roleId, scope_type: scopeType, scope_target: scopeTarget },
    });
    return c.json({ success: true, message: 'Role removed from the group successfully' });
  } catch (error) {
    return (
      knownGroupError(c, error) ??
      serverError(c, 'remove_group_role', error, 'Failed to remove the role from the group')
    );
  }
}

// =============================================================================
// A user's groups
// =============================================================================

/** GET /api/admin/users/:id/groups */
export async function adminUserGroupsListHandler(c: GroupContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    const resolvedAccount = await subjectAccountOrRefusal(c, userId);
    if (resolvedAccount.inactive) return accountInactive(c);
    if (!resolvedAccount.found) return notFound(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, userId))) return notFound(c);

    const now = Math.floor(Date.now() / 1000);
    const dbs = rbacDatabasesFromContext(c, coreAdapter);
    const [memberships, resolved] = await Promise.all([
      coreAdapter.query<{
        group_id: string;
        subject_id: string;
        assignment_source: string;
        source_ref: string;
        lifecycle_state: string;
        starts_at: unknown;
        expires_at: unknown;
        stale_after: unknown;
        created_at: unknown;
      }>(
        `SELECT group_id, subject_id, assignment_source, source_ref, lifecycle_state, starts_at,
                expires_at, stale_after, created_at
           FROM group_memberships WHERE tenant_id = ? AND subject_id = ?
          ORDER BY created_at ASC, id ASC`,
        [tenantId, userId]
      ),
      resolveSubjectGroups(dbs, tenantId, userId, now),
    ]);
    const names = await loadGroupNames(dbs.metadata as DatabaseAdapter, tenantId, [
      ...memberships.map((row) => row.group_id),
      ...resolved.effectiveGroupIds,
    ]);
    return c.json({
      user_id: userId,
      memberships: memberships.map((row) => ({
        group_id: row.group_id,
        group_key: names.get(row.group_id)?.group_key ?? null,
        display_name: names.get(row.group_id)?.display_name ?? null,
        ...presentMembership(row, now),
      })),
      resolved: {
        direct_group_ids: [...resolved.directGroupIds],
        effective_groups: [...resolved.effectiveGroupIds].map((id) => ({
          id,
          group_key: names.get(id)?.group_key ?? null,
          display_name: names.get(id)?.display_name ?? null,
          direct: resolved.directGroupIds.has(id),
        })),
      },
    });
  } catch (error) {
    return (
      knownGroupError(c, error) ??
      serverError(c, 'list_user_groups', error, 'Failed to list the user groups')
    );
  }
}
