/**
 * Consent Screen Type Definitions
 *
 * Phase 2-B: Consent Screen Enhancement
 * - Organization info display
 * - Organization switching
 * - Acting-as (delegation) support
 */

import type { OrganizationType, PlanType, RelationshipType, PermissionLevel } from './rbac';
import type { ConsentScreenItem, ConsentEnforcement } from './consent-statements';

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
  resource?: string | string[];
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  claims?: string;
  authorization_details?: string;
  response_mode?: string;
  max_age?: string;
  prompt?: string;
  acr_values?: string;
  ui_locales?: string;
  authorization_request_source?: 'frontchannel' | 'par';
  authorization_request_integrity_protected?: boolean;

  // RBAC extensions (Phase 2-B)
  /** Target organization ID for org-scoped authorization */
  org_id?: string;
  /** Acting on behalf of this user ID */
  acting_as?: string;
  /** Relationship type for acting-as */
  acting_as_relationship_type?: RelationshipType;

  // Custom Redirect URIs (Authrim Extension)
  /** Redirect on technical errors */
  error_uri?: string;
  /** Redirect on user cancellation (e.g., consent denial) */
  cancel_uri?: string;

  // Consent Management
  /** Required consent statement IDs */
  consent_items_required?: string[];
  /** Consent enforcement mode */
  consent_items_enforcement?: ConsentEnforcement;
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

// =============================================================================
// Policy Versioning
// =============================================================================

/**
 * Policy types that can be versioned
 */
export type PolicyType = 'privacy_policy' | 'terms_of_service' | 'cookie_policy';

/**
 * Policy version information
 */
export interface PolicyVersion {
  /** Unique version identifier (e.g., "v1.0.0", "2024-01-15") */
  version: string;
  /** Policy type */
  policyType: PolicyType;
  /** URL to the policy document */
  policyUri?: string;
  /** SHA-256 hash of policy content for integrity verification */
  policyHash?: string;
  /** When this version became effective (Unix timestamp) */
  effectiveAt: number;
}

/**
 * Consent version information stored with consent record
 */
export interface ConsentVersionInfo {
  /** Privacy policy version agreed to */
  privacyPolicyVersion?: string;
  /** Terms of service version agreed to */
  tosVersion?: string;
  /** Internal consent version number (auto-incremented on updates) */
  consentVersion: number;
}

/**
 * Current policy versions for a tenant
 */
export interface CurrentPolicyVersions {
  /** Current privacy policy version */
  privacyPolicy?: PolicyVersion;
  /** Current terms of service version */
  termsOfService?: PolicyVersion;
  /** Current cookie policy version */
  cookiePolicy?: PolicyVersion;
}

// =============================================================================
// Granular Scope Selection
// =============================================================================

/**
 * Granular scope selection in consent screen
 */
export interface GranularScopeSelection {
  /** Scope name */
  name: string;
  /** Whether this scope is selected by the user */
  selected: boolean;
  /** Whether this scope is required (cannot be deselected) */
  required: boolean;
}

// =============================================================================
// Consent Revocation
// =============================================================================

/**
 * Consent revoke request
 */
export interface ConsentRevokeRequest {
  /** Client ID to revoke consent for */
  clientId: string;
  /** Reason for revocation (optional) */
  reason?: 'user_request' | 'admin_action' | 'policy_violation';
  /** Whether to also revoke all related tokens */
  revokeTokens?: boolean;
}

/**
 * Consent revoke result
 */
export interface ConsentRevokeResult {
  /** Whether revocation was successful */
  success: boolean;
  /** Number of access tokens revoked */
  accessTokensRevoked: number;
  /** Number of refresh tokens revoked */
  refreshTokensRevoked: number;
  /** Timestamp of revocation */
  revokedAt: number;
}

/**
 * User consent record (for listing)
 */
export interface UserConsentRecord {
  /** Consent ID */
  id: string;
  /** Client ID */
  clientId: string;
  /** Client name */
  clientName?: string;
  /** Client logo URI */
  clientLogoUri?: string;
  /** Granted scopes */
  scopes: string[];
  /** Selected scopes (if granular) */
  selectedScopes?: string[];
  /** When consent was granted (Unix timestamp) */
  grantedAt: number;
  /** When consent expires (null = no expiration) */
  expiresAt?: number;
  /** Policy versions agreed to */
  policyVersions?: ConsentVersionInfo;
}

// =============================================================================
// Data Export (GDPR Data Portability)
// =============================================================================

/**
 * Data export status
 */
export type DataExportStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'expired';

/**
 * Data export format
 */
export type DataExportFormat = 'json' | 'csv';

/**
 * Data export sections
 */
export type DataExportSection = 'profile' | 'consents' | 'sessions' | 'audit_log' | 'passkeys';

/**
 * Data export request
 */
export interface DataExportRequest {
  /** Request ID */
  id: string;
  /** Opaque public artifact identifier for materialized exports */
  publicArtifactId?: string;
  /** User ID */
  userId: string;
  /** Export status */
  status: DataExportStatus;
  /** Output format */
  format: DataExportFormat;
  /** Sections to include */
  includeSections: DataExportSection[];
  /** When requested (Unix timestamp) */
  requestedAt: number;
  /** When processing started */
  startedAt?: number;
  /** When completed */
  completedAt?: number;
  /** Download link expiration */
  expiresAt?: number;
  /** File size in bytes */
  fileSize?: number;
  /** Materialized formats currently available for download */
  availableFormats?: DataExportFormat[];
  /** Error message if failed */
  errorMessage?: string;
}

