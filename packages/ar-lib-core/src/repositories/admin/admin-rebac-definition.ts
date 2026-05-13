/**
 * Admin ReBAC Definition Repository
 *
 * Repository for Admin ReBAC relationship type definitions stored in DB_ADMIN.
 * Manages relationship type metadata (e.g., 'admin_supervises', 'admin_team_member').
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { requireTenantId } from '../tenant';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';

/**
 * Admin ReBAC definition entity
 */
export interface AdminRebacDefinitionEntity extends BaseEntity {
  tenant_id: string;
  relation_name: string;
  display_name: string | null;
  description: string | null;
  priority: number;
  is_system: boolean;
}

/**
 * Admin ReBAC definition (API model)
 */
export interface AdminRebacDefinition {
  id: string;
  tenant_id: string;
  relation_name: string;
  display_name: string | null;
  description: string | null;
  priority: number;
  is_system: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Admin ReBAC definition create input
 */
export interface AdminRebacDefinitionCreateInput {
  tenant_id?: string;
  relation_name: string;
  display_name?: string;
  description?: string;
  priority?: number;
}

/**
 * Admin ReBAC definition update input
 */
export interface AdminRebacDefinitionUpdateInput {
  display_name?: string;
  description?: string;
  priority?: number;
}

/**
 * Admin ReBAC Definition Repository
 */
export class AdminRebacDefinitionRepository extends BaseRepository<AdminRebacDefinitionEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_rebac_definitions',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'relation_name',
        'display_name',
        'description',
        'priority',
        'is_system',
      ],
    });
  }

  /**
   * Create a new ReBAC definition
   */
  async createDefinition(input: AdminRebacDefinitionCreateInput): Promise<AdminRebacDefinition> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const entity: AdminRebacDefinitionEntity = {
      id,
      tenant_id: requireTenantId(input.tenant_id, 'Repository create'),
      relation_name: input.relation_name,
      display_name: input.display_name ?? null,
      description: input.description ?? null,
      priority: input.priority ?? 0,
      is_system: false,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_rebac_definitions (
        id, tenant_id, relation_name, display_name, description,
        priority, is_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entity.id,
      entity.tenant_id,
      entity.relation_name,
      entity.display_name,
      entity.description,
      entity.priority,
      entity.is_system ? 1 : 0,
      entity.created_at,
      entity.updated_at,
    ]);

    return this.entityToDefinition(entity);
  }

  /**
   * Get definition by ID
   */
  async getDefinition(id: string): Promise<AdminRebacDefinition | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_rebac_definitions WHERE id = ?',
      [id]
    );
    return row ? this.rowToDefinition(row) : null;
  }

  /**
   * Get definition by relation name
   */
  async getDefinitionByName(
    tenantId: string,
    relationName: string
  ): Promise<AdminRebacDefinition | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_rebac_definitions WHERE tenant_id = ? AND relation_name = ?',
      [tenantId, relationName]
    );
    return row ? this.rowToDefinition(row) : null;
  }

  /**
   * List all definitions for a tenant
   */
  async listDefinitions(
    tenantId: string,
    options?: { includeSystem?: boolean; limit?: number; offset?: number }
  ): Promise<AdminRebacDefinition[]> {
    let sql: string;
    const params: unknown[] = [tenantId];

    if (options?.includeSystem) {
      sql = 'SELECT * FROM admin_rebac_definitions WHERE (tenant_id = ? OR is_system = 1)';
    } else {
      sql = 'SELECT * FROM admin_rebac_definitions WHERE tenant_id = ? AND is_system = 0';
    }

    sql += ' ORDER BY priority DESC, relation_name ASC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = await this.adapter.query<Record<string, unknown>>(sql, params);
    return rows.map((row) => this.rowToDefinition(row));
  }

  /**
   * Update definition
   */
  async updateDefinition(
    id: string,
    input: AdminRebacDefinitionUpdateInput
  ): Promise<AdminRebacDefinition | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    // Prevent updating system definitions
    if (existing.is_system) {
      throw new Error('Cannot update system ReBAC definition');
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
    if (input.priority !== undefined) {
      updates.push('priority = ?');
      values.push(input.priority);
    }

    if (updates.length === 0) {
      return this.entityToDefinition(existing);
    }

    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp());
    values.push(id);

    const sql = `UPDATE admin_rebac_definitions SET ${updates.join(', ')} WHERE id = ?`;
    await this.adapter.execute(sql, values);

    const updated = await this.findById(id);
    return updated ? this.entityToDefinition(updated) : null;
  }

  /**
   * Delete definition
   */
  async deleteDefinition(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) {
      return false;
    }

    // Prevent deleting system definitions
    if (existing.is_system) {
      throw new Error('Cannot delete system ReBAC definition');
    }

    const result = await this.adapter.execute('DELETE FROM admin_rebac_definitions WHERE id = ?', [
      id,
    ]);
    return result.rowsAffected > 0;
  }

  /**
   * Convert database row to AdminRebacDefinition
   */
  private rowToDefinition(row: Record<string, unknown>): AdminRebacDefinition {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      relation_name: row.relation_name as string,
      display_name: row.display_name as string | null,
      description: row.description as string | null,
      priority: (row.priority as number) ?? 0,
      is_system: Boolean(row.is_system),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Convert entity to AdminRebacDefinition
   */
  private entityToDefinition(entity: AdminRebacDefinitionEntity): AdminRebacDefinition {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      relation_name: entity.relation_name,
      display_name: entity.display_name,
      description: entity.description,
      priority: entity.priority,
      is_system: entity.is_system,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}
