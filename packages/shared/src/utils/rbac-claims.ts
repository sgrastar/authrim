/**
 * RBAC Claims Utility
 *
 * Utilities for retrieving RBAC information to include in tokens.
 * Part of RBAC Phase 1 & 2 implementation.
 *
 * Environment Variables:
 * - RBAC_ID_TOKEN_CLAIMS: Comma-separated list of claims to include in ID Token
 *   Default: "roles,user_type,org_id,plan,org_type"
 *   Available: roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary
 *
 * - RBAC_ACCESS_TOKEN_CLAIMS: Comma-separated list of claims to include in Access Token
 *   Default: "roles,org_id,org_type"
 *   Available: roles,scoped_roles,org_id,org_type,permissions,org_context
 *
 * Usage:
 * ```typescript
 * import { getUserRBACClaims, getIDTokenRBACClaims, getAccessTokenRBACClaims } from '@authrim/shared';
 *
 * const claims = await getUserRBACClaims(env.DB, subjectId);
 * // Add to token: { ...claims }
 *
 * // Or with environment variable control:
 * const idTokenClaims = await getIDTokenRBACClaims(env.DB, subjectId, env.RBAC_ID_TOKEN_CLAIMS);
 * const accessTokenClaims = await getAccessTokenRBACClaims(env.DB, subjectId, env.RBAC_ACCESS_TOKEN_CLAIMS);
 * ```
 */

import type { D1Database } from '@cloudflare/workers-types';
import type {
  RBACTokenClaims,
  UserType,
  PlanType,
  OrganizationType,
  ScopeType,
  TokenOrgInfo,
  TokenScopedRole,
  RelationshipsSummary,
  IDTokenClaimKey,
  AccessTokenClaimKey,
} from '../types/rbac';
import { DEFAULT_ID_TOKEN_CLAIMS, DEFAULT_ACCESS_TOKEN_CLAIMS } from '../types/rbac';

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
 * When claimsConfig is provided, it controls which claims are included.
 * Available claims: roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @param claimsConfig - Optional comma-separated list of claims (RBAC_ID_TOKEN_CLAIMS env var)
 * @returns Claims for ID Token
 */
export async function getIDTokenRBACClaims(
  db: D1Database,
  subjectId: string,
  claimsConfig?: string
): Promise<Partial<RBACTokenClaims>> {
  // If claimsConfig is provided, use the configurable version
  if (claimsConfig !== undefined) {
    return getIDTokenRBACClaimsConfigurable(db, subjectId, claimsConfig);
  }
  // Otherwise, use the legacy behavior for backward compatibility
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
 * @param claimsConfig - Optional comma-separated list of claims to include (env var)
 * @returns Claims for Access Token
 */
export async function getAccessTokenRBACClaims(
  db: D1Database,
  subjectId: string,
  claimsConfig?: string
): Promise<Partial<RBACTokenClaims>> {
  const enabledClaims = parseClaimsConfig<AccessTokenClaimKey>(
    claimsConfig,
    DEFAULT_ACCESS_TOKEN_CLAIMS
  );

  const claims: Partial<RBACTokenClaims> = {};

  // Determine what data to fetch based on enabled claims
  const needsRoles = enabledClaims.includes('roles');
  const needsScopedRoles = enabledClaims.includes('scoped_roles');
  const needsOrgInfo = enabledClaims.includes('org_id') || enabledClaims.includes('org_type');
  const needsPermissions = enabledClaims.includes('permissions');

  // Fetch required data in parallel
  const [roles, scopedRoles, orgInfo, permissions] = await Promise.all([
    needsRoles ? resolveEffectiveRoles(db, subjectId) : Promise.resolve([]),
    needsScopedRoles ? resolveScopedRoles(db, subjectId) : Promise.resolve([]),
    needsOrgInfo ? resolveOrganizationInfo(db, subjectId) : Promise.resolve(null),
    needsPermissions ? resolvePermissions(db, subjectId) : Promise.resolve([]),
  ]);

  // Add claims based on configuration
  if (needsRoles && roles.length > 0) {
    claims.authrim_roles = roles;
  }

  if (needsScopedRoles && scopedRoles.length > 0) {
    claims.authrim_scoped_roles = scopedRoles;
  }

  if (orgInfo) {
    if (enabledClaims.includes('org_id')) {
      claims.authrim_org_id = orgInfo.org_id;
    }
    if (enabledClaims.includes('org_type')) {
      claims.authrim_org_type = orgInfo.org_type;
    }
  }

  if (needsPermissions && permissions.length > 0) {
    claims.authrim_permissions = permissions;
  }

  // org_context is not populated here - it requires request context (acting_as parameter)
  // This will be handled at the token endpoint level

  return claims;
}

// =============================================================================
// Phase 2: Additional Data Resolution Functions
// =============================================================================

/**
 * Get user's scoped roles with full scope information
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Array of scoped roles
 */
export async function resolveScopedRoles(
  db: D1Database,
  subjectId: string
): Promise<TokenScopedRole[]> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .prepare(
      `SELECT r.name, ra.scope_type, ra.scope_target
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY r.name ASC`
    )
    .bind(subjectId, now)
    .all<{ name: string; scope_type: string; scope_target: string }>();

  return result.results.map((r) => ({
    name: r.name,
    scope: r.scope_type as ScopeType,
    ...(r.scope_target && { scopeTarget: r.scope_target }),
  }));
}

