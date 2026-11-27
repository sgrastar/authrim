/**
 * Tenant RBAC across the tenant's two core databases
 *
 * Roles, groups and group role assignments are tenant settings, kept in the
 * tenant metadata database (`tenant_core/default`). A subject's assignments
 * and memberships (`role_assignments`, `group_memberships`) are account data, kept in the account's own
 * database (`tenant_core/users`, one of possibly several shards). The two may be different D1
 * databases, so no query joins them and no foreign key links them: assignments are read from the
 * account database, the definitions they name are read by id from the metadata database, and the
 * two are joined here. An assignment whose definition is missing (a role deleted since) grants
 * nothing.
 *
 * In a single-database deployment both are the same database.
 */

import { listGroupRoleAssignments } from './group-role-assignments';
import { resolveSubjectGroups, rbacIdBatches } from './group-membership';
import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';

export interface TenantRBACDatabases {
  /** Role and group definitions and group role assignments. */
  metadata: DatabaseSource;
  /** The subject's direct role assignments and group memberships. */
  account: DatabaseSource;
}

/** The databases of a deployment that keeps metadata and accounts in one database. */
export function singleDatabaseRBAC(db: DatabaseSource): TenantRBACDatabases {
  return { metadata: db, account: db };
}

export interface TenantRoleDefinition {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  permissions_json: string;
  role_type: string;
  grant_tier: number;
  /** 1/0 in SQLite and D1, true/false in PostgreSQL */
  is_assignable: number | boolean | null;
  is_system: number | boolean;
}

export interface SubjectRoleAssignmentRecord {
  id: string;
  role_id: string;
  scope_type: string;
  scope_target: string;
  expires_at: number | null;
  assigned_by: string | null;
  created_at: number;
}

export interface ResolvedSubjectRole {
  assignment: EffectiveRoleAssignment;
  role: TenantRoleDefinition;
}

const ROLE_COLUMNS = `id, name, display_name, description, permissions_json, role_type,
  grant_tier, is_assignable, is_system`;

