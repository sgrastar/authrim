/**
 * ID-JAG (Identity Assertion Authorization Grant) Types
 *
 * Implementation of draft-ietf-oauth-identity-assertion-authz-grant
 * for IdP-mediated authorization using Token Exchange (RFC 8693).
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
 */

/**
 * ID-JAG Token Type URN
 *
 * Used in Token Exchange requests to indicate an ID-JAG token is being requested.
 */
export const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';

/**
 * RFC 8693 Token Type URNs for Token Exchange
 * Named differently from TOKEN_TYPES in constants.ts (which defines Bearer/DPoP)
 */
export const TOKEN_TYPE_URNS = {
  ACCESS_TOKEN: 'urn:ietf:params:oauth:token-type:access_token',
  REFRESH_TOKEN: 'urn:ietf:params:oauth:token-type:refresh_token',
  ID_TOKEN: 'urn:ietf:params:oauth:token-type:id_token',
  JWT: 'urn:ietf:params:oauth:token-type:jwt',
  SAML1: 'urn:ietf:params:oauth:token-type:saml1',
  SAML2: 'urn:ietf:params:oauth:token-type:saml2',
  ID_JAG: TOKEN_TYPE_ID_JAG,
} as const;

/**
 * ID-JAG Configuration
 */
export interface IdJagConfig {
  /** Enable ID-JAG support */
  enabled: boolean;

  /** Allowed issuers for subject_token (IdPs that can be trusted) */
  allowedIssuers: string[];

  /** Maximum token lifetime for ID-JAG tokens (seconds) */
  maxTokenLifetime: number;

  /** Whether to include tenant claim in ID-JAG tokens */
  includeTenantClaim: boolean;

  /** Require confidential client only (per spec recommendation) */
  requireConfidentialClient: boolean;
}

/**
 * Default ID-JAG Configuration
 *
 * Secure defaults per specification recommendations
 */
export const DEFAULT_ID_JAG_CONFIG: IdJagConfig = {
  enabled: false,
  allowedIssuers: [],
  maxTokenLifetime: 3600, // 1 hour
  includeTenantClaim: true,
  requireConfidentialClient: true, // SHOULD only be supported for confidential clients
};

/**
 * ID-JAG Token Exchange Request Parameters
 *
 * Extended Token Exchange (RFC 8693) parameters for ID-JAG
 */
export interface IdJagTokenExchangeRequest {
  /** Must be 'urn:ietf:params:oauth:grant-type:token-exchange' */
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange';

  /** The identity assertion (ID Token or SAML assertion) */
  subject_token: string;

  /** Type of subject_token */
  subject_token_type:
    | 'urn:ietf:params:oauth:token-type:id_token'
    | 'urn:ietf:params:oauth:token-type:jwt'
    | 'urn:ietf:params:oauth:token-type:saml2';

  /** Request ID-JAG token */
  requested_token_type: typeof TOKEN_TYPE_ID_JAG;

  /** Target audience(s) for the ID-JAG token */
  audience?: string | string[];

  /** Requested scopes */
  scope?: string;

  /** Resource indicators (RFC 8707) */
  resource?: string | string[];
}

/**
 * ID-JAG Token Response
 *
 * Token Exchange response with ID-JAG token
 */
export interface IdJagTokenResponse {
  /** The issued ID-JAG token */
  access_token: string;

  /** Token type indicator */
  issued_token_type: typeof TOKEN_TYPE_ID_JAG;

  /** Bearer token type */
  token_type: 'Bearer' | 'DPoP';

  /** Token lifetime in seconds */
  expires_in: number;

  /** Granted scopes */
  scope?: string;

  /** Optional refresh token (if allowed) */
  refresh_token?: string;
}

/**
 * ID-JAG Token Claims
 *
 * Claims included in the ID-JAG token (JWT)
 */
export interface IdJagTokenClaims {
  /** Issuer (this IdP) */
  iss: string;

  /** Subject (end-user identifier) */
  sub: string;

  /** Audience (target API) */
  aud: string | string[];

  /** Issued at timestamp */
  iat: number;

  /** Expiration timestamp */
  exp: number;

  /** JWT ID */
  jti: string;

  /** Client ID that requested the token */
  client_id: string;

  /** Original subject_token issuer */
  original_issuer?: string;

  /** Tenant identifier (for multi-tenant scenarios) */
  tenant?: string;

  /** Authentication Context Class Reference (from original assertion) */
  acr?: string;

  /** Authentication Methods References (from original assertion) */
  amr?: string[];

  /** Scopes granted */
  scope?: string;

  /** Actor claim for delegation scenarios */
  act?: {
    sub: string;
    [key: string]: unknown;
  };
}

/**
 * Discovery Metadata Extension for ID-JAG
 *
 * Additional metadata to advertise in /.well-known/openid-configuration
 */
export interface IdJagDiscoveryMetadata {
  /** Supported token types for identity chaining */
  identity_chaining_requested_token_types_supported?: string[];

  /** Supported subject token types for ID-JAG */
  id_jag_subject_token_types_supported?: string[];
}

/**
 * Validate if a token type is a valid subject_token_type for ID-JAG
 */
export function isValidIdJagSubjectTokenType(tokenType: string): boolean {
  const validTypes = [
    TOKEN_TYPE_URNS.ID_TOKEN,
    TOKEN_TYPE_URNS.JWT,
    TOKEN_TYPE_URNS.SAML2,
    TOKEN_TYPE_URNS.SAML1,
  ];
  return validTypes.includes(tokenType as (typeof validTypes)[number]);
}

/**
 * Check if request is an ID-JAG token exchange request
 */
export function isIdJagRequest(requestedTokenType: string | undefined): boolean {
  return requestedTokenType === TOKEN_TYPE_ID_JAG;
}
