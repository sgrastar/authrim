/**
 * Tenant Contract (External API: TenantPolicy)
 *
 * Tenant-level policy that defines the allowable range for all settings.
 * Clients can only select values within these constraints (no relaxation, only restriction).
 *
 * Encompasses all 15 existing settings categories:
 * oauth, session, security, consent, ciba, rate-limit, device-flow,
 * tokens, external-idp, credentials, federation, scim, client,
 * infrastructure (read-only), encryption (selection only)
 */

import type {
  ContractMetadata,
  ContractExtensions,
  AuthMethodAvailability,
  MfaMethod,
  SigningAlgorithm,
  KeyEncryptionAlgorithm,
  ContentEncryptionAlgorithm,
  ResponseType,
  RequirementLevel,
  PiiStoragePolicy,
  AuditDetailLevel,
  CustomScopeDefinition,
  CustomClaimDefinition,
  SecurityTier,
  ComplianceModule,
  ClientAuthMethod,
} from './common';

import type { TenantPolicyPreset } from './presets';

// =============================================================================
// Main TenantContract Interface
// =============================================================================

/**
 * Tenant Contract (External API: TenantPolicy)
 *
 * Defines the allowable configuration range at the tenant level.
 * All 15 settings categories are unified here.
 */
export interface TenantContract {
  /** Tenant ID */
  tenantId: string;

  /** Contract version (incremented on change) */
  version: number;

  /** Preset used as base */
  preset: TenantPolicyPreset;

  // ========== OAuth/OIDC Settings (category: oauth) ==========
  oauth: TenantOAuthPolicy;

  // ========== Session Settings (category: session) ==========
  session: TenantSessionPolicy;

  // ========== Security Settings (category: security) ==========
  security: TenantSecurityPolicy;

  // ========== Encryption Settings (selection from platform options) ==========
  encryption: TenantEncryptionPolicy;

  // ========== Scope/Claim Settings ==========
  scopes: TenantScopePolicy;

  // ========== Authentication Method Settings ==========
  authMethods: TenantAuthMethodPolicy;

  // ========== Consent Settings (category: consent) ==========
  consent: TenantConsentPolicy;

  // ========== CIBA Settings (category: ciba) ==========
  ciba: TenantCibaPolicy;

  // ========== Device Flow Settings (category: device-flow) ==========
  deviceFlow: TenantDeviceFlowPolicy;

  // ========== External IdP Settings (category: external-idp) ==========
  externalIdp: TenantExternalIdpPolicy;

  // ========== Federation Settings (category: federation) ==========
  federation: TenantFederationPolicy;

  // ========== SCIM Settings (category: scim) ==========
  scim: TenantScimPolicy;

  // ========== Rate Limit Settings (category: rate-limit) ==========
  rateLimit: TenantRateLimitPolicy;

  // ========== Token Settings (category: tokens) ==========
  tokens: TenantTokensPolicy;

  // ========== Credentials Settings (category: credentials) ==========
  credentials: TenantCredentialsPolicy;

  // ========== Data Residency / Region ==========
  dataResidency: TenantDataResidencyPolicy;

  // ========== Audit Settings ==========
  audit: TenantAuditPolicy;

  // ========== Extensions (Future Features) ==========
  /**
   * Extension settings for future features.
   * Allows adding new categories without breaking changes.
   */
  extensions?: ContractExtensions;

  // ========== Metadata ==========
  metadata: ContractMetadata;
}

// =============================================================================
// OAuth Policy
// =============================================================================

/**
 * OAuth/OIDC policy at tenant level.
 * Defines upper bounds for token expiry and security requirements.
 */
export interface TenantOAuthPolicy {
  // --- Token Expiry Upper Bounds ---
  /** Maximum access token expiry (seconds) */
  maxAccessTokenExpiry: number;
  /** Maximum refresh token expiry (seconds) */
  maxRefreshTokenExpiry: number;
  /** Maximum ID token expiry (seconds) */
  maxIdTokenExpiry: number;
  /** Maximum authorization code TTL (seconds) */
  maxAuthCodeTtl: number;

  // --- Security Requirements ---
  /** PKCE requirement level */
  pkceRequirement: RequirementLevel;
  /** PAR (Pushed Authorization Request) requirement level */
  parRequirement: RequirementLevel;
  /** JARM (JWT Secured Authorization Response Mode) enabled */
  jarmEnabled: boolean;
  /** JAR (JWT-Secured Authorization Request) enabled - for FAPI 2.0 Message Signing */
  jarEnabled?: boolean;

  // --- Allowed Response Types ---
  /** Allowed OAuth response types */
  allowedResponseTypes: ResponseType[];

