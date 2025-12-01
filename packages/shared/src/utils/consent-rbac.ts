/**
 * Consent RBAC Utilities
 *
 * Phase 2-B: Consent Screen Enhancement
 * Utilities for retrieving RBAC information for consent screen display.
 *
 * These functions extend the base rbac-claims.ts with consent-specific logic:
 * - Organization membership validation
 * - Acting-as relationship validation
 * - Full consent screen data aggregation
 */

import type { D1Database } from '@cloudflare/workers-types';
import type {
  ConsentOrgInfo,
  ConsentActingAsInfo,
  ConsentUserInfo,
  ConsentFeatureFlags,
} from '../types/consent';
import type { RelationshipType, PermissionLevel, OrganizationType, PlanType } from '../types/rbac';
import { resolveAllOrganizations, resolveEffectiveRoles } from './rbac-claims';

// =============================================================================
// Consent RBAC Data Retrieval
// =============================================================================

/**
 * Result of getConsentRBACData
 */
export interface ConsentRBACData {
  /** All organizations the user belongs to */
  organizations: ConsentOrgInfo[];
  /** User's primary organization (null if no membership) */
  primary_org: ConsentOrgInfo | null;
  /** User's role names (from all assignments) */
  roles: string[];
}

/**
 * Get comprehensive RBAC data for consent screen
 *
 * Fetches all organization memberships, primary org, and role assignments
 * for displaying on the consent screen.
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Consent RBAC data
 */
export async function getConsentRBACData(
  db: D1Database,
  subjectId: string
): Promise<ConsentRBACData> {
  // Fetch organizations and roles in parallel
  const [orgs, roles] = await Promise.all([
    resolveAllOrganizationsWithPlan(db, subjectId),
    resolveEffectiveRoles(db, subjectId),
  ]);

  // Find primary organization
  const primaryOrg = orgs.find((o) => o.is_primary) || null;

  return {
    organizations: orgs,
    primary_org: primaryOrg,
    roles,
  };
}

/**
 * Resolve all organizations with plan information
 *
 * Extended version of resolveAllOrganizations that includes plan info
 * needed for consent screen display.
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Array of organization info with plan
 */
async function resolveAllOrganizationsWithPlan(
  db: D1Database,
  subjectId: string
): Promise<ConsentOrgInfo[]> {
  const result = await db
    .prepare(
      `SELECT o.id, o.name, o.org_type, o.plan, m.is_primary
       FROM organizations o
       JOIN subject_org_membership m ON o.id = m.org_id
       WHERE m.subject_id = ? AND o.is_active = 1
       ORDER BY m.is_primary DESC, o.name ASC`
    )
    .bind(subjectId)
    .all<{ id: string; name: string; org_type: string; plan: string; is_primary: number }>();

  return result.results.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.org_type as OrganizationType,
    is_primary: r.is_primary === 1,
    plan: r.plan as PlanType,
  }));
}

// =============================================================================
// Organization Access Validation
// =============================================================================

/**
 * Result of validateConsentOrgAccess
 */
export interface OrgAccessValidationResult {
  /** Whether access is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Organization info if valid */
  organization?: ConsentOrgInfo;
}

/**
 * Validate that a user has access to a specific organization
 *
 * Checks that:
 * 1. The organization exists and is active
 * 2. The user is a member of the organization
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @param orgId - Target organization ID
 * @returns Validation result
 */
export async function validateConsentOrgAccess(
  db: D1Database,
  subjectId: string,
  orgId: string
): Promise<OrgAccessValidationResult> {
  const result = await db
    .prepare(
      `SELECT o.id, o.name, o.org_type, o.plan, m.is_primary
       FROM organizations o
       JOIN subject_org_membership m ON o.id = m.org_id
       WHERE o.id = ? AND m.subject_id = ? AND o.is_active = 1`
    )
    .bind(orgId, subjectId)
    .first<{ id: string; name: string; org_type: string; plan: string; is_primary: number }>();

  if (!result) {
    return {
      valid: false,
      error: 'User is not a member of the specified organization',
    };
  }

  return {
    valid: true,
    organization: {
      id: result.id,
      name: result.name,
      type: result.org_type as OrganizationType,
      is_primary: result.is_primary === 1,
      plan: result.plan as PlanType,
    },
  };
}

// =============================================================================
// Acting-As Relationship Validation
// =============================================================================

/**
 * Result of validateActingAsRelationship
 */
export interface ActingAsValidationResult {
  /** Whether the acting-as relationship is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Relationship type if valid */
  relationship_type?: RelationshipType;
  /** Permission level granted if valid */
  permission_level?: PermissionLevel;
}

/**
 * Allowed relationship types for acting-as consent
 * These relationships grant the ability to act on behalf of another user
 */
const ACTING_AS_ALLOWED_RELATIONSHIPS: RelationshipType[] = [
  'parent_child',
  'guardian',
  'delegate',
];

