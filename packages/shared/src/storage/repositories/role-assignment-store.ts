/**
 * Role Assignment Store Implementation
 *
 * Manages role assignments with scope support (global, org, resource) in D1.
 * Part of RBAC Phase 1 implementation.
 */

import type { IStorageAdapter } from '../interfaces';
import type {
  RoleAssignment,
  RoleAssignmentRow,
  IRoleAssignmentStore,
  ScopeType,
} from '../interfaces';

/**
 * Convert D1 row to RoleAssignment entity
 */
function rowToRoleAssignment(row: RoleAssignmentRow): RoleAssignment {
  return {
    ...row,
    expires_at: row.expires_at ?? undefined,
    assigned_by: row.assigned_by ?? undefined,
    metadata_json: row.metadata_json ?? undefined,
  };
}

/**
 * RoleAssignmentStore implementation (D1-based)
 */
export class RoleAssignmentStore implements IRoleAssignmentStore {
  constructor(private adapter: IStorageAdapter) {}

  async getRoleAssignment(assignmentId: string): Promise<RoleAssignment | null> {
    const results = await this.adapter.query<RoleAssignmentRow>(
      'SELECT * FROM role_assignments WHERE id = ?',
      [assignmentId]
    );
    return results[0] ? rowToRoleAssignment(results[0]) : null;
  }

  async createRoleAssignment(
    assignment: Omit<RoleAssignment, 'id' | 'created_at' | 'updated_at'>
  ): Promise<RoleAssignment> {
    const id = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Math.floor(Date.now() / 1000); // UNIX seconds

    const newAssignment: RoleAssignment = {
      id,
      tenant_id: assignment.tenant_id,
      subject_id: assignment.subject_id,
      role_id: assignment.role_id,
      scope_type: assignment.scope_type,
      scope_target: assignment.scope_target,
      expires_at: assignment.expires_at,
      assigned_by: assignment.assigned_by,
      metadata_json: assignment.metadata_json,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO role_assignments (
        id, tenant_id, subject_id, role_id, scope_type, scope_target,
        expires_at, assigned_by, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newAssignment.id,
        newAssignment.tenant_id,
        newAssignment.subject_id,
        newAssignment.role_id,
        newAssignment.scope_type,
        newAssignment.scope_target,
        newAssignment.expires_at ?? null,
        newAssignment.assigned_by ?? null,
        newAssignment.metadata_json ?? null,
        newAssignment.created_at,
        newAssignment.updated_at,
      ]
    );

    return newAssignment;
  }

  async updateRoleAssignment(
    assignmentId: string,
    updates: Partial<RoleAssignment>
  ): Promise<RoleAssignment> {
    const existing = await this.getRoleAssignment(assignmentId);
    if (!existing) {
      throw new Error(`Role assignment not found: ${assignmentId}`);
    }

    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    const updated: RoleAssignment = {
      ...existing,
      ...updates,
      id: assignmentId, // Prevent changing ID
      updated_at: now,
    };

    await this.adapter.execute(
      `UPDATE role_assignments SET
        scope_type = ?, scope_target = ?, expires_at = ?,
        metadata_json = ?, updated_at = ?
      WHERE id = ?`,
      [
        updated.scope_type,
        updated.scope_target,
        updated.expires_at ?? null,
        updated.metadata_json ?? null,
        updated.updated_at,
        assignmentId,
      ]
    );

    return updated;
  }

  async deleteRoleAssignment(assignmentId: string): Promise<void> {
    await this.adapter.execute('DELETE FROM role_assignments WHERE id = ?', [assignmentId]);
  }

  // ==========================================================================
  // Assignment queries
  // ==========================================================================

  async listAssignmentsBySubject(
    subjectId: string,
    options?: { scopeType?: ScopeType; scopeTarget?: string; includeExpired?: boolean }
  ): Promise<RoleAssignment[]> {
    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    let sql = 'SELECT * FROM role_assignments WHERE subject_id = ?';
    const params: unknown[] = [subjectId];

    if (options?.scopeType) {
      sql += ' AND scope_type = ?';
      params.push(options.scopeType);
    }

    if (options?.scopeTarget !== undefined) {
      sql += ' AND scope_target = ?';
      params.push(options.scopeTarget);
    }

    if (!options?.includeExpired) {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(now);
    }

    sql += ' ORDER BY created_at ASC';

    const results = await this.adapter.query<RoleAssignmentRow>(sql, params);
    return results.map(rowToRoleAssignment);
  }

  async listAssignmentsByRole(
    roleId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<RoleAssignment[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const results = await this.adapter.query<RoleAssignmentRow>(
      `SELECT * FROM role_assignments WHERE role_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [roleId, limit, offset]
    );
    return results.map(rowToRoleAssignment);
  }

  async getEffectiveRoles(
    subjectId: string,
    options?: { scopeType?: ScopeType; scopeTarget?: string }
  ): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    let sql = `
      SELECT DISTINCT r.name
      FROM role_assignments ra
      JOIN roles r ON ra.role_id = r.id
      WHERE ra.subject_id = ?
        AND (ra.expires_at IS NULL OR ra.expires_at > ?)
    `;
    const params: unknown[] = [subjectId, now];

    if (options?.scopeType) {
      if (options.scopeType === 'global') {
        // For global scope, only include global assignments
        sql += ' AND ra.scope_type = ?';
        params.push('global');
      } else {
        // For org/resource scope, include both global and specific scope
        sql += ' AND (ra.scope_type = ? OR (ra.scope_type = ? AND ra.scope_target = ?))';
        params.push('global', options.scopeType, options.scopeTarget ?? '');
      }
    }

    sql += ' ORDER BY r.name ASC';

    const results = await this.adapter.query<{ name: string }>(sql, params);
    return results.map((r) => r.name);
  }

  async hasRole(
    subjectId: string,
    roleName: string,
    options?: { scopeType?: ScopeType; scopeTarget?: string }
  ): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    let sql = `
      SELECT COUNT(*) as count
      FROM role_assignments ra
      JOIN roles r ON ra.role_id = r.id
      WHERE ra.subject_id = ?
        AND r.name = ?
        AND (ra.expires_at IS NULL OR ra.expires_at > ?)
    `;
    const params: unknown[] = [subjectId, roleName, now];

    if (options?.scopeType) {
      if (options.scopeType === 'global') {
        sql += ' AND ra.scope_type = ?';
        params.push('global');
      } else {
        // Check both global and specific scope
        sql += ' AND (ra.scope_type = ? OR (ra.scope_type = ? AND ra.scope_target = ?))';
        params.push('global', options.scopeType, options.scopeTarget ?? '');
      }
    }

    const results = await this.adapter.query<{ count: number }>(sql, params);
    return (results[0]?.count ?? 0) > 0;
  }
}
