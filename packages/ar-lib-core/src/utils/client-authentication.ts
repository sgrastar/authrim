/**
 * Client Authentication Utilities
 * Implements private_key_jwt and client_secret_jwt authentication methods
 * RFC 7523: JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication
 */

import { jwtVerify, importJWK, type JWK } from 'jose';
import type { ClientMetadata } from '../types/oidc';
import { isInternalUrl } from './url-security';
import { ALLOWED_ASYMMETRIC_ALGS } from '../constants';
import { timingSafeEqual } from './crypto';
import { createLogger } from './logger';

const log = createLogger().module('CLIENT_AUTH');

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
   * Whether to accept Issuer ID as a valid audience value (in addition to token endpoint URL).
   * RFC 7523 Section 3 recommends the token endpoint URL, but OIDC Core and industry practice
   * also accept the Issuer ID for interoperability (Google, Microsoft, Okta, Auth0, Keycloak).
   * Default: true (industry standard)
   */
  acceptIssuerIdAsAudience?: boolean;
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
  const { acceptIssuerIdAsAudience = true } = options;

  try {
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
    const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');
    const normalizedEndpoint = normalizeUrl(tokenEndpoint);

    // RFC 7523 Section 3 recommends token endpoint URL, but OIDC Core and industry practice
    // also accept the Issuer ID (token endpoint without /token suffix)
    // See: https://openid.net/specs/openid-connect-core-1_0.html#ClientAuthentication
    const issuerUrl = tokenEndpoint.replace(/\/token$/, '');
    const normalizedIssuer = normalizeUrl(issuerUrl);

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

    // SECURITY: Use timing-safe comparison to prevent timing attacks on audience values
    const audienceMatches = audiences.some((aud) => {
      const normalizedAud = normalizeUrl(aud);
      // Check if audience matches token endpoint URL (RFC 7523 recommended)
      if (timingSafeEqual(normalizedAud, normalizedEndpoint)) {
        return true;
      }
      // Also accept Issuer ID if option is enabled (industry standard for interoperability)
      if (acceptIssuerIdAsAudience && timingSafeEqual(normalizedAud, normalizedIssuer)) {
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
    if (claims.nbf && claims.nbf > now) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion is not yet valid',
      };
    }

    // Step 7: Get public key for signature verification
    // Helper function to find key by kid (RFC 7517 Section 4.5)
    const findKeyByKid = (keys: JWK[], targetKid?: string): JWK | undefined => {
      if (targetKid) {
        // Find key with matching kid
        const matchingKey = keys.find((k) => k.kid === targetKid);
        if (matchingKey) {
          return matchingKey;
        }
        // If kid is specified but not found, return undefined (will trigger error)
        return undefined;
      }
      // If no kid specified, use first key (backward compatibility)
      return keys[0];
    };

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

        log.debug(`Fetching JWKS from: ${client.jwks_uri}`);
        const response = await fetch(client.jwks_uri, {
          headers: {
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch JWKS: ${response.status}`);
        }
        const jwks = (await response.json()) as { keys: JWK[] };
        if (jwks.keys && jwks.keys.length > 0) {
          jwksKeys = jwks.keys;
          log.debug(`Fetched ${jwksKeys.length} keys from jwks_uri`);
        }
      } catch (fetchError) {
        log.error('Failed to fetch JWKS from URI', {}, fetchError as Error);
        // If jwks_uri fetch fails but we have embedded jwks, fall back to it
        if (client.jwks?.keys && client.jwks.keys.length > 0) {
          log.warn('Falling back to embedded JWKS');
          jwksKeys = client.jwks.keys as JWK[];
        } else {
          return {
            valid: false,
            error: 'invalid_client',
            error_description: 'Failed to fetch client JWKS from jwks_uri',
          };
        }
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

      const foundKey = findKeyByKid(jwksKeys, kid);
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
    const cryptoKey = await importJWK(publicKey, publicKey.alg || 'RS256');

    // Build acceptable audiences array based on options
    // - Token endpoint URL (RFC 7523 recommended)
    // - Issuer ID (if acceptIssuerIdAsAudience is enabled - industry standard)
    const acceptableAudiences = acceptIssuerIdAsAudience
      ? [normalizedEndpoint, normalizedIssuer]
      : [normalizedEndpoint];

    await jwtVerify(assertion, cryptoKey, {
      issuer: client.client_id,
      audience: acceptableAudiences,
      algorithms: [...ALLOWED_ASYMMETRIC_ALGS],
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
