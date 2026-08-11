/**
 * Client Authentication Utilities
 * Implements private_key_jwt and client_secret_jwt authentication methods
 * RFC 7523: JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication
 */

import { jwtVerify, importJWK, type JWK } from 'jose';
import type { ClientMetadata } from '../types/oidc';
import { isInternalUrl, safeFetchJson } from './url-security';
import { ALLOWED_ASYMMETRIC_ALGS } from '../constants';
import { timingSafeEqual, verifyClientSecretHash } from './crypto';
import { createLogger } from './logger';
import { parseBasicAuth } from './basic-auth';
import { parseToken } from './jwt';

const log = createLogger().module('CLIENT_AUTH');
const MAX_CLIENT_ASSERTION_SIZE_BYTES = 16 * 1024;
const MAX_CLIENT_ASSERTION_SEGMENT_SIZE_BYTES = 8 * 1024;
const CLIENT_ASSERTION_TYPE_JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * Client Assertion Claims (RFC 7523 Section 3)
 * Used for private_key_jwt and client_secret_jwt authentication
 */
export interface ClientAssertionClaims {
  iss: string; // Issuer - MUST be the client_id
  sub: string; // Subject - MUST be the client_id
  aud: string | string[]; // Audience - MUST be the token endpoint URL
  exp: number; // Expiration time
  iat?: number; // Issued at time
  jti?: string; // JWT ID (unique identifier for replay protection)
  nbf?: number; // Not before time
}

/**
 * Client Assertion Validation Result
 */
export interface ClientAssertionValidationResult {
  valid: boolean;
  client_id?: string;
  error?: string;
  error_description?: string;
}

/**
 * Options for client assertion validation
 */
export interface ClientAssertionValidationOptions {
  /**
   * Accepted audience policy. FAPI 2.0 Security Profile Final requires exactly one string
   * containing the authorization server issuer identifier.
   * Default: endpoint-or-issuer (backward-compatible RFC 7523/OIDC interoperability mode)
   */
  audiencePolicy?: 'endpoint-or-issuer' | 'issuer-only';
  /**
   * Whether to accept Issuer ID as a valid audience value (in addition to token endpoint URL).
   * RFC 7523 Section 3 recommends the token endpoint URL, but OIDC Core and industry practice
   * also accept the Issuer ID for interoperability (Google, Microsoft, Okta, Auth0, Keycloak).
   * Default: true (industry standard)
   */
  acceptIssuerIdAsAudience?: boolean;
  /** Explicit authorization server issuer, for endpoints other than `/token` (for example PAR). */
  issuer?: string;
  /** Additional endpoint URLs accepted as audience values. */
  additionalAudiences?: string[];
  /** Allowed positive clock skew for nbf, in seconds. Default: 0. */
  clockSkewSeconds?: number;
  /**
   * Explicit JWS algorithm allowlist for the calling security profile.
   * FAPI callers use this to exclude RS256 and other algorithms that are valid in generic OIDC.
   */
  allowedAlgorithms?: readonly string[];
}

function isVerificationKeyForAlgorithm(key: JWK, algorithm: string): boolean {
  if (key.use !== undefined && key.use !== 'sig') {
    return false;
  }
  if (Array.isArray(key.key_ops) && !key.key_ops.includes('verify')) {
    return false;
  }
  if (key.alg !== undefined && key.alg !== algorithm) {
    return false;
  }

  if (algorithm.startsWith('RS') || algorithm.startsWith('PS')) {
    return key.kty === 'RSA' && typeof key.n === 'string' && typeof key.e === 'string';
  }
  if (algorithm.startsWith('ES')) {
    const expectedCurve =
      algorithm === 'ES256' ? 'P-256' : algorithm === 'ES384' ? 'P-384' : 'P-521';
    return (
      key.kty === 'EC' &&
      key.crv === expectedCurve &&
      typeof key.x === 'string' &&
      typeof key.y === 'string'
    );
  }
  if (algorithm === 'EdDSA') {
    return (
      key.kty === 'OKP' &&
      (key.crv === 'Ed25519' || key.crv === 'Ed448') &&
      typeof key.x === 'string'
    );
  }
  return false;
}

