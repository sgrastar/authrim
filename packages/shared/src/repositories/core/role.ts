/**
 * Role Repository
 *
 * Repository for RBAC (Role-Based Access Control) stored in D1_CORE database.
 * Handles role definitions and user-role assignments.
 *
 * Key features:
 * - Role CRUD with permissions management
 * - User-role assignment/revocation
 * - Permission checking utilities
 * - Bulk role operations
 *
 * Note: Does not extend BaseRepository because roles table
 * doesn't have updated_at field (roles are versioned via new records).
 *
 * Tables: roles, user_roles
 * Schema (roles):
 *   - id: TEXT PRIMARY KEY (UUID)
 *   - name: TEXT UNIQUE NOT NULL
 *   - description: TEXT
 *   - permissions_json: TEXT NOT NULL (JSON array of permissions)
 *   - created_at: INTEGER NOT NULL (timestamp)
 *
 * Schema (user_roles):
 *   - user_id: TEXT NOT NULL (FK to users)
 *   - role_id: TEXT NOT NULL (FK to roles)
 *   - created_at: INTEGER NOT NULL (timestamp)
 *   - PRIMARY KEY (user_id, role_id)
 */

import { generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';

/**
 * Role entity representing an RBAC role
 */
export interface Role {
  /** Unique role ID (UUID) */
  id: string;
  /** Role name (unique) */
  name: string;
  /** Role description */
  description: string | null;
  /** Permissions granted by this role */
  permissions: string[];
  /** Creation timestamp (Unix ms) */
  created_at: number;
}

/**
 * User-role assignment entity
 */
export interface UserRole {
  /** User ID */
  user_id: string;
  /** Role ID */
  role_id: string;
  /** Assignment timestamp (Unix ms) */
  created_at: number;
}

/**
 * Input for creating a new role
 */
export interface CreateRoleInput {
  /** Optional role ID (auto-generated if not provided) */
  id?: string;
  /** Role name (must be unique) */
  name: string;
  /** Role description */
  description?: string;
  /** Permissions granted by this role */
  permissions: string[];
}

/**
 * Input for updating a role
 */
export interface UpdateRoleInput {
  /** New role name */
  name?: string;
  /** New description */
  description?: string;
  /** New permissions (replaces existing) */
  permissions?: string[];
}

/**
 * Database row type for roles table
 */
interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions_json: string;
  created_at: number;
}

/**
 * Database row type for user_roles table
 */
interface UserRoleRow {
  user_id: string;
  role_id: string;
  created_at: number;
}

/**
 * Role Repository
 *
 * Provides CRUD operations for RBAC roles and user assignments with:
 * - Role creation and management
 * - User-role assignment/revocation
 * - Permission checking
 */
export class RoleRepository {
  protected readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  // =========================================================================
  // Role CRUD Operations
  // =========================================================================

  /**
   * Create a new role
   *
   * @param input - Role creation input
   * @returns Created role
   * @throws Error if role name already exists
   */
  async create(input: CreateRoleInput): Promise<Role> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const permissionsJson = JSON.stringify(input.permissions);

