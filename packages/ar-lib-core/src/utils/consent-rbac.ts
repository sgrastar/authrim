/**
 * Consent RBAC Utilities
 *
 * Phase 2-B: Consent Screen Enhancement
 * Utilities for retrieving RBAC information for consent screen display.
 *
 * These functions extend the base rbac-claims.ts with consent-specific logic:
 * - Acting-as relationship validation
 * - Full consent screen data aggregation
 */

import type { ConsentActingAsInfo, ConsentUserInfo, ConsentFeatureFlags } from '../types/consent';
import type { RelationshipType, PermissionLevel } from '../types/rbac';
import { ensureDatabaseAdapter, type DatabaseSource } from '../db/adapter-source';
import { CanonicalRuntimeUserStore } from '../repositories/identity/canonical-runtime-user-store';
import { resolveSubjectRoles, type TenantRBACDatabases } from '../services/tenant-rbac';

// =============================================================================
// Consent RBAC Data Retrieval
// =============================================================================

/**
 * Result of getConsentRBACData
 */
export interface ConsentRBACData {
  /** User's role names (from all assignments) */
  roles: string[];
}

/**
 * Get comprehensive RBAC data for consent screen
 *
 * Fetches the role assignments for displaying on the consent screen.
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @returns Consent RBAC data
 */
export async function getConsentRBACData(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<ConsentRBACData> {
  const roles = await resolveSubjectRoles(dbs, tenantId, subjectId);

  return {
    roles: [...new Set(roles.map(({ role }) => role.name))],
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
 * @param db - Database source
 * @param actorId - User who wants to act on behalf
 * @param targetId - User being acted on behalf of
 * @returns Validation result
 */
export async function validateActingAsRelationship(
  db: DatabaseSource,
  actorId: string,
  targetId: string,
  tenantId: string
): Promise<ActingAsValidationResult> {
  const now = Math.floor(Date.now() / 1000);
  const adapter = ensureDatabaseAdapter(db, 'consent-rbac-acting-as');

  // Find a valid relationship where actor can act on behalf of target
  // Actor is the "from" side (parent, guardian, delegate)
  const result = await adapter.queryOne<{ relationship_type: string; permission_level: string }>(
    `SELECT relationship_type, permission_level
       FROM relationships
       WHERE from_id = ? AND to_id = ?
         AND tenant_id = ?
         AND from_type = 'subject' AND to_type = 'subject'
         AND relationship_type IN ('parent_child', 'guardian', 'delegate')
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
    [actorId, targetId, tenantId, now]
  );

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
 * @param db - Database source
 * @param actorId - User who is acting
 * @param targetId - User being acted on behalf of
 * @returns Acting-as info or null if relationship is invalid
 */
export async function getActingAsUserInfo(
  db: DatabaseSource,
  actorId: string,
  targetId: string,
  tenantId: string,
  dbPII?: DatabaseSource
): Promise<ConsentActingAsInfo | null> {
  // First validate the relationship
  const validation = await validateActingAsRelationship(db, actorId, targetId, tenantId);

  if (!validation.valid || !validation.relationship_type || !validation.permission_level) {
    return null;
  }

  const coreAdapter = ensureDatabaseAdapter(db, 'consent-rbac-acting-as-core');
  if (!dbPII) {
    const account = await coreAdapter.queryOne<{ legacy_user_id: string }>(
      "SELECT legacy_user_id FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ? AND lifecycle_state = 'active'",
      [targetId, tenantId]
    );
    if (!account) return null;
    return {
      id: targetId,
      name: undefined,
      email: targetId,
      relationship_type: validation.relationship_type,
      permission_level: validation.permission_level,
    };
  }
  const user = await new CanonicalRuntimeUserStore({
    coreAdapter,
    piiAdapter: ensureDatabaseAdapter(dbPII, 'consent-rbac-acting-as-pii'),
    tenantId,
  }).findById(targetId);
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name ?? undefined,
    email: user.email ?? targetId,
    relationship_type: validation.relationship_type,
    permission_level: validation.permission_level,
  };
}

// =============================================================================
// User Info for Consent Screen
// =============================================================================

/**
 * Get user info for consent screen display
 * PII/Non-PII DB separation: separates Core DB and PII DB
 *
 * @param db - D1 database (Core)
 * @param subjectId - User ID
 * @param dbPII - D1 database (PII) - optional
 * @returns User info or null if not found
 */
export async function getConsentUserInfo(
  db: DatabaseSource,
  subjectId: string,
  tenantId: string,
  dbPII?: DatabaseSource
): Promise<ConsentUserInfo | null> {
  const coreAdapter = ensureDatabaseAdapter(db, 'consent-user-core');
  if (!dbPII) {
    const account = await coreAdapter.queryOne<{ legacy_user_id: string }>(
      "SELECT legacy_user_id FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ? AND lifecycle_state = 'active'",
      [subjectId, tenantId]
    );
    return account
      ? {
          id: subjectId,
          email: subjectId,
          name: undefined,
          picture: undefined,
        }
      : null;
  }
  const user = await new CanonicalRuntimeUserStore({
    coreAdapter,
    piiAdapter: ensureDatabaseAdapter(dbPII, 'consent-user-pii'),
    tenantId,
  }).findById(subjectId);
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email ?? subjectId,
    name: user.name ?? undefined,
    picture: user.picture ?? undefined,
  };
}

// =============================================================================
// Feature Flags
// =============================================================================

/**
 * Parse consent feature flags from environment variables
 *
 * @param actingAsEnabled - RBAC_CONSENT_ACTING_AS env var
 * @param showRoles - RBAC_CONSENT_SHOW_ROLES env var
 * @returns Feature flags for consent screen
 */
export function parseConsentFeatureFlags(
  actingAsEnabled?: string,
  showRoles?: string
): ConsentFeatureFlags {
  return {
    acting_as_enabled: actingAsEnabled === 'true',
    show_roles: showRoles === 'true',
  };
}
