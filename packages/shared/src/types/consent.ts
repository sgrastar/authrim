/**
 * Consent Screen Type Definitions
 *
 * Phase 2-B: Consent Screen Enhancement
 * - Organization info display
 * - Organization switching
 * - Acting-as (delegation) support
 */

import type { OrganizationType, PlanType, RelationshipType, PermissionLevel } from './rbac';

// =============================================================================
// Scope Information
// =============================================================================

/**
 * Scope details for consent screen display
 */
export interface ConsentScopeInfo {
  /** Scope name (e.g., "openid", "profile") */
  name: string;
  /** Human-readable title */
  title: string;
  /** Description of what access this scope grants */
  description: string;
  /** Whether this scope is required (cannot be unchecked) */
  required: boolean;
}

// =============================================================================
// Client Information
// =============================================================================

/**
 * Client information for consent screen
 */
export interface ConsentClientInfo {
  /** OAuth2 client_id */
  client_id: string;
  /** Human-readable client name */
  client_name: string;
  /** Logo URL */
  logo_uri?: string;
  /** Client website URL */
  client_uri?: string;
  /** Privacy policy URL */
  policy_uri?: string;
  /** Terms of service URL */
  tos_uri?: string;
  /** Whether this client is trusted (first-party) */
  is_trusted?: boolean;
}

// =============================================================================
// User Information
// =============================================================================

/**
 * User information for consent screen
 */
export interface ConsentUserInfo {
  /** User ID (subject) */
  id: string;
  /** Email address */
  email: string;
  /** Display name */
  name?: string;
  /** Profile picture URL */
  picture?: string;
}

// =============================================================================
// Organization Information
// =============================================================================

/**
 * Organization information for consent screen
 */
export interface ConsentOrgInfo {
  /** Organization ID */
  id: string;
  /** Organization name */
  name: string;
  /** Organization type */
  type: OrganizationType;
  /** Whether this is the user's primary organization */
  is_primary: boolean;
  /** Subscription plan (optional) */
  plan?: PlanType;
}

// =============================================================================
// Acting-As (Delegation) Information
// =============================================================================

/**
 * Acting-as target user information
 */
export interface ConsentActingAsInfo {
  /** Target user ID */
  id: string;
  /** Target user name */
  name?: string;
  /** Target user email */
  email: string;
  /** Relationship type (how the acting user is related) */
  relationship_type: RelationshipType;
  /** Permission level granted */
  permission_level: PermissionLevel;
}

// =============================================================================
// Consent Screen Data (API Response)
// =============================================================================

/**
 * Full consent screen data returned by the API
 * GET /auth/consent?challenge_id=xxx with Accept: application/json
 */
export interface ConsentScreenData {
  /** Challenge ID for form submission */
  challenge_id: string;

  /** Client requesting access */
  client: ConsentClientInfo;

  /** Scopes being requested */
  scopes: ConsentScopeInfo[];

  /** Currently authenticated user */
  user: ConsentUserInfo;

  /** All organizations the user belongs to */
  organizations: ConsentOrgInfo[];

  /** User's primary organization (null if no org membership) */
  primary_org: ConsentOrgInfo | null;

  /** User's role names in the current/target organization */
  roles: string[];

  /** Acting-as info (null if not acting on behalf of someone) */
  acting_as: ConsentActingAsInfo | null;

  /** Target organization ID from request (for org-scoped consent) */
  target_org_id: string | null;

  /** RBAC feature flags for UI display */
  features: ConsentFeatureFlags;
}

/**
 * Feature flags for conditional UI rendering
 */
export interface ConsentFeatureFlags {
  /** Show organization selector for multi-org users */
  org_selector_enabled: boolean;
  /** Show acting-as indicator and allow delegation */
  acting_as_enabled: boolean;
  /** Show user's roles on consent screen */
  show_roles: boolean;
}

// =============================================================================
// Challenge Metadata
// =============================================================================

/**
 * Extended consent challenge metadata
 * Stored in ChallengeStore with RBAC extensions
 */
export interface ConsentChallengeMetadata {
  // Standard OAuth2/OIDC parameters
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  claims?: string;
  response_mode?: string;
  max_age?: string;
  prompt?: string;
  acr_values?: string;

  // RBAC extensions (Phase 2-B)
  /** Target organization ID for org-scoped authorization */
  org_id?: string;
  /** Acting on behalf of this user ID */
  acting_as?: string;
  /** Relationship type for acting-as */
  acting_as_relationship_type?: RelationshipType;
}

// =============================================================================
// Consent Submission
// =============================================================================

/**
 * Consent form submission data
 * POST /auth/consent
 */
export interface ConsentSubmission {
  /** Challenge ID */
  challenge_id: string;
  /** Whether consent was approved */
  approved: boolean;
  /** Selected organization ID (for multi-org users) */
  selected_org_id?: string;
  /** Acting-as user ID (if delegation is active) */
  acting_as_user_id?: string;
  /** Selected scopes (if UI allows scope selection) */
  selected_scopes?: string[];
}

// =============================================================================
// Consent Decision Result
// =============================================================================

/**
 * Result of consent processing
 */
export interface ConsentDecisionResult {
  /** Whether consent was successful */
  success: boolean;
  /** Redirect URL (on success or denial) */
  redirect_url?: string;
  /** Error code (on failure) */
  error?: string;
  /** Error description (on failure) */
  error_description?: string;
}
