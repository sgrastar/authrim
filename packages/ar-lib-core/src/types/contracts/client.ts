/**
 * Client Contract (External API: ClientProfile)
 *
 * Client-level configuration that selects specific values within tenant policy constraints.
 * Clients can only restrict, never relax tenant policy (no relaxation, only restriction).
 *
 * Covers:
 * - Client type and authentication method
 * - OAuth settings (within tenant bounds)
 * - Encryption algorithm selection
 * - Scope/claim configuration
 * - Consent settings
 * - Redirect URI constraints
 */

import type {
  ContractMetadata,
  SigningAlgorithm,
  KeyEncryptionAlgorithm,
  ContentEncryptionAlgorithm,
  ClientAuthMethod,
  ClaimMapping,
} from './common';

import type { ClientProfilePreset } from './presets';

// =============================================================================
// Main ClientContract Interface
// =============================================================================

/**
 * Client Contract (External API: ClientProfile)
 *
 * Defines the specific configuration for this client within tenant policy bounds.
 * All settings must be equal to or more restrictive than tenant policy.
 */
export interface ClientContract {
  /** Client ID */
  clientId: string;

  /** Contract version (incremented on change) */
  version: number;

  /** Referenced tenant contract version */
  tenantContractVersion: number;

  /** Preset used as base */
  preset: ClientProfilePreset;

  // ========== Client Type ==========
  clientType: ClientTypeConfig;

  // ========== OAuth Settings (selected within tenant bounds) ==========
  oauth: ClientOAuthConfig;

  // ========== Encryption Settings (selected within tenant bounds) ==========
  encryption: ClientEncryptionConfig;

  // ========== Scope/Claim Settings ==========
  scopes: ClientScopeConfig;

  // ========== Authentication Method Settings ==========
  authMethods: ClientAuthMethodConfig;

  // ========== Consent Settings ==========
  consent: ClientConsentConfig;

  // ========== Redirect Configuration ==========
  redirect: ClientRedirectConfig;

  // ========== Token Customization ==========
  tokens: ClientTokenConfig;

  // ========== Metadata ==========
  metadata: ContractMetadata;
}

// =============================================================================
// Client Type Configuration
// =============================================================================

/**
 * Client type and authentication configuration.
 */
export interface ClientTypeConfig {
  /** Client type (public or confidential) */
  type: 'public' | 'confidential';

  /** First-party flag (owned by tenant) */
  isFirstParty: boolean;

  /** Client authentication method (confidential clients only) */
  authenticationMethod?: ClientAuthMethod;

  /** Application type for metadata */
  applicationType?: 'web' | 'native' | 'spa' | 'service';

  /** Client display name */
  displayName?: string;

  /** Client description */
  description?: string;

  /** Logo URI for consent screen */
  logoUri?: string;

  /** Policy URI */
  policyUri?: string;

  /** Terms of service URI */
  tosUri?: string;
}

// =============================================================================
// OAuth Configuration
// =============================================================================

/**
 * OAuth settings selected within tenant policy bounds.
 * All expiry values must be <= tenant max values.
 */
export interface ClientOAuthConfig {
  // --- Token Expiry (must be <= tenant max) ---
  /** Access token expiry (seconds) */
  accessTokenExpiry: number;
  /** Refresh token expiry (seconds) */
  refreshTokenExpiry: number;
  /** ID token expiry (seconds) */
  idTokenExpiry: number;
  /** Authorization code TTL (seconds) */
  authCodeTtl: number;

  // --- Signing Algorithm (from tenant allowed list) ---
  /** ID token signing algorithm */
  idTokenSigningAlg: SigningAlgorithm;

  // --- Response Types (subset of tenant allowed) ---
  /** Allowed response types */
  allowedResponseTypes: ('code' | 'token' | 'id_token')[];

  // --- Grant Types ---
  /** Allowed grant types */
  allowedGrantTypes: GrantType[];

  // --- Security Requirements (can be stricter than tenant) ---
  /** PKCE required */
  pkceRequired: boolean;
  /** PAR required */
  parRequired: boolean;

  // --- Behavioral Settings ---
  /** Refresh token rotation enabled */
  refreshTokenRotation: boolean;
  /** Reissue ID token on refresh */
  refreshIdTokenReissue: boolean;
  /** Require offline_access scope for refresh tokens */
  offlineAccessRequired: boolean;
}

/**
 * OAuth 2.0 grant types.
 */
export type GrantType =
  | 'authorization_code'
  | 'refresh_token'
  | 'client_credentials'
  | 'urn:ietf:params:oauth:grant-type:device_code'
  | 'urn:openid:params:grant-type:ciba';

// =============================================================================
// Encryption Configuration
// =============================================================================

/**
 * Encryption settings selected within tenant policy bounds.
 */
export interface ClientEncryptionConfig {
  // --- JWE Key Encryption (from tenant allowed list) ---
  /** Key encryption algorithm for this client */
  keyEncryptionAlg?: KeyEncryptionAlgorithm;

  // --- JWE Content Encryption (from tenant allowed list) ---
  /** Content encryption algorithm for this client */
  contentEncryptionAlg?: ContentEncryptionAlgorithm;

  // --- Token Encryption ---
  /** Encrypt ID tokens */
  encryptIdToken: boolean;
  /** Encrypt UserInfo response */
  encryptUserInfo: boolean;

  // --- Client Public Key (for encryption) ---
  /** Client JWKS URI */
  jwksUri?: string;
  /** Client JWKS (inline) */
  jwks?: JsonWebKeySet;
}

/**
 * JSON Web Key Set.
 */
export interface JsonWebKeySet {
  keys: JsonWebKey[];
}

/**
 * JSON Web Key (simplified).
 */
