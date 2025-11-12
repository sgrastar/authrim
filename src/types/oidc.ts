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
  token_type: 'Bearer';
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
  software_id?: string;
  software_version?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  application_type?: string;
  scope?: string;
}

/**
 * Stored Client Metadata
 */
export interface ClientMetadata extends ClientRegistrationResponse {
  created_at: number;
  updated_at: number;
}
