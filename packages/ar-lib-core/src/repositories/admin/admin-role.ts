/**
 * Admin Role Repository
 *
 * Repository for Admin role data stored in DB_ADMIN.
 * Handles role definitions and role assignments for Admin RBAC.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import {
  BaseRepository,
  type BaseEntity,
  type FilterCondition,
  type PaginationOptions,
  type PaginationResult,
  generateId,
  getCurrentTimestamp,
} from '../base';
import type {
  AdminRole,
  AdminRoleCreateInput,
  AdminRoleUpdateInput,
  AdminRoleType,
  AdminRoleAssignment,
  AdminRoleAssignmentCreateInput,
  AdminRoleAssignmentScopeType,
} from '../../types/admin-user';

/**
 * Admin role entity (extends BaseEntity for repository compatibility)
 */
interface AdminRoleEntity extends BaseEntity {
  tenant_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  permissions_json: string;
  hierarchy_level: number;
  role_type: AdminRoleType;
  is_system: boolean;
}

/**
 * Admin role assignment entity
 */
interface AdminRoleAssignmentEntity extends BaseEntity {
  tenant_id: string;
  admin_user_id: string;
  admin_role_id: string;
  scope_type: AdminRoleAssignmentScopeType;
  scope_id: string | null;
  expires_at: number | null;
  assigned_by: string | null;
}

/**
 * Admin Role Repository
 */
