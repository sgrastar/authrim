/**
 * Role assignments written by JIT provisioning (external IdP role rules, the default role)
 */

import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import { createLogger } from '../utils/logger';
import { findTenantRole, type TenantRBACDatabases } from './tenant-rbac';
import { ROLE_TIER_BELOW_WILDCARD, roleTierCoversWildcards } from '../utils/permission-grammar';

const log = createLogger().module('JIT-ROLE-ASSIGNMENT');

function getAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'jit-role-assignment');
}

/**
 * Assign a role to a user at the given scope (JIT role rules, default role)
 *
 * The role is a tenant setting (metadata database); the assignment is the user's account data
 * (account database). See services/tenant-rbac.ts.
 *
 * @param dbs - The tenant's metadata and the user's account database
 * @param userId - User ID
 * @param roleId - Role ID to assign
 * @param scopeType - Assignment scope type ('global', 'tenant', 'group', 'resource')
 * @param scopeTarget - Assignment scope target (e.g. 'group:<id>')
 * @param tenantId - Tenant ID
 * @returns Assignment result
 */
export async function assignScopedRoleToUser(
  dbs: TenantRBACDatabases,
  userId: string,
  roleId: string,
  scopeType: string,
  scopeTarget: string,
  tenantId: string
): Promise<{
  success: boolean;
  assignment_id?: string;
  error?: string;
  /**
   * The role exists but may not be given (refused, not failed): `role_not_assignable`, or
   * `role_grant_tier_below_wildcard` (its grant tier is below what its wildcards need).
   */
  code?: 'role_not_assignable' | 'role_grant_tier_below_wildcard';
}> {
  const adapter = getAdapter(dbs.account);
  const assignmentId = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    // Check if role exists
    const roleCheck = await findTenantRole(dbs.metadata, tenantId, { id: roleId });

    if (!roleCheck) {
      return {
        success: false,
        // SECURITY: Do not expose role ID to prevent enumeration
        error: 'Role not found',
      };
    }

    // A role marked not assignable is not given, by a JIT rule either, as an
    // administrator could not grant it directly (1/0 in SQLite and D1, true/false in PostgreSQL).
    if (roleCheck.is_assignable !== 1 && roleCheck.is_assignable !== true) {
      log.warn('JIT role not assignable; skipped', { tenantId, roleId });
      return { success: false, error: 'Role not assignable', code: 'role_not_assignable' };
    }
    // A role below the tier its wildcards need is not given (roleTierCoversWildcards).
    if (!roleTierCoversWildcards(roleCheck)) {
      log.warn('JIT role below its wildcard grant tier; skipped', { tenantId, roleId });
      return {
        success: false,
        error: 'Role grant tier below its wildcards',
        code: ROLE_TIER_BELOW_WILDCARD,
      };
    }

    // Check if already assigned
    const existing = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE tenant_id = ? AND subject_id = ? AND role_id = ? AND scope_type = ? AND scope_target = ?`,
      [tenantId, userId, roleId, scopeType, scopeTarget]
    );

    if (existing) {
      return {
        success: true,
        assignment_id: existing.id,
        error: 'Already assigned',
      };
    }

    // Create assignment
    await adapter.execute(
      `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, scope_type, scope_target, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [assignmentId, tenantId, userId, roleId, scopeType, scopeTarget, now, now]
    );

    return {
      success: true,
      assignment_id: assignmentId,
    };
  } catch (error) {
    log.error('Database error in assignScopedRoleToUser', { roleId, userId }, error as Error);
    return {
      success: false,
      // SECURITY: Do not expose internal error details
      error: 'Failed to assign role',
    };
  }
}
