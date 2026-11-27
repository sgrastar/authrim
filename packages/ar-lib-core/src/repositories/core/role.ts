/**
 * Role Repository
 *
 * Repository for RBAC (Role-Based Access Control) role definitions stored in D1_CORE database.
 * Role assignments are role_assignments rows (see services/tenant-rbac.ts).
 *
 * Key features:
 * - Role CRUD with permissions management
 *
 * Note: Does not extend BaseRepository because roles table
 * doesn't have updated_at field (roles are versioned via new records).
 *
 * Tables: roles
 * Schema (roles):
 *   - id: TEXT PRIMARY KEY (UUID)
 *   - tenant_id: TEXT NOT NULL
 *   - name: TEXT NOT NULL
 *   - description: TEXT
 *   - permissions_json: TEXT NOT NULL (JSON array of permissions)
 *   - created_at: INTEGER NOT NULL (timestamp)
 *   - UNIQUE(tenant_id, name)
 */

import { generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';

/**
 * Role entity representing an RBAC role
 */
export interface Role {
  /** Unique role ID (UUID) */
  id: string;
  /** Tenant ID */
  tenant_id: string;
  /** Role name (unique within tenant) */
  name: string;
  /** Role description */
  description: string | null;
  /** Permissions granted by this role */
  permissions: string[];
  /** Creation timestamp (Unix ms) */
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
  tenant_id: string;
  name: string;
  description: string | null;
  permissions_json: string;
  created_at: number;
}

function requireTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

/**
 * Role Repository
 *
 * Provides CRUD operations for RBAC roles.
 */
export class RoleRepository {
  protected readonly adapter: DatabaseAdapter;
  protected readonly tenantId: string;

  constructor(adapter: DatabaseAdapter, tenantId: string) {
    this.adapter = adapter;
    this.tenantId = requireTenantId(tenantId, 'RoleRepository');
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
      INSERT INTO roles (id, tenant_id, name, description, permissions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      id,
      this.tenantId,
      input.name,
      input.description ?? null,
      permissionsJson,
      now,
    ]);

    return {
      id,
      tenant_id: this.tenantId,
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
    const sql = 'SELECT * FROM roles WHERE id = ? AND tenant_id = ?';
    const row = await this.adapter.queryOne<RoleRow>(sql, [id, this.tenantId]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find role by name
   *
   * @param name - Role name
   * @returns Role or null if not found
   */
  async findByName(name: string): Promise<Role | null> {
    const sql = 'SELECT * FROM roles WHERE tenant_id = ? AND name = ?';
    const row = await this.adapter.queryOne<RoleRow>(sql, [this.tenantId, name]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find all roles
   *
   * @returns Array of all roles
   */
  async findAll(): Promise<Role[]> {
    const sql = 'SELECT * FROM roles WHERE tenant_id = ? ORDER BY name ASC';
    const rows = await this.adapter.query<RoleRow>(sql, [this.tenantId]);
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

    const sql = `UPDATE roles SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`;
    params.push(id, this.tenantId);

    await this.adapter.execute(sql, params);
    return this.findById(id);
  }

  /**
   * Delete a role
   *
   * @param id - Role ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    const sql = 'DELETE FROM roles WHERE id = ? AND tenant_id = ?';
    const result = await this.adapter.execute(sql, [id, this.tenantId]);
    return result.rowsAffected > 0;
  }

  /**
   * Check if role name exists
   *
   * @param name - Role name
   * @returns True if exists
   */
  async nameExists(name: string): Promise<boolean> {
    const sql = 'SELECT 1 FROM roles WHERE tenant_id = ? AND name = ?';
    const result = await this.adapter.queryOne<{ 1: number }>(sql, [this.tenantId, name]);
    return result !== null;
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
      tenant_id: row.tenant_id,
      name: row.name,
      description: row.description,
      permissions,
      created_at: row.created_at,
    };
  }
}
