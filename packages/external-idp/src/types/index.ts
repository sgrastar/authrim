/**
 * External IdP Types
 * Types for upstream provider configuration, linked identities, and auth state
 */

// =============================================================================
// Provider Configuration
// =============================================================================

export type ProviderType = 'oidc' | 'oauth2';

export interface UpstreamProvider {
  id: string;
  tenantId: string;
  slug?: string; // User-friendly identifier for callback URLs (e.g., "google")
  name: string;
  providerType: ProviderType;
  enabled: boolean;
  priority: number;

  // OIDC/OAuth2 endpoints
  issuer?: string;
  clientId: string;
  clientSecretEncrypted: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  scopes: string;

  // Configuration
  attributeMapping: Record<string, string>;
  autoLinkEmail: boolean;
  jitProvisioning: boolean;
  requireEmailVerified: boolean;

  // Provider-specific settings
  providerQuirks: Record<string, unknown>;

  // UI customization
  iconUrl?: string;
  buttonColor?: string;
  buttonText?: string;

  // Metadata
  createdAt: number;
  updatedAt: number;
}

// =============================================================================
// Linked Identity
// =============================================================================

export interface LinkedIdentity {
  id: string;
  tenantId: string;
  userId: string;
  providerId: string;
  providerUserId: string;
  providerEmail?: string;
  emailVerified: boolean;

  // Token storage (encrypted)
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  tokenExpiresAt?: number;

  // Raw data
  rawClaims?: Record<string, unknown>;
  profileData?: Record<string, unknown>;

  // Timestamps
  linkedAt: number;
  lastLoginAt?: number;
  updatedAt: number;
}

// =============================================================================
// Auth State (for CSRF/PKCE)
// =============================================================================

export interface ExternalIdpAuthState {
  id: string;
  tenantId: string;
  providerId: string;
  state: string;
  nonce?: string;
  codeVerifier?: string;
  redirectUri: string;
  userId?: string; // Set if linking to existing account
  sessionId?: string;
  originalAuthRequest?: string; // JSON for OIDC proxy flow
  /** max_age parameter sent in authorization request (for auth_time validation) */
  maxAge?: number;
  /** acr_values parameter sent in authorization request (for acr validation) */
  acrValues?: string;
  expiresAt: number;
  createdAt: number;
}

// =============================================================================
// OIDC/OAuth2 Types
// =============================================================================

export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  scopes_supported?: string[];
  response_types_supported: string[];
  grant_types_supported?: string[];
  subject_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  claims_supported?: string[];
  /** RFC 7009 Token Revocation endpoint */
  revocation_endpoint?: string;
  /** OpenID Connect Back-Channel Logout endpoint (for IdPs that support it) */
  end_session_endpoint?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface UserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  /** Time when authentication occurred (OIDC Core) */
  auth_time?: number;
  /** Authentication Context Class Reference (OIDC Core) */
  acr?: string;
  /** Authentication Methods References (OIDC Core) */
  amr?: string[];
  [key: string]: unknown;
}

// =============================================================================
// Identity Stitching
// =============================================================================

export interface StitchingConfig {
  enabled: boolean;
  requireVerifiedEmail: boolean;
}

export interface HandleIdentityParams {
  provider: UpstreamProvider;
  userInfo: UserInfo;
  tokens: TokenResponse;
  linkingUserId?: string;
  tenantId?: string;
}

export interface HandleIdentityResult {
  userId: string;
  isNewUser: boolean;
  linkedIdentityId: string;
  stitchedFromExisting: boolean;
}

// =============================================================================
// API Responses
// =============================================================================

export interface ProviderListResponse {
  providers: Array<{
    id: string;
    slug?: string; // User-friendly identifier for URLs
    name: string;
    providerType: ProviderType;
    iconUrl?: string;
    buttonColor?: string;
    buttonText?: string;
    enabled: boolean;
  }>;
}

export interface LinkedIdentityListResponse {
  identities: Array<{
    id: string;
    providerId: string;
    providerName: string;
    providerEmail?: string;
    linkedAt: number;
    lastLoginAt?: number;
  }>;
}

// =============================================================================
// External IdP Error Codes
// =============================================================================

/**
 * Error codes for external IdP authentication flows
 * These codes are returned to the UI for user-friendly error messages
 */
export const ExternalIdPErrorCode = {
  /**
   * An account with this email already exists.
   * User should log in with existing credentials first, then link the external account.
   * Safe to show: User has already authenticated with the external provider.
   */
  ACCOUNT_EXISTS_LINK_REQUIRED: 'account_exists_link_required',

  /**
   * The external provider returned an unverified email.
   * We require verified emails for security.
   * Safe to show: Generic security message, no email enumeration risk.
   */
  EMAIL_NOT_VERIFIED: 'email_not_verified',

  /**
   * JIT (Just-In-Time) provisioning is disabled.
   * New account creation is not allowed via external providers.
   * Safe to show: Policy information, no sensitive data.
   */
  JIT_PROVISIONING_DISABLED: 'jit_provisioning_disabled',

  /**
   * No account found and automatic linking/provisioning not available.
   * User needs to register first or contact admin.
   * Safe to show: Generic "no account" message.
   */
  NO_ACCOUNT_FOUND: 'no_account_found',

  /**
   * The external provider returned an error.
   * Could be access_denied, invalid_scope, etc.
   */
  PROVIDER_ERROR: 'provider_error',

  /**
   * Internal error during callback processing.
   */
  CALLBACK_FAILED: 'callback_failed',

  /**
   * Identity stitching would auto-link, but email is not verified on Authrim side.
   * User should verify their email first.
   */
  LOCAL_EMAIL_NOT_VERIFIED: 'local_email_not_verified',

  /**
   * The authentication context class (acr) returned by the provider does not meet
   * the requested acr_values. The user may need to re-authenticate with a stronger method.
   * OIDC Core 1.0 Section 3.1.2.1
   */
  ACR_VALUES_NOT_SATISFIED: 'acr_values_not_satisfied',

  /**
   * Token revocation at the provider failed.
   * The identity was unlinked locally but tokens may still be valid at the provider.
   */
  TOKEN_REVOCATION_FAILED: 'token_revocation_failed',
} as const;

export type ExternalIdPErrorCode = (typeof ExternalIdPErrorCode)[keyof typeof ExternalIdPErrorCode];

/**
 * Custom error class for external IdP operations
 */
export class ExternalIdPError extends Error {
  constructor(
    public readonly code: ExternalIdPErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ExternalIdPError';
  }
}
