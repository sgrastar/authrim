/**
 * What an import may write that the Admin API would refuse its requester.
 *
 * A restore writes the bundle's rows as they are. Some rows grant more than a tenant's own
 * administrators may: settings only the platform may change for a tenant (see
 * `tenantEditRequiresPlatformAuthority`, for example the institution's scopes, which decide what
 * the SAML IdP may assert), Admin role assignments with a global scope (they make the person an
 * administrator of every tenant), and Admin roles named like a system role (Admin checks read the
 * name, so such a role is that role once assigned). The import request records what its requester could grant
 * when they asked (the intent's `authority`, part of its digest), and every such row of the bundle
 * is held to it twice: when the input is validated (before approval and before anything is
 * written) and again as the restore writes it. Only rows of the bundle are judged, never rows the
 * shared Admin database already holds for other tenants or for the platform.
 */
import {
  CATEGORY_SCOPE_CONFIG,
  categoryTenantEditRequiresPlatformAuthority,
  hasGlobalAdminPermission,
  type AdminAuthContext,
  type CategoryName,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  TENANT_BACKUP_NO_IMPORT_AUTHORITY,
  TenantBackupRequestStore,
  type TenantBackupImportAuthority,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED,
  type PortableSqliteRow,
  type SqliteDatasetInspectionPolicy,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { hasPlatformAuthorityForTenantEdit } from './routes/settings-v2/settings-authorization';
import { RESERVED_ROLE_NAMES } from './routes/admin-management/admin-role-authority';

export const TENANT_SETTINGS_DOCUMENTS_DATASET = 'admin.tenant_settings_documents';
export const ADMIN_ROLE_ASSIGNMENTS_DATASET = 'admin.admin_role_assignments';
export const ADMIN_ROLES_DATASET = 'admin.admin_roles';
const GUARD_ID = 'restore-authority-v1';

/** What `auth` may grant now, as the settings and Admin role routes judge it. */
export function tenantBackupImportAuthority(
  auth: AdminAuthContext,
  actorId: string
): TenantBackupImportAuthority {
  const platformSettingsCategories = (Object.keys(CATEGORY_SCOPE_CONFIG) as CategoryName[])
    .filter(
      (category) =>
        categoryTenantEditRequiresPlatformAuthority(category) &&
        hasPlatformAuthorityForTenantEdit(auth, category)
    )
    .sort();
  const permitted = hasGlobalAdminPermission(auth, '*');
  return {
    actorId,
    platformSettingsCategories,
    globalAdmin: { permitted, hierarchyLevel: permitted ? (auth.globalHierarchyLevel ?? 0) : 0 },
  };
}

/**
 * Whether a requester of `requesterLevel` may restore a global assignment of a role at
 * `roleLevel`: at or below their own global level.
 *
 * This differs from a new global assignment by the Admin API, which needs a level above the role
 * (`callerOutranksGlobally`), so that no one can give their own top level to someone else. With
 * that rule no one could restore a global super_admin, and a DR restore of the tenant the platform
 * administrators belong to would leave no one able to sign in to administer the platform. A
 * restore is meant to put back assignments that existed, not to make new ones; but a bundle is
 * not signed by Authrim (its key comes from a passphrase the requester holds, and the format is
 * public), so a requester can build a bundle of their own. The equal level is therefore the most
 * a restore gives that the API would not: a requester with the global wildcard can restore
 * assignments of their own level, never above it, and every such restore is audited as critical.
 */
export function outranksForRestore(requesterLevel: number, roleLevel: number): boolean {
  return roleLevel <= requesterLevel;
}

function refused(): never {
  throw new Error(TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED);
}

function text(row: PortableSqliteRow, column: string): string {
  const field = Object.hasOwn(row, column) ? row[column] : undefined;
  if (!Array.isArray(field) || field.length !== 2 || field[0] !== 'text') refused();
  if (typeof field[1] !== 'string') refused();
  return field[1];
}

function nullableText(row: PortableSqliteRow, column: string): string | null {
  const field = Object.hasOwn(row, column) ? row[column] : undefined;
  if (Array.isArray(field) && field.length === 2 && field[0] === 'null' && field[1] === null)
    return null;
  return text(row, column);
}

/**
 * A role's hierarchy level as the Admin repositories read it: a number (the role API accepts
 * fractions), and no level as 0.
 */
function storedLevel(value: unknown): number {
  const level = value === null || value === undefined ? 0 : Number(value);
  if (typeof value === 'string' || !Number.isFinite(level)) refused();
  return level;
}

function hierarchyLevel(row: PortableSqliteRow): number {
  const field = Object.hasOwn(row, 'hierarchy_level') ? row.hierarchy_level : undefined;
  if (Array.isArray(field) && field.length === 2 && field[0] === 'null' && field[1] === null)
    return 0;
  if (
    !Array.isArray(field) ||
    field.length !== 2 ||
    (field[0] !== 'integer' && field[0] !== 'real') ||
    typeof field[1] !== 'string' ||
    !/^-?[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)?$/i.test(field[1])
  )
    refused();
  return storedLevel(Number(field[1]));
}

function integer(row: PortableSqliteRow, column: string): number {
  const field = Object.hasOwn(row, column) ? row[column] : undefined;
  if (!Array.isArray(field) || field.length !== 2 || field[0] !== 'integer') refused();
  const value = Number(field[1]);
  if (typeof field[1] !== 'string' || !/^-?[0-9]{1,15}$/.test(field[1])) refused();
  return value;
}

interface BundleRole {
  name: string;
  level: number;
  parent: string | null;
  /** A system role: a platform-tenant row with is_system set. */
  system: boolean;
}

function bundleRole(row: PortableSqliteRow): BundleRole {
  return {
    name: text(row, 'name'),
    level: hierarchyLevel(row),
    parent: nullableText(row, 'inherits_from'),
    system: text(row, 'tenant_id') === 'default' && integer(row, 'is_system') === 1,
  };
}

function parse(rowJson: string): PortableSqliteRow {
  let row: unknown;
  try {
    row = JSON.parse(rowJson);
  } catch {
    return refused();
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) refused();
  return row as PortableSqliteRow;
}

export function createTenantBackupRestoreAuthorityGuard(input: {
  /** The management database: import requests, the Admin restore target and the audit log. */
  database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
  /**
   * The bundle's validated `admin.admin_roles` rows, for a restore (an empty list when the bundle
   * has none). Roles are judged by the bundle's own definitions, not by what the target already
   * holds: rows of one execution batch are transformed before any of them is written.
   */
  loadBundleRoles(context: TenantBackupStepContext): Promise<readonly string[]>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const requests = new TenantBackupRequestStore(input.database);
  let cache: { key: string; value: Promise<TenantBackupImportAuthority> } | undefined;
  let rolesCache: { key: string; value: Promise<Map<string, BundleRole>> } | undefined;
  let reachCache: { key: string; value: Promise<Set<string>> } | undefined;
  let storedRolesCache: { key: string; value: Map<string, Promise<BundleRole | null>> } | undefined;
  let systemCache:
    | { key: string; value: Promise<{ id: string; name: string; hierarchy_level: number }[]> }
    | undefined;

  const leaseKey = (context: TenantBackupStepContext) =>
    JSON.stringify([
      context.lease.tenantId,
      context.lease.operationId,
      context.lease.owner,
      context.lease.fencingToken,
    ]);

  function bundleRoles(context: TenantBackupStepContext): Promise<Map<string, BundleRole>> {
    const key = leaseKey(context);
    if (rolesCache?.key === key) return rolesCache.value;
    const value = input.loadBundleRoles(context).then((rows) => {
      const roles = new Map<string, BundleRole>();
      for (const rowJson of rows) {
        const row = parse(rowJson);
        const id = text(row, 'id');
        if (roles.has(id)) refused();
        roles.set(id, bundleRole(row));
      }
      return roles;
    });
    rolesCache = { key, value };
    return value;
  }

  /**
   * A role and what it inherits, read from the bundle (on restore) and then from the Admin
   * database: the assigned role's name, and the highest level in its chain. Null when the role
   * itself is unknown; an unknown parent ends the chain (it gives nothing).
   */
  async function roleChain(
    context: TenantBackupStepContext,
    roleId: string,
    bundle: Map<string, BundleRole> | null,
    start?: BundleRole
  ): Promise<{ name: string; level: number } | null> {
    const lookup = async (id: string): Promise<BundleRole | null> => {
      const fromBundle = bundle?.get(id);
      if (fromBundle) return fromBundle;
      return storedRole(context, id);
    };
    const first = start ?? (await lookup(roleId));
    if (!first) return null;
    let level = first.level;
    let parent = first.parent;
    const seen = new Set([roleId]);
    while (parent && !seen.has(parent)) {
      // A chain longer than any the role API builds is not judged by a part of it.
      if (seen.size > 64) refused();
      seen.add(parent);
      const next = await lookup(parent);
      if (!next) break;
      level = Math.max(level, next.level);
      parent = next.parent;
    }
    return { name: first.name, level };
  }

  /**
   * The role ids that the tenant's global assignments and pending global invitations lead to: the
   * granted roles and every parent they name, directly or through others (a parent that no longer
   * exists included). Read once per operation slice (the role API's `roleReachesGlobalAssignment`,
   * for every role at once). A role written later in the restore that fills such a parent is in
   * the set, and is judged with its own whole chain.
   */
  function reachedByGlobalGrants(context: TenantBackupStepContext): Promise<Set<string>> {
    const key = leaseKey(context);
    if (reachCache?.key === key) return reachCache.value;
    const tenantId = context.lease.tenantId;
    const value = Promise.all([
      input.database.query<{ admin_role_id: string }>(
        `SELECT DISTINCT admin_role_id FROM admin_role_assignments
          WHERE tenant_id=? AND scope_type='global'`,
        [tenantId]
      ),
      input.database.query<{ admin_role_id: string }>(
        `SELECT DISTINCT admin_role_id FROM admin_invitations
          WHERE tenant_id=? AND scope_type='global' AND status='pending'`,
        [tenantId]
      ),
    ]).then(async ([assignments, invitations]) => {
      const reached = new Set([...assignments, ...invitations].map((row) => row.admin_role_id));
      if (!reached.size) return reached;
      const roles = await input.database.query<{ id: string; inherits_from: string | null }>(
        `SELECT id,inherits_from FROM admin_roles
          WHERE tenant_id=? OR (tenant_id='default' AND is_system=1)`,
        [tenantId]
      );
      const parents = new Map(roles.map((role) => [role.id, role.inherits_from]));
      const pending = [...reached];
      for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
        const parent = parents.get(id);
        if (parent && !reached.has(parent)) {
          reached.add(parent);
          pending.push(parent);
        }
      }
      return reached;
    });
    reachCache = { key, value };
    return value;
  }

  /**
   * A role stored in the Admin database for this tenant (or a system role), read once per
   * operation slice: a role the bundle defines is taken from the bundle instead.
   */
  function storedRole(context: TenantBackupStepContext, id: string): Promise<BundleRole | null> {
    const key = leaseKey(context);
    if (storedRolesCache?.key !== key) storedRolesCache = { key, value: new Map() };
    const known = storedRolesCache.value.get(id);
    if (known) return known;
    const value = input.database
      .queryOne<{ name: string; hierarchy_level: unknown; inherits_from: string | null }>(
        `SELECT name,hierarchy_level,inherits_from FROM admin_roles
          WHERE id=? AND (tenant_id=? OR (tenant_id='default' AND is_system=1))`,
        [id, context.lease.tenantId]
      )
      .then((stored) =>
        stored
          ? {
              name: stored.name,
              level: storedLevel(stored.hierarchy_level),
              parent: stored.inherits_from,
              system: false,
            }
          : null
      );
    storedRolesCache.value.set(id, value);
    return value;
  }

  /** The database's system roles (the platform tenant's), read once per operation slice. */
  function storedSystemRoles(
    context: TenantBackupStepContext
  ): Promise<{ id: string; name: string; hierarchy_level: number }[]> {
    const key = leaseKey(context);
    if (systemCache?.key === key) return systemCache.value;
    const value = input.database
      .query<{
        id: string;
        name: string;
        hierarchy_level: unknown;
      }>(
        `SELECT id,name,hierarchy_level FROM admin_roles WHERE tenant_id='default' AND is_system=1`
      )
      .then((rows) =>
        rows.map((role) => ({ ...role, hierarchy_level: storedLevel(role.hierarchy_level) }))
      );
    systemCache = { key, value };
    return value;
  }

  function authority(context: TenantBackupStepContext): Promise<TenantBackupImportAuthority> {
    const key = leaseKey(context);
    if (cache?.key === key) return cache.value;
    const value = requests
      .load(context.lease.tenantId, context.lease.operationId)
      .then((intent) => {
        if (intent.kind !== 'import') refused();
        return intent.authority ?? TENANT_BACKUP_NO_IMPORT_AUTHORITY;
      });
    cache = { key, value };
    return value;
  }

  async function admitSettings(context: TenantBackupStepContext, rowJson: string) {
    const category = text(parse(rowJson), 'category');
    if (!categoryTenantEditRequiresPlatformAuthority(category as CategoryName)) return;
    if (!(await authority(context)).platformSettingsCategories.includes(category)) refused();
  }

  /**
   * A tenant-scoped assignment is a tenant's own; any other scope reaches every tenant, with what
   * the role holds and inherits. Validation checks the permission; the restore (still a phase that
   * cleanup can undo) also the highest level in the role's chain, from the bundle's own roles, and
   * audits it. The same rows give the same answer when the restore verifies them later.
   */
  async function admitAssignment(
    context: TenantBackupStepContext,
    rowJson: string,
    restore: { mode: 'write' | 'defer' | 'verify'; sourceRowJson: string } | null
  ) {
    const row = parse(rowJson);
    if (text(row, 'scope_type') === 'tenant') return;
    const requester = await authority(context);
    if (!requester.globalAdmin.permitted) refused();
    if (!restore) return;
    const roleId = text(row, 'admin_role_id');
    const role = await roleChain(context, roleId, await bundleRoles(context));
    if (!role || !outranksForRestore(requester.globalAdmin.hierarchyLevel, role.level)) refused();
    // Audited before the row is written (a retried write records it once): who asked for the
    // import, and the assignment as the restore writes it.
    if (restore.mode === 'write')
      await auditGlobalAssignment(context, requester, {
        assignmentId: text(row, 'id'),
        adminUserId: text(row, 'admin_user_id'),
        sourceAdminUserId: text(parse(restore.sourceRowJson), 'admin_user_id'),
        roleId,
        roleName: role.name,
        roleLevel: role.level,
        scopeType: text(row, 'scope_type'),
        scopeId: nullableText(row, 'scope_id'),
      });
  }

  async function auditGlobalAssignment(
    context: TenantBackupStepContext,
    requester: TenantBackupImportAuthority,
    assignment: Record<string, string | number | null> & { assignmentId: string }
  ) {
    const id = `tenant-backup-global-grant:${context.lease.operationId}:${assignment.assignmentId}`;
    const expected = {
      tenant_id: context.lease.tenantId,
      admin_user_id: requester.actorId || null,
      action: 'tenant_backup.global_admin_assignment_restored',
      resource_type: 'admin_role_assignment',
      resource_id: assignment.assignmentId,
      result: 'success',
      severity: 'critical',
      metadata_json: JSON.stringify({
        operationId: context.lease.operationId,
        requesterLevel: requester.globalAdmin.hierarchyLevel,
        ...assignment,
      }),
    };
    // One statement: a new entry, or a retried write's own entry (every field the same). Any
    // other row under the id (a restored audit row, for one) returns nothing, and the assignment
    // is not written without its record.
    const columns = Object.keys(expected);
    const stored = await input.database.queryOne<{ id: string }>(
      `INSERT INTO admin_audit_log (id,${columns.join(',')},created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET id=excluded.id
         WHERE ${columns.map((column) => `admin_audit_log.${column} IS excluded.${column}`).join(' AND ')}
       RETURNING id`,
      [
        id,
        expected.tenant_id,
        expected.admin_user_id,
        expected.action,
        expected.resource_type,
        expected.resource_id,
        expected.result,
        expected.severity,
        expected.metadata_json,
        now(),
      ]
    );
    if (stored?.id !== id) throw new Error('backup_restore_authority_audit_failed');
  }

  /**
   * Admin checks read role names, so a role named like a system role (or one of the reserved
   * administrator names) is that role wherever it is assigned, whatever level and permissions it
   * says it has. The role API never lets a custom role take such a name; a bundle's role may keep
   * it only for a requester who could restore a global assignment of that system role (for a
   * reserved name with no system role, of the highest one).
   */
  async function admitRole(context: TenantBackupStepContext, rowJson: string, restore: Restore) {
    const row = parse(rowJson);
    // System roles belong to the platform tenant, so only its restore brings any; the catalog of a
    // restore is then pinned to the bundle's (the restore writes them as it goes).
    await admitRoleName(
      context,
      row,
      restore && context.lease.tenantId === 'default' ? await bundleRoles(context) : null
    );
    // Reach is judged against assignments that were there before the restore: at validation, and
    // as the role is written (the bundle's own assignments come after their roles, and each is
    // judged with the role's whole chain). Final verification, when they exist, does not ask again.
    if (!restore) await admitRoleReach(context, row, null);
    else if (restore.mode === 'write') await admitRoleReach(context, row, 'bundle');
  }

  /**
   * A role that a global assignment (or pending global invitation) already in the Admin database
   * leads to, directly or through inheritance, gives every tenant what it holds and inherits: for
   * example a role filling a parent another tenant role names but no longer has. Such a role takes
   * the authority of a global assignment of the highest role in its own chain.
   */
  async function admitRoleReach(
    context: TenantBackupStepContext,
    row: PortableSqliteRow,
    bundle: 'bundle' | null
  ) {
    const roleId = text(row, 'id');
    if (!(await reachedByGlobalGrants(context)).has(roleId)) return;
    const chain = await roleChain(
      context,
      roleId,
      bundle ? await bundleRoles(context) : null,
      bundleRole(row)
    );
    const { globalAdmin } = await authority(context);
    if (
      !chain ||
      !globalAdmin.permitted ||
      !outranksForRestore(globalAdmin.hierarchyLevel, chain.level)
    )
      refused();
  }

  /**
   * The level a role row takes: as a system role itself (a platform-tenant row with is_system), as
   * one named like a system role, or as one with a reserved name (the highest system level). Null
   * for an ordinary role. The system roles are the database's, except that on a platform-tenant
   * restore the bundle's replace them, so the answer does not change as the restore writes them;
   * the row itself never counts as one of the others.
   */
  async function systemLevel(
    context: TenantBackupStepContext,
    row: PortableSqliteRow,
    bundle: Map<string, BundleRole> | null
  ): Promise<number | null> {
    const id = text(row, 'id');
    const own = bundleRole(row);
    const stored = await storedSystemRoles(context);
    const catalog = [
      ...stored.filter((role) => !bundle?.has(role.id)),
      ...[...(bundle ?? new Map<string, BundleRole>())]
        .filter(([, role]) => role.system)
        .map(([roleId, role]) => ({ id: roleId, name: role.name, hierarchy_level: role.level })),
    ].filter((role) => role.id !== id);
    const levels = [
      ...(own.system ? [own.level] : []),
      ...catalog.filter((role) => role.name === own.name).map((role) => role.hierarchy_level),
    ];
    if (RESERVED_ROLE_NAMES.has(own.name)) {
      // A reserved name with no system role at all is refused outright.
      if (!catalog.length && !own.system) refused();
      levels.push(...catalog.map((role) => role.hierarchy_level));
    }
    return levels.length ? Math.max(...levels) : null;
  }

  async function admitRoleName(
    context: TenantBackupStepContext,
    row: PortableSqliteRow,
    bundle: Map<string, BundleRole> | null
  ) {
    const level = await systemLevel(context, row, bundle);
    // Not a system role or name: an ordinary role, assigned like any other.
    if (level === null) return;
    const { globalAdmin } = await authority(context);
    if (!globalAdmin.permitted || !outranksForRestore(globalAdmin.hierarchyLevel, level)) refused();
  }

  type Restore = { mode: 'write' | 'defer' | 'verify'; sourceRowJson: string } | null;
  const guards: Record<
    string,
    (context: TenantBackupStepContext, rowJson: string, restore: Restore) => Promise<void>
  > = {
    [TENANT_SETTINGS_DOCUMENTS_DATASET]: (context, rowJson) => admitSettings(context, rowJson),
    [ADMIN_ROLE_ASSIGNMENTS_DATASET]: (context, rowJson, restore) =>
      admitAssignment(context, rowJson, restore),
    [ADMIN_ROLES_DATASET]: (context, rowJson, restore) => admitRole(context, rowJson, restore),
  };

  /** Hold the guarded datasets' rows to the request's authority, on validation and restore. */
  function wrap(
    policies: readonly SqliteDatasetInspectionPolicy[]
  ): SqliteDatasetInspectionPolicy[] {
    return policies.map((policy) => {
      const guard = Object.hasOwn(guards, policy.dataset.id)
        ? guards[policy.dataset.id]
        : undefined;
      if (!guard) return policy;
      if (policy.admitRow) throw new Error('backup_restore_authority_guard_conflict');
      const base = policy.restoreTransform;
      return {
        ...policy,
        admitRow: {
          id: `${GUARD_ID}:${policy.dataset.id}`,
          admit: (context, rowJson) => guard(context, rowJson, null),
        },
        restoreTransform: {
          // Transform ids take [a-z0-9_.:-] only (the policy inspector refuses anything else).
          id: base ? `${base.id}.${GUARD_ID}` : `${GUARD_ID}:${policy.dataset.id}`,
          async transform(context, rowJson, mode) {
            const transformed = base ? await base.transform(context, rowJson, mode) : rowJson;
            await guard(context, transformed, { mode, sourceRowJson: rowJson });
            return transformed;
          },
        },
      };
    });
  }

  return { wrap, authority };
}
