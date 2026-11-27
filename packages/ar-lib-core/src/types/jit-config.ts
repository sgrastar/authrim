/**
 * JIT Provisioning Configuration Types
 *
 * This module contains type definitions for JIT (Just-In-Time) Provisioning
 * configuration and related settings:
 * - JIT Provisioning config (KV-stored)
 * - Email domain hash config (key rotation support)
 * - Default values with secure defaults
 */

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
   * Default role ID to assign to JIT-provisioned users
   * Applied when no role_assignment_rules match
   */
  default_role_id: string;

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
  default_role_id: 'role_end_user', // Basic role
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
   * New users will use this version
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