export class AdminRoleRepository extends BaseRepository<AdminRoleEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_roles',
      primaryKey: 'id',
      softDelete: false, // Roles don't use soft delete
      allowedFields: [
        'tenant_id',
        'name',
        'display_name',
        'description',
        'permissions_json',
        'hierarchy_level',
        'role_type',
        'is_system',
      ],
    });
  }

  /**
   * Create a new Admin role
   *
   * @param input - Role creation input
   * @returns Created role
   */
  async createRole(input: AdminRoleCreateInput): Promise<AdminRole> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const role: AdminRoleEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      name: input.name,
      display_name: input.display_name ?? null,
      description: input.description ?? null,
      permissions_json: JSON.stringify(input.permissions),
      hierarchy_level: input.hierarchy_level ?? 0,
      role_type: input.role_type ?? 'custom',
      is_system: false, // User-created roles are never system roles
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_roles (
        id, tenant_id, name, display_name, description,
        permissions_json, hierarchy_level, role_type, is_system,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      role.id,
      role.tenant_id,
      role.name,
      role.display_name,
      role.description,
      role.permissions_json,
      role.hierarchy_level,
      role.role_type,
      role.is_system ? 1 : 0,
      role.created_at,
      role.updated_at,
    ]);

    return this.entityToRole(role);
  }

  /**
   * Update an Admin role
   *
   * @param id - Role ID
   * @param input - Update input
   * @returns Updated role or null if not found or is system role
   */
  async updateRole(id: string, input: AdminRoleUpdateInput): Promise<AdminRole | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    // Prevent updating system roles
    if (existing.is_system) {
      throw new Error('Cannot update system role');
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.display_name !== undefined) {
      updates.push('display_name = ?');
      values.push(input.display_name);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description);
    }
    if (input.permissions !== undefined) {
      updates.push('permissions_json = ?');
      values.push(JSON.stringify(input.permissions));
    }
    if (input.hierarchy_level !== undefined) {
      updates.push('hierarchy_level = ?');
      values.push(input.hierarchy_level);
    }

    if (updates.length === 0) {
      return this.entityToRole(existing);
    }

    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp());
    values.push(id);

    const sql = `UPDATE admin_roles SET ${updates.join(', ')} WHERE id = ?`;
    await this.adapter.execute(sql, values);

    const updated = await this.findById(id);
    return updated ? this.entityToRole(updated) : null;
  }

  /**
   * Delete an Admin role
   *
   * @param id - Role ID
   * @returns True if deleted, false if not found or is system role
   */
  async deleteRole(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) {
      return false;
    }

    // Prevent deleting system/builtin roles
    if (existing.is_system || existing.role_type === 'builtin') {
      throw new Error('Cannot delete system or builtin role');
    }

    const result = await this.adapter.execute('DELETE FROM admin_roles WHERE id = ?', [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Find role by name
   *
   * @param tenantId - Tenant ID
   * @param name - Role name
   * @returns Role or null
   */
  async findByName(tenantId: string, name: string): Promise<AdminRole | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_roles WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );
    return row ? this.rowToRole(row) : null;
  }

  /**
   * Get all roles for a tenant
   *
   * @param tenantId - Tenant ID
   * @returns List of roles
   */
  async getRolesByTenant(tenantId: string): Promise<AdminRole[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_roles WHERE tenant_id = ? ORDER BY hierarchy_level DESC, name ASC',
      [tenantId]
    );
    return rows.map((row) => this.rowToRole(row));
  }

  /**
   * Get system roles (available for all tenants)
   *
   * @returns List of system roles
   */
  async getSystemRoles(): Promise<AdminRole[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_roles WHERE is_system = 1 ORDER BY hierarchy_level DESC',
      []
    );
    return rows.map((row) => this.rowToRole(row));
  }

  /**
   * Get role by ID
   *
   * @param id - Role ID
   * @returns Role or null
   */
  async getRole(id: string): Promise<AdminRole | null> {
    const entity = await this.findById(id);
    return entity ? this.entityToRole(entity) : null;
  }

  /**
   * Map database row to entity
   */
  private rowToEntity(row: Record<string, unknown>): AdminRoleEntity {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      name: row.name as string,
      display_name: row.display_name as string | null,
      description: row.description as string | null,
      permissions_json: row.permissions_json as string,
      hierarchy_level: (row.hierarchy_level as number) ?? 0,
      role_type: row.role_type as AdminRoleType,
      is_system: Boolean(row.is_system),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Map database row to AdminRole
   */
  private rowToRole(row: Record<string, unknown>): AdminRole {
    return this.entityToRole(this.rowToEntity(row));
  }

  /**
   * Convert entity to AdminRole type
   */
  private entityToRole(entity: AdminRoleEntity): AdminRole {
    let permissions: string[];
    try {
      permissions = JSON.parse(entity.permissions_json);
    } catch {
      permissions = [];
    }

    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      name: entity.name,
      display_name: entity.display_name,
      description: entity.description,
      permissions,
      hierarchy_level: entity.hierarchy_level,
      role_type: entity.role_type,
      is_system: entity.is_system,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}

/**
 * Admin Role Assignment Repository
 */
export class AdminRoleAssignmentRepository extends BaseRepository<AdminRoleAssignmentEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_role_assignments',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'admin_user_id',
        'admin_role_id',
        'scope_type',
        'scope_id',
        'expires_at',
        'assigned_by',
      ],
    });
  }

  /**
   * Assign a role to an Admin user
   *
   * @param input - Assignment input
   * @returns Created assignment
   */
  async assignRole(input: AdminRoleAssignmentCreateInput): Promise<AdminRoleAssignment> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const assignment: AdminRoleAssignmentEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      admin_user_id: input.admin_user_id,
      admin_role_id: input.admin_role_id,
      scope_type: input.scope_type ?? 'tenant',
      scope_id: input.scope_id ?? null,
      expires_at: input.expires_at ?? null,
      assigned_by: input.assigned_by ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_role_assignments (
        id, tenant_id, admin_user_id, admin_role_id,
        scope_type, scope_id, expires_at, assigned_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      assignment.id,
      assignment.tenant_id,
      assignment.admin_user_id,
      assignment.admin_role_id,
      assignment.scope_type,
      assignment.scope_id,
      assignment.expires_at,
      assignment.assigned_by,
      assignment.created_at,
    ]);

    return this.entityToAssignment(assignment);
  }

  /**
   * Remove a role assignment
   *
   * @param adminUserId - Admin user ID
   * @param adminRoleId - Admin role ID
   * @param scopeType - Scope type
   * @param scopeId - Scope ID (optional)
   * @returns True if removed
   */
  async removeAssignment(
    adminUserId: string,
    adminRoleId: string,
    scopeType?: AdminRoleAssignmentScopeType,
    scopeId?: string
  ): Promise<boolean> {
    let sql = 'DELETE FROM admin_role_assignments WHERE admin_user_id = ? AND admin_role_id = ?';
    const params: unknown[] = [adminUserId, adminRoleId];

    if (scopeType) {
      sql += ' AND scope_type = ?';
      params.push(scopeType);
    }
    if (scopeId !== undefined) {
      sql += ' AND scope_id = ?';
      params.push(scopeId);
    }

    const result = await this.adapter.execute(sql, params);
    return result.rowsAffected > 0;
  }

  /**
   * Get all roles assigned to an Admin user
   *
   * @param adminUserId - Admin user ID
   * @param includeExpired - Include expired assignments (default: false)
   * @returns List of role assignments with role details
   */
  async getAssignmentsByUser(
    adminUserId: string,
    includeExpired: boolean = false
  ): Promise<Array<AdminRoleAssignment & { role: AdminRole }>> {
    const now = getCurrentTimestamp();

    let sql = `
      SELECT
        ra.*,
        r.name as role_name,
        r.display_name as role_display_name,
        r.description as role_description,
        r.permissions_json,
        r.hierarchy_level,
        r.role_type,
        r.is_system,
        r.created_at as role_created_at,
        r.updated_at as role_updated_at
      FROM admin_role_assignments ra
      JOIN admin_roles r ON ra.admin_role_id = r.id
      WHERE ra.admin_user_id = ?
    `;
    const params: unknown[] = [adminUserId];

    if (!includeExpired) {
      sql += ' AND (ra.expires_at IS NULL OR ra.expires_at > ?)';
      params.push(now);
    }

    sql += ' ORDER BY r.hierarchy_level DESC';

    const rows = await this.adapter.query<Record<string, unknown>>(sql, params);

    return rows.map((row) => {
      let permissions: string[];
      try {
        permissions = JSON.parse(row.permissions_json as string);
      } catch {
        permissions = [];
      }

      return {
        id: row.id as string,
        tenant_id: row.tenant_id as string,
        admin_user_id: row.admin_user_id as string,
        admin_role_id: row.admin_role_id as string,
        scope_type: row.scope_type as AdminRoleAssignmentScopeType,
        scope_id: row.scope_id as string | null,
        expires_at: row.expires_at as number | null,
        assigned_by: row.assigned_by as string | null,
        created_at: row.created_at as number,
        role: {
          id: row.admin_role_id as string,
          tenant_id: row.tenant_id as string,
          name: row.role_name as string,
          display_name: row.role_display_name as string | null,
          description: row.role_description as string | null,
          permissions,
          hierarchy_level: (row.hierarchy_level as number) ?? 0,
          role_type: row.role_type as AdminRoleType,
          is_system: Boolean(row.is_system),
          created_at: row.role_created_at as number,
          updated_at: row.role_updated_at as number,
        },
      };
    });
  }

  /**
   * Get all permissions for an Admin user (aggregated from all assigned roles)
   *
   * @param adminUserId - Admin user ID
   * @returns Set of permission strings
   */
  async getPermissionsByUser(adminUserId: string): Promise<Set<string>> {
    const assignments = await this.getAssignmentsByUser(adminUserId);
    const permissions = new Set<string>();

    for (const assignment of assignments) {
      for (const permission of assignment.role.permissions) {
        permissions.add(permission);
      }
    }

    return permissions;
  }

  /**
   * Get Admin users assigned to a role
   *
   * @param roleId - Role ID
   * @returns List of Admin user IDs
   */
  async getUsersByRole(roleId: string): Promise<string[]> {
    const now = getCurrentTimestamp();
    const rows = await this.adapter.query<{ admin_user_id: string }>(
      `SELECT DISTINCT admin_user_id FROM admin_role_assignments
       WHERE admin_role_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [roleId, now]
    );
    return rows.map((row) => row.admin_user_id);
  }

  /**
   * Check if Admin user has a specific role
   *
   * @param adminUserId - Admin user ID
   * @param roleName - Role name to check
   * @returns True if user has the role
   */
  async hasRole(adminUserId: string, roleName: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const row = await this.adapter.queryOne<{ id: string }>(
      `SELECT ra.id FROM admin_role_assignments ra
       JOIN admin_roles r ON ra.admin_role_id = r.id
       WHERE ra.admin_user_id = ? AND r.name = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       LIMIT 1`,
      [adminUserId, roleName, now]
    );
    return row !== null;
  }

  /**
   * Delete all assignments for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @returns Number of deleted assignments
   */
  async deleteAllByUser(adminUserId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_role_assignments WHERE admin_user_id = ?',
      [adminUserId]
    );
    return result.rowsAffected;
  }

  /**
   * Delete all assignments for a role
   *
   * @param roleId - Role ID
   * @returns Number of deleted assignments
   */
  async deleteAllByRole(roleId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_role_assignments WHERE admin_role_id = ?',
      [roleId]
    );
    return result.rowsAffected;
  }

  /**
   * Convert entity to AdminRoleAssignment type
   */
  private entityToAssignment(entity: AdminRoleAssignmentEntity): AdminRoleAssignment {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      admin_user_id: entity.admin_user_id,
      admin_role_id: entity.admin_role_id,
      scope_type: entity.scope_type,
      scope_id: entity.scope_id,
      expires_at: entity.expires_at,
      assigned_by: entity.assigned_by,
      created_at: entity.created_at,
    };
  }
}
