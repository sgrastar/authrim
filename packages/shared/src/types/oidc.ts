/**
 * OpenID Connect and OAuth 2.0 Type Definitions
 */

/**
 * OpenID Provider Metadata (Discovery Document)
 * https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata
 */
export interface OIDCProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  response_modes_supported?: string[];
  grant_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  subject_types_supported: string[];
  scopes_supported: string[];
  claims_supported: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  registration_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  end_session_endpoint?: string;
  // RFC 9126: PAR (Pushed Authorization Requests)
  pushed_authorization_request_endpoint?: string;
  require_pushed_authorization_requests?: boolean;
  // RFC 9449: DPoP (Demonstrating Proof of Possession)
  dpop_signing_alg_values_supported?: string[];
  // RFC 9101 (JAR): Request Object support
  request_parameter_supported?: boolean;
  request_uri_parameter_supported?: boolean;
  request_object_signing_alg_values_supported?: string[];
  // RFC 7516: JWE (JSON Web Encryption) support
  id_token_encryption_alg_values_supported?: string[];
  id_token_encryption_enc_values_supported?: string[];
  userinfo_encryption_alg_values_supported?: string[];
  userinfo_encryption_enc_values_supported?: string[];
  // OIDC Core: Additional metadata
  claim_types_supported?: string[];
  claims_parameter_supported?: boolean;
  acr_values_supported?: string[];
}

/**
 * Authorization Request Parameters
 */
export interface AuthorizationRequest {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  nonce?: string;
}

/**
 * Token Request Parameters
 */
export interface TokenRequest {
  grant_type: string;
  code: string;
  client_id: string;
  redirect_uri: string;
  client_secret?: string;
  code_verifier?: string; // PKCE code verifier
}

/**
 * Token Response
 * https://tools.ietf.org/html/rfc6749#section-5.1
 */
export interface TokenResponse {
  access_token: string;
  id_token: string;
  token_type: 'Bearer' | 'DPoP';
  expires_in: number;
  scope?: string;
  refresh_token?: string;
}

/**
 * ID Token Claims
 * https://openid.net/specs/openid-connect-core-1_0.html#IDToken
 */
export interface IDTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  at_hash?: string;
  c_hash?: string;
  acr?: string;
  amr?: string[];
  azp?: string;
  // Standard profile claims
  name?: string;
  given_name?: string;
  family_name?: string;
  middle_name?: string;
  nickname?: string;
  preferred_username?: string;
  profile?: string;
  picture?: string;
  website?: string;
  gender?: string;
  birthdate?: string;
  zoneinfo?: string;
  locale?: string;
  updated_at?: number;
  // Standard email claims
  email?: string;
  email_verified?: boolean;
  // Standard phone claims
  phone_number?: string;
  phone_number_verified?: boolean;
  // Standard address claim
  address?: {
    formatted?: string;
    street_address?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
}

/**
 * UserInfo Response
 */
export interface UserInfoResponse {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

/**
 * Authorization Code Metadata
 */
export interface AuthCodeMetadata {
  client_id: string;
  redirect_uri: string;
  scope: string;
  sub: string; // Subject (user identifier) - required for token issuance
  nonce?: string;
  timestamp: number;
  code_challenge?: string;
  code_challenge_method?: 'S256' | 'plain';
}

/**
 * OAuth 2.0 Error Response
 */
export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Dynamic Client Registration Request
 * https://openid.net/specs/openid-connect-registration-1_0.html#ClientMetadata
 */
export interface ClientRegistrationRequest {
  // Required fields
  redirect_uris: string[];
  // Optional fields
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: { keys: unknown[] }; // Embedded JWK Set
  software_id?: string;
  software_version?: string;
  // Token endpoint authentication
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none';
  // Grant types and response types
  grant_types?: string[];
  response_types?: string[];
  // Application type
  application_type?: 'web' | 'native';
  // Scopes
  scope?: string;
  // Subject type (OIDC Core 8)
  subject_type?: 'public' | 'pairwise';
  sector_identifier_uri?: string;
  // JWE (JSON Web Encryption) - RFC 7516
  id_token_encrypted_response_alg?: string;
  id_token_encrypted_response_enc?: string;
  userinfo_encrypted_response_alg?: string;
  userinfo_encrypted_response_enc?: string;
}

/**
 * Dynamic Client Registration Response
 * https://openid.net/specs/openid-connect-registration-1_0.html#RegistrationResponse
 */
export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: { keys: unknown[] };
  software_id?: string;
  software_version?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  application_type?: string;
  scope?: string;
  subject_type?: 'public' | 'pairwise';
  sector_identifier_uri?: string;
  // JWE (JSON Web Encryption) - RFC 7516
  id_token_encrypted_response_alg?: string;
  id_token_encrypted_response_enc?: string;
  userinfo_encrypted_response_alg?: string;
  userinfo_encrypted_response_enc?: string;
}

