/**
 * Admin Relationship Repository
 *
 * Repository for Admin relationships stored in DB_ADMIN.
 * Manages ReBAC (Relationship-Based Access Control) for Admin users.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';

/**
 * Admin relationship entity
 */
export interface AdminRelationshipEntity extends BaseEntity {
  tenant_id: string;
  relationship_type: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  permission_level: string;
  is_transitive: boolean;
  expires_at: number | null;
  is_bidirectional: boolean;
  metadata_json: string | null;
  created_by: string | null;
}

/**
 * Admin relationship (API model)
 */
export interface AdminRelationship {
  id: string;
  tenant_id: string;
  relationship_type: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  permission_level: 'full' | 'limited' | 'read_only';
  is_transitive: boolean;
  expires_at: number | null;
  is_bidirectional: boolean;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Admin relationship create input
 */
export interface AdminRelationshipCreateInput {
  tenant_id?: string;
  relationship_type: string;
  from_type?: string;
  from_id: string;
  to_type?: string;
  to_id: string;
  permission_level?: 'full' | 'limited' | 'read_only';
  is_transitive?: boolean;
  expires_at?: number;
  is_bidirectional?: boolean;
  metadata?: Record<string, unknown>;
  created_by?: string;
}

/**
 * Admin Relationship Repository
 */
export class AdminRelationshipRepository extends BaseRepository<AdminRelationshipEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_relationships',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'relationship_type',
        'from_type',
        'from_id',
        'to_type',
        'to_id',
        'permission_level',
        'is_transitive',
        'expires_at',
        'is_bidirectional',
        'metadata_json',
        'created_by',
      ],
    });
  }

  /**
   * Create a new Admin relationship
   */
  async createRelationship(input: AdminRelationshipCreateInput): Promise<AdminRelationship> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const entity: AdminRelationshipEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      relationship_type: input.relationship_type,
      from_type: input.from_type ?? 'admin_user',
      from_id: input.from_id,
      to_type: input.to_type ?? 'admin_user',
      to_id: input.to_id,
      permission_level: input.permission_level ?? 'full',
      is_transitive: input.is_transitive ?? false,
      expires_at: input.expires_at ?? null,
      is_bidirectional: input.is_bidirectional ?? false,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      created_by: input.created_by ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_relationships (
        id, tenant_id, relationship_type, from_type, from_id,
        to_type, to_id, permission_level, is_transitive, expires_at,
        is_bidirectional, metadata_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entity.id,
      entity.tenant_id,
      entity.relationship_type,
      entity.from_type,
      entity.from_id,
      entity.to_type,
      entity.to_id,
      entity.permission_level,
      entity.is_transitive ? 1 : 0,
      entity.expires_at,
      entity.is_bidirectional ? 1 : 0,
      entity.metadata_json,
      entity.created_by,
      entity.created_at,
      entity.updated_at,
    ]);

    return this.entityToRelationship(entity);
  }

  /**
   * Get relationship by ID
   */
  async getRelationship(id: string): Promise<AdminRelationship | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_relationships WHERE id = ?',
      [id]
    );
    return row ? this.rowToRelationship(row) : null;
  }

  /**
   * Get all relationships for an Admin user (as source)
   */
  async getRelationshipsFrom(
    adminUserId: string,
    options?: { relationshipType?: string }
  ): Promise<AdminRelationship[]> {
    const now = getCurrentTimestamp();
    let sql = `
      SELECT * FROM admin_relationships
      WHERE from_type = 'admin_user' AND from_id = ?
      AND (expires_at IS NULL OR expires_at > ?)
    `;
    const params: unknown[] = [adminUserId, now];

    if (options?.relationshipType) {
      sql += ' AND relationship_type = ?';
      params.push(options.relationshipType);
    }

    sql += ' ORDER BY relationship_type, created_at DESC';

    const rows = await this.adapter.query<Record<string, unknown>>(sql, params);
    return rows.map((row) => this.rowToRelationship(row));
  }

  /**
   * Get all relationships for an Admin user (as target)
   */
  async getRelationshipsTo(
    adminUserId: string,
    options?: { relationshipType?: string }
  ): Promise<AdminRelationship[]> {
    const now = getCurrentTimestamp();
    let sql = `
      SELECT * FROM admin_relationships
      WHERE to_type = 'admin_user' AND to_id = ?
      AND (expires_at IS NULL OR expires_at > ?)
    `;
    const params: unknown[] = [adminUserId, now];

    if (options?.relationshipType) {
      sql += ' AND relationship_type = ?';
      params.push(options.relationshipType);
    }

    sql += ' ORDER BY relationship_type, created_at DESC';

    const rows = await this.adapter.query<Record<string, unknown>>(sql, params);
    return rows.map((row) => this.rowToRelationship(row));
  }

  /**
   * Check if a relationship exists
   */
  async hasRelationship(
    fromId: string,
    toId: string,
    relationshipType: string,
    options?: { fromType?: string; toType?: string }
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const fromType = options?.fromType ?? 'admin_user';
    const toType = options?.toType ?? 'admin_user';

    const row = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_relationships
       WHERE relationship_type = ? AND from_type = ? AND from_id = ?
       AND to_type = ? AND to_id = ?
       AND (expires_at IS NULL OR expires_at > ?)`,
      [relationshipType, fromType, fromId, toType, toId, now]
    );

    return (row?.count ?? 0) > 0;
  }

  /**
   * List all relationships for a tenant
   */
  async listRelationships(
    tenantId: string,
    options?: {
      relationshipType?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ relationships: AdminRelationship[]; total: number }> {
    const now = getCurrentTimestamp();
    let countSql = `
      SELECT COUNT(*) as count FROM admin_relationships
      WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)
    `;
    let sql = `
      SELECT * FROM admin_relationships
      WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)
    `;
    const params: unknown[] = [tenantId, now];

    if (options?.relationshipType) {
      countSql += ' AND relationship_type = ?';
      sql += ' AND relationship_type = ?';
      params.push(options.relationshipType);
    }

    sql += ' ORDER BY created_at DESC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const countResult = await this.adapter.queryOne<{ count: number }>(
      countSql,
      params.slice(0, options?.relationshipType ? 3 : 2)
    );
    const total = countResult?.count ?? 0;

    const rows = await this.adapter.query<Record<string, unknown>>(sql, params);
    const relationships = rows.map((row) => this.rowToRelationship(row));

    return { relationships, total };
  }

  /**
   * Delete relationship
   */
  async deleteRelationship(id: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM admin_relationships WHERE id = ?', [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete all relationships for an Admin user
   */
  async deleteAllByUser(adminUserId: string): Promise<number> {
    const result = await this.adapter.execute(
      `DELETE FROM admin_relationships
       WHERE (from_type = 'admin_user' AND from_id = ?)
       OR (to_type = 'admin_user' AND to_id = ?)`,
      [adminUserId, adminUserId]
    );
    return result.rowsAffected;
  }

  /**
   * Cleanup expired relationships
   */
  async cleanupExpiredRelationships(): Promise<number> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'DELETE FROM admin_relationships WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now]
    );
    return result.rowsAffected;
  }

  /**
   * Convert database row to AdminRelationship
   */
  private rowToRelationship(row: Record<string, unknown>): AdminRelationship {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(row.metadata_json as string);
      } catch {
        metadata = null;
      }
    }

    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      relationship_type: row.relationship_type as string,
      from_type: row.from_type as string,
      from_id: row.from_id as string,
      to_type: row.to_type as string,
      to_id: row.to_id as string,
      permission_level: row.permission_level as AdminRelationship['permission_level'],
      is_transitive: Boolean(row.is_transitive),
      expires_at: row.expires_at as number | null,
      is_bidirectional: Boolean(row.is_bidirectional),
      metadata,
      created_by: row.created_by as string | null,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Convert entity to AdminRelationship
   */
  private entityToRelationship(entity: AdminRelationshipEntity): AdminRelationship {
    let metadata: Record<string, unknown> | null = null;
    if (entity.metadata_json) {
      try {
        metadata = JSON.parse(entity.metadata_json);
      } catch {
        metadata = null;
      }
    }

    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      relationship_type: entity.relationship_type,
      from_type: entity.from_type,
      from_id: entity.from_id,
      to_type: entity.to_type,
      to_id: entity.to_id,
      permission_level: entity.permission_level as AdminRelationship['permission_level'],
      is_transitive: entity.is_transitive,
      expires_at: entity.expires_at,
      is_bidirectional: entity.is_bidirectional,
      metadata,
      created_by: entity.created_by,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}
