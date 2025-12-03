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
    name: string;
    providerType: ProviderType;
    iconUrl?: string;
    buttonColor?: string;
    buttonText?: string;
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
