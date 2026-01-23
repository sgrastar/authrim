/**
 * Admin Attribute Value Repository
 *
 * Repository for Admin attribute values stored in DB_ADMIN.
 * Manages attribute value assignments to Admin users.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';

/**
 * Admin attribute value entity
 */
export interface AdminAttributeValueEntity extends BaseEntity {
  tenant_id: string;
  admin_user_id: string;
  admin_attribute_id: string;
  value: string;
  value_index: number;
  source: string;
  expires_at: number | null;
  assigned_by: string | null;
}

/**
 * Admin attribute value (API model)
 */
export interface AdminAttributeValue {
  id: string;
  tenant_id: string;
  admin_user_id: string;
  admin_attribute_id: string;
  value: string;
  value_index: number;
  source: string;
  expires_at: number | null;
  assigned_by: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Admin attribute value create input
 */
export interface AdminAttributeValueCreateInput {
  tenant_id?: string;
  admin_user_id: string;
  admin_attribute_id: string;
  value: string;
  value_index?: number;
  source?: string;
  expires_at?: number;
  assigned_by?: string;
}

/**
 * Admin Attribute Value Repository
 */
export class AdminAttributeValueRepository extends BaseRepository<AdminAttributeValueEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_attribute_values',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'admin_user_id',
        'admin_attribute_id',
        'value',
        'value_index',
        'source',
        'expires_at',
        'assigned_by',
      ],
    });
  }

  /**
   * Set attribute value for an Admin user
   */
  async setAttributeValue(input: AdminAttributeValueCreateInput): Promise<AdminAttributeValue> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const entity: AdminAttributeValueEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      admin_user_id: input.admin_user_id,
      admin_attribute_id: input.admin_attribute_id,
      value: input.value,
      value_index: input.value_index ?? 0,
      source: input.source ?? 'manual',
      expires_at: input.expires_at ?? null,
      assigned_by: input.assigned_by ?? null,
      created_at: now,
      updated_at: now,
    };

    // Use INSERT OR REPLACE to handle upsert
    const sql = `
      INSERT OR REPLACE INTO admin_attribute_values (
        id, tenant_id, admin_user_id, admin_attribute_id, value,
        value_index, source, expires_at, assigned_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entity.id,
      entity.tenant_id,
      entity.admin_user_id,
      entity.admin_attribute_id,
      entity.value,
      entity.value_index,
      entity.source,
      entity.expires_at,
      entity.assigned_by,
      entity.created_at,
      entity.updated_at,
    ]);

    return this.entityToValue(entity);
  }

  /**
   * Get all attribute values for an Admin user
   */
  async getAttributesByUser(adminUserId: string): Promise<AdminAttributeValue[]> {
    const now = getCurrentTimestamp();
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_attribute_values
       WHERE admin_user_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY admin_attribute_id, value_index`,
      [adminUserId, now]
    );
    return rows.map((row) => this.rowToValue(row));
  }

  /**
   * Get specific attribute value for an Admin user
   */
  async getAttributeValue(
    adminUserId: string,
    attributeId: string,
    valueIndex: number = 0
  ): Promise<AdminAttributeValue | null> {
    const now = getCurrentTimestamp();
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM admin_attribute_values
       WHERE admin_user_id = ? AND admin_attribute_id = ? AND value_index = ?
       AND (expires_at IS NULL OR expires_at > ?)`,
      [adminUserId, attributeId, valueIndex, now]
    );
    return row ? this.rowToValue(row) : null;
  }

  /**
   * Get Admin users by attribute value
   */
  async getUsersByAttributeValue(
    tenantId: string,
    attributeId: string,
    value: string
  ): Promise<string[]> {
    const now = getCurrentTimestamp();
    const rows = await this.adapter.query<{ admin_user_id: string }>(
      `SELECT DISTINCT admin_user_id FROM admin_attribute_values
       WHERE tenant_id = ? AND admin_attribute_id = ? AND value = ?
       AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, attributeId, value, now]
    );
    return rows.map((row) => row.admin_user_id);
  }

  /**
   * Delete attribute value
   */
  async deleteAttributeValue(
    adminUserId: string,
    attributeId: string,
    valueIndex: number = 0
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM admin_attribute_values
       WHERE admin_user_id = ? AND admin_attribute_id = ? AND value_index = ?`,
      [adminUserId, attributeId, valueIndex]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Delete all attribute values for an Admin user
   */
  async deleteAllByUser(adminUserId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_attribute_values WHERE admin_user_id = ?',
      [adminUserId]
    );
    return result.rowsAffected;
  }

  /**
   * Delete all values for a specific attribute (for all users)
   */
  async deleteAllByAttribute(attributeId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_attribute_values WHERE admin_attribute_id = ?',
      [attributeId]
    );
    return result.rowsAffected;
  }

  /**
   * Cleanup expired attribute values
   */
  async cleanupExpiredValues(): Promise<number> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'DELETE FROM admin_attribute_values WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now]
    );
    return result.rowsAffected;
  }

  /**
   * Convert database row to AdminAttributeValue
   */
  private rowToValue(row: Record<string, unknown>): AdminAttributeValue {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      admin_user_id: row.admin_user_id as string,
      admin_attribute_id: row.admin_attribute_id as string,
      value: row.value as string,
      value_index: row.value_index as number,
      source: row.source as string,
      expires_at: row.expires_at as number | null,
      assigned_by: row.assigned_by as string | null,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Convert entity to AdminAttributeValue
   */
  private entityToValue(entity: AdminAttributeValueEntity): AdminAttributeValue {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      admin_user_id: entity.admin_user_id,
      admin_attribute_id: entity.admin_attribute_id,
      value: entity.value,
      value_index: entity.value_index,
      source: entity.source,
      expires_at: entity.expires_at,
      assigned_by: entity.assigned_by,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}
