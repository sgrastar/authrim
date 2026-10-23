/**
 * Access Control Statistics API Endpoint
 *
 * Provides aggregated statistics for the Access Control Hub:
 * - RBAC: roles and assignments count
 * - ABAC: attributes count
 * - ReBAC: relation definitions and tuples count
 * - Policies: policy count and active status
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  countRoleAssignments,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  getLogger,
} from '@authrim/ar-lib-core';
import { tenantRBACStores } from './rbac-account-stores';

// =============================================================================
// Types
// =============================================================================

/**
 * RBAC statistics
 */
interface RBACStats {
  total_roles: number;
  total_assignments: number;
}

/**
 * ABAC statistics
 */
interface ABACStats {
  total_attributes: number;
  active_attributes: number;
}

/**
 * ReBAC statistics
 */
interface ReBACStats {
  total_definitions: number;
  total_tuples: number;
}

/**
 * Policy statistics
 */
interface PolicyStats {
  total_policies: number;
  active_policies: number;
}

/**
 * Access Control statistics response
 */
export interface AccessControlStats {
  rbac: RBACStats;
  abac: ABACStats;
  rebac: ReBACStats;
  policies: PolicyStats;
}

// =============================================================================
// Helpers
// =============================================================================

/** A count added up over the tenant's account databases. */
async function countAcross(
  accounts: DatabaseAdapter[],
  sql: string,
  params: unknown[]
): Promise<number> {
  const rows = await Promise.all(
    accounts.map((adapter) => adapter.queryOne<{ count: number | null }>(sql, params))
  );
  return rows.reduce((sum, row) => sum + Number(row?.count ?? 0), 0);
}

// =============================================================================
// Handler
// =============================================================================

/**
 * GET /api/admin/access-control/stats
 * Get aggregated statistics for access control features
 */
export async function adminAccessControlStatsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    // Definitions (roles, relation definitions, policies) are in the tenant metadata database;
    // role assignments in every account database. Verified attributes and relationships are
    // account data the Admin API still writes in the metadata database: they are counted in
    // both, each database once.
    const { metadata: adapter, accounts } = await tenantRBACStores(c, tenantId);
    const accountsAndMetadata = accounts.includes(adapter) ? accounts : [adapter, ...accounts];

    // Execute all queries in parallel for performance
    const [rbacStats, abacStats, rebacStats, policyStats] = await Promise.all([
      // RBAC: count roles and the assignments of those roles
      Promise.all([
        adapter.query<{ id: string }>('SELECT id FROM roles WHERE tenant_id = ?', [tenantId]),
        countRoleAssignments(accounts, tenantId, { per: 'assignment' }),
      ]).then(([roles, assignments]) => [
        { count: roles.length },
        { count: roles.reduce((sum, role) => sum + (assignments.get(role.id) ?? 0), 0) },
      ]),

      // ABAC: count attributes (total and active)
      Promise.all([
        countAcross(
          accountsAndMetadata,
          'SELECT COUNT(*) as count FROM user_verified_attributes WHERE tenant_id = ?',
          [tenantId]
        ).then((count) => ({ count })),
        countAcross(
          accountsAndMetadata,
          `SELECT COUNT(*) as count FROM user_verified_attributes
           WHERE tenant_id = ?
           AND (expires_at IS NULL OR expires_at > ?)`,
          [tenantId, Math.floor(Date.now() / 1000)]
        ).then((count) => ({ count })),
      ]),

      // ReBAC: count relation definitions and tuples
      Promise.all([
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM relation_definitions WHERE tenant_id = ?',
          [tenantId]
        ),
        countAcross(
          accountsAndMetadata,
          'SELECT COUNT(*) as count FROM relationships WHERE tenant_id = ?',
          [tenantId]
        ).then((count) => ({ count })),
      ]),

      // Policies: count total and active
      Promise.all([
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM policy_rules WHERE tenant_id = ?',
          [tenantId]
        ),
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM policy_rules WHERE tenant_id = ? AND enabled = 1',
          [tenantId]
        ),
      ]),
    ]);

    const stats: AccessControlStats = {
      rbac: {
        total_roles: rbacStats[0]?.count ?? 0,
        total_assignments: rbacStats[1]?.count ?? 0,
      },
      abac: {
        total_attributes: abacStats[0]?.count ?? 0,
        active_attributes: abacStats[1]?.count ?? 0,
      },
      rebac: {
        total_definitions: rebacStats[0]?.count ?? 0,
        total_tuples: rebacStats[1]?.count ?? 0,
      },
      policies: {
        total_policies: policyStats[0]?.count ?? 0,
        active_policies: policyStats[1]?.count ?? 0,
      },
    };

    return c.json(stats);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-ACCESS-CONTROL-STATS');
    log.error('Failed to get access control statistics', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
