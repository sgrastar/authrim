/**
 * Resolved Policy (External API: EffectivePolicy)
 *
 * Runtime-resolved policy combining Tenant Policy and Client Profile.
 * Pinned to session with flow version for consistency during authentication flow.
 *
 * The resolution process:
 * 1. Start with Tenant Policy
 * 2. Apply Client Profile restrictions
 * 3. Generate effective settings for flow execution
 */

import type {
  SigningAlgorithm,
  KeyEncryptionAlgorithm,
  ContentEncryptionAlgorithm,
  MfaMethod,
  SecurityTier,
} from './common';

import type { AuthMethodType, ClientConsentPolicy, GrantType } from './client';

// =============================================================================
// Main ResolvedPolicy Interface
// =============================================================================

/**
 * Resolved Policy (External API: EffectivePolicy)
 *
 * The effective policy for a specific client session.
 * All constraints from Tenant Policy and Client Profile are merged.
 */
export interface ResolvedPolicy {
  /** Resolution ID (hash of tenant.version + client.version) */
  resolutionId: string;

  /** Resolution timestamp (ISO 8601) */
  resolvedAt: string;

  /** Tenant policy version */
  tenantPolicyVersion: number;

  /** Client profile version */
  clientProfileVersion: number;

  /** Tenant ID */
  tenantId: string;

  /** Client ID */
  clientId: string;

  // ========== Effective OAuth Settings ==========
  oauth: EffectiveOAuthSettings;

  // ========== Effective Encryption Settings ==========
  encryption: EffectiveEncryptionSettings;

  // ========== Effective Session Settings ==========
  session: EffectiveSessionSettings;

  // ========== Effective Consent Settings ==========
  consent: EffectiveConsentSettings;

  // ========== Available Authentication Methods ==========
  authMethods: EffectiveAuthMethodSettings;

  // ========== MFA Settings ==========
  mfa: EffectiveMfaSettings;

  // ========== Scope Settings ==========
  scopes: EffectiveScopeSettings;

  // ========== Security Settings ==========
  security: EffectiveSecuritySettings;

  // ========== Flow Constraints ==========
  flowConstraints: FlowConstraints;

  // ========== Client Info (for UI) ==========
  clientInfo: ResolvedClientInfo;
}

// =============================================================================
// Effective Settings - OAuth
// =============================================================================

/**
 * Effective OAuth settings after resolution.
 */
export interface EffectiveOAuthSettings {
  /** Access token expiry (seconds) */
  accessTokenExpiry: number;

  /** Refresh token expiry (seconds) */
  refreshTokenExpiry: number;

  /** ID token expiry (seconds) */
  idTokenExpiry: number;

  /** Authorization code TTL (seconds) */
  authCodeTtl: number;

  /** ID token signing algorithm */
  idTokenSigningAlg: SigningAlgorithm;

  /** Allowed response types */
  allowedResponseTypes: ('code' | 'token' | 'id_token')[];

  /** Allowed grant types */
  allowedGrantTypes: GrantType[];

  /** PKCE required */
  pkceRequired: boolean;

  /** PAR required */
  parRequired: boolean;

  /** JARM enabled */
  jarmEnabled: boolean;

  /** Refresh token rotation enabled */
  refreshTokenRotation: boolean;

  /** Reissue ID token on refresh */
  refreshIdTokenReissue: boolean;

  /** Access token format */
  accessTokenFormat: 'opaque' | 'jwt';

  /** ID token audience format */
  idTokenAudFormat: 'array' | 'string';
}

// =============================================================================
// Effective Settings - Encryption
// =============================================================================

/**
 * Effective encryption settings after resolution.
 */
export interface EffectiveEncryptionSettings {
  /** Signing algorithm */
  signingAlgorithm: SigningAlgorithm;

  /** Key encryption algorithm (if encryption enabled) */
  keyEncryptionAlg?: KeyEncryptionAlgorithm;

  /** Content encryption algorithm (if encryption enabled) */
  contentEncryptionAlg?: ContentEncryptionAlgorithm;

  /** ID token encryption enabled */
  encryptIdToken: boolean;

  /** UserInfo encryption enabled */
  encryptUserInfo: boolean;

  /** PII encryption required */
  piiEncryptionRequired: boolean;
}

// =============================================================================
// Effective Settings - Session
// =============================================================================

/**
 * Effective session settings after resolution.
 */
export interface EffectiveSessionSettings {
  /** Maximum session age (seconds) */
  maxSessionAge: number;

  /** Idle timeout (seconds) */
  idleTimeout: number;

  /** Maximum concurrent sessions */
  maxConcurrentSessions?: number;

  /** Sliding session enabled */
  slidingSessionEnabled: boolean;
}

// =============================================================================
// Effective Settings - Consent
// =============================================================================

/**
 * Effective consent settings after resolution.
 */
export interface EffectiveConsentSettings {
  /** Consent policy */
  policy: ClientConsentPolicy;

  /** Consent remember duration (seconds) */
  rememberDuration?: number;

  /** Implicit scopes (not shown in consent) */
  implicitScopes: string[];

