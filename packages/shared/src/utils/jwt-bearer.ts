/**
 * JWT Bearer Flow Utilities (RFC 7523)
 * https://datatracker.ietf.org/doc/html/rfc7523
 *
 * Implements JWT Bearer Grant Type for OAuth 2.0
 * Used for service-to-service authentication without user interaction
 */

import { jwtVerify, importJWK, type JWK, type JWTPayload } from 'jose';

/**
 * JWT Bearer Assertion Claims
 * RFC 7523 Section 3
 */
export interface JWTBearerAssertion extends JWTPayload {
  iss: string; // Issuer - identifies the principal that issued the JWT
  sub: string; // Subject - identifies the principal that is the subject of the JWT
  aud: string | string[]; // Audience - identifies the OP (authorization server)
  exp: number; // Expiration time
  iat: number; // Issued at time
  jti?: string; // JWT ID (unique identifier for replay protection)
  scope?: string; // Optional scope claim
}

/**
 * Trusted Issuer Configuration
 * Defines which issuers are allowed to issue JWT assertions
 */
export interface TrustedIssuer {
  /** Issuer identifier (iss claim value) */
  issuer: string;
  /** Public key or JWKS URI for signature verification */
  jwks?: { keys: JWK[] };
  jwks_uri?: string;
  /** Allowed subjects (sub claim values) - if empty, any subject is allowed */
  allowed_subjects?: string[];
  /** Allowed scopes for this issuer */
  allowed_scopes?: string[];
}

/**
 * JWT Bearer Validation Result
 */
export interface JWTBearerValidationResult {
  valid: boolean;
  claims?: JWTBearerAssertion;
  error?: string;
  error_description?: string;
}

/**
 * Validate JWT Bearer Assertion
 *
 * RFC 7523 Section 3: JWT Format and Processing Requirements
 *
 * @param assertion - JWT assertion string
 * @param expectedAudience - Expected audience (OP's issuer URL)
 * @param trustedIssuers - Map of trusted issuers
 * @returns Validation result
 */
export async function validateJWTBearerAssertion(
  assertion: string,
  expectedAudience: string,
  trustedIssuers: Map<string, TrustedIssuer>
): Promise<JWTBearerValidationResult> {
  try {
    // Step 1: Parse JWT header to get issuer (from claims, not header)
    // We need to decode without verification first to get the issuer
    const parts = assertion.split('.');
    if (parts.length !== 3) {
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: 'JWT assertion format is invalid',
      };
    }

    // Decode payload (base64url)
    const payloadBase64 = parts[1];
    if (!payloadBase64) {
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: 'JWT assertion payload is missing',
      };
    }

    const payloadJson = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(payloadJson) as JWTBearerAssertion;

    // Step 2: Verify required claims exist
    if (!claims.iss || !claims.sub || !claims.aud || !claims.exp) {
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: 'JWT assertion is missing required claims (iss, sub, aud, exp)',
      };
    }

    // Step 3: Check if issuer is trusted
    const trustedIssuer = trustedIssuers.get(claims.iss);
    if (!trustedIssuer) {
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: `Issuer '${claims.iss}' is not trusted`,
      };
    }

    // Step 4: Verify audience matches OP
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expectedAudience)) {
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: `Audience does not match. Expected '${expectedAudience}'`,
      };
    }

    // Step 5: Verify subject is allowed (if restrictions exist)
    if (trustedIssuer.allowed_subjects && trustedIssuer.allowed_subjects.length > 0) {
      if (!trustedIssuer.allowed_subjects.includes(claims.sub)) {
        return {
          valid: false,
          error: 'invalid_grant',
          error_description: `Subject '${claims.sub}' is not allowed for issuer '${claims.iss}'`,
        };
      }
    }

    // Step 6: Get public key for signature verification
    let publicKey: JWK | null = null;

    if (trustedIssuer.jwks?.keys && trustedIssuer.jwks.keys.length > 0) {
      // Use embedded JWKS
      publicKey = trustedIssuer.jwks.keys[0]; // For simplicity, use first key
    } else if (trustedIssuer.jwks_uri) {
      // Fetch JWKS from URI
      try {
        const response = await fetch(trustedIssuer.jwks_uri);
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
          error: 'server_error',
          error_description: 'Failed to fetch issuer JWKS',
        };
      }
    }

    if (!publicKey) {
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: 'No public key available for issuer signature verification',
      };
    }

    // Step 7: Verify JWT signature
    const cryptoKey = await importJWK(publicKey, 'RS256');
    const { payload } = await jwtVerify(assertion, cryptoKey, {
      issuer: claims.iss,
      audience: expectedAudience,
      algorithms: ['RS256', 'ES256'],
    });

    // Step 8: Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: 'JWT assertion has expired',
      };
    }

    // Step 9: Verify scope (if restricted)
    if (claims.scope && trustedIssuer.allowed_scopes) {
      const requestedScopes = claims.scope.split(' ');
      const hasDisallowedScope = requestedScopes.some(
        (scope) => !trustedIssuer.allowed_scopes?.includes(scope)
      );

      if (hasDisallowedScope) {
        return {
          valid: false,
          error: 'invalid_scope',
          error_description: 'Requested scope is not allowed for this issuer',
        };
      }
    }

    // All validations passed
    return {
      valid: true,
      claims: payload as JWTBearerAssertion,
    };
  } catch (error) {
    console.error('JWT Bearer assertion validation error:', error);
    return {
      valid: false,
      error: 'invalid_grant',
      error_description:
        error instanceof Error ? error.message : 'Failed to validate JWT assertion',
    };
  }
}

/**
 * Create a trusted issuer configuration from environment variables
 *
 * Format: TRUSTED_ISSUERS=issuer1:jwks_uri1,issuer2:jwks_uri2
 *
 * @param envVar - Environment variable value
 * @returns Map of trusted issuers
 */
export function parseTrustedIssuers(envVar?: string): Map<string, TrustedIssuer> {
  const issuers = new Map<string, TrustedIssuer>();

  if (!envVar) {
    return issuers;
  }

  const entries = envVar.split(',');
  for (const entry of entries) {
    // Split on : only when followed by http:// or https://
    // This allows URLs to contain : in the protocol without breaking
    const parts = entry.split(/:(?=https?:\/\/)/);
    if (parts.length === 2) {
      const issuer = parts[0].trim();
      const jwks_uri = parts[1].trim();
      issuers.set(issuer, {
        issuer,
        jwks_uri,
      });
    }
  }

  return issuers;
}
