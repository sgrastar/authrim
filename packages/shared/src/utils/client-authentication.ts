/**
 * Client Authentication Utilities
 * Implements private_key_jwt and client_secret_jwt authentication methods
 * RFC 7523: JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication
 */

import { jwtVerify, importJWK, type JWK } from 'jose';
import type { ClientMetadata } from '../types/oidc';

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
 * Validate Client Assertion JWT
 *
 * Validates private_key_jwt or client_secret_jwt authentication
 * per RFC 7523 Section 3
 *
 * @param assertion - JWT assertion string
 * @param tokenEndpoint - Token endpoint URL (expected audience)
 * @param client - Client metadata (must include jwks or jwks_uri for private_key_jwt)
 * @returns Validation result
 */
export async function validateClientAssertion(
  assertion: string,
  tokenEndpoint: string,
  client: ClientMetadata
): Promise<ClientAssertionValidationResult> {
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
    const header = JSON.parse(headerJson) as { alg?: string };

    // Reject 'none' algorithm
    if (header.alg === 'none' || !header.alg) {
      console.warn('[SECURITY] Rejected unsigned client assertion (alg=none or missing)');
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
    if (claims.iss !== client.client_id || claims.sub !== client.client_id) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion iss and sub must be the client_id',
      };
    }

    // Step 4: Verify audience matches token endpoint
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(tokenEndpoint)) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: `Audience does not match token endpoint. Expected '${tokenEndpoint}'`,
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
    let publicKey: JWK | null = null;

    if (client.jwks?.keys && client.jwks.keys.length > 0) {
      // Use embedded JWKS
      publicKey = client.jwks.keys[0] as JWK; // Use first key (TODO: support key selection by kid)
    } else if (client.jwks_uri) {
      // Fetch JWKS from URI
      try {
        const response = await fetch(client.jwks_uri);
        if (!response.ok) {
          throw new Error(`Failed to fetch JWKS: ${response.status}`);
        }
        const jwks = (await response.json()) as { keys: JWK[] };
        if (jwks.keys && jwks.keys.length > 0) {
          publicKey = jwks.keys[0];
        }
      } catch (fetchError) {
        return {
          valid: false,
          error: 'invalid_client',
          error_description: 'Failed to fetch client JWKS',
        };
      }
    }

    if (!publicKey) {
      return {
        valid: false,
        error: 'invalid_client',
        error_description: 'No public key available for client signature verification',
      };
    }

    // Step 8: Verify JWT signature
    const cryptoKey = await importJWK(publicKey, publicKey.alg || 'RS256');
    await jwtVerify(assertion, cryptoKey, {
      issuer: client.client_id,
      audience: tokenEndpoint,
      algorithms: ['RS256', 'ES256', 'RS384', 'ES384', 'RS512', 'ES512'],
    });

    // All validations passed
    return {
      valid: true,
      client_id: client.client_id,
    };
  } catch (error) {
    console.error('Client assertion validation error:', error);
    return {
      valid: false,
      error: 'invalid_client',
      error_description:
        error instanceof Error ? error.message : 'Failed to validate client assertion',
    };
  }
}
