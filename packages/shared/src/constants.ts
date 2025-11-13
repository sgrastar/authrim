/**
 * OIDC and OAuth 2.0 Constants
 *
 * Centralized constant definitions for OpenID Connect and OAuth 2.0 protocol.
 * This file provides type-safe constants to avoid magic strings and numbers.
 */

/**
 * OpenID Connect Scopes
 * https://openid.net/specs/openid-connect-core-1_0.html#ScopeClaims
 */
export const OIDC_SCOPES = {
  OPENID: 'openid',
  PROFILE: 'profile',
  EMAIL: 'email',
  ADDRESS: 'address',
  PHONE: 'phone',
  OFFLINE_ACCESS: 'offline_access',
} as const;

/**
 * Standard OIDC Claims
 * https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims
 */
export const STANDARD_CLAIMS = {
  // Identity Claims
  SUB: 'sub',
  NAME: 'name',
  GIVEN_NAME: 'given_name',
  FAMILY_NAME: 'family_name',
  MIDDLE_NAME: 'middle_name',
  NICKNAME: 'nickname',
  PREFERRED_USERNAME: 'preferred_username',
  PROFILE: 'profile',
  PICTURE: 'picture',
  WEBSITE: 'website',
  EMAIL: 'email',
  EMAIL_VERIFIED: 'email_verified',
  GENDER: 'gender',
  BIRTHDATE: 'birthdate',
  ZONEINFO: 'zoneinfo',
  LOCALE: 'locale',
  PHONE_NUMBER: 'phone_number',
  PHONE_NUMBER_VERIFIED: 'phone_number_verified',
  ADDRESS: 'address',
  UPDATED_AT: 'updated_at',

  // Token Claims
  ISS: 'iss',
  AUD: 'aud',
  EXP: 'exp',
  IAT: 'iat',
  AUTH_TIME: 'auth_time',
  NONCE: 'nonce',
  ACR: 'acr',
  AMR: 'amr',
  AZP: 'azp',

  // Code Flow Specific
  AT_HASH: 'at_hash',
  C_HASH: 'c_hash',
} as const;

/**
 * OAuth 2.0 and OIDC Error Codes
 * https://tools.ietf.org/html/rfc6749#section-4.1.2.1
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthError
 */
export const ERROR_CODES = {
  // OAuth 2.0 Errors (RFC 6749)
  INVALID_REQUEST: 'invalid_request',
  INVALID_CLIENT: 'invalid_client',
  INVALID_GRANT: 'invalid_grant',
  UNAUTHORIZED_CLIENT: 'unauthorized_client',
  UNSUPPORTED_GRANT_TYPE: 'unsupported_grant_type',
  INVALID_SCOPE: 'invalid_scope',
  ACCESS_DENIED: 'access_denied',
  UNSUPPORTED_RESPONSE_TYPE: 'unsupported_response_type',
  SERVER_ERROR: 'server_error',
  TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',

  // OIDC Specific Errors
  INTERACTION_REQUIRED: 'interaction_required',
  LOGIN_REQUIRED: 'login_required',
  ACCOUNT_SELECTION_REQUIRED: 'account_selection_required',
  CONSENT_REQUIRED: 'consent_required',
  INVALID_REQUEST_URI: 'invalid_request_uri',
  INVALID_REQUEST_OBJECT: 'invalid_request_object',
  REQUEST_NOT_SUPPORTED: 'request_not_supported',
  REQUEST_URI_NOT_SUPPORTED: 'request_uri_not_supported',
  REGISTRATION_NOT_SUPPORTED: 'registration_not_supported',

  // Token Endpoint Errors
  INVALID_TOKEN: 'invalid_token',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
} as const;

/**
 * PKCE (Proof Key for Code Exchange) Constants
 * https://tools.ietf.org/html/rfc7636
 */
export const PKCE = {
  METHOD_S256: 'S256',
  METHOD_PLAIN: 'plain',
  VERIFIER_MIN_LENGTH: 43,
  VERIFIER_MAX_LENGTH: 128,
  CHALLENGE_MIN_LENGTH: 43,
  CHALLENGE_MAX_LENGTH: 128,
  VERIFIER_PATTERN: /^[A-Za-z0-9_-]{43,128}$/,
  CHALLENGE_PATTERN: /^[A-Za-z0-9_-]{43,128}$/,
} as const;

