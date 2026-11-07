/**
 * Admin groups: a tenant's administrators gathered under one name, and the roles given to the
 * group, which every member holds while both the membership and the grant exist.
 *
 * Nothing is copied into `admin_role_assignments`. What an administrator holds is read from the
 * view `admin_effective_role_assignments` (their own assignments and their groups', side by side),
 * so a removed member, grant or group takes the roles away at the next read.
 *
 * A group's `revision` goes up whenever its grants change. Adding a member, and adding a grant,
 * carry the revision the caller was judged against in the statement itself, so a role granted
 * meanwhile is never handed to a member the caller could not have given it to.
 */

import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';
import { guardClause, type AdminWriteGuard } from './write-guard';

/** The view that holds every assignment an administrator has, own and through groups. */
export const ADMIN_EFFECTIVE_ROLE_ASSIGNMENTS = 'admin_effective_role_assignments' as const;

export interface AdminGroup {
  id: string;
  tenant_id: string;
  group_key: string;
  display_name: string;
  description: string | null;
  revision: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminGroupSummary extends AdminGroup {
  member_count: number;
  grant_count: number;
}

export interface AdminGroupMember {
  id: string;
  tenant_id: string;
  admin_group_id: string;
  admin_user_id: string;
  added_by: string | null;
  created_at: number;
  email: string | null;
  name: string | null;
  status: string | null;
  is_active: boolean;
}

export interface AdminGroupRoleGrant {
  id: string;
  tenant_id: string;
  admin_group_id: string;
  admin_role_id: string;
  scope_type: 'tenant';
  scope_id: string;
  expires_at: number | null;
  assigned_by: string | null;
  created_at: number;
  updated_at: number;
  role_name: string;
  role_display_name: string | null;
  hierarchy_level: number;
}

/** A group's grants as one statement read them, with the revision they belong to. */
export interface AdminGroupGrantSnapshot {
  revision: number;
  grants: Array<{
    id: string;
    admin_role_id: string;
    role_name: string;
    hierarchy_level: number;
    expires_at: number | null;
  }>;
}

export type AdminGroupAddResult = 'added' | 'exists' | 'changed';

function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/iu.test(error instanceof Error ? error.message : String(error));
}

function toGroup(row: Record<string, unknown>): AdminGroup {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    group_key: row.group_key as string,
    display_name: row.display_name as string,
    description: (row.description as string | null) ?? null,
    revision: Number(row.revision ?? 1),
    created_by: (row.created_by as string | null) ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function toGrant(row: Record<string, unknown>): AdminGroupRoleGrant {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    admin_group_id: row.admin_group_id as string,
    admin_role_id: row.admin_role_id as string,
    scope_type: 'tenant',
    scope_id: row.scope_id as string,
    expires_at:
      row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    assigned_by: (row.assigned_by as string | null) ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    role_name: row.role_name as string,
    role_display_name: (row.role_display_name as string | null) ?? null,
    hierarchy_level: Number(row.hierarchy_level ?? 0),
  };
}

/**
 * Raises a group's revision when the statement just before it in the same batch changed a row:
 * its grants changed. `changes()` is that statement's row count (statements of a batch run in
 * order on one connection), so a refused or superseded change leaves the revision, and the
 * invitations and checks bound to it, as it was.
 */
function bumpRevisionIfChanged(tenantId: string, groupId: string, now: number): PreparedStatement {
  return {
    sql: `UPDATE admin_groups SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND changes() > 0`,
    params: [now, groupId, tenantId],
  };
}

/**
 * On an invitation's enrolment, the statement that adds the new admin to the groups the invitation
 * names, each only while its grants are still the version the inviter was judged against (a group
 * changed since, or gone, is left out). For the enrolment batch, after the admin's row is written
 * and while the invitation is still pending.
 */
