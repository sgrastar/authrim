/**
 * JIT Provisioning Configuration Types
 *
 * This module contains type definitions for JIT (Just-In-Time) Provisioning
 * configuration and related settings:
 * - JIT Provisioning config (KV-stored)
 * - Email domain hash config (key rotation support)
 * - Default values with secure defaults
 */

import type { OrganizationType } from './rbac';

// =============================================================================
// JIT Provisioning Configuration
// =============================================================================

/**
 * JIT Provisioning configuration
 *
 * Stored in KV: jit_provisioning_config
 * Priority: KV → ENV → DEFAULT_JIT_CONFIG
 */
export interface JITProvisioningConfig {
  /** Master switch for JIT Provisioning */
  enabled: boolean;

  /**
   * Whether to auto-create organization when domain matches but no org exists
   * SECURITY: Default false - requires explicit admin setup
   */
  auto_create_org_on_domain_match: boolean;

  /**
   * Whether to join all matching organizations (true) or just the first (false)
   * Default: false (join only highest priority match)
   */
  join_all_matching_orgs: boolean;

  /**
   * Whether to create user without organization if no domain mapping exists
   * Default: true (allow user creation even without org)
   */
  allow_user_without_org: boolean;

  /**
   * Default role ID to assign to JIT-provisioned users
   * Applied when no role_assignment_rules match
   */
  default_role_id: string;

  /**
   * Whether to use unverified domain mappings
   * SECURITY: Default false - only verified domains are used
   */
  allow_unverified_domain_mappings: boolean;

  /**
   * Optional: Restrict JIT to specific IdP providers
   * null = all providers allowed
   */
  allowed_provider_ids?: string[] | null;

  /**
   * Whether to require verified email from IdP
   * Default: true
   */
  require_verified_email?: boolean;

  /**
   * Rate limiting for JIT user creation (per tenant)
   */
  rate_limit?: {
    /** Max JIT users per minute */
    max_per_minute: number;
    /** Max JIT users per hour */
    max_per_hour: number;
  };

  /** Configuration version for cache invalidation */
  version?: string;
  /** Last update timestamp */
  updated_at?: number;
}

/**
 * Default JIT Provisioning configuration
 * SECURITY: Defaults are set to most secure/restrictive options
 */
export const DEFAULT_JIT_CONFIG: JITProvisioningConfig = {
  enabled: true,
  auto_create_org_on_domain_match: false, // Require explicit org setup
  join_all_matching_orgs: false, // Join only first match
  allow_user_without_org: true, // Allow standalone users
  default_role_id: 'role_end_user', // Basic role
  allow_unverified_domain_mappings: false, // Require verification
  allowed_provider_ids: null, // All providers allowed
  require_verified_email: true, // Require verified email
  rate_limit: {
    max_per_minute: 10,
    max_per_hour: 100,
  },
  version: '1',
};

// =============================================================================
// Email Domain Hash Configuration (Key Rotation Support)
// =============================================================================

/**
 * Email domain hash configuration with key rotation support
 *
 * Stored in KV: email_domain_hash_config
 * Priority: KV → ENV (EMAIL_DOMAIN_HASH_SECRET) → error
 */
export interface EmailDomainHashConfig {
  /**
   * Current active version for new hashes
   * New users and domain mappings will use this version
   */
  current_version: number;

  /**
   * Secret keys by version
   * { 1: "old_secret", 2: "new_secret" }
   */
  secrets: Record<number, string>;

  /**
   * Whether key migration is in progress
   * When true:
   * - New hashes use current_version
   * - Lookups check multiple versions
   * - Login triggers hash update for users on old versions
   */
  migration_in_progress: boolean;

  /**
   * Versions scheduled for deprecation
   * Users on these versions will be logged with warnings
   */
  deprecated_versions: number[];

  /** Configuration version for cache invalidation */
  version?: string;
  /** Last update timestamp */
  updated_at?: number;
}

/**
 * Default email domain hash configuration
 * Note: secrets must be provided via ENV or KV
 */
export const DEFAULT_EMAIL_DOMAIN_HASH_CONFIG: Omit<EmailDomainHashConfig, 'secrets'> = {
  current_version: 1,
  migration_in_progress: false,
  deprecated_versions: [],
  version: '1',
};

// =============================================================================
// Key Rotation Status
// =============================================================================

/**
 * Key rotation migration status
 * Returned by GET /api/admin/settings/domain-hash-keys/status
 */
export interface KeyRotationStatus {
  /** Current active version */
  current_version: number;

  /** Whether migration is in progress */
  migration_in_progress: boolean;

  /** User count by hash version */
  users_by_version: Record<number, number>;

  /** Org domain mapping count by hash version */
  org_mappings_by_version: Record<number, number>;

  /** Deprecated versions */
  deprecated_versions: number[];

  /** Estimated completion timestamp (when migration is in progress) */
  estimated_completion?: string;
}

/**
 * Input for starting key rotation
 */
export interface KeyRotationInput {
  /** New secret key to add */
  new_secret: string;
}

/**
 * Result of key rotation start
 */
export interface KeyRotationResult {
  /** New version number */
  new_version: number;
  /** Whether migration started */
  migration_in_progress: boolean;
  /** Status message */
  message: string;
}

// =============================================================================
// Auto Organization Creation Configuration
// =============================================================================

/**
 * Configuration for automatic organization creation
 * Used when auto_create_org_on_domain_match is true
 *
 * Stored in KV: org_auto_creation_config
 */
export interface OrgAutoCreationConfig {
  /** Whether auto-creation is enabled */
  enabled: boolean;

  /** Default template for auto-created organizations */
  default_org_template: {
    /** Organization type */
    org_type: OrganizationType;
    /** Subscription plan */
    plan: 'free' | 'starter' | 'professional' | 'enterprise';
    /** Active status */
    is_active: boolean;
    /** Optional metadata template */
    metadata_template?: Record<string, unknown>;
  };

  /** Naming conventions for auto-created orgs */
  naming: {
    /**
     * Pattern for org name
     * {{domain}} is replaced with sanitized domain
     * e.g., "{{domain}}" → "example-com"
     */
    name_pattern: string;
    /**
     * Pattern for display name
     * {{Domain}} is replaced with capitalized domain
     * e.g., "{{Domain}} Users" → "Example.com Users"
     */
    display_name_pattern: string;
  };

  /** Domains that cannot auto-create orgs */
  blocked_domains: string[];

  /** Rate limiting */
  rate_limit: {
    /** Max orgs created per day */
    max_per_day: number;
  };

  /** Configuration version */
  version?: string;
  /** Last update timestamp */
  updated_at?: number;
}

/**
 * Default organization auto-creation configuration
 */
export const DEFAULT_ORG_AUTO_CREATION_CONFIG: OrgAutoCreationConfig = {
  enabled: false, // Disabled by default
  default_org_template: {
    org_type: 'enterprise',
    plan: 'free',
    is_active: true,
  },
  naming: {
    name_pattern: '{{domain}}',
    display_name_pattern: '{{Domain}}',
  },
  blocked_domains: [
    // Common free email providers
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'icloud.com',
    'protonmail.com',
    'mail.com',
  ],
  rate_limit: {
    max_per_day: 10,
  },
  version: '1',
};
