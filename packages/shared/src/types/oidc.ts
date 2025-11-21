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
  // RFC 8628: Device Authorization Grant
  device_authorization_endpoint?: string;
  // OIDC CIBA (Client Initiated Backchannel Authentication)
  backchannel_authentication_endpoint?: string;
  backchannel_token_delivery_modes_supported?: string[];
  backchannel_authentication_request_signing_alg_values_supported?: string[];
  backchannel_user_code_parameter_supported?: boolean;
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
  // Trusted Client Settings
  is_trusted?: boolean; // Trusted (First-Party) client
  skip_consent?: boolean; // Skip consent screen for trusted clients
  // Claims Parameter Settings
  allow_claims_without_scope?: boolean; // Allow claims parameter to request claims without corresponding scope (default: false)
  // JWE fields inherited from ClientRegistrationResponse
  id_token_encrypted_response_alg?: string;
  id_token_encrypted_response_enc?: string;
  userinfo_encrypted_response_alg?: string;
  userinfo_encrypted_response_enc?: string;
  jwks?: { keys: unknown[] };
  // CIBA (Client Initiated Backchannel Authentication) settings
  backchannel_token_delivery_mode?: string; // 'poll', 'ping', 'push', or combination
  backchannel_client_notification_endpoint?: string; // Callback URL for ping/push modes
  backchannel_authentication_request_signing_alg?: string; // Algorithm for signed auth requests
  backchannel_user_code_parameter?: boolean; // Whether client supports user_code parameter
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

/**
 * Device Authorization Request
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.1
 */
export interface DeviceAuthorizationRequest {
  client_id: string;
  scope?: string;
}

/**
 * Device Authorization Response
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.2
 */
export interface DeviceAuthorizationResponse {
  device_code: string; // Unique device verification code
  user_code: string; // End-user verification code (8-char, human-readable)
  verification_uri: string; // End-user verification URI
  verification_uri_complete?: string; // Verification URI with user_code included
  expires_in: number; // Lifetime in seconds (typically 300-600)
  interval?: number; // Minimum polling interval in seconds (default 5)
}

/**
 * Device Code Metadata
 * Internal storage for device authorization flow
 */
export interface DeviceCodeMetadata {
  device_code: string;
  user_code: string;
  client_id: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  created_at: number;
  expires_at: number;
  last_poll_at?: number; // Last time the device polled for the token
  poll_count?: number; // Number of times the device has polled
  user_id?: string; // Set when user approves the device
  sub?: string; // Subject (user identifier) - set when approved
}

/**
 * CIBA (Client Initiated Backchannel Authentication) Request
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 */
export interface CIBAAuthenticationRequest {
  scope: string;
  client_notification_token?: string; // Required for ping and push modes
  acr_values?: string;
  login_hint_token?: string; // JWT containing login hint
  id_token_hint?: string; // Previously issued ID token
  login_hint?: string; // Email, phone, or other identifier
  binding_message?: string; // Human-readable message to display to user
  user_code?: string; // Optional code for user to verify
  requested_expiry?: number; // Requested expiry time in seconds
}

/**
 * CIBA Authentication Response
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html#auth_response
 */
export interface CIBAAuthenticationResponse {
  auth_req_id: string; // Unique authentication request identifier
  expires_in: number; // Lifetime in seconds
  interval?: number; // Minimum polling interval in seconds (poll mode only)
}

/**
 * CIBA Request Metadata
 * Internal storage for CIBA authentication flow
 */
export interface CIBARequestMetadata {
  auth_req_id: string; // Unique authentication request identifier
  client_id: string;
  scope: string;
  login_hint?: string; // Email, phone, or other user identifier
  login_hint_token?: string; // JWT containing login hint
  id_token_hint?: string; // Previously issued ID token
  binding_message?: string; // Message to display to user
  user_code?: string; // Optional verification code
  acr_values?: string; // Requested Authentication Context Class Reference values
  requested_expiry?: number; // Client-requested expiry time
  status: 'pending' | 'approved' | 'denied' | 'expired';
  delivery_mode: 'poll' | 'ping' | 'push'; // Token delivery mode
  client_notification_token?: string; // For ping/push modes
  client_notification_endpoint?: string; // Callback URL for ping/push modes
  created_at: number;
  expires_at: number;
  last_poll_at?: number; // Last time client polled for the token
  poll_count?: number; // Number of times client has polled
  interval: number; // Minimum polling interval in seconds
  user_id?: string; // Set when user approves the request
  sub?: string; // Subject (user identifier) - set when approved
  nonce?: string; // Nonce for ID token (optional)
  // Token issuance tracking
  token_issued?: boolean; // True if tokens have been issued
  token_issued_at?: number; // Timestamp when tokens were issued
}