export function adminInvitationGroupJoin(invitationId: string, now: number): PreparedStatement {
  return {
    sql: `INSERT INTO admin_group_members (
            id, tenant_id, admin_group_id, member_type, admin_user_id, added_by, created_at
          )
          SELECT 'invitation:' || ig.id, ig.tenant_id, ig.admin_group_id, 'admin_user',
                 i.admin_user_id, i.created_by, ?
            FROM admin_invitation_groups ig
            JOIN admin_invitations i
              ON i.id = ig.invitation_id AND i.tenant_id = ig.tenant_id
            JOIN admin_groups grp
              ON grp.id = ig.admin_group_id AND grp.tenant_id = ig.tenant_id
             AND grp.revision = ig.group_revision
           WHERE ig.invitation_id = ? AND i.status = 'pending'`,
    params: [now, invitationId],
  };
}

/**
 * For the enrolment batch, before `adminInvitationGroupJoin`: fails the whole batch (a NOT NULL
 * violation, so D1 rolls it back) when one of `expectedJoined` no longer has the version the
 * invitation was judged against, or is gone. The enrolment's audit says which groups are joined;
 * this keeps it true when a group changes between that read and the write (the enrolment is then
 * refused and can be retried). Null when no group is expected to be joined.
 */
export function adminInvitationGroupJoinCheck(
  invitationId: string,
  expectedJoined: readonly string[]
): PreparedStatement | null {
  if (expectedJoined.length === 0) return null;
  return {
    sql: `INSERT INTO admin_group_members (
            id, tenant_id, admin_group_id, member_type, admin_user_id, added_by, created_at
          )
          SELECT 'invitation-conflict:' || ig.id, ig.tenant_id, ig.admin_group_id, 'admin_user',
                 NULL, NULL, 0
            FROM admin_invitation_groups ig
            LEFT JOIN admin_groups grp
              ON grp.id = ig.admin_group_id AND grp.tenant_id = ig.tenant_id
           WHERE ig.invitation_id = ?
             AND ig.admin_group_id IN (${expectedJoined.map(() => '?').join(', ')})
             AND (grp.id IS NULL OR grp.revision <> ig.group_revision)`,
    params: [invitationId, ...expectedJoined],
  };
}