    const sql = `
      INSERT INTO roles (id, name, description, permissions_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      id,
      input.name,
      input.description ?? null,
      permissionsJson,
      now,
    ]);

    return {
      id,
      name: input.name,
      description: input.description ?? null,
      permissions: input.permissions,
      created_at: now,
    };
  }

  /**
   * Find role by ID
   *
   * @param id - Role ID
   * @returns Role or null if not found
   */
  async findById(id: string): Promise<Role | null> {
    const sql = 'SELECT * FROM roles WHERE id = ?';
    const row = await this.adapter.queryOne<RoleRow>(sql, [id]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find role by name
   *
   * @param name - Role name
   * @returns Role or null if not found
   */
  async findByName(name: string): Promise<Role | null> {
    const sql = 'SELECT * FROM roles WHERE name = ?';
    const row = await this.adapter.queryOne<RoleRow>(sql, [name]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find all roles
   *
   * @returns Array of all roles
   */
  async findAll(): Promise<Role[]> {
    const sql = 'SELECT * FROM roles ORDER BY name ASC';
    const rows = await this.adapter.query<RoleRow>(sql);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Update a role
   *
   * @param id - Role ID
   * @param input - Update input
   * @returns Updated role or null if not found
   */
  async update(id: string, input: UpdateRoleInput): Promise<Role | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      params.push(input.name);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }

    if (input.permissions !== undefined) {
      updates.push('permissions_json = ?');
      params.push(JSON.stringify(input.permissions));
    }

    if (updates.length === 0) {
      return existing;
    }

    const sql = `UPDATE roles SET ${updates.join(', ')} WHERE id = ?`;
    params.push(id);

    await this.adapter.execute(sql, params);
    return this.findById(id);
  }

  /**
   * Delete a role
   * Note: This will cascade delete user_roles entries
   *
   * @param id - Role ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    const sql = 'DELETE FROM roles WHERE id = ?';
    const result = await this.adapter.execute(sql, [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Check if role name exists
   *
   * @param name - Role name
   * @returns True if exists
   */
  async nameExists(name: string): Promise<boolean> {
    const sql = 'SELECT 1 FROM roles WHERE name = ?';
    const result = await this.adapter.queryOne<{ 1: number }>(sql, [name]);
    return result !== null;
  }

  // =========================================================================
  // User-Role Assignment Operations
  // =========================================================================

  /**
   * Assign a role to a user
   *
   * @param userId - User ID
   * @param roleId - Role ID
   * @returns User-role assignment or null if role doesn't exist
   */
  async assignRoleToUser(userId: string, roleId: string): Promise<UserRole | null> {
    // Verify role exists
    const roleExists = await this.findById(roleId);
    if (!roleExists) {
      return null;
    }

    const now = getCurrentTimestamp();

    // Use INSERT OR IGNORE to handle duplicate assignments gracefully
    const sql = `
      INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at)
      VALUES (?, ?, ?)
    `;

    await this.adapter.execute(sql, [userId, roleId, now]);

    return {
      user_id: userId,
      role_id: roleId,
      created_at: now,
    };
  }

  /**
   * Revoke a role from a user
   *
   * @param userId - User ID
   * @param roleId - Role ID
   * @returns True if revoked, false if assignment didn't exist
   */
  async revokeRoleFromUser(userId: string, roleId: string): Promise<boolean> {
    const sql = 'DELETE FROM user_roles WHERE user_id = ? AND role_id = ?';
    const result = await this.adapter.execute(sql, [userId, roleId]);
    return result.rowsAffected > 0;
  }

  /**
   * Get all roles for a user
   *
   * @param userId - User ID
   * @returns Array of roles assigned to the user
   */
  async findRolesForUser(userId: string): Promise<Role[]> {
    const sql = `
      SELECT r.* FROM roles r
      INNER JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.name ASC
    `;

    const rows = await this.adapter.query<RoleRow>(sql, [userId]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Get all users with a specific role
   *
   * @param roleId - Role ID
   * @returns Array of user IDs with this role
   */
  async findUsersWithRole(roleId: string): Promise<string[]> {
    const sql = 'SELECT user_id FROM user_roles WHERE role_id = ? ORDER BY created_at ASC';
    const rows = await this.adapter.query<{ user_id: string }>(sql, [roleId]);
    return rows.map((row) => row.user_id);
  }

  /**
   * Check if user has a specific role
   *
   * @param userId - User ID
   * @param roleId - Role ID
   * @returns True if user has the role
   */
  async userHasRole(userId: string, roleId: string): Promise<boolean> {
    const sql = 'SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?';
    const result = await this.adapter.queryOne<{ 1: number }>(sql, [userId, roleId]);
    return result !== null;
  }

  /**
   * Check if user has a specific role by name
   *
   * @param userId - User ID
   * @param roleName - Role name
   * @returns True if user has the role
   */
  async userHasRoleByName(userId: string, roleName: string): Promise<boolean> {
    const sql = `
      SELECT 1 FROM user_roles ur
      INNER JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = ? AND r.name = ?
    `;
    const result = await this.adapter.queryOne<{ 1: number }>(sql, [userId, roleName]);
    return result !== null;
  }

  /**
   * Get all permissions for a user (aggregated from all roles)
   *
   * @param userId - User ID
   * @returns Array of unique permissions
   */
  async getPermissionsForUser(userId: string): Promise<string[]> {
    const roles = await this.findRolesForUser(userId);
    const permissionsSet = new Set<string>();

    for (const role of roles) {
      for (const permission of role.permissions) {
        permissionsSet.add(permission);
      }
    }

    return Array.from(permissionsSet).sort();
  }

  /**
   * Check if user has a specific permission
   *
   * @param userId - User ID
   * @param permission - Permission to check
   * @returns True if user has the permission (via any role)
   */
  async userHasPermission(userId: string, permission: string): Promise<boolean> {
    const permissions = await this.getPermissionsForUser(userId);
    return permissions.includes(permission);
  }

  /**
   * Check if user has all specified permissions
   *
   * @param userId - User ID
   * @param requiredPermissions - Permissions to check
   * @returns True if user has all permissions
   */
  async userHasAllPermissions(userId: string, requiredPermissions: string[]): Promise<boolean> {
    const permissions = await this.getPermissionsForUser(userId);
    return requiredPermissions.every((p) => permissions.includes(p));
  }

  /**
   * Check if user has any of the specified permissions
   *
   * @param userId - User ID
   * @param anyPermissions - Permissions to check
   * @returns True if user has at least one permission
   */
  async userHasAnyPermission(userId: string, anyPermissions: string[]): Promise<boolean> {
    const permissions = await this.getPermissionsForUser(userId);
    return anyPermissions.some((p) => permissions.includes(p));
  }

  /**
   * Remove all role assignments for a user
   *
   * @param userId - User ID
   * @returns Number of role assignments removed
   */
  async removeAllRolesFromUser(userId: string): Promise<number> {
    const sql = 'DELETE FROM user_roles WHERE user_id = ?';
    const result = await this.adapter.execute(sql, [userId]);
    return result.rowsAffected;
  }

  /**
   * Replace all roles for a user
   *
   * @param userId - User ID
   * @param roleIds - New role IDs
   * @returns Number of roles assigned
   */
  async setRolesForUser(userId: string, roleIds: string[]): Promise<number> {
    // Remove existing roles
    await this.removeAllRolesFromUser(userId);

    if (roleIds.length === 0) {
      return 0;
    }

    const now = getCurrentTimestamp();
    let assignedCount = 0;

    for (const roleId of roleIds) {
      const result = await this.assignRoleToUser(userId, roleId);
      if (result) {
        assignedCount++;
      }
    }

    return assignedCount;
  }

  /**
   * Count users with a specific role
   *
   * @param roleId - Role ID
   * @returns Number of users with this role
   */
  async countUsersWithRole(roleId: string): Promise<number> {
    const sql = 'SELECT COUNT(*) as count FROM user_roles WHERE role_id = ?';
    const result = await this.adapter.queryOne<{ count: number }>(sql, [roleId]);
    return result?.count ?? 0;
  }

  /**
   * Get role assignment details
   *
   * @param userId - User ID
   * @param roleId - Role ID
   * @returns User-role assignment or null if not found
   */
  async getUserRoleAssignment(userId: string, roleId: string): Promise<UserRole | null> {
    const sql = 'SELECT * FROM user_roles WHERE user_id = ? AND role_id = ?';
    const row = await this.adapter.queryOne<UserRoleRow>(sql, [userId, roleId]);
    return row ?? null;
  }

  /**
   * Convert database row to Role entity
   */
  private rowToEntity(row: RoleRow): Role {
    let permissions: string[] = [];
    try {
      permissions = JSON.parse(row.permissions_json);
    } catch {
      // Invalid JSON, use empty array
      permissions = [];
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      permissions,
      created_at: row.created_at,
    };
  }
}