  // --- Algorithm Selection ---
  /** Allowed ID token signing algorithms */
  allowedIdTokenSigningAlgs: SigningAlgorithm[];

  // --- Behavioral Settings ---
  /** Refresh token rotation enabled */
  refreshTokenRotation: boolean;
  /** Reissue ID token on refresh */
  refreshIdTokenReissue: boolean;
  /** Require offline_access scope for refresh tokens */
  offlineAccessRequired: boolean;
}

// =============================================================================
// Session Policy
// =============================================================================

/**
 * Session management policy.
 */
export interface TenantSessionPolicy {
  /** Maximum session age (seconds) */
  maxSessionAge: number;
  /** Idle timeout (seconds) */
  idleTimeout: number;
  /** Maximum concurrent sessions per user */
  maxConcurrentSessions?: number;
  /** Allow session extension */
  allowSessionExtension: boolean;
  /** Sliding session enabled */
  slidingSessionEnabled: boolean;
}

// =============================================================================
// Security Policy
// =============================================================================

/**
 * Security policy including MFA requirements.
 */
export interface TenantSecurityPolicy {
  /** Security tier */
  tier: SecurityTier;
  /** Compliance modules enabled */
  complianceModules: ComplianceModule[];

  /** MFA policy */
  mfa: TenantMfaPolicy;

  /** Password policy (if password auth enabled) */
  passwordPolicy?: TenantPasswordPolicy;
}

/**
 * MFA policy at tenant level.
 */
export interface TenantMfaPolicy {
  /** MFA requirement level */
  requirement: 'required' | 'conditional' | 'optional' | 'disabled';
  /** Allowed MFA methods */
  allowedMethods: MfaMethod[];
  /** Maximum MFA remember duration (seconds) */
  rememberDurationMax: number;
  /** Conditions for conditional MFA */
  conditions?: MfaCondition[];
}

/**
 * Condition for conditional MFA.
 */
export interface MfaCondition {
  /** Condition type */
  type: 'new_device' | 'high_risk' | 'sensitive_scope' | 'time_based';
  /** Configuration */
  config?: Record<string, unknown>;
}

/**
 * Password policy.
 */
export interface TenantPasswordPolicy {
  /** Minimum length */
  minLength: number;
  /** Require uppercase */
  requireUppercase: boolean;
  /** Require lowercase */
  requireLowercase: boolean;
  /** Require numbers */
  requireNumbers: boolean;
  /** Require special characters */
  requireSpecialChars: boolean;
  /** Password history count (prevent reuse) */
  historyCount: number;
  /** Maximum age before forced reset (days, 0 = never) */
  maxAgeDays: number;
}

// =============================================================================
// Encryption Policy
// =============================================================================

/**
 * Encryption settings - selectable from platform-supported algorithms.
 */
export interface TenantEncryptionPolicy {
  /** Allowed signing algorithms */
  allowedSigningAlgorithms: SigningAlgorithm[];
  /** Allowed JWE key encryption algorithms */
  allowedKeyEncryptionAlgorithms: KeyEncryptionAlgorithm[];
  /** Allowed JWE content encryption algorithms */
  allowedContentEncryptionAlgorithms: ContentEncryptionAlgorithm[];
  /** PII encryption required */
  piiEncryptionRequired: boolean;
}

// =============================================================================
// Scope Policy
// =============================================================================

/**
 * Scope and claim policy.
 */
export interface TenantScopePolicy {
  /** Maximum allowed scopes (clients can only use subset) */
  allowedScopes: string[];
  /** Explicitly forbidden scopes */
  forbiddenScopes: string[];
  /** Custom scope definitions */
  customScopes?: CustomScopeDefinition[];
  /** Custom claim definitions */
  customClaims?: CustomClaimDefinition[];
}

// =============================================================================
// Auth Method Policy
// =============================================================================

/**
 * Authentication method availability policy.
 */
export interface TenantAuthMethodPolicy {
  /** Passkey/WebAuthn */
  passkey: AuthMethodAvailability;
  /** Email verification code */
  emailCode: AuthMethodAvailability;
  /** Password */
  password: AuthMethodAvailability;
  /** External Identity Provider (SSO) */
  externalIdp: AuthMethodAvailability;
  /** Decentralized Identifier */
  did: AuthMethodAvailability;
}

// =============================================================================
// Consent Policy
// =============================================================================

/**
 * Consent settings policy.
 */
export interface TenantConsentPolicy {
  /** Default consent policy for first-party apps */
  firstPartyDefault: 'skip' | 'show' | 'remember';
  /** Default consent policy for third-party apps */
  thirdPartyDefault: 'always' | 'remember';
  /** Maximum consent remember duration (seconds) */
  maxRememberDuration: number;
  /** Allow implicit scopes (not shown in consent) */
  allowImplicitScopes: boolean;
}

