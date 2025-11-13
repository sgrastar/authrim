/**
 * DPoP (Demonstrating Proof of Possession) Utilities
 * RFC 9449: OAuth 2.0 Demonstrating Proof of Possession (DPoP)
 * https://datatracker.ietf.org/doc/html/rfc9449
 */

import { importJWK, jwtVerify, calculateJwkThumbprint, base64url, type JWK } from 'jose';
import type { DPoPClaims, DPoPValidationResult } from '../types/oidc';
import type { KVNamespace } from '@cloudflare/workers-types';

interface DPoPHeader {
  typ: string;
  alg: string;
  jwk: JWK;
}

/**
 * Validates a DPoP proof JWT
 * @param dpopProof - The DPoP proof JWT from the DPoP header
 * @param method - HTTP method (e.g., 'POST', 'GET')
 * @param url - Full request URL
 * @param accessToken - Optional access token for validation (when present, ath claim must match)
 * @param nonceStore - KV namespace for nonce tracking (replay protection)
 * @returns Validation result with JWK thumbprint if valid
 */
export async function validateDPoPProof(
  dpopProof: string,
  method: string,
  url: string,
  accessToken?: string,
  nonceStore?: KVNamespace
): Promise<DPoPValidationResult> {
  try {
    // Parse JWT header without verification first to extract JWK
    const parts = dpopProof.split('.');
    if (parts.length !== 3) {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof must be a valid JWT',
      };
    }

    const headerPart = parts[0];
    const payloadPart = parts[1];

    if (!headerPart || !payloadPart) {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof must be a valid JWT',
      };
    }

    const header = JSON.parse(
      new TextDecoder().decode(base64url.decode(headerPart))
    ) as Partial<DPoPHeader>;
    // Payload parsing removed as we verify the entire JWT later

    // Validate header
    if (header.typ !== 'dpop+jwt') {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof typ header must be "dpop+jwt"',
      };
    }

    if (!header.alg || header.alg === 'none') {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof must use a valid signing algorithm',
      };
    }

    if (!header.jwk || typeof header.jwk !== 'object') {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof must include jwk header parameter',
      };
    }

    // Validate JWK
    const jwk: JWK = header.jwk;
    if (!jwk.kty) {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'JWK must include kty parameter',
      };
    }

    // Ensure JWK does not contain private key material
    if (jwk.d || jwk.p || jwk.q || jwk.dp || jwk.dq || jwk.qi) {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'JWK must not contain private key material',
      };
    }

    // Import public key from JWK
    let publicKey;
    try {
      publicKey = await importJWK(jwk, header.alg);
    } catch {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'Invalid JWK in DPoP proof header',
      };
    }

    // Verify JWT signature
    let verifiedPayload;
    try {
      const { payload: verified } = await jwtVerify(dpopProof, publicKey, {
        typ: 'dpop+jwt',
      });
      verifiedPayload = verified as unknown as DPoPClaims;
    } catch {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof signature verification failed',
      };
    }

    // Validate claims
    const claims = verifiedPayload;

    // jti (required)
    if (!claims.jti || typeof claims.jti !== 'string') {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof must include jti claim',
      };
    }

    // htm (required) - must match HTTP method (uppercase)
    if (!claims.htm || claims.htm !== method.toUpperCase()) {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: `DPoP proof htm claim must match request method (${method.toUpperCase()})`,
      };
    }

    // htu (required) - must match request URL (without query and fragment)
    const requestUrl = new URL(url);
    const htu = `${requestUrl.protocol}//${requestUrl.host}${requestUrl.pathname}`;
    if (!claims.htu || claims.htu !== htu) {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof htu claim must match request URL',
      };
    }

    // iat (required) - must be recent (within 60 seconds)
    if (!claims.iat || typeof claims.iat !== 'number') {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof must include iat claim',
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const clockSkew = 60; // 60 seconds clock skew tolerance
    if (claims.iat > now + clockSkew) {
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof iat claim is in the future',
      };
    }

    if (claims.iat < now - 60) {
      // DPoP proof must be fresh (within 60 seconds)
      return {
        valid: false,
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof is too old (must be within 60 seconds)',
      };
    }

    // ath (optional but required when access token is present)
    if (accessToken) {
      if (!claims.ath) {
        return {
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'DPoP proof must include ath claim when access token is present',
        };
      }

      // Validate ath (access token hash)
      const expectedAth = await calculateAccessTokenHash(accessToken);
      if (claims.ath !== expectedAth) {
        return {
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'DPoP proof ath claim does not match access token',
        };
      }
    }

    // Replay protection: check if jti has been used before
    if (nonceStore) {
      const usedJti = await nonceStore.get(`dpop_jti:${claims.jti}`);
      if (usedJti) {
        return {
          valid: false,
          error: 'use_dpop_nonce',
          error_description: 'DPoP proof jti has already been used (replay attack detected)',
        };
      }

      // Store jti with TTL of 60 seconds (same as proof freshness window)
      await nonceStore.put(`dpop_jti:${claims.jti}`, '1', {
        expirationTtl: 60,
      });
    }

    // Calculate JWK thumbprint (jkt)
    const jkt = await calculateJwkThumbprint(jwk, 'sha256');

    return {
      valid: true,
      jwk,
      jkt,
    };
  } catch (error) {
    console.error('DPoP validation error:', error);
    return {
      valid: false,
      error: 'invalid_dpop_proof',
      error_description: error instanceof Error ? error.message : 'Unknown DPoP validation error',
    };
  }
}

/**
 * Calculates the access token hash (ath) for DPoP
 * RFC 9449 Section 4.2: ath = base64url(SHA-256(access_token))
 * @param accessToken - The access token to hash
 * @returns Base64url-encoded SHA-256 hash of the access token
 */
export async function calculateAccessTokenHash(accessToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(accessToken);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return base64url.encode(new Uint8Array(hashBuffer));
}

/**
 * Extracts the DPoP proof from the request headers
 * @param headers - Request headers
 * @returns DPoP proof JWT or undefined if not present
 */
export function extractDPoPProof(headers: Headers): string | undefined {
  const proof = headers.get('dpop') || headers.get('DPoP');
  return proof || undefined;
}

/**
 * Checks if the Authorization header contains a DPoP-bound token
 * @param authHeader - Authorization header value
 * @returns True if the token is DPoP-bound
 */
export function isDPoPBoundToken(authHeader: string): boolean {
  return authHeader.trim().toLowerCase().startsWith('dpop ');
}

/**
 * Extracts the access token from a DPoP Authorization header
 * @param authHeader - Authorization header value
 * @returns Access token or undefined if invalid
 */
export function extractDPoPToken(authHeader: string): string | undefined {
  if (!isDPoPBoundToken(authHeader)) {
    return undefined;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2) {
    return undefined;
  }

  return parts[1];
}