/**
 * Get all organizations the user belongs to
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Array of organization info
 */
export async function resolveAllOrganizations(
  db: D1Database,
  subjectId: string
): Promise<TokenOrgInfo[]> {
  const result = await db
    .prepare(
      `SELECT o.id, o.name, o.org_type, m.is_primary
       FROM organizations o
       JOIN subject_org_membership m ON o.id = m.org_id
       WHERE m.subject_id = ? AND o.is_active = 1
       ORDER BY m.is_primary DESC, o.name ASC`
    )
    .bind(subjectId)
    .all<{ id: string; name: string; org_type: string; is_primary: number }>();

  return result.results.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.org_type as OrganizationType,
    is_primary: r.is_primary === 1,
  }));
}

/**
 * Get relationships summary (parent/child IDs)
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Relationships summary
 */
export async function resolveRelationshipsSummary(
  db: D1Database,
  subjectId: string
): Promise<RelationshipsSummary> {
  const now = Math.floor(Date.now() / 1000);

  // Fetch parent_child relationships where user is parent or child
  const result = await db
    .prepare(
      `SELECT relationship_type, from_id, to_id
       FROM relationships
       WHERE (from_id = ? OR to_id = ?)
         AND relationship_type = 'parent_child'
         AND (expires_at IS NULL OR expires_at > ?)`
    )
    .bind(subjectId, subjectId, now)
    .all<{ relationship_type: string; from_id: string; to_id: string }>();

  const childrenIds: string[] = [];
  const parentIds: string[] = [];

  for (const r of result.results) {
    if (r.from_id === subjectId) {
      // User is the parent
      childrenIds.push(r.to_id);
    } else {
      // User is the child
      parentIds.push(r.from_id);
    }
  }

  return {
    children_ids: childrenIds,
    parent_ids: parentIds,
  };
}

/**
 * Get resolved permissions from user's roles
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Array of permission strings
 */
