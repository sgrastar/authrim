/**
 * Relationship Store Implementation
 *
 * Manages subject-subject (and future org-org) relationships in D1.
 * Part of RBAC Phase 1 implementation.
 *
 * Phase 1 focuses on subject-subject relationships (parent_child, guardian, delegate, manager).
 * The from_type/to_type fields are prepared for future org-org relationships (reseller_of).
 */

import type { IStorageAdapter } from '../interfaces';
import type { Relationship, RelationshipRow, IRelationshipStore } from '../interfaces';

/**
 * Convert D1 row to Relationship entity
 */
function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    ...row,
    expires_at: row.expires_at ?? undefined,
    is_bidirectional: row.is_bidirectional === 1,
    metadata_json: row.metadata_json ?? undefined,
  };
}

/**
 * RelationshipStore implementation (D1-based)
 */
export class RelationshipStore implements IRelationshipStore {
  constructor(private adapter: IStorageAdapter) {}

  async getRelationship(relationshipId: string): Promise<Relationship | null> {
    const results = await this.adapter.query<RelationshipRow>(
      'SELECT * FROM relationships WHERE id = ?',
      [relationshipId]
    );
    return results[0] ? rowToRelationship(results[0]) : null;
  }

  async createRelationship(
    relationship: Omit<Relationship, 'id' | 'created_at' | 'updated_at'>
  ): Promise<Relationship> {
    const id = `rel_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Math.floor(Date.now() / 1000); // UNIX seconds

    const newRelationship: Relationship = {
      id,
      tenant_id: relationship.tenant_id,
      relationship_type: relationship.relationship_type,
      from_type: relationship.from_type,
      from_id: relationship.from_id,
      to_type: relationship.to_type,
      to_id: relationship.to_id,
      permission_level: relationship.permission_level,
      expires_at: relationship.expires_at,
      is_bidirectional: relationship.is_bidirectional,
      metadata_json: relationship.metadata_json,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO relationships (
        id, tenant_id, relationship_type, from_type, from_id, to_type, to_id,
        permission_level, expires_at, is_bidirectional, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newRelationship.id,
        newRelationship.tenant_id,
        newRelationship.relationship_type,
        newRelationship.from_type,
        newRelationship.from_id,
        newRelationship.to_type,
        newRelationship.to_id,
        newRelationship.permission_level,
        newRelationship.expires_at ?? null,
        newRelationship.is_bidirectional ? 1 : 0,
        newRelationship.metadata_json ?? null,
        newRelationship.created_at,
        newRelationship.updated_at,
      ]
    );

    return newRelationship;
  }

  async updateRelationship(
    relationshipId: string,
    updates: Partial<Relationship>
  ): Promise<Relationship> {
    const existing = await this.getRelationship(relationshipId);
    if (!existing) {
      throw new Error(`Relationship not found: ${relationshipId}`);
    }

    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    const updated: Relationship = {
      ...existing,
      ...updates,
      id: relationshipId, // Prevent changing ID
      // Prevent changing relationship structure (these define the relationship)
      tenant_id: existing.tenant_id,
      relationship_type: existing.relationship_type,
      from_type: existing.from_type,
      from_id: existing.from_id,
      to_type: existing.to_type,
      to_id: existing.to_id,
      updated_at: now,
    };

    await this.adapter.execute(
      `UPDATE relationships SET
        permission_level = ?, expires_at = ?, is_bidirectional = ?,
        metadata_json = ?, updated_at = ?
      WHERE id = ?`,
      [
        updated.permission_level,
        updated.expires_at ?? null,
        updated.is_bidirectional ? 1 : 0,
        updated.metadata_json ?? null,
        updated.updated_at,
        relationshipId,
      ]
    );

    return updated;
  }

  async deleteRelationship(relationshipId: string): Promise<void> {
    await this.adapter.execute('DELETE FROM relationships WHERE id = ?', [relationshipId]);
  }

  // ==========================================================================
  // Relationship queries
  // ==========================================================================

  async listRelationshipsFrom(
    fromType: string,
    fromId: string,
    options?: { relationshipType?: string; includeExpired?: boolean }
  ): Promise<Relationship[]> {
    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    let sql = 'SELECT * FROM relationships WHERE from_type = ? AND from_id = ?';
    const params: unknown[] = [fromType, fromId];

    if (options?.relationshipType) {
      sql += ' AND relationship_type = ?';
      params.push(options.relationshipType);
    }

    if (!options?.includeExpired) {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(now);
    }

    sql += ' ORDER BY created_at ASC';

    const results = await this.adapter.query<RelationshipRow>(sql, params);
    return results.map(rowToRelationship);
  }

  async listRelationshipsTo(
    toType: string,
    toId: string,
    options?: { relationshipType?: string; includeExpired?: boolean }
  ): Promise<Relationship[]> {
    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    let sql = 'SELECT * FROM relationships WHERE to_type = ? AND to_id = ?';
    const params: unknown[] = [toType, toId];

    if (options?.relationshipType) {
      sql += ' AND relationship_type = ?';
      params.push(options.relationshipType);
    }

    if (!options?.includeExpired) {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(now);
    }

    sql += ' ORDER BY created_at ASC';

    const results = await this.adapter.query<RelationshipRow>(sql, params);
    return results.map(rowToRelationship);
  }

  async findRelationship(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    relationshipType: string
  ): Promise<Relationship | null> {
    const results = await this.adapter.query<RelationshipRow>(
      `SELECT * FROM relationships
       WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?
         AND relationship_type = ?`,
      [fromType, fromId, toType, toId, relationshipType]
    );
    return results[0] ? rowToRelationship(results[0]) : null;
  }

  // ==========================================================================
  // Parent-child convenience methods
  // ==========================================================================

  async getParentSubjects(childSubjectId: string): Promise<Relationship[]> {
    return this.listRelationshipsTo('subject', childSubjectId, {
      relationshipType: 'parent_child',
      includeExpired: false,
    });
  }

  async getChildSubjects(parentSubjectId: string): Promise<Relationship[]> {
    return this.listRelationshipsFrom('subject', parentSubjectId, {
      relationshipType: 'parent_child',
      includeExpired: false,
    });
  }
}