async function loadByIds<T extends { id: string }>(
  db: DatabaseSource,
  table: 'roles',
  columns: string,
  tenantId: string,
  ids: Iterable<string>
): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  const adapter = ensureDatabaseAdapter(db, `tenant-rbac-${table}`);
  for (const batch of rbacIdBatches(ids)) {
    const rows = await adapter.query<T>(
      `SELECT ${columns} FROM ${table}
        WHERE tenant_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
      [tenantId, ...batch]
    );
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

/** The tenant's roles among `roleIds`, by id. Ids of another tenant's roles are not found. */
export function loadTenantRoles(
  metadata: DatabaseSource,
  tenantId: string,
  roleIds: Iterable<string>
): Promise<Map<string, TenantRoleDefinition>> {
  return loadByIds(metadata, 'roles', ROLE_COLUMNS, tenantId, roleIds);
}

/** One role of the tenant, or null. */
export async function findTenantRole(
  metadata: DatabaseSource,
  tenantId: string,
  role: { id: string } | { name: string }
): Promise<TenantRoleDefinition | null> {
  const adapter = ensureDatabaseAdapter(metadata, 'tenant-rbac-roles');
  return 'id' in role
    ? adapter.queryOne<TenantRoleDefinition>(
        `SELECT ${ROLE_COLUMNS} FROM roles WHERE tenant_id = ? AND id = ?`,
        [tenantId, role.id]
      )
    : adapter.queryOne<TenantRoleDefinition>(
        `SELECT ${ROLE_COLUMNS} FROM roles WHERE tenant_id = ? AND name = ?`,
        [tenantId, role.name]
      );
}

/** The subject's role assignments that have not expired at `nowSeconds`. */
export async function listSubjectRoleAssignments(
  account: DatabaseSource,
  tenantId: string,
  subjectId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<SubjectRoleAssignmentRecord[]> {
  return ensureDatabaseAdapter(
    account,
    'tenant-rbac-role-assignments'
  ).query<SubjectRoleAssignmentRecord>(
    `SELECT id, role_id, scope_type, scope_target, expires_at, assigned_by, created_at
       FROM role_assignments
      WHERE tenant_id = ? AND subject_id = ?
        AND (expires_at IS NULL OR expires_at > ?)`,
    [tenantId, subjectId, nowSeconds]
  );
}

export type EffectiveRoleAssignment = SubjectRoleAssignmentRecord & {
  /** groupId owns the assignment; throughGroupId is the subject's direct membership. */
  via: { kind: 'direct' } | { kind: 'group'; groupId: string; throughGroupId: string };
};

export async function resolveEffectiveRoleAssignments(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  nowSeconds: number
) {
  return (await resolveEffectiveAssignmentsAndGroups(dbs, tenantId, subjectId, nowSeconds))
    .assignments;
}

/** The subject's effective role assignments, and the effective groups they were read through. */
async function resolveEffectiveAssignmentsAndGroups(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  nowSeconds: number
): Promise<{
  assignments: EffectiveRoleAssignment[];
  effectiveGroupIds: Set<string>;
  unknownGroupIds: Set<string>;
  rolesComplete: boolean;
}> {
  const [direct, groups] = await Promise.all([
    listSubjectRoleAssignments(dbs.account, tenantId, subjectId, nowSeconds),
    resolveSubjectGroups(dbs, tenantId, subjectId, nowSeconds),
  ]);
  const effective: EffectiveRoleAssignment[] = direct.map((row) => ({
    ...row,
    via: { kind: 'direct' },
  }));
  const [assignments, unknownGrants] = await Promise.all([
    listGroupRoleAssignments(dbs.metadata, tenantId, groups.effectiveGroupIds, nowSeconds),
    // A role granted to a group whose membership is unknown (or one of its ancestors, which the
    // unknown set holds) may be the subject's: the roles are then not complete.
    groups.unknownGroupIds.size
      ? listGroupRoleAssignments(dbs.metadata, tenantId, groups.unknownGroupIds, nowSeconds)
      : Promise.resolve([]),
  ]);
  const byGroup = new Map<string, typeof assignments>();
  for (const row of assignments) {
    const rows = byGroup.get(row.group_id) ?? [];
    rows.push(row);
    byGroup.set(row.group_id, rows);
  }
  for (const [throughGroupId, path] of groups.paths) {
    for (const groupId of path) {
      for (const row of byGroup.get(groupId) ?? [])
        effective.push({ ...row, via: { kind: 'group', groupId, throughGroupId } });
    }
  }
  return {
    assignments: effective,
    effectiveGroupIds: groups.effectiveGroupIds,
    unknownGroupIds: groups.unknownGroupIds,
    rolesComplete: unknownGrants.length === 0,
  };
}

/**
 * The subject's unexpired role assignments with the roles they name, sorted by role name.
 * Assignments of a role the tenant no longer has are left out.
 */
export async function resolveSubjectRoles(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<ResolvedSubjectRole[]> {
  return (await resolveSubjectRolesAndGroups(dbs, tenantId, subjectId, nowSeconds)).roles;
}

/**
 * The subject's roles (as resolveSubjectRoles) and its effective groups (direct memberships and
 * their active ancestors), read together. `unknownGroupIds` are the groups whose membership is
 * not known (resolveSubjectGroups): neither in `effectiveGroupIds` nor known not to be. When one of
 * them carries a role grant, `rolesComplete` is false: `roles` then holds only the assignments that
 * are known (direct ones and those through known groups), so it may grant what they grant but
 * must not be read as the whole set (no "has no role X" decision, no attribute-based rule).
 */
export async function resolveSubjectRolesAndGroups(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{
  roles: ResolvedSubjectRole[];
  effectiveGroupIds: string[];
  unknownGroupIds: string[];
  rolesComplete: boolean;
}> {
  const { assignments, effectiveGroupIds, unknownGroupIds, rolesComplete } =
    await resolveEffectiveAssignmentsAndGroups(dbs, tenantId, subjectId, nowSeconds);
  const roles = await loadTenantRoles(
    dbs.metadata,
    tenantId,
    assignments.map((assignment) => assignment.role_id)
  );
  return {
    roles: assignments
      .flatMap((assignment) => {
        const role = roles.get(assignment.role_id);
        return role ? [{ assignment, role }] : [];
      })
      .sort((left, right) => compareText(left.role.name, right.role.name)),
    effectiveGroupIds: [...effectiveGroupIds],
    unknownGroupIds: [...unknownGroupIds],
    rolesComplete,
  };
}

/** What a check is about, for deciding which role assignments hold for it. */
export interface RoleAssignmentTarget {
  /** The tenant of the check; a tenant-scoped assignment holds in its own tenant only. */
  tenantId?: string;
  /** Groups the resource belongs to. */
  groupIds?: readonly string[] | ReadonlySet<string>;
  resourceType?: string;
  resourceId?: string;
}

/** The scopes a role assignment can have. */
export const ROLE_SCOPE_TYPES = ['global', 'tenant', 'group', 'resource'] as const;
export type RoleScopeType = (typeof ROLE_SCOPE_TYPES)[number];

export function isRoleScopeType(value: unknown): value is RoleScopeType {
  return typeof value === 'string' && (ROLE_SCOPE_TYPES as readonly string[]).includes(value);
}

/**
 * Why a role assignment's scope and target are not one a reader understands, or null when they
 * are: the targets `roleAssignmentHolds` reads. None for global; empty or the tenant id for tenant
 * (any non-empty id when `tenantId` is not given); `group:<id>` for group; `resource:<type>:<id>`
 * or `resource:<id>` for resource. Any other scope (the removed `org`) is refused. Shared by the
 * role assignment rules API, the JIT plan reader and the scoped role claim.
 */
export function roleScopeTargetError(
  scopeType: unknown,
  scopeTarget: unknown,
  tenantId?: string
): string | null {
  if (!isRoleScopeType(scopeType)) {
    return `scope_type must be one of: ${ROLE_SCOPE_TYPES.join(', ')}`;
  }
  if (scopeTarget !== null && scopeTarget !== undefined && typeof scopeTarget !== 'string') {
    return 'scope_target must be a string';
  }
  const target = scopeTarget ?? '';
  if (scopeType === 'global') {
    return target === '' ? null : 'scope_target must be empty for global scope';
  }
  if (scopeType === 'tenant') {
    return target === '' || (tenantId === undefined ? !/\s/.test(target) : target === tenantId)
      ? null
      : 'scope_target must be empty or the tenant id for tenant scope';
  }
  if (scopeType === 'group') {
    return /^group:[^\s:]+$/.test(target)
      ? null
      : 'scope_target must be group:<group id> for group scope';
  }
  return /^resource:[^\s:]+(?::[^\s:]+)?$/.test(target)
    ? null
    : 'scope_target must be resource:<type>:<id> or resource:<id> for resource scope';
}

/**
 * Whether a role assignment holds for a target: a global one always; a tenant one (as invitations
 * once wrote) in its own tenant (`scope_target` empty or the tenant id); a group one for a resource
 * of that group (`group:<id>`); a resource one for that resource (`resource:<type>:<id>` or
 * `resource:<id>`). One with another scope, or whose target is not known, does not.
 */
export function roleAssignmentHolds(
  assignment: { scope: string | null | undefined; scopeTarget?: string | null },
  target: RoleAssignmentTarget
): boolean {
  // An empty scope is not global: an unknown scope grants nothing.
  const scope = assignment.scope ?? 'global';
  const scopeTarget = assignment.scopeTarget ?? '';
  // A row whose scope or target is not one the readers know (the removed `org`, a global row
  // with a target, a group target without `group:`) never holds.
  if (roleScopeTargetError(scope, scopeTarget, target.tenantId)) return false;
  if (scope === 'global') return true;
  if (scope === 'tenant') {
    return scopeTarget === '' || (Boolean(target.tenantId) && scopeTarget === target.tenantId);
  }
  if (scope === 'group') {
    for (const id of target.groupIds ?? []) {
      if (id && scopeTarget === `group:${id}`) return true;
    }
    return false;
  }
  if (scope === 'resource') {
    const { resourceType, resourceId } = target;
    return (
      Boolean(resourceId) &&
      ((Boolean(resourceType) && scopeTarget === `resource:${resourceType}:${resourceId}`) ||
        scopeTarget === `resource:${resourceId}`)
    );
  }
  return false;
}

/** A flag column as read: 1/0 in SQLite and D1, true/false in PostgreSQL. */
export function isSet(flag: number | boolean | null | undefined): boolean {
  return flag === 1 || flag === true;
}

/** The permissions a role grants, from its permissions_json; empty when it is not a list. */
export function rolePermissions(role: Pick<TenantRoleDefinition, 'permissions_json'>): string[] {
  try {
    const parsed: unknown = JSON.parse(role.permissions_json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