  /** Allow granular scope selection */
  allowGranularConsent: boolean;

  /** First-party client (may skip consent) */
  isFirstParty: boolean;
}

// =============================================================================
// Effective Settings - Authentication Methods
// =============================================================================

/**
 * Effective authentication method settings.
 * Result of Tenant ∩ Client intersection.
 */
export interface EffectiveAuthMethodSettings {
  /** Passkey available */
  passkey: boolean;

  /** Email code available */
  emailCode: boolean;

  /** Password available */
  password: boolean;

  /** External IdP available */
  externalIdp: boolean;

  /** DID available */
  did: boolean;

  /** Preferred method */
  preferred?: AuthMethodType;

  /** Available external IdP provider IDs */
  availableExternalIdpIds?: string[];
}

// =============================================================================
// Effective Settings - MFA
// =============================================================================

/**
 * Effective MFA settings after resolution.
 */
export interface EffectiveMfaSettings {
  /** MFA required */
  required: boolean;

  /** MFA conditional (risk-based) */
  conditional: boolean;

  /** Available MFA methods */
  availableMethods: MfaMethod[];

  /** MFA remember allowed */
  canRemember: boolean;

  /** MFA remember duration (seconds) */
  rememberDuration?: number;
}

// =============================================================================
// Effective Settings - Scopes
// =============================================================================

/**
 * Effective scope settings after resolution.
 */
export interface EffectiveScopeSettings {
  /** Available scopes for this client */
  available: string[];

  /** Default scopes */
  default: string[];

  /** Dynamic scope requests allowed */
  dynamicAllowed: boolean;
}

// =============================================================================
// Effective Settings - Security
// =============================================================================

/**
 * Effective security settings after resolution.
 */
export interface EffectiveSecuritySettings {
  /** Security tier */
  tier: SecurityTier;

  /** PKCE required */
  pkceRequired: boolean;

  /** PAR required */
  parRequired: boolean;

  /** Client type */
  clientType: 'public' | 'confidential';

  /** Rate limit: login attempts per minute */
  loginAttemptsPerMinute: number;

  /** Rate limit: token requests per minute */
  tokenRequestsPerMinute: number;
}

// =============================================================================
// Flow Constraints
// =============================================================================

/**
 * Constraints for flow design based on resolved policy.
 */
export interface FlowConstraints {
  /** Available capability types for flow nodes */
  availableCapabilities: AvailableCapability[];

  /** Forbidden capability types */
  forbiddenCapabilities: ForbiddenCapability[];

  /** Required capabilities (must be in flow) */
  requiredCapabilities: RequiredCapability[];

  /** Available intents */
  availableIntents: string[];
}

/**
 * Available capability for flow design.
 */
export interface AvailableCapability {
  /** Capability type */
  type: string;

  /** Display name */
  displayName: string;

  /** Category */
  category: 'authentication' | 'verification' | 'consent' | 'flow_control' | 'oidc_core';

  /** Whether this is an OIDC core capability (read-only) */
  oidcCore: boolean;
}

/**
 * Forbidden capability with reason.
 */
export interface ForbiddenCapability {
  /** Capability type */
  type: string;

  /** Reason for being forbidden */
  reason: string;

  /** Source of constraint */
  source: 'tenant' | 'client' | 'security_tier';
}

/**
 * Required capability with reason.
 */
export interface RequiredCapability {
  /** Capability type */
  type: string;

  /** Reason for being required */
  reason: string;

  /** Source of requirement */
  source: 'tenant' | 'client' | 'security_tier' | 'compliance';
}

// =============================================================================
// Resolved Client Info
// =============================================================================

/**
 * Resolved client information for UI display.
 */
export interface ResolvedClientInfo {
  /** Client ID */
  clientId: string;

  /** Client display name */
  displayName?: string;

  /** Client description */
  description?: string;

  /** Logo URI */
  logoUri?: string;

  /** Policy URI */
  policyUri?: string;

  /** Terms of service URI */
  tosUri?: string;

  /** First-party flag */
  isFirstParty: boolean;

  /** Application type */
  applicationType?: 'web' | 'native' | 'spa' | 'service';
}

// =============================================================================
// Resolution Utilities (see resolver.ts for PolicyResolutionOptions/Debug/Step)
// =============================================================================

// Note: PolicyResolutionOptions, PolicyResolutionDebug, and PolicyResolutionStep
// are defined in resolver.ts to avoid duplicate exports.

// =============================================================================
// Policy Comparison
// =============================================================================

/**
 * Result of comparing two resolved policies.
 */
export interface PolicyComparisonResult {
  /** Policies are identical */
  identical: boolean;

  /** Differences found */
  differences: PolicyDifference[];
}

/**
 * Single policy difference.
 */
export interface PolicyDifference {
  /** Field path */
  path: string;

  /** Old value */
  oldValue: unknown;

  /** New value */
  newValue: unknown;

  /** Impact level */
  impact: 'breaking' | 'major' | 'minor';

  /** Description of impact */
  impactDescription?: string;
}
