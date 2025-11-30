/**
 * RBAC Claims Utility
 *
 * Utilities for retrieving RBAC information to include in tokens.
 * Part of RBAC Phase 1 implementation.
 *
 * Usage:
 * ```typescript
 * import { getUserRBACClaims } from '@authrim/shared';
 *
 * const claims = await getUserRBACClaims(env.DB, subjectId);
 * // Add to token: { ...claims }
 * ```
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { RBACTokenClaims, UserType, PlanType, OrganizationType } from '../types/rbac';

/**
 * Resolved organization information
 */
interface ResolvedOrgInfo {
  org_id: string;
  plan: PlanType;
  org_type: OrganizationType;
}

/**
 * Get user's effective roles from role_assignments
 *
 * Returns distinct role names that are:
 * 1. Assigned to the user
 * 2. Not expired
 * 3. Any scope (global, org, resource)
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Array of role names
 */
export async function resolveEffectiveRoles(db: D1Database, subjectId: string): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000); // UNIX seconds

  const result = await db
    .prepare(
      `SELECT DISTINCT r.name
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY r.name ASC`
    )
    .bind(subjectId, now)
    .all<{ name: string }>();

  return result.results.map((r) => r.name);
}

/**
 * Get user's primary organization information
 *
 * Returns the primary organization for the user based on
 * subject_org_membership.is_primary = 1.
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Organization info or null if no primary org
 */
export async function resolveOrganizationInfo(
  db: D1Database,
  subjectId: string
): Promise<ResolvedOrgInfo | null> {
  const result = await db
    .prepare(
      `SELECT o.id as org_id, o.plan, o.org_type
       FROM organizations o
       JOIN subject_org_membership m ON o.id = m.org_id
       WHERE m.subject_id = ? AND m.is_primary = 1 AND o.is_active = 1`
    )
    .bind(subjectId)
    .first<{ org_id: string; plan: string; org_type: string }>();

  if (!result) {
    return null;
  }

  return {
    org_id: result.org_id,
    plan: result.plan as PlanType,
    org_type: result.org_type as OrganizationType,
  };
}

/**
 * Get user's user_type from users table
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns User type or 'end_user' as default
 */
export async function resolveUserType(db: D1Database, subjectId: string): Promise<UserType> {
  const result = await db
    .prepare('SELECT user_type FROM users WHERE id = ?')
    .bind(subjectId)
    .first<{ user_type: string }>();

  return (result?.user_type as UserType) || 'end_user';
}

/**
 * Get all RBAC claims for a user
 *
 * This is the main function to call when generating tokens.
 * Returns all RBAC-related claims with authrim_ prefix.
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns RBACTokenClaims object
 *
 * @example
 * ```typescript
 * const rbacClaims = await getUserRBACClaims(env.DB, userId);
 * // Result:
 * // {
 * //   authrim_roles: ['end_user', 'org_admin'],
 * //   authrim_user_type: 'enterprise_admin',
 * //   authrim_org_id: 'org_123',
 * //   authrim_plan: 'professional',
 * //   authrim_org_type: 'enterprise'
 * // }
 * ```
 */
export async function getUserRBACClaims(
  db: D1Database,
  subjectId: string
): Promise<RBACTokenClaims> {
  // Fetch all RBAC info in parallel
  const [roles, orgInfo, userType] = await Promise.all([
    resolveEffectiveRoles(db, subjectId),
    resolveOrganizationInfo(db, subjectId),
    resolveUserType(db, subjectId),
  ]);

  const claims: RBACTokenClaims = {};

  // Add roles if any exist
  if (roles.length > 0) {
    claims.authrim_roles = roles;
  }

  // Add user type
  claims.authrim_user_type = userType;

  // Add organization info if user has a primary org
  if (orgInfo) {
    claims.authrim_org_id = orgInfo.org_id;
    claims.authrim_plan = orgInfo.plan;
    claims.authrim_org_type = orgInfo.org_type;
  }

  return claims;
}

/**
 * Get RBAC claims for ID Token
 *
 * ID Token includes all RBAC claims:
 * - authrim_roles
 * - authrim_user_type
 * - authrim_org_id
 * - authrim_plan
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Claims for ID Token
 */
export async function getIDTokenRBACClaims(
  db: D1Database,
  subjectId: string
): Promise<Partial<RBACTokenClaims>> {
  return getUserRBACClaims(db, subjectId);
}

/**
 * Get RBAC claims for Access Token
 *
 * Access Token includes:
 * - authrim_roles
 * - authrim_org_id
 * - authrim_org_type
 *
 * Note: user_type and plan are omitted from access token
 * as they are primarily for client-side display purposes.
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Claims for Access Token
 */
export async function getAccessTokenRBACClaims(
  db: D1Database,
  subjectId: string
): Promise<Pick<RBACTokenClaims, 'authrim_roles' | 'authrim_org_id' | 'authrim_org_type'>> {
  const [roles, orgInfo] = await Promise.all([
    resolveEffectiveRoles(db, subjectId),
    resolveOrganizationInfo(db, subjectId),
  ]);

  const claims: Pick<RBACTokenClaims, 'authrim_roles' | 'authrim_org_id' | 'authrim_org_type'> = {};

  if (roles.length > 0) {
    claims.authrim_roles = roles;
  }

  if (orgInfo) {
    claims.authrim_org_id = orgInfo.org_id;
    claims.authrim_org_type = orgInfo.org_type;
  }

  return claims;
}