function selectClientAssertionVerificationKey(
  keys: JWK[],
  algorithm: string,
  kid?: string
): JWK | undefined {
  const candidates = keys.filter((key) => isVerificationKeyForAlgorithm(key, algorithm));
  if (kid) {
    return candidates.find((key) => key.kid === kid);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface OAuthClientAuthenticationParams {
  clientId?: string;
  clientSecret?: string;
  clientAssertion?: string;
  clientAssertionType?: string;
  authorizationHeader?: string;
}

export interface ParsedOAuthClientAuthentication {
  clientId?: string;
  clientSecret?: string;
  clientAssertion?: string;
  clientAssertionType?: string;
  presentation: ClientAuthenticationPresentation;
}

export type ParseOAuthClientAuthenticationResult =
  | { ok: true; credentials: ParsedOAuthClientAuthentication }
  | { ok: false; error: 'invalid_client'; errorDescription: string };

export type ConfidentialOAuthClientAuthenticationResult =
  | { ok: true; method: 'client_secret' | 'client_assertion'; clientId: string }
  | { ok: false; error: 'invalid_client'; errorDescription: string };

export interface ClientAuthenticationPresentation {
  basic: boolean;
  clientSecretPost: boolean;
  clientAssertion: boolean;
  clientAssertionType?: string;
}

export type ClientAuthenticationMethodValidationResult =
  | { valid: true }
  | { valid: false; errorDescription: string };

/**
 * Enforce the authentication method registered for a client.
 *
 * A valid secret is not interchangeable with a registered JWT key, and RFC 6749
 * forbids using more than one client authentication mechanism in one request.
 */
export function validateRegisteredClientAuthenticationMethod(
  client: ClientMetadata,
  presentation: ClientAuthenticationPresentation
): ClientAuthenticationMethodValidationResult {
  const presentedCount =
    Number(presentation.basic) +
    Number(presentation.clientSecretPost) +
    Number(presentation.clientAssertion);

  if (presentedCount > 1) {
    return {
      valid: false,
      errorDescription: 'Multiple client authentication methods are not allowed',
    };
  }

  // Preserve compatibility for legacy records that predate explicit method metadata.
  // Newly registered clients always have an explicit token_endpoint_auth_method.
  const registeredMethod = client.token_endpoint_auth_method;
  if (!registeredMethod) {
    return { valid: true };
  }

  const hasJwtBearerAssertion =
    presentation.clientAssertion &&
    presentation.clientAssertionType === CLIENT_ASSERTION_TYPE_JWT_BEARER;

  switch (registeredMethod) {
    case 'private_key_jwt':
    case 'client_secret_jwt':
      if (presentedCount === 1 && hasJwtBearerAssertion) return { valid: true };
      break;
    case 'client_secret_basic':
      if (presentedCount === 1 && presentation.basic) return { valid: true };
      break;
    case 'client_secret_post':
      if (presentedCount === 1 && presentation.clientSecretPost) return { valid: true };
      break;
    case 'none':
      if (presentedCount === 0) return { valid: true };
      break;
    default:
      return {
        valid: false,
        errorDescription: 'Client authentication configuration is invalid',
      };
  }

  return {
    valid: false,
    errorDescription: `Client must authenticate using ${registeredMethod}`,
  };
}

/**
 * Extract OAuth client authentication credentials from request parameters and Basic auth.
 */
export function parseOAuthClientAuthenticationParams(
  params: OAuthClientAuthenticationParams
): ParseOAuthClientAuthenticationResult {
  let clientId = params.clientId;
  let clientSecret = params.clientSecret;
  const clientAssertion = params.clientAssertion;
  const clientAssertionType = params.clientAssertionType;
  const clientSecretPostPresented = params.clientSecret !== undefined;
  const clientAssertionPresented = params.clientAssertion !== undefined;

  if (clientAssertion && clientAssertionType === CLIENT_ASSERTION_TYPE_JWT_BEARER && !clientId) {
    try {
      const assertionPayload = parseToken(clientAssertion);
      clientId =
        typeof assertionPayload.sub === 'string'
          ? assertionPayload.sub
          : typeof assertionPayload.iss === 'string'
            ? assertionPayload.iss
            : undefined;
    } catch {
      return {
        ok: false,
        error: 'invalid_client',
        errorDescription: 'Invalid client_assertion JWT format',
      };
    }
  }

  const basicAuth = parseBasicAuth(params.authorizationHeader);
  if (basicAuth.success) {
    if (clientAssertion || clientSecret) {
      return {
        ok: false,
        error: 'invalid_client',
        errorDescription: 'Multiple client authentication methods are not allowed',
      };
    }
    if (clientId && !timingSafeEqual(clientId, basicAuth.credentials.username)) {
      return {
        ok: false,
        error: 'invalid_client',
        errorDescription: 'Client authentication failed',
      };
    }
    clientId = basicAuth.credentials.username;
    clientSecret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    return {
      ok: false,
      error: 'invalid_client',
      errorDescription: 'Invalid Authorization header format',
    };
  }

  return {
    ok: true,
    credentials: {
      clientId,
      clientSecret,
      clientAssertion,
      clientAssertionType,
      presentation: {
        basic: basicAuth.success,
        clientSecretPost: clientSecretPostPresented,
        clientAssertion: clientAssertionPresented,
        clientAssertionType,
      },
    },
  };
}

/**
 * Authenticate a confidential OAuth client. Public clients are rejected.
 *
 * This is used by flows such as CIBA where client authentication is mandatory.
 */
export async function authenticateConfidentialOAuthClient(
  client: ClientMetadata,
  endpoint: string,
  credentials: ParsedOAuthClientAuthentication,
  assertionOptions: ClientAssertionValidationOptions = {}
): Promise<ConfidentialOAuthClientAuthenticationResult> {
  const methodValidation = validateRegisteredClientAuthenticationMethod(
    client,
    credentials.presentation
  );
  if (!methodValidation.valid) {
    return {
      ok: false,
      error: 'invalid_client',
      errorDescription: 'Client authentication failed',
    };
  }

  if (credentials.clientId && !timingSafeEqual(credentials.clientId, client.client_id)) {
    return {
      ok: false,
      error: 'invalid_client',
      errorDescription: 'Client authentication failed',
    };
  }

  if (
    credentials.clientAssertion &&
    credentials.clientAssertionType === CLIENT_ASSERTION_TYPE_JWT_BEARER
  ) {
    const assertionValidation = await validateClientAssertion(
      credentials.clientAssertion,
      endpoint,
      client,
      assertionOptions
    );

    if (!assertionValidation.valid) {
      return {
        ok: false,
        error: 'invalid_client',
        errorDescription: 'Client assertion validation failed',
      };
    }

    return { ok: true, method: 'client_assertion', clientId: client.client_id };
  }

  if (client.client_secret_hash) {
    const storedHash = client.client_secret_hash;
    if (
      credentials.clientSecret &&
      (await verifyClientSecretHash(credentials.clientSecret, storedHash))
    ) {
      return { ok: true, method: 'client_secret', clientId: client.client_id };
    }
  }

  return {
    ok: false,
    error: 'invalid_client',
    errorDescription: 'Client authentication failed',
  };
}

/**
 * Validate Client Assertion JWT
 *
 * Validates private_key_jwt or client_secret_jwt authentication
 * per RFC 7523 Section 3
 *
 * @param assertion - JWT assertion string
 * @param tokenEndpoint - Token endpoint URL (expected audience)
 * @param client - Client metadata (must include jwks or jwks_uri for private_key_jwt)
 * @param options - Validation options
 * @returns Validation result
 */
export async function validateClientAssertion(
  assertion: string,
  tokenEndpoint: string,
  client: ClientMetadata,
  options: ClientAssertionValidationOptions = {}
): Promise<ClientAssertionValidationResult> {
  // Default: Accept Issuer ID as audience (industry standard for interoperability)
  const {
    audiencePolicy = 'endpoint-or-issuer',
    acceptIssuerIdAsAudience = true,
    issuer,
    additionalAudiences = [],
    clockSkewSeconds = 0,
    allowedAlgorithms = ALLOWED_ASYMMETRIC_ALGS,
  } = options;

  try {
    const sizeError = validateAssertionSize(assertion);
    if (sizeError) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: sizeError,
      };
    }

    // Step 1: Parse JWT to get claims (without verification first)
    const parts = assertion.split('.');
    if (parts.length !== 3) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion JWT format is invalid',
      };
    }

    // Step 1.5: Decode header and check algorithm
    const headerBase64 = parts[0];
    if (!headerBase64) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion header is missing',
      };
    }

    const headerJson = atob(headerBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const header = JSON.parse(headerJson) as { alg?: string; kid?: string };

    // Extract kid for key selection (RFC 7517)
    const kid = header.kid;

    // Debug logging for private_key_jwt investigation
    log.debug('private_key_jwt client info', {
      client_id: client.client_id,
      has_jwks: !!client.jwks,
      has_jwks_uri: !!client.jwks_uri,
      jwks_keys_count: client.jwks?.keys?.length,
    });
    log.debug('private_key_jwt JWT Header', { kid, alg: header.alg });

    // Reject 'none' algorithm
    if (header.alg === 'none' || !header.alg) {
      log.warn('SECURITY - Rejected unsigned client assertion (alg=none or missing)');
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Unsigned client assertions (alg=none) are not allowed',
      };
    }
    if (!allowedAlgorithms.includes(header.alg)) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion signing algorithm is not allowed',
      };
    }
    if (
      client.token_endpoint_auth_signing_alg &&
      client.token_endpoint_auth_signing_alg !== header.alg
    ) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion signing algorithm does not match client metadata',
      };
    }

    // Decode payload
    const payloadBase64 = parts[1];
    if (!payloadBase64) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion payload is missing',
      };
    }

    const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(payloadJson) as ClientAssertionClaims;

    // Step 2: Verify required claims exist
    if (!claims.iss || !claims.sub || !claims.aud || !claims.exp) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion is missing required claims (iss, sub, aud, exp)',
      };
    }

    // Step 3: Verify iss and sub match client_id (RFC 7523 Section 3)
    // SECURITY: Use timing-safe comparison to prevent timing attacks
    const issMatches = timingSafeEqual(claims.iss, client.client_id);
    const subMatches = timingSafeEqual(claims.sub, client.client_id);
    if (!issMatches || !subMatches) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion iss and sub must be the client_id',
      };
    }

    // Step 4: Verify audience matches token endpoint or issuer ID
    // URL normalization: remove trailing slashes for comparison
    const normalizeUrl = (url: string): string => {
      let result = url;
      while (result.endsWith('/')) {
        result = result.slice(0, -1);
      }
      return result;
    };
    const normalizedEndpoint = normalizeUrl(tokenEndpoint);

    // RFC 7523 Section 3 recommends token endpoint URL, but OIDC Core and industry practice
    // also accept the Issuer ID (token endpoint without /token suffix)
    // See: https://openid.net/specs/openid-connect-core-1_0.html#ClientAuthentication
    const issuerUrl = issuer || tokenEndpoint.replace(/\/token$/, '');
    const normalizedIssuer = normalizeUrl(issuerUrl);
    const normalizedAdditionalAudiences = additionalAudiences.map(normalizeUrl);

    if (audiencePolicy === 'issuer-only' && Array.isArray(claims.aud)) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Audience must be the authorization server issuer identifier',
      };
    }

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

    // SECURITY: Use timing-safe comparison to prevent timing attacks on audience values
    const audienceMatches = audiences.some((aud) => {
      const normalizedAud = normalizeUrl(aud);
      if (audiencePolicy === 'issuer-only') {
        return timingSafeEqual(normalizedAud, normalizedIssuer);
      }
      // Check if audience matches token endpoint URL (RFC 7523 recommended)
      if (timingSafeEqual(normalizedAud, normalizedEndpoint)) {
        return true;
      }
      // Also accept Issuer ID if option is enabled (industry standard for interoperability)
      if (acceptIssuerIdAsAudience && timingSafeEqual(normalizedAud, normalizedIssuer)) {
        return true;
      }
      if (
        normalizedAdditionalAudiences.some((acceptedAudience) =>
          timingSafeEqual(normalizedAud, acceptedAudience)
        )
      ) {
        return true;
      }
      return false;
    });

    if (!audienceMatches) {
      return {
        valid: false,
        error: 'invalid_client',
        // SECURITY: Do not expose token endpoint URL in error message
        error_description: 'Audience does not match the expected value',
      };
    }

    // Step 5: Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion has expired',
      };
    }

    // Step 6: Verify not before time (if present)
    if (claims.nbf && claims.nbf > now + Math.max(0, clockSkewSeconds)) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion is not yet valid',
      };
    }

    // Step 7: Get a verification key matching kid, algorithm, key type, and intended use.
    let publicKey: JWK | null = null;
    let jwksKeys: JWK[] = [];

    // OIDC Dynamic Client Registration 1.0 Section 2:
    // "If a Client can use jwks_uri, it MUST NOT use jwks."
    // jwks_uri enables key rotation (Section 10 of OIDC Core), so we prioritize it
    // even if embedded jwks exists (for backward compatibility with misconfigured clients)
    if (client.jwks_uri) {
      // Fetch JWKS from URI - enables key rotation
      try {
        // SSRF protection: Block requests to internal addresses
        if (isInternalUrl(client.jwks_uri)) {
          return {
            valid: false,
            error: 'SSRF protection: jwks_uri cannot point to internal addresses',
          };
        }

        log.debug('Fetching JWKS from client jwks_uri');
        const jwks = await safeFetchJson<{ keys: JWK[] }>(client.jwks_uri, {
          headers: {
            Accept: 'application/json',
          },
          timeoutMs: 5000,
          maxResponseSize: 256 * 1024,
          redirect: 'error',
        });
        if (jwks.keys && jwks.keys.length > 0) {
          jwksKeys = jwks.keys;
          log.debug(`Fetched ${jwksKeys.length} keys from jwks_uri`);
        }
      } catch (fetchError) {
        log.error('Failed to fetch JWKS from URI', {}, fetchError as Error);
        return {
          valid: false,
          error: 'invalid_client',
          error_description: 'Failed to fetch client JWKS from jwks_uri',
        };
      }
    } else if (client.jwks?.keys && client.jwks.keys.length > 0) {
      // Use embedded JWKS only if jwks_uri is not provided
      log.debug('Using embedded JWKS (no jwks_uri configured)');
      jwksKeys = client.jwks.keys as JWK[];
    }

    // Find key by kid (or use first key if no kid specified)
    if (jwksKeys.length > 0) {
      // Debug: Log available keys
      log.debug('JWKS Keys', {
        keys: jwksKeys.map((k) => ({
          kid: k.kid,
          kty: k.kty,
          alg: k.alg,
        })),
      });

      const foundKey = selectClientAssertionVerificationKey(jwksKeys, header.alg, kid);
      if (foundKey) {
        publicKey = foundKey;
        log.debug('Selected key', { kid: foundKey.kid, kty: foundKey.kty });
      } else {
        log.debug('No matching key found', { kid });
      }
    }

    if (!publicKey) {
      return {
        valid: false,
        error: 'invalid_client',
        // SECURITY: Do not expose kid value in error message to prevent key enumeration
        error_description: 'No matching public key found for client signature verification',
      };
    }

    // Step 8: Verify JWT signature
    // SECURITY: Use algorithm whitelist to prevent algorithm confusion attacks
    const cryptoKey = await importJWK(publicKey, header.alg);

    // Build acceptable audiences array based on options
    // - Token endpoint URL (RFC 7523 recommended)
    // - Issuer ID (if acceptIssuerIdAsAudience is enabled - industry standard)
    const acceptableAudiences = [
      normalizedEndpoint,
      ...(acceptIssuerIdAsAudience ? [normalizedIssuer] : []),
      ...normalizedAdditionalAudiences,
    ];

    await jwtVerify(assertion, cryptoKey, {
      issuer: client.client_id,
      audience: acceptableAudiences,
      algorithms: [...allowedAlgorithms],
      clockTolerance: Math.max(0, clockSkewSeconds),
    });

    // All validations passed
    return {
      valid: true,
      client_id: client.client_id,
    };
  } catch (error) {
    // PII Protection: Don't log full error object (may contain client info in stack)
    log.error('Client assertion validation error', {}, error as Error);
    // SECURITY: Use generic error message to prevent information leakage
    // Internal library errors (jose) may contain implementation details
    return {
      valid: false,
      error: 'invalid_client',
      error_description: 'Failed to validate client assertion',
    };
  }
}

function validateAssertionSize(assertion: string): string | null {
  if (new TextEncoder().encode(assertion).byteLength > MAX_CLIENT_ASSERTION_SIZE_BYTES) {
    return 'Client assertion JWT is too large';
  }

  for (const segment of assertion.split('.')) {
    if (new TextEncoder().encode(segment).byteLength > MAX_CLIENT_ASSERTION_SEGMENT_SIZE_BYTES) {
      return 'Client assertion JWT segment is too large';
    }
  }

  return null;
}
