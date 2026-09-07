/**
 * External IdP Types
 * Types for upstream provider configuration, linked identities, and auth state
 */

// =============================================================================
// Provider Configuration
// =============================================================================

export type ProviderType = 'oidc' | 'oauth2';

/**
 * Token endpoint authentication method
 * - client_secret_basic: Credentials in Authorization header (RFC 6749 Section 2.3.1)
 * - client_secret_post: Credentials in request body (RFC 6749 Section 2.3.1)
 */
export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post';

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
  /** Token endpoint authentication method (default: client_secret_post) */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;

  // Configuration
  // Keys normally target standard OIDC claims (sub, email, name, picture, ...).
  // When JIT provisioning is enabled, targets may also use:
  // - custom_claims.<field_key>
  // - custom_fields.<field_key>
  // to populate Authrim custom claims from upstream provider claims.
  attributeMapping: Record<string, string>;
  autoLinkEmail: boolean;
  jitProvisioning: boolean;
  requireEmailVerified: boolean;
  /**
   * Always fetch userinfo even when id_token contains claims.
   * Enable this for OIDC RP certification testing or when userinfo
   * returns additional claims not present in id_token.
   * Default: false
   */
  alwaysFetchUserinfo?: boolean;
  /**
   * Whether to enable SSO (Single Sign-On) for this provider.
   * - true (default): Use handoff flow (redirect with handoff_token)
   * - false: Use Direct Auth flow (redirect with authorization code)
   */
  enableSso?: boolean;

  // Provider-specific settings
  providerQuirks: Record<string, unknown>;

  // Request Object (JAR - RFC 9101) settings for RP conformance testing
  /**
   * Whether to use request objects (JAR - RFC 9101)
   * When enabled, authorization parameters are sent as a signed JWT
   */
  useRequestObject?: boolean;
  /**
   * Algorithm for signing request objects (e.g., RS256, ES256)
   * Required when useRequestObject is true
   */
  requestObjectSigningAlg?: string;
  /**
   * JWK containing the private key for signing request objects
   * Stored encrypted in the database
   */
  privateKeyJwkEncrypted?: string;
  /**
   * JWK containing the public key (for JWKS endpoint registration with the OP)
   */
  publicKeyJwk?: Record<string, unknown>;

  // UI customization
  iconUrl?: string;
  iconName?: string;
  buttonColor?: string;
  buttonColorDark?: string;
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
  /** Authrim client ID initiating the external IdP flow */
  clientId?: string;
  providerId: string;
  state: string;
  nonce?: string;
  /** @deprecated Use codeChallenge for client-side PKCE */
  codeVerifier?: string;
  /** Code challenge for PKCE (client-side or server-side) */
  codeChallenge?: string;
  /** Flow ID for diagnostic correlation */
  flowId?: string;
  redirectUri: string;
  userId?: string; // Set if linking to existing account
  sessionId?: string;
  originalAuthRequest?: string; // JSON for OIDC proxy flow
  /** max_age parameter sent in authorization request (for auth_time validation) */
  maxAge?: number;
  /** acr_values parameter sent in authorization request (for acr validation) */
  acrValues?: string;
  /** OIDC prompt parameter (none, login, consent, select_account) */
  prompt?: string;
  /** Whether SSO is enabled for this authentication flow */
  enableSso?: boolean;
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
  token_endpoint_auth_methods_supported?: string[];
  token_endpoint_auth_signing_alg_values_supported?: string[];
  dpop_signing_alg_values_supported?: string[];
  subject_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  request_object_signing_alg_values_supported?: string[];
  authorization_signing_alg_values_supported?: string[];
  claims_supported?: string[];
  /** RFC 7009 Token Revocation endpoint */
  revocation_endpoint?: string;
  /** OpenID Connect Dynamic Client Registration endpoint (RFC 7591/OIDC Registration) */
  registration_endpoint?: string;
  /** RFC 9126 Pushed Authorization Request endpoint. */
  pushed_authorization_request_endpoint?: string;
  require_pushed_authorization_requests?: boolean;
  /** OpenID Connect Back-Channel Logout endpoint (for IdPs that support it) */
  end_session_endpoint?: string;
}

export interface DynamicClientRegistrationConfig {
  enabled: boolean;
  /** Re-register when the configured issuer changes; maintained by Authrim. */
  registeredIssuer?: string;
  clientName?: string;
  initiateLoginUri?: string;
  requestUris?: string[];
  userinfoSignedResponseAlg?: string;
  initialAccessTokenEncrypted?: string;
}

export interface DynamicClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
  token_endpoint_auth_method?: TokenEndpointAuthMethod | 'none';
  [key: string]: unknown;
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
  tenantId: string;
}

export interface HandleIdentityReadyResult {
  status: 'ready';
  userId: string;
  isNewUser: boolean;
  linkedIdentityId: string;
  stitchedFromExisting: boolean;
  /** Roles assigned during JIT provisioning */
  roles_assigned?: Array<{
    role_id: string;
    scope_type: string;
    scope_target: string;
  }>;
  /** Organizations joined during JIT provisioning */
  orgs_joined?: string[];
  /** Attributes set during JIT provisioning */
  attributes_set?: Array<{
    name: string;
    value: string;
  }>;
}

export interface HandleIdentityPendingResult {
  status: 'pending';
  userId: string;
  isNewUser: true;
  stitchedFromExisting: false;
  linkedIdentityId?: string;
  roles_assigned?: HandleIdentityReadyResult['roles_assigned'];
  orgs_joined?: HandleIdentityReadyResult['orgs_joined'];
  attributes_set?: HandleIdentityReadyResult['attributes_set'];
  accountId: string;
  operationId: string;
  providerId: string;
  providerUserId: string;
}

export type HandleIdentityResult = HandleIdentityReadyResult | HandleIdentityPendingResult;

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
    iconName?: string;
    buttonColor?: string;
    buttonColorDark?: string;
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
   * Internal error while creating or materializing a local account.
   */
  ACCOUNT_CREATION_FAILED: 'account_creation_failed',

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

  /**
   * Access denied by policy rule evaluation.
   * The user's attributes did not meet the required conditions.
   * Maps to OIDC error: access_denied
   */
  POLICY_ACCESS_DENIED: 'policy_access_denied',

  /**
   * Automatic account creation failed because required custom claims are missing.
   * This is distinct from generic policy denial so future incomplete-user flows can branch on it.
   */
  REQUIRED_CUSTOM_CLAIMS_MISSING: 'required_custom_claims_missing',

  /**
   * User interaction required by policy rule.
   * The user may need to complete additional steps.
   * Maps to OIDC error: interaction_required
   */
  POLICY_INTERACTION_REQUIRED: 'policy_interaction_required',

  /**
   * Re-authentication required by policy rule.
   * The user may need to authenticate again with stronger credentials.
   * Maps to OIDC error: login_required
   */
  POLICY_LOGIN_REQUIRED: 'policy_login_required',
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
