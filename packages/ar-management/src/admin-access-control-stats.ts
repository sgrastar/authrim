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
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  getLogger,
} from '@authrim/ar-lib-core';

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

/**
 * Create database adapter from context
 */
function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  return new D1Adapter({ db: c.env.DB });
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
    const adapter = createAdapter(c);

    // Execute all queries in parallel for performance
    const [rbacStats, abacStats, rebacStats, policyStats] = await Promise.all([
      // RBAC: count roles and assignments
      Promise.all([
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM roles WHERE tenant_id = ?',
          [tenantId]
        ),
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM user_roles WHERE tenant_id = ?',
          [tenantId]
        ),
      ]),

      // ABAC: count attributes (total and active)
      Promise.all([
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM user_attributes WHERE tenant_id = ?',
          [tenantId]
        ),
        adapter.queryOne<{ count: number }>(
          `SELECT COUNT(*) as count FROM user_attributes
           WHERE tenant_id = ?
           AND (expires_at IS NULL OR expires_at > ?)`,
          [tenantId, Math.floor(Date.now() / 1000)]
        ),
      ]),

      // ReBAC: count relation definitions and tuples
      Promise.all([
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM rebac_relation_definitions WHERE tenant_id = ?',
          [tenantId]
        ),
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM rebac_relationship_tuples WHERE tenant_id = ?',
          [tenantId]
        ),
      ]),

      // Policies: count total and active
      Promise.all([
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM policies WHERE tenant_id = ?',
          [tenantId]
        ),
        adapter.queryOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM policies WHERE tenant_id = ? AND is_active = 1',
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
