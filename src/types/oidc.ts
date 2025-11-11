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
  grant_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  subject_types_supported: string[];
  scopes_supported: string[];
  claims_supported: string[];
  token_endpoint_auth_methods_supported?: string[];
  registration_endpoint?: string;
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
 */
export interface TokenResponse {
  access_token: string;
  id_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope?: string;
}

/**
 * ID Token Claims
 */
export interface IDTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nonce?: string;
  // Additional claims
  name?: string;
  email?: string;
  email_verified?: boolean;
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