/**
 * Validate that a user can act on behalf of another user
 *
 * Checks that:
 * 1. A valid relationship exists between the two users
 * 2. The relationship type allows acting-as (parent_child, guardian, delegate)
 * 3. The relationship has not expired
 *
 * @param db - D1 database
 * @param actorId - User who wants to act on behalf
 * @param targetId - User being acted on behalf of
 * @returns Validation result
 */
export async function validateActingAsRelationship(
  db: D1Database,
  actorId: string,
  targetId: string
): Promise<ActingAsValidationResult> {
  const now = Math.floor(Date.now() / 1000);

  // Find a valid relationship where actor can act on behalf of target
  // Actor is the "from" side (parent, guardian, delegate)
  const result = await db
    .prepare(
      `SELECT relationship_type, permission_level
       FROM relationships
       WHERE from_id = ? AND to_id = ?
         AND from_type = 'subject' AND to_type = 'subject'
         AND relationship_type IN ('parent_child', 'guardian', 'delegate')
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    )
    .bind(actorId, targetId, now)
    .first<{ relationship_type: string; permission_level: string }>();

  if (!result) {
    return {
      valid: false,
      error: 'No valid acting-as relationship exists',
    };
  }

  const relationshipType = result.relationship_type as RelationshipType;

  if (!ACTING_AS_ALLOWED_RELATIONSHIPS.includes(relationshipType)) {
    return {
      valid: false,
      error: `Relationship type '${relationshipType}' does not allow acting-as`,
    };
  }

  return {
    valid: true,
    relationship_type: relationshipType,
    permission_level: result.permission_level as PermissionLevel,
  };
}

// =============================================================================
// Acting-As User Info Retrieval
// =============================================================================

/**
 * Get information about the target user for acting-as display
 *
 * @param db - D1 database
 * @param actorId - User who is acting
 * @param targetId - User being acted on behalf of
 * @returns Acting-as info or null if relationship is invalid
 */
export async function getActingAsUserInfo(
  db: D1Database,
  actorId: string,
  targetId: string
): Promise<ConsentActingAsInfo | null> {
  // First validate the relationship
  const validation = await validateActingAsRelationship(db, actorId, targetId);

  if (!validation.valid || !validation.relationship_type || !validation.permission_level) {
    return null;
  }

  // Get target user info
  const user = await db
    .prepare(`SELECT id, email, name FROM users WHERE id = ?`)
    .bind(targetId)
    .first<{ id: string; email: string; name: string | null }>();

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name ?? undefined,
    email: user.email,
    relationship_type: validation.relationship_type,
    permission_level: validation.permission_level,
  };
}

// =============================================================================
// User Info for Consent Screen
// =============================================================================

/**
 * Get user info for consent screen display
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns User info or null if not found
 */
export async function getConsentUserInfo(
  db: D1Database,
  subjectId: string
): Promise<ConsentUserInfo | null> {
  const result = await db
    .prepare(`SELECT id, email, name, picture FROM users WHERE id = ?`)
    .bind(subjectId)
    .first<{ id: string; email: string; name: string | null; picture: string | null }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    email: result.email,
    name: result.name ?? undefined,
    picture: result.picture ?? undefined,
  };
}

// =============================================================================
// Feature Flags
// =============================================================================

/**
 * Parse consent feature flags from environment variables
 *
 * @param orgSelectorEnabled - RBAC_CONSENT_ORG_SELECTOR env var
 * @param actingAsEnabled - RBAC_CONSENT_ACTING_AS env var
 * @param showRoles - RBAC_CONSENT_SHOW_ROLES env var
 * @returns Feature flags for consent screen
 */
export function parseConsentFeatureFlags(
  orgSelectorEnabled?: string,
  actingAsEnabled?: string,
  showRoles?: string
): ConsentFeatureFlags {
  return {
    org_selector_enabled: orgSelectorEnabled === 'true',
    acting_as_enabled: actingAsEnabled === 'true',
    show_roles: showRoles === 'true',
  };
}

// =============================================================================
// Roles for Specific Organization
// =============================================================================

/**
 * Get user's roles within a specific organization
 *
 * Returns roles that are either:
 * 1. Global scope (apply to all orgs)
 * 2. Org-scoped with the target organization
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @param orgId - Target organization ID
 * @returns Array of role names
 */
export async function getRolesInOrganization(
  db: D1Database,
  subjectId: string,
  orgId: string
): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .prepare(
      `SELECT DISTINCT r.name
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
         AND (
           ra.scope_type = 'global'
           OR (ra.scope_type = 'org' AND ra.scope_target = ?)
         )
       ORDER BY r.name ASC`
    )
    .bind(subjectId, now, `org:${orgId}`)
    .all<{ name: string }>();

  return result.results.map((r) => r.name);
}