export class AdminGroupRepository {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly tenantId: string
  ) {}

  async list(): Promise<AdminGroupSummary[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT grp.*,
              (SELECT COUNT(*) FROM admin_group_members m
                WHERE m.admin_group_id = grp.id AND m.tenant_id = grp.tenant_id) AS member_count,
              (SELECT COUNT(*) FROM admin_group_role_grants g
                WHERE g.admin_group_id = grp.id AND g.tenant_id = grp.tenant_id) AS grant_count
         FROM admin_groups grp
        WHERE grp.tenant_id = ?
        ORDER BY grp.display_name, grp.group_key`,
      [this.tenantId]
    );
    return rows.map((row) => ({
      ...toGroup(row),
      member_count: Number(row.member_count ?? 0),
      grant_count: Number(row.grant_count ?? 0),
    }));
  }

  async get(groupId: string): Promise<AdminGroup | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_groups WHERE id = ? AND tenant_id = ?',
      [groupId, this.tenantId]
    );
    return row ? toGroup(row) : null;
  }

  /** Creates a group; null when the tenant already has one with this key. */
  async create(input: {
    groupKey: string;
    displayName: string;
    description?: string | null;
    createdBy: string | null;
  }): Promise<AdminGroup | null> {
    const now = getCurrentTimestamp();
    const group: AdminGroup = {
      id: generateId(),
      tenant_id: this.tenantId,
      group_key: input.groupKey,
      display_name: input.displayName,
      description: input.description ?? null,
      revision: 1,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    };
    try {
      await this.adapter.execute(
        `INSERT INTO admin_groups
           (id, tenant_id, group_key, display_name, description, revision, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [
          group.id,
          group.tenant_id,
          group.group_key,
          group.display_name,
          group.description,
          group.created_by,
          now,
          now,
        ]
      );
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    return group;
  }

  /** Renames or re-describes a group (its key stays); null when there is no such group. */
  async update(
    groupId: string,
    input: { displayName?: string; description?: string | null }
  ): Promise<AdminGroup | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(input.displayName);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(input.description);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(getCurrentTimestamp());
      await this.adapter.execute(
        `UPDATE admin_groups SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...params, groupId, this.tenantId]
      );
    }
    return this.get(groupId);
  }

  /**
   * Removes a group with its members and grants, while its grants are still the ones of
   * `expectedRevision`. False when there is no such group, its grants changed, or `guard` no
   * longer holds when the statement runs.
   */
  async delete(
    groupId: string,
    expectedRevision: number,
    guard?: AdminWriteGuard
  ): Promise<boolean> {
    const condition = guardClause(guard);
    // Only the grants the caller was judged against: a role granted meanwhile is not taken
    // away by someone who could not have removed it.
    const result = await this.adapter.execute(
      `DELETE FROM admin_groups WHERE id = ? AND tenant_id = ? AND revision = ?${condition.sql}`,
      [groupId, this.tenantId, expectedRevision, ...condition.params]
    );
    return result.rowsAffected > 0;
  }

  async listMembers(groupId: string): Promise<AdminGroupMember[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT m.*, au.email AS email, au.name AS name, au.status AS status,
              au.is_active AS is_active
         FROM admin_group_members m
         LEFT JOIN admin_users au ON au.id = m.admin_user_id AND au.tenant_id = m.tenant_id
        WHERE m.admin_group_id = ? AND m.tenant_id = ?
        ORDER BY au.email, m.created_at`,
      [groupId, this.tenantId]
    );
    return rows.map((row) => ({
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      admin_group_id: row.admin_group_id as string,
      admin_user_id: row.admin_user_id as string,
      added_by: (row.added_by as string | null) ?? null,
      created_at: Number(row.created_at),
      email: (row.email as string | null) ?? null,
      name: (row.name as string | null) ?? null,
      status: (row.status as string | null) ?? null,
      is_active: Number(row.is_active ?? 0) === 1,
    }));
  }

  async getMembership(groupId: string, adminUserId: string): Promise<{ id: string } | null> {
    return this.adapter.queryOne<{ id: string }>(
      `SELECT id FROM admin_group_members
        WHERE admin_group_id = ? AND admin_user_id = ? AND tenant_id = ?`,
      [groupId, adminUserId, this.tenantId]
    );
  }

  /**
   * The group's grants with the revision they belong to, read in one statement so the two
   * agree. Null when there is no such group.
   */
  async grantSnapshot(groupId: string): Promise<AdminGroupGrantSnapshot | null> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT grp.revision AS revision, g.id AS id, g.admin_role_id AS admin_role_id,
              r.name AS role_name, r.hierarchy_level AS hierarchy_level, g.expires_at AS expires_at
         FROM admin_groups grp
         LEFT JOIN admin_group_role_grants g
           ON g.admin_group_id = grp.id AND g.tenant_id = grp.tenant_id
         LEFT JOIN admin_roles r ON r.id = g.admin_role_id
        WHERE grp.id = ? AND grp.tenant_id = ?`,
      [groupId, this.tenantId]
    );
    if (rows.length === 0) return null;
    return {
      revision: Number(rows[0].revision),
      grants: rows
        .filter((row) => row.id !== null && row.id !== undefined)
        .map((row) => ({
          id: row.id as string,
          admin_role_id: row.admin_role_id as string,
          role_name: (row.role_name as string | null) ?? '',
          // A grant whose role cannot be read is taken as the highest, so no one outranks it.
          hierarchy_level:
            row.hierarchy_level === null || row.hierarchy_level === undefined
              ? Number.MAX_SAFE_INTEGER
              : Number(row.hierarchy_level),
          expires_at:
            row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
        })),
    };
  }

  /**
   * Adds the tenant's administrator to the group, if the group's grants are still the ones of
   * `expectedRevision`. 'changed' when they are not (or the group or administrator is gone),
   * 'exists' when already a member.
   */
  async addMember(input: {
    groupId: string;
    adminUserId: string;
    addedBy: string | null;
    expectedRevision: number;
  }): Promise<AdminGroupAddResult> {
    try {
      const statement = this.memberInsert(input);
      const result = await this.adapter.execute(statement.sql, statement.params);
      return result.rowsAffected > 0 ? 'added' : 'changed';
    } catch (error) {
      if (isUniqueViolation(error)) return 'exists';
      throw error;
    }
  }

  /** The guarded INSERT of `addMember`, for callers that put it in a batch of their own. */
  memberInsert(input: {
    groupId: string;
    adminUserId: string;
    addedBy: string | null;
    expectedRevision: number;
    id?: string;
  }): PreparedStatement {
    return {
      sql: `INSERT INTO admin_group_members
              (id, tenant_id, admin_group_id, member_type, admin_user_id, added_by, created_at)
            SELECT ?, grp.tenant_id, grp.id, 'admin_user', au.id, ?, ?
              FROM admin_groups grp
              JOIN admin_users au ON au.id = ? AND au.tenant_id = grp.tenant_id
             WHERE grp.id = ? AND grp.tenant_id = ? AND grp.revision = ?`,
      params: [
        input.id ?? generateId(),
        input.addedBy,
        getCurrentTimestamp(),
        input.adminUserId,
        input.groupId,
        this.tenantId,
        input.expectedRevision,
      ],
    };
  }

  /**
   * Ends one membership (the one that was checked, not a later one of the same administrator),
   * while the group's grants are still the ones of `expectedRevision`. False when it is gone,
   * the grants changed, or `guard` fails.
   */
  async removeMember(
    groupId: string,
    membershipId: string,
    expectedRevision: number,
    guard?: AdminWriteGuard
  ): Promise<boolean> {
    const condition = guardClause(guard);
    const result = await this.adapter.execute(
      `DELETE FROM admin_group_members
        WHERE id = ? AND admin_group_id = ? AND tenant_id = ?
          AND (SELECT revision FROM admin_groups WHERE id = ? AND tenant_id = ?) = ?${condition.sql}`,
      [
        membershipId,
        groupId,
        this.tenantId,
        groupId,
        this.tenantId,
        expectedRevision,
        ...condition.params,
      ]
    );
    return result.rowsAffected > 0;
  }

  async listGrants(groupId: string): Promise<AdminGroupRoleGrant[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT g.*, r.name AS role_name, r.display_name AS role_display_name,
              r.hierarchy_level AS hierarchy_level
         FROM admin_group_role_grants g
         JOIN admin_roles r ON r.id = g.admin_role_id
        WHERE g.admin_group_id = ? AND g.tenant_id = ?
        ORDER BY r.hierarchy_level DESC, r.name`,
      [groupId, this.tenantId]
    );
    return rows.map(toGrant);
  }

  async getGrant(groupId: string, grantId: string): Promise<AdminGroupRoleGrant | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT g.*, r.name AS role_name, r.display_name AS role_display_name,
              r.hierarchy_level AS hierarchy_level
         FROM admin_group_role_grants g
         JOIN admin_roles r ON r.id = g.admin_role_id
        WHERE g.id = ? AND g.admin_group_id = ? AND g.tenant_id = ?`,
      [grantId, groupId, this.tenantId]
    );
    return row ? toGrant(row) : null;
  }

  /**
   * Gives the group a role for its tenant, if its grants are still the ones of
   * `expectedRevision`, and raises the revision. Null with 'changed' when they are not, or with
   * 'exists' when the group already has the role.
   */
  async addGrant(input: {
    groupId: string;
    roleId: string;
    expiresAt: number | null;
    assignedBy: string | null;
    expectedRevision: number;
  }): Promise<{ grant: AdminGroupRoleGrant } | { grant: null; reason: 'changed' | 'exists' }> {
    const id = generateId();
    const now = getCurrentTimestamp();
    try {
      const [inserted] = await this.adapter.batch([
        {
          sql: `INSERT INTO admin_group_role_grants
                  (id, tenant_id, admin_group_id, admin_role_id, scope_type, scope_id, expires_at,
                   assigned_by, created_at, updated_at)
                SELECT ?, grp.tenant_id, grp.id, ?, 'tenant', grp.tenant_id, ?, ?, ?, ?
                  FROM admin_groups grp
                 WHERE grp.id = ? AND grp.tenant_id = ? AND grp.revision = ?`,
          params: [
            id,
            input.roleId,
            input.expiresAt,
            input.assignedBy,
            now,
            now,
            input.groupId,
            this.tenantId,
            input.expectedRevision,
          ],
        },
        {
          // Only when the grant went in: the revision the INSERT checked is still the current one.
          sql: `UPDATE admin_groups SET revision = revision + 1, updated_at = ?
                 WHERE id = ? AND tenant_id = ? AND revision = ?
                   AND EXISTS (SELECT 1 FROM admin_group_role_grants WHERE id = ?)`,
          params: [now, input.groupId, this.tenantId, input.expectedRevision, id],
        },
      ]);
      if (!inserted || inserted.rowsAffected === 0) return { grant: null, reason: 'changed' };
    } catch (error) {
      if (isUniqueViolation(error)) return { grant: null, reason: 'exists' };
      throw error;
    }
    const grant = await this.getGrant(input.groupId, id);
    if (!grant) return { grant: null, reason: 'changed' };
    return { grant };
  }

  /**
   * Sets a grant's expiry (null: permanent), if it is still `previousExpiresAt`, and raises the
   * group's revision. False when there is no such grant, its expiry changed, or `guard` fails.
   */
  async updateGrantExpiry(
    groupId: string,
    grantId: string,
    expiresAt: number | null,
    previousExpiresAt: number | null,
    guard?: AdminWriteGuard
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const condition = guardClause(guard);
    // Only from the expiry the change was judged against (longer or shorter is decided from
    // it); a concurrent change makes this one ask again.
    const target = `FROM admin_group_role_grants
               WHERE id = ? AND admin_group_id = ? AND tenant_id = ? AND expires_at IS ?${condition.sql}`;
    const targetParams = [grantId, groupId, this.tenantId, previousExpiresAt, ...condition.params];
    const [updated] = await this.adapter.batch([
      {
        sql: `UPDATE admin_group_role_grants SET expires_at = ?, updated_at = ?
               WHERE id IN (SELECT id ${target})`,
        params: [expiresAt, now, ...targetParams],
      },
      // The revision goes up only when the change just before it went in (`changes()` is the
      // row count of the previous statement of this batch), so a refused or superseded change
      // leaves it as it was.
      bumpRevisionIfChanged(this.tenantId, groupId, now),
    ]);
    return (updated?.rowsAffected ?? 0) > 0;
  }

  /** Takes a role away from the group. False when there is no such grant, or `guard` fails. */
  async removeGrant(groupId: string, grantId: string, guard?: AdminWriteGuard): Promise<boolean> {
    const now = getCurrentTimestamp();
    const condition = guardClause(guard);
    const target = `FROM admin_group_role_grants
               WHERE id = ? AND admin_group_id = ? AND tenant_id = ?${condition.sql}`;
    const targetParams = [grantId, groupId, this.tenantId, ...condition.params];
    const [removed] = await this.adapter.batch([
      {
        sql: `DELETE FROM admin_group_role_grants WHERE id IN (SELECT id ${target})`,
        params: targetParams,
      },
      bumpRevisionIfChanged(this.tenantId, groupId, now),
    ]);
    return (removed?.rowsAffected ?? 0) > 0;
  }

  /** The groups an administrator of the tenant belongs to. */
  async groupsOfUser(
    adminUserId: string
  ): Promise<Array<{ id: string; group_key: string; display_name: string }>> {
    return this.adapter.query<{ id: string; group_key: string; display_name: string }>(
      `SELECT grp.id, grp.group_key, grp.display_name
         FROM admin_group_members m
         JOIN admin_groups grp ON grp.id = m.admin_group_id AND grp.tenant_id = m.tenant_id
        WHERE m.admin_user_id = ? AND m.tenant_id = ?
        ORDER BY grp.display_name`,
      [adminUserId, this.tenantId]
    );
  }

  /** Whether any group of the tenant gives this role (an assignment of it in all but name). */
  async roleIsGranted(roleId: string): Promise<boolean> {
    const row = await this.adapter.queryOne<{ id: string }>(
      'SELECT id FROM admin_group_role_grants WHERE admin_role_id = ? AND tenant_id = ? LIMIT 1',
      [roleId, this.tenantId]
    );
    return row !== null;
  }
}
