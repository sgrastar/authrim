/**
 * Role Store Implementation
 *
 * Manages roles with extended attributes (role_type, hierarchy_level, etc.) in D1.
 * Part of RBAC Phase 1 implementation.
 */

import type { IStorageAdapter } from '../interfaces';
import type { Role, RoleRow, IRoleStore } from '../interfaces';

/**
 * Convert D1 row to Role entity
 */
function rowToRole(row: RoleRow): Role {
  return {
    ...row,
    is_assignable: row.is_assignable === 1,
    description: row.description ?? undefined,
    parent_role_id: row.parent_role_id ?? undefined,
  };
}

/**
 * RoleStore implementation (D1-based)
 */
export class RoleStore implements IRoleStore {
  constructor(private adapter: IStorageAdapter) {}

  async getRole(roleId: string): Promise<Role | null> {
    const results = await this.adapter.query<RoleRow>('SELECT * FROM roles WHERE id = ?', [roleId]);
    return results[0] ? rowToRole(results[0]) : null;
  }

  async getRoleByName(tenantId: string, name: string): Promise<Role | null> {
    const results = await this.adapter.query<RoleRow>(
      'SELECT * FROM roles WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );
    return results[0] ? rowToRole(results[0]) : null;
  }

  async createRole(role: Omit<Role, 'id' | 'created_at'>): Promise<Role> {
    const id = `role_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Math.floor(Date.now() / 1000); // UNIX seconds

    const newRole: Role = {
      id,
      tenant_id: role.tenant_id,
      name: role.name,
      description: role.description,
      permissions_json: role.permissions_json,
      role_type: role.role_type,
      is_assignable: role.is_assignable,
      hierarchy_level: role.hierarchy_level,
      parent_role_id: role.parent_role_id,
      created_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO roles (
        id, tenant_id, name, description, permissions_json, role_type,
        is_assignable, hierarchy_level, parent_role_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newRole.id,
        newRole.tenant_id,
        newRole.name,
        newRole.description ?? null,
        newRole.permissions_json,
        newRole.role_type,
        newRole.is_assignable ? 1 : 0,
        newRole.hierarchy_level,
        newRole.parent_role_id ?? null,
        newRole.created_at,
      ]
    );

    return newRole;
  }

  async updateRole(roleId: string, updates: Partial<Role>): Promise<Role> {
    const existing = await this.getRole(roleId);
    if (!existing) {
      throw new Error(`Role not found: ${roleId}`);
    }

    // Prevent modification of system roles
    if (existing.role_type === 'system') {
      throw new Error(`Cannot modify system role: ${roleId}`);
    }

    const updated: Role = {
      ...existing,
      ...updates,
      id: roleId, // Prevent changing ID
      role_type: existing.role_type, // Prevent changing role_type
    };

    await this.adapter.execute(
      `UPDATE roles SET
        name = ?, description = ?, permissions_json = ?,
        is_assignable = ?, hierarchy_level = ?, parent_role_id = ?
      WHERE id = ?`,
      [
        updated.name,
        updated.description ?? null,
        updated.permissions_json,
        updated.is_assignable ? 1 : 0,
        updated.hierarchy_level,
        updated.parent_role_id ?? null,
        roleId,
      ]
    );

    return updated;
  }

  async deleteRole(roleId: string): Promise<void> {
    const existing = await this.getRole(roleId);
    if (!existing) {
      throw new Error(`Role not found: ${roleId}`);
    }

    // Prevent deletion of system and builtin roles
    if (existing.role_type === 'system' || existing.role_type === 'builtin') {
      throw new Error(`Cannot delete ${existing.role_type} role: ${roleId}`);
    }

    await this.adapter.execute('DELETE FROM roles WHERE id = ?', [roleId]);
  }

  async listRoles(
    tenantId: string,
    options?: { limit?: number; offset?: number; roleType?: string }
  ): Promise<Role[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    let sql = 'SELECT * FROM roles WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (options?.roleType) {
      sql += ' AND role_type = ?';
      params.push(options.roleType);
    }

    sql += ' ORDER BY hierarchy_level DESC, name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = await this.adapter.query<RoleRow>(sql, params);
    return results.map(rowToRole);
  }

  async getChildRoles(roleId: string): Promise<Role[]> {
    const results = await this.adapter.query<RoleRow>(
      'SELECT * FROM roles WHERE parent_role_id = ? ORDER BY hierarchy_level DESC, name ASC',
      [roleId]
    );
    return results.map(rowToRole);
  }
}