export interface JsonWebKey {
  kty: string;
  use?: 'sig' | 'enc';
  key_ops?: string[];
  alg?: string;
  kid?: string;
  [key: string]: unknown;
}

// =============================================================================
// Scope Configuration
// =============================================================================

/**
 * Scope and claim configuration.
 */
export interface ClientScopeConfig {
  /** Allowed scopes for this client (⊆ tenant allowedScopes) */
  allowedScopes: string[];

  /** Default scopes when not specified in request */
  defaultScopes: string[];

  /** Allow dynamic scope requests */
  allowDynamicScopes: boolean;

  /** Claim mappings for token customization */
  claimMappings?: ClaimMapping[];

  /** Additional claims to include in ID token */
  additionalIdTokenClaims?: string[];

  /** Additional claims to include in access token */
  additionalAccessTokenClaims?: string[];
}

// =============================================================================
// Authentication Method Configuration
// =============================================================================

/**
 * Authentication method configuration.
 * Can only enable methods that are enabled at tenant level.
 */
export interface ClientAuthMethodConfig {
  /** Passkey/WebAuthn enabled (if tenant allows) */
  passkey: boolean;

  /** Email verification code enabled (if tenant allows) */
  emailCode: boolean;

  /** Password enabled (if tenant allows) */
  password: boolean;

  /** External IdP enabled (if tenant allows) */
  externalIdp: boolean;

  /** Decentralized ID enabled (if tenant allows) */
  did: boolean;

  /** Preferred authentication method */
  preferredMethod?: AuthMethodType;

  /** Allowed external IdP provider IDs */
  allowedExternalIdpIds?: string[];

  /** MFA requirement (can be stricter than tenant) */
  mfaRequirement?: 'required' | 'conditional' | 'optional';
}

/**
 * Authentication method types.
 */
export type AuthMethodType = 'passkey' | 'emailCode' | 'password' | 'externalIdp' | 'did';

// =============================================================================
// Consent Configuration
// =============================================================================

/**
 * Consent settings for this client.
 */
export interface ClientConsentConfig {
  /** Consent policy */
  policy: ClientConsentPolicy;

  /** Consent remember duration (seconds, if policy allows) */
  rememberDuration?: number;

  /** Implicit scopes (not shown in consent screen) */
  implicitScopes?: string[];

  /** Custom scope descriptions for consent screen */
  scopeDescriptions?: Record<string, ConsentScopeDescription>;

  /** Show granular scope selection to user */
  allowGranularConsent: boolean;
}

/**
 * Client consent policy.
 */
export type ClientConsentPolicy =
  | 'always' // Always show consent
  | 'first_time' // Show on first authorization only
  | 'remember' // Remember user's choice
  | 'skip'; // Skip consent (first-party only)

/**
 * Custom scope description for consent screen.
 */
export interface ConsentScopeDescription {
  /** Display name */
  displayName: string;
  /** Description */
  description: string;
  /** Icon identifier */
  icon?: string;
}

// =============================================================================
// Redirect Configuration
// =============================================================================

/**
 * Redirect URI configuration.
 */
export interface ClientRedirectConfig {
  /** Allowed redirect URIs (exact match) */
  allowedRedirectUris: string[];

  /** Allowed redirect URI patterns (wildcard support) */
  allowedRedirectPatterns?: string[];

  /** Allow localhost redirect (development) */
  allowLocalhost: boolean;

  /** Post logout redirect URIs */
  postLogoutRedirectUris?: string[];

  /** Backchannel logout URI (for session management) */
  backchannelLogoutUri?: string;

  /** Frontchannel logout URI */
  frontchannelLogoutUri?: string;

  /** Initiate login URI */
  initiateLoginUri?: string;
}

// =============================================================================
// Token Customization Configuration
// =============================================================================

/**
 * Token customization settings.
 */
export interface ClientTokenConfig {
  /** ID token audience format */
  idTokenAudFormat: 'array' | 'string';

  /** Include iss in authorization response (RFC 9207) */
  issResponseParam: boolean;

  /** Token introspection enabled for this client */
  introspectionEnabled: boolean;

  /** Token revocation enabled for this client */
  revocationEnabled: boolean;

  /** Access token format */
  accessTokenFormat: 'opaque' | 'jwt';

  /** Custom access token claims */
  customAccessTokenClaims?: Record<string, unknown>;
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Result of client contract validation against tenant policy.
 */
export interface ClientContractValidationResult {
  /** Validation passed */
  valid: boolean;

  /** Validation errors */
  errors: ClientContractValidationError[];

  /** Validation warnings */
  warnings: ClientContractValidationWarning[];
}

/**
 * Client contract validation error.
 */
export interface ClientContractValidationError {
  /** Error code */
  code: ClientValidationErrorCode;
  /** Field path (e.g., 'oauth.accessTokenExpiry') */
  field: string;
  /** Error message */
  message: string;
  /** Tenant constraint value */
  tenantValue?: unknown;
  /** Client requested value */
  clientValue?: unknown;
}

/**
 * Client contract validation warning.
 */
export interface ClientContractValidationWarning {
  /** Warning code */
  code: string;
  /** Field path */
  field: string;
  /** Warning message */
  message: string;
}

/**
 * Client validation error codes.
 */
export type ClientValidationErrorCode =
  | 'exceeds_tenant_max' // Value exceeds tenant maximum
  | 'not_in_tenant_allowed' // Value not in tenant allowed list
  | 'tenant_disabled' // Feature disabled at tenant level
  | 'tenant_required' // Feature required at tenant level but not enabled
  | 'invalid_format' // Invalid format
  | 'missing_required' // Required field missing
  | 'invalid_combination'; // Invalid combination of settings