// =============================================================================
// CIBA Policy
// =============================================================================

/**
 * CIBA (Client-Initiated Backchannel Authentication) policy.
 */
export interface TenantCibaPolicy {
  /** CIBA enabled */
  enabled: boolean;
  /** Allowed modes */
  allowedModes: ('poll' | 'ping' | 'push')[];
  /** Maximum request expiry (seconds) */
  maxRequestExpiry: number;
  /** Polling interval (seconds) */
  pollingInterval: number;
}

// =============================================================================
// Device Flow Policy
// =============================================================================

/**
 * Device Authorization Grant policy.
 */
export interface TenantDeviceFlowPolicy {
  /** Device flow enabled */
  enabled: boolean;
  /** User code length */
  userCodeLength: number;
  /** Device code expiry (seconds) */
  deviceCodeExpiry: number;
  /** Polling interval (seconds) */
  pollingInterval: number;
}

// =============================================================================
// External IdP Policy
// =============================================================================

/**
 * External Identity Provider policy.
 */
export interface TenantExternalIdpPolicy {
  /** External IdP enabled */
  enabled: boolean;
  /** Allowed providers (empty = all allowed) */
  allowedProviders?: string[];
  /** JIT (Just-In-Time) provisioning enabled */
  jitProvisioningEnabled: boolean;
  /** Account linking enabled */
  accountLinkingEnabled: boolean;
}

// =============================================================================
// Federation Policy
// =============================================================================

/**
 * Federation settings policy.
 */
export interface TenantFederationPolicy {
  /** Federation enabled */
  enabled: boolean;
  /** SAML enabled */
  samlEnabled: boolean;
  /** OIDC federation enabled */
  oidcEnabled: boolean;
  /** Maximum assertion lifetime (seconds) */
  maxAssertionLifetime: number;
}

// =============================================================================
// SCIM Policy
// =============================================================================

/**
 * SCIM provisioning policy.
 */
export interface TenantScimPolicy {
  /** SCIM enabled */
  enabled: boolean;
  /** Auto-provisioning enabled */
  autoProvisioningEnabled: boolean;
  /** Allowed operations */
  allowedOperations: ('create' | 'read' | 'update' | 'delete')[];
}

// =============================================================================
// Rate Limit Policy
// =============================================================================

/**
 * Rate limiting policy.
 */
export interface TenantRateLimitPolicy {
  /** Login attempts per minute */
  loginAttemptsPerMinute: number;
  /** Token requests per minute */
  tokenRequestsPerMinute: number;
  /** API requests per minute */
  apiRequestsPerMinute: number;
  /** Lockout duration after exceeded (seconds) */
  lockoutDuration: number;
}

// =============================================================================
// Tokens Policy
// =============================================================================

/**
 * Token-related settings policy.
 */
export interface TenantTokensPolicy {
  /** ID token aud format */
  idTokenAudFormat: 'array' | 'string';
  /** Include iss in authorization response (RFC 9207) */
  issResponseParam: boolean;
  /** Introspection enabled */
  introspectionEnabled: boolean;
  /** Revocation enabled */
  revocationEnabled: boolean;
}

// =============================================================================
// Credentials Policy
// =============================================================================

/**
 * Credentials settings policy.
 */
export interface TenantCredentialsPolicy {
  /** Client secret minimum length */
  clientSecretMinLength: number;
  /** Client secret rotation required */
  clientSecretRotationRequired: boolean;
  /** Maximum client secret age (days) */
  maxClientSecretAgeDays: number;
  /** Allowed client authentication methods - for FAPI 2.0 (mTLS or private_key_jwt only) */
  allowedClientAuthMethods?: ClientAuthMethod[];
  /** Public clients allowed - set to false for FAPI 2.0 compliance */
  publicClientsAllowed?: boolean;
}

// =============================================================================
// Data Residency Policy
// =============================================================================

/**
 * Data residency and DRC (Data Residency Control) policy.
 */
export interface TenantDataResidencyPolicy {
  /** DRC enabled */
  enabled: boolean;
  /** Primary data region */
  primaryRegion?: string;
  /** Allowed regions */
  allowedRegions?: string[];
  /** PII storage policy */
  piiStoragePolicy?: PiiStoragePolicy;
}

// =============================================================================
// Audit Policy
// =============================================================================

/**
 * Audit logging policy.
 */
export interface TenantAuditPolicy {
  /** Log retention days */
  retentionDays: number;
  /** Detail level */
  detailLevel: AuditDetailLevel;
  /** Flow replay data retention enabled */
  flowReplayEnabled: boolean;
}
