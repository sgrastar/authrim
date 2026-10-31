/**
 * Tenant RBAC across the tenant's two core databases
 *
 * Role and organisation definitions (`roles`, `organizations`) are tenant settings, kept in the
 * tenant metadata database (`tenant_core/default`). A subject's assignments
 * (`role_assignments`, `subject_org_membership`) are account data, kept in the account's own
 * database (`tenant_core/users`, one of possibly several shards). The two may be different D1
 * databases, so no query joins them and no foreign key links them: assignments are read from the
 * account database, the definitions they name are read by id from the metadata database, and the
 * two are joined here. An assignment whose definition is missing (a role deleted since) grants
 * nothing.
 *
 * In a single-database deployment both are the same database.
 */

import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';

export interface TenantRBACDatabases {
  /** The tenant metadata database: role and organisation definitions. */
  metadata: DatabaseSource;
  /** The subject's account database: its role assignments and organisation memberships. */
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
  hierarchy_level: number | null;
  /** 1/0 in SQLite and D1, true/false in PostgreSQL */
  is_assignable: number | boolean | null;
  is_system: number | boolean;
  parent_role_id: string | null;
}

export interface TenantOrganizationDefinition {
  id: string;
  name: string;
  display_name: string | null;
  org_type: string;
  plan: string | null;
  parent_org_id: string | null;
  is_active: number | boolean | null;
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

export interface SubjectOrgMembershipRecord {
  id: string;
  org_id: string;
  membership_type: string;
  is_primary: number | boolean | null;
  created_at: number;
}

export interface ResolvedSubjectRole {
  assignment: SubjectRoleAssignmentRecord;
  role: TenantRoleDefinition;
}

export interface ResolvedSubjectOrganization {
  membership: SubjectOrgMembershipRecord;
  organization: TenantOrganizationDefinition;
}

// D1 binds at most 100 parameters per statement; the tenant id takes one.
const ID_BATCH_SIZE = 90;

const ROLE_COLUMNS = `id, name, display_name, description, permissions_json, role_type,
  hierarchy_level, is_assignable, is_system, parent_role_id`;
const ORGANIZATION_COLUMNS = 'id, name, display_name, org_type, plan, parent_org_id, is_active';

async function loadByIds<T extends { id: string }>(
  db: DatabaseSource,
  table: 'roles' | 'organizations',
  columns: string,
  tenantId: string,
  ids: Iterable<string>
): Promise<Map<string, T>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, T>();
  if (unique.length === 0) return found;
  const adapter = ensureDatabaseAdapter(db, `tenant-rbac-${table}`);
  for (let offset = 0; offset < unique.length; offset += ID_BATCH_SIZE) {
    const batch = unique.slice(offset, offset + ID_BATCH_SIZE);
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

/** The tenant's organisations among `orgIds`, by id, active or not. */
export function loadTenantOrganizations(
  metadata: DatabaseSource,
  tenantId: string,
  orgIds: Iterable<string>
): Promise<Map<string, TenantOrganizationDefinition>> {
  return loadByIds(metadata, 'organizations', ORGANIZATION_COLUMNS, tenantId, orgIds);
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

/** One organisation of the tenant, active or not, or null. */
export async function findTenantOrganization(
  metadata: DatabaseSource,
  tenantId: string,
  orgId: string
): Promise<TenantOrganizationDefinition | null> {
  return (await loadTenantOrganizations(metadata, tenantId, [orgId])).get(orgId) ?? null;
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

/** The subject's organisation memberships. */
export async function listSubjectOrgMemberships(
  account: DatabaseSource,
  tenantId: string,
  subjectId: string
): Promise<SubjectOrgMembershipRecord[]> {
  return ensureDatabaseAdapter(
    account,
    'tenant-rbac-org-membership'
  ).query<SubjectOrgMembershipRecord>(
    `SELECT id, org_id, membership_type, is_primary, created_at
       FROM subject_org_membership
      WHERE tenant_id = ? AND subject_id = ?`,
    [tenantId, subjectId]
  );
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
  const assignments = await listSubjectRoleAssignments(
    dbs.account,
    tenantId,
    subjectId,
    nowSeconds
  );
  const roles = await loadTenantRoles(
    dbs.metadata,
    tenantId,
    assignments.map((assignment) => assignment.role_id)
  );
  return assignments
    .flatMap((assignment) => {
      const role = roles.get(assignment.role_id);
      return role ? [{ assignment, role }] : [];
    })
    .sort((left, right) => compareText(left.role.name, right.role.name));
}

/**
 * The subject's memberships of organisations the tenant has, primary first, then by organisation
 * name. With `activeOnly`, memberships of deactivated organisations are left out too.
 */
export async function resolveSubjectOrganizations(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  options: { activeOnly?: boolean } = {}
): Promise<ResolvedSubjectOrganization[]> {
  const memberships = await listSubjectOrgMemberships(dbs.account, tenantId, subjectId);
  const organizations = await loadTenantOrganizations(
    dbs.metadata,
    tenantId,
    memberships.map((membership) => membership.org_id)
  );
  return memberships
    .flatMap((membership) => {
      const organization = organizations.get(membership.org_id);
      if (!organization) return [];
      if (options.activeOnly && !isSet(organization.is_active)) return [];
      return [{ membership, organization }];
    })
    .sort(
      (left, right) =>
        Number(isSet(right.membership.is_primary)) - Number(isSet(left.membership.is_primary)) ||
        compareText(left.organization.name, right.organization.name) ||
        compareText(left.organization.id, right.organization.id)
    );
}

/** What a check is about, for deciding which role assignments hold for it. */
export interface RoleAssignmentTarget {
  /** The tenant of the check; a tenant-scoped assignment holds in its own tenant only. */
  tenantId?: string;
  /** The organisation the resource belongs to, when known. */
  orgId?: string;
  resourceType?: string;
  resourceId?: string;
}

/**
 * Whether a role assignment holds for a target: a global one always; a tenant one (as invitations
 * once wrote) in its own tenant (`scope_target` empty or the tenant id); an organisation one for a resource of that
 * organisation (`org:<id>`); a resource one for that resource (`resource:<type>:<id>` or
 * `resource:<id>`). One with another scope, or whose target is not known, does not.
 */
export function roleAssignmentHolds(
  assignment: { scope: string | null | undefined; scopeTarget?: string | null },
  target: RoleAssignmentTarget
): boolean {
  // An empty scope is not global: an unknown scope grants nothing.
  const scope = assignment.scope ?? 'global';
  const scopeTarget = assignment.scopeTarget ?? '';
  if (scope === 'global') return true;
  if (scope === 'tenant') {
    return scopeTarget === '' || (Boolean(target.tenantId) && scopeTarget === target.tenantId);
  }
  if (scope === 'org') return Boolean(target.orgId) && scopeTarget === `org:${target.orgId}`;
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
