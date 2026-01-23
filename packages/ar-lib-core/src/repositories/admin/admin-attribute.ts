/**
 * Admin Attribute Repository
 *
 * Repository for Admin ABAC attribute definitions stored in DB_ADMIN.
 * Manages attribute types (department, clearance_level, etc.) for Admin users.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';

/**
 * Admin attribute entity
 */
export interface AdminAttributeEntity extends BaseEntity {
  tenant_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  attribute_type: 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array';
  allowed_values_json: string | null;
  min_value: number | null;
  max_value: number | null;
  regex_pattern: string | null;
  is_required: boolean;
  is_multi_valued: boolean;
  is_system: boolean;
}

/**
 * Admin attribute (API model)
 */
export interface AdminAttribute {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  attribute_type: 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array';
  allowed_values: string[] | null;
  min_value: number | null;
  max_value: number | null;
  regex_pattern: string | null;
  is_required: boolean;
  is_multi_valued: boolean;
  is_system: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Admin attribute create input
 */
export interface AdminAttributeCreateInput {
  tenant_id?: string;
  name: string;
  display_name?: string;
  description?: string;
  attribute_type?: 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array';
  allowed_values?: string[];
  min_value?: number;
  max_value?: number;
  regex_pattern?: string;
  is_required?: boolean;
  is_multi_valued?: boolean;
}

/**
 * Admin Attribute Repository
 */
export class AdminAttributeRepository extends BaseRepository<AdminAttributeEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_attributes',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'name',
        'display_name',
        'description',
        'attribute_type',
        'allowed_values_json',
        'min_value',
        'max_value',
        'regex_pattern',
        'is_required',
        'is_multi_valued',
        'is_system',
      ],
    });
  }

  /**
   * Create a new Admin attribute
   */
  async createAttribute(input: AdminAttributeCreateInput): Promise<AdminAttribute> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const entity: AdminAttributeEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      name: input.name,
      display_name: input.display_name ?? null,
      description: input.description ?? null,
      attribute_type: input.attribute_type ?? 'string',
      allowed_values_json: input.allowed_values ? JSON.stringify(input.allowed_values) : null,
      min_value: input.min_value ?? null,
      max_value: input.max_value ?? null,
      regex_pattern: input.regex_pattern ?? null,
      is_required: input.is_required ?? false,
      is_multi_valued: input.is_multi_valued ?? false,
      is_system: false,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_attributes (
        id, tenant_id, name, display_name, description,
        attribute_type, allowed_values_json, min_value, max_value, regex_pattern,
        is_required, is_multi_valued, is_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entity.id,
      entity.tenant_id,
      entity.name,
      entity.display_name,
      entity.description,
      entity.attribute_type,
      entity.allowed_values_json,
      entity.min_value,
      entity.max_value,
      entity.regex_pattern,
      entity.is_required ? 1 : 0,
      entity.is_multi_valued ? 1 : 0,
      entity.is_system ? 1 : 0,
      entity.created_at,
      entity.updated_at,
    ]);

    return this.entityToAttribute(entity);
  }

  /**
   * Get attribute by ID
   */
  async getAttribute(id: string): Promise<AdminAttribute | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_attributes WHERE id = ?',
      [id]
    );
    return row ? this.rowToAttribute(row) : null;
  }

  /**
   * Get attribute by name
   */
  async getAttributeByName(tenantId: string, name: string): Promise<AdminAttribute | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_attributes WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );
    return row ? this.rowToAttribute(row) : null;
  }

  /**
   * List all attributes for a tenant
   */
  async listAttributes(
    tenantId: string,
    options?: { includeSystem?: boolean; limit?: number; offset?: number }
  ): Promise<AdminAttribute[]> {
    let sql = 'SELECT * FROM admin_attributes WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (!options?.includeSystem) {
      sql += ' AND is_system = 0';
    }

    sql += ' ORDER BY name ASC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = await this.adapter.query<Record<string, unknown>>(sql, params);
    return rows.map((row) => this.rowToAttribute(row));
  }

  /**
   * Update attribute
   */
  async updateAttribute(
    id: string,
    updates: Partial<Omit<AdminAttributeCreateInput, 'tenant_id'>>
  ): Promise<AdminAttribute | null> {
    const existing = await this.getAttribute(id);
    if (!existing || existing.is_system) {
      return null;
    }

    const now = getCurrentTimestamp();
    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.display_name !== undefined) {
      setClauses.push('display_name = ?');
      params.push(updates.display_name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      params.push(updates.description);
    }
    if (updates.allowed_values !== undefined) {
      setClauses.push('allowed_values_json = ?');
      params.push(JSON.stringify(updates.allowed_values));
    }
    if (updates.min_value !== undefined) {
      setClauses.push('min_value = ?');
      params.push(updates.min_value);
    }
    if (updates.max_value !== undefined) {
      setClauses.push('max_value = ?');
      params.push(updates.max_value);
    }
    if (updates.regex_pattern !== undefined) {
      setClauses.push('regex_pattern = ?');
      params.push(updates.regex_pattern);
    }
    if (updates.is_required !== undefined) {
      setClauses.push('is_required = ?');
      params.push(updates.is_required ? 1 : 0);
    }
    if (updates.is_multi_valued !== undefined) {
      setClauses.push('is_multi_valued = ?');
      params.push(updates.is_multi_valued ? 1 : 0);
    }

    params.push(id);

    await this.adapter.execute(
      `UPDATE admin_attributes SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );

    return this.getAttribute(id);
  }

  /**
   * Delete attribute
   */
  async deleteAttribute(id: string): Promise<boolean> {
    const existing = await this.getAttribute(id);
    if (!existing || existing.is_system) {
      return false;
    }

    const result = await this.adapter.execute(
      'DELETE FROM admin_attributes WHERE id = ? AND is_system = 0',
      [id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Convert database row to AdminAttribute
   */
  private rowToAttribute(row: Record<string, unknown>): AdminAttribute {
    let allowedValues: string[] | null = null;
    if (row.allowed_values_json) {
      try {
        allowedValues = JSON.parse(row.allowed_values_json as string);
      } catch {
        allowedValues = null;
      }
    }

    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      name: row.name as string,
      display_name: row.display_name as string | null,
      description: row.description as string | null,
      attribute_type: row.attribute_type as AdminAttribute['attribute_type'],
      allowed_values: allowedValues,
      min_value: row.min_value as number | null,
      max_value: row.max_value as number | null,
      regex_pattern: row.regex_pattern as string | null,
      is_required: Boolean(row.is_required),
      is_multi_valued: Boolean(row.is_multi_valued),
      is_system: Boolean(row.is_system),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Convert entity to AdminAttribute
   */
  private entityToAttribute(entity: AdminAttributeEntity): AdminAttribute {
    let allowedValues: string[] | null = null;
    if (entity.allowed_values_json) {
      try {
        allowedValues = JSON.parse(entity.allowed_values_json);
      } catch {
        allowedValues = null;
      }
    }

    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      name: entity.name,
      display_name: entity.display_name,
      description: entity.description,
      attribute_type: entity.attribute_type,
      allowed_values: allowedValues,
      min_value: entity.min_value,
      max_value: entity.max_value,
      regex_pattern: entity.regex_pattern,
      is_required: entity.is_required,
      is_multi_valued: entity.is_multi_valued,
      is_system: entity.is_system,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}