/**
 * OAuth 2.0 Grant Types
 */
export const GRANT_TYPES = {
  AUTHORIZATION_CODE: 'authorization_code',
  REFRESH_TOKEN: 'refresh_token',
  CLIENT_CREDENTIALS: 'client_credentials',
  PASSWORD: 'password',
  IMPLICIT: 'implicit',
} as const;

/**
 * OAuth 2.0 Response Types
 */
export const RESPONSE_TYPES = {
  CODE: 'code',
  TOKEN: 'token',
  ID_TOKEN: 'id_token',
  CODE_ID_TOKEN: 'code id_token',
  CODE_TOKEN: 'code token',
  ID_TOKEN_TOKEN: 'id_token token',
  CODE_ID_TOKEN_TOKEN: 'code id_token token',
} as const;

/**
 * Response Modes
 */
export const RESPONSE_MODES = {
  QUERY: 'query',
  FRAGMENT: 'fragment',
  FORM_POST: 'form_post',
} as const;

/**
 * Token Types
 */
export const TOKEN_TYPES = {
  BEARER: 'Bearer',
  DPoP: 'DPoP',
} as const;

/**
 * Subject Types
 */
export const SUBJECT_TYPES = {
  PUBLIC: 'public',
  PAIRWISE: 'pairwise',
} as const;

/**
 * Client Authentication Methods
 */
export const CLIENT_AUTH_METHODS = {
  CLIENT_SECRET_POST: 'client_secret_post',
  CLIENT_SECRET_BASIC: 'client_secret_basic',
  CLIENT_SECRET_JWT: 'client_secret_jwt',
  PRIVATE_KEY_JWT: 'private_key_jwt',
  NONE: 'none',
} as const;

/**
 * Signing Algorithms
 */
export const SIGNING_ALGS = {
  RS256: 'RS256',
  RS384: 'RS384',
  RS512: 'RS512',
  ES256: 'ES256',
  ES384: 'ES384',
  ES512: 'ES512',
  HS256: 'HS256',
  HS384: 'HS384',
  HS512: 'HS512',
  PS256: 'PS256',
  PS384: 'PS384',
  PS512: 'PS512',
} as const;

/**
 * HTTP Status Codes (commonly used in OIDC)
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  FOUND: 302,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/**
 * Default Expiry Times (in seconds)
 */
export const DEFAULT_EXPIRY = {
  AUTHORIZATION_CODE: 120, // 2 minutes
  ACCESS_TOKEN: 3600, // 1 hour
  REFRESH_TOKEN: 2592000, // 30 days
  ID_TOKEN: 3600, // 1 hour
  STATE: 300, // 5 minutes
  NONCE: 300, // 5 minutes
} as const;

/**
 * Validation Limits
 */
export const VALIDATION_LIMITS = {
  CLIENT_ID_MAX_LENGTH: 256,
  STATE_MAX_LENGTH: 512,
  NONCE_MAX_LENGTH: 512,
  REDIRECT_URI_MAX_LENGTH: 2048,
  SCOPE_MAX_COUNT: 20,
} as const;

/**
 * Cache Control Values
 */
export const CACHE_CONTROL = {
  NO_STORE: 'no-store',
  NO_CACHE: 'no-cache',
  PUBLIC_1H: 'public, max-age=3600',
  PUBLIC_24H: 'public, max-age=86400',
  PRIVATE_1H: 'private, max-age=3600',
} as const;

/**
 * Content Types
 */
export const CONTENT_TYPES = {
  JSON: 'application/json',
  FORM_URLENCODED: 'application/x-www-form-urlencoded',
  JWT: 'application/jwt',
  JWKS_JSON: 'application/jwk-set+json',
} as const;

/**
 * Well-Known Endpoints
 */
export const WELL_KNOWN = {
  OPENID_CONFIGURATION: '/.well-known/openid-configuration',
  JWKS: '/.well-known/jwks.json',
  OAUTH_AUTHORIZATION_SERVER: '/.well-known/oauth-authorization-server',
} as const;

/**
 * Standard Endpoints
 */
export const ENDPOINTS = {
  AUTHORIZE: '/authorize',
  TOKEN: '/token',
  USERINFO: '/userinfo',
  REVOCATION: '/revoke',
  INTROSPECTION: '/introspect',
  REGISTRATION: '/register',
  END_SESSION: '/endsession',
} as const;