/**
 * Exported user data structure (GDPR Article 20 compliant)
 */
export interface ExportedUserData {
  /** Export metadata */
  metadata: {
    /** When the export was generated */
    exportedAt: string;
    /** Export format */
    format: string;
    /** Export schema version */
    version: string;
    /** User ID */
    userId: string;
    /** Tenant ID */
    tenantId?: string;
  };
  /** User profile data */
  profile?: {
    id: string;
    email: string;
    emailVerified: boolean;
    phoneNumber?: string;
    phoneNumberVerified?: boolean;
    name?: string;
    givenName?: string;
    familyName?: string;
    middleName?: string;
    nickname?: string;
    preferredUsername?: string;
    picture?: string;
    website?: string;
    gender?: string;
    birthdate?: string;
    zoneinfo?: string;
    locale?: string;
    address?: {
      formatted?: string;
      streetAddress?: string;
      locality?: string;
      region?: string;
      postalCode?: string;
      country?: string;
    };
    createdAt: string;
    updatedAt: string;
  };
  /** Consent history */
  consents?: Array<{
    clientId: string;
    clientName?: string;
    scopes: string[];
    selectedScopes?: string[];
    grantedAt: string;
    expiresAt?: string;
    policyVersions?: {
      privacyPolicy?: string;
      termsOfService?: string;
    };
  }>;
  /** Consent change history (audit log) */
  consentHistory?: Array<{
    action: string;
    clientId: string;
    scopesBefore?: string[];
    scopesAfter?: string[];
    timestamp: string;
  }>;
  /** Active sessions */
  sessions?: Array<{
    id: string;
    createdAt: string;
    expiresAt: string;
    lastActiveAt?: string;
  }>;
  /** Registered passkeys */
  passkeys?: Array<{
    id: string;
    deviceName?: string;
    createdAt: string;
    lastUsedAt?: string;
  }>;
}

// =============================================================================
// Consent Expiration
// =============================================================================

/**
 * Consent expiration configuration
 */
export interface ConsentExpirationConfig {
  /** Whether consent expiration is enabled */
  enabled: boolean;
  /** Default expiration in seconds (0 = no expiration) */
  defaultExpirationSeconds: number;
  /** Grace period in seconds before re-consent is required */
  gracePeriodSeconds: number;
}

// =============================================================================
// Consent History (Audit)
// =============================================================================

/**
 * Consent history action types
 */
export type ConsentHistoryAction =
  | 'granted'
  | 'updated'
  | 'revoked'
  | 'version_upgraded'
  | 'scopes_updated'
  | 'expired';

/**
 * Consent history record
 */
export interface ConsentHistoryRecord {
  /** Record ID */
  id: string;
  /** Tenant ID */
  tenantId: string;
  /** User ID */
  userId: string;
  /** Client ID */
  clientId: string;
  /** Action type */
  action: ConsentHistoryAction;
  /** Scopes before the change */
  scopesBefore?: string[];
  /** Scopes after the change */
  scopesAfter?: string[];
  /** Privacy policy version at time of action */
  privacyPolicyVersion?: string;
  /** TOS version at time of action */
  tosVersion?: string;
  /** Hashed IP address */
  ipAddressHash?: string;
  /** User agent string */
  userAgent?: string;
  /** When the action occurred */
  createdAt: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Extended Consent Screen Data
// =============================================================================

/**
 * Extended consent screen data with versioning and granular scopes
 */
export interface ExtendedConsentScreenData extends ConsentScreenData {
  /** Whether granular scope selection is enabled */
  granular_scopes_enabled?: boolean;

  /** Current policy versions for this tenant */
  current_policy_versions?: CurrentPolicyVersions;

  /** Whether re-consent is required due to policy update */
  requires_reconsent?: boolean;

  /** Reason for requiring re-consent */
  reconsent_reason?: 'policy_updated' | 'scopes_changed' | 'expired';

  /** Previous consent info (if updating existing consent) */
  previous_consent?: {
    scopes: string[];
    grantedAt: number;
    policyVersions?: ConsentVersionInfo;
  };

  /** Versioning information (structured format for UI consumption) */
  versioning?: {
    requiresReconsent: boolean;
    changedPolicies: string[];
    currentVersions: {
      privacyPolicy?: { version: string; policyUri?: string };
      termsOfService?: { version: string; policyUri?: string };
    };
  };

  // Consent Management (SAP CDC-like)
  /** Consent items to display on consent screen */
  consent_items?: ConsentScreenItem[];
  /** Whether consent management feature is enabled */
  consent_management_enabled?: boolean;
  /** Consent language resolved for this user */
  consent_language?: string;
}

/**
 * Extended consent submission with policy acknowledgement
 */
export interface ExtendedConsentSubmission extends ConsentSubmission {
  /** Acknowledged policy versions */
  acknowledged_policy_versions?: {
    privacy_policy?: string;
    terms_of_service?: string;
  };

  /** Consent item decisions (statement_id -> 'granted' | 'denied') */
  consent_item_decisions?: Record<string, 'granted' | 'denied'>;
}