export async function resolvePermissions(db: D1Database, subjectId: string): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .prepare(
      `SELECT DISTINCT r.permissions_json
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
         AND r.permissions_json IS NOT NULL
         AND r.permissions_json != '[]'`
    )
    .bind(subjectId, now)
    .all<{ permissions_json: string }>();

  const permissionsSet = new Set<string>();

  for (const r of result.results) {
    try {
      const perms = JSON.parse(r.permissions_json) as string[];
      for (const p of perms) {
        permissionsSet.add(p);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return Array.from(permissionsSet).sort();
}

/**
 * Get primary organization name
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Organization name or null
 */
export async function resolveOrganizationName(
  db: D1Database,
  subjectId: string
): Promise<string | null> {
  const result = await db
    .prepare(
      `SELECT o.name
       FROM organizations o
       JOIN subject_org_membership m ON o.id = m.org_id
       WHERE m.subject_id = ? AND m.is_primary = 1 AND o.is_active = 1`
    )
    .bind(subjectId)
    .first<{ name: string }>();

  return result?.name ?? null;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse comma-separated claims configuration string
 *
 * @param config - Comma-separated claims string from environment variable
 * @param defaults - Default claims if config is not provided
 * @returns Array of enabled claim keys
 */
function parseClaimsConfig<T extends string>(config: string | undefined, defaults: T[]): T[] {
  if (!config || config.trim() === '') {
    return defaults;
  }

  return config
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as T[];
}

/**
 * Get RBAC claims for ID Token with environment variable control
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @param claimsConfig - Optional comma-separated list of claims to include (env var)
 * @returns Claims for ID Token
 */
export async function getIDTokenRBACClaimsConfigurable(
  db: D1Database,
  subjectId: string,
  claimsConfig?: string
): Promise<Partial<RBACTokenClaims>> {
  const enabledClaims = parseClaimsConfig<IDTokenClaimKey>(claimsConfig, DEFAULT_ID_TOKEN_CLAIMS);

  const claims: Partial<RBACTokenClaims> = {};

  // Determine what data to fetch based on enabled claims
  const needsRoles = enabledClaims.includes('roles');
  const needsScopedRoles = enabledClaims.includes('scoped_roles');
  const needsUserType = enabledClaims.includes('user_type');
  const needsOrgId = enabledClaims.includes('org_id');
  const needsOrgName = enabledClaims.includes('org_name');
  const needsPlan = enabledClaims.includes('plan');
  const needsOrgType = enabledClaims.includes('org_type');
  const needsOrgs = enabledClaims.includes('orgs');
  const needsRelationships = enabledClaims.includes('relationships_summary');

  // Determine if we need basic org info
  const needsBasicOrgInfo = needsOrgId || needsPlan || needsOrgType;

  // Fetch required data in parallel
  const [roles, scopedRoles, userType, orgInfo, orgName, orgs, relationships] = await Promise.all([
    needsRoles ? resolveEffectiveRoles(db, subjectId) : Promise.resolve([]),
    needsScopedRoles ? resolveScopedRoles(db, subjectId) : Promise.resolve([]),
    needsUserType ? resolveUserType(db, subjectId) : Promise.resolve('end_user' as UserType),
    needsBasicOrgInfo ? resolveOrganizationInfo(db, subjectId) : Promise.resolve(null),
    needsOrgName ? resolveOrganizationName(db, subjectId) : Promise.resolve(null),
    needsOrgs ? resolveAllOrganizations(db, subjectId) : Promise.resolve([]),
    needsRelationships
      ? resolveRelationshipsSummary(db, subjectId)
      : Promise.resolve({ children_ids: [], parent_ids: [] }),
  ]);

  // Add claims based on configuration
  if (needsRoles && roles.length > 0) {
    claims.authrim_roles = roles;
  }

  if (needsScopedRoles && scopedRoles.length > 0) {
    claims.authrim_scoped_roles = scopedRoles;
  }

  if (needsUserType) {
    claims.authrim_user_type = userType;
  }

  if (orgInfo) {
    if (needsOrgId) {
      claims.authrim_org_id = orgInfo.org_id;
    }
    if (needsPlan) {
      claims.authrim_plan = orgInfo.plan;
    }
    if (needsOrgType) {
      claims.authrim_org_type = orgInfo.org_type;
    }
  }

  if (needsOrgName && orgName) {
    claims.authrim_org_name = orgName;
  }

  if (needsOrgs && orgs.length > 0) {
    claims.authrim_orgs = orgs;
  }

  if (
    needsRelationships &&
    (relationships.children_ids.length > 0 || relationships.parent_ids.length > 0)
  ) {
    claims.authrim_relationships_summary = relationships;
  }

  return claims;
}