/**
 * Stored Client Metadata
 */
export interface ClientMetadata extends ClientRegistrationResponse {
  created_at: number;
  updated_at: number;
  // OIDC Core 8: Subject Identifier Types
  subject_type?: 'public' | 'pairwise';
  sector_identifier_uri?: string; // For pairwise subject type
  // JWE fields inherited from ClientRegistrationResponse
  id_token_encrypted_response_alg?: string;
  id_token_encrypted_response_enc?: string;
  userinfo_encrypted_response_alg?: string;
  userinfo_encrypted_response_enc?: string;
  jwks?: { keys: unknown[] };
}

/**
 * Refresh Token Metadata
 * Stored in KV for refresh token management
 */
export interface RefreshTokenData {
  jti: string; // Unique token ID
  client_id: string;
  sub: string; // Subject (user identifier)
  scope: string;
  iat: number; // Issued at timestamp
  exp: number; // Expiration timestamp
}

/**
 * Token Introspection Request
 * https://tools.ietf.org/html/rfc7662#section-2.1
 */
export interface IntrospectionRequest {
  token: string;
  token_type_hint?: 'access_token' | 'refresh_token';
}

/**
 * Token Introspection Response
 * https://tools.ietf.org/html/rfc7662#section-2.2
 */
export interface IntrospectionResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  username?: string;
  token_type?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
  aud?: string;
  iss?: string;
  jti?: string;
}

/**
 * Token Revocation Request
 * https://tools.ietf.org/html/rfc7009#section-2.1
 */
export interface RevocationRequest {
  token: string;
  token_type_hint?: 'access_token' | 'refresh_token';
}

/**
 * DPoP (Demonstrating Proof of Possession) JWT Header
 * https://datatracker.ietf.org/doc/html/rfc9449#section-4.2
 */
export interface DPoPHeader {
  typ: 'dpop+jwt';
  alg: string; // Signing algorithm (e.g., 'RS256', 'ES256')
  jwk: {
    kty: string;
    // RSA public key
    n?: string;
    e?: string;
    // EC public key
    crv?: string;
    x?: string;
    y?: string;
  };
}

/**
 * DPoP JWT Claims
 * https://datatracker.ietf.org/doc/html/rfc9449#section-4.2
 */
export interface DPoPClaims {
  jti: string; // Unique identifier for the DPoP proof
  htm: string; // HTTP method (uppercase, e.g., 'POST', 'GET')
  htu: string; // HTTP URI (without query and fragment)
  iat: number; // Issued at timestamp
  ath?: string; // Access token hash (base64url-encoded SHA-256 hash)
  nonce?: string; // Server-provided nonce for replay protection
}

/**
 * DPoP Proof Validation Result
 */
export interface DPoPValidationResult {
  valid: boolean;
  error?: string;
  error_description?: string;
  jwk?: {
    kty: string;
    n?: string;
    e?: string;
    crv?: string;
    x?: string;
    y?: string;
  };
  jkt?: string; // JWK Thumbprint (SHA-256, base64url-encoded)
}
