/**
 * VCI Token Validation Service
 *
 * Validates access tokens and proofs of possession for credential issuance.
 */

import type { Env } from '../../types';
import { decodeBase64Url, safeFetch, createLogger } from '@authrim/ar-lib-core';
import { createVCConfigManager } from '../../utils/vc-config';

const log = createLogger().module('VCI-TOKEN');

export interface TokenValidationResult {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  vct?: string;
  claims?: Record<string, unknown>;
  holderBinding?: { kty: string; crv: string; x: string; y?: string };
  error?: string;
}

export interface ProofValidationResult {
  valid: boolean;
  holderPublicKey?: { kty: string; crv: string; x: string; y?: string };
  error?: string;
}

/**
 * JWT Header
 */
interface JWTHeader {
  alg: string;
  typ?: string;
  kid?: string;
  jwk?: { kty: string; crv: string; x: string; y?: string };
}

/**
 * JWT Payload for VCI Access Token
 */
interface VCIAccessTokenPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  jti?: string;
  scope?: string;
  // VCI specific
  tenant_id?: string;
  credential_configuration_id?: string;
  credential_claims?: Record<string, unknown>;
  cnf?: {
    jwk?: { kty: string; crv: string; x: string; y?: string };
  };
}

/**
 * Validate a VCI access token
 */
export async function validateVCIAccessToken(
  env: Env,
  accessToken: string
): Promise<TokenValidationResult> {
  try {
    // Parse JWT without full verification (signature verification should use JWKS)
    const parts = accessToken.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid token format' };
    }

    // Decode header and payload
    const header = JSON.parse(decodeBase64Url(parts[0])) as JWTHeader;
    const payload = JSON.parse(decodeBase64Url(parts[1])) as VCIAccessTokenPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token expired' };
    }

    // Check not-before
    if (payload.iat && payload.iat > now + 60) {
      // Allow 60 seconds clock skew
      return { valid: false, error: 'Token not yet valid' };
    }

    // Validate issuer (should be our auth server)
    const expectedIssuer = env.ISSUER_IDENTIFIER || 'did:web:authrim.com';
    // Allow issuer to be URL or DID format
    if (!payload.iss || (!payload.iss.includes('authrim') && payload.iss !== expectedIssuer)) {
      return { valid: false, error: 'Invalid issuer' };
    }

    // Validate audience (should include this VCI endpoint)
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const _vciAudience = `${expectedIssuer}/vci`; // Reserved for strict audience check
    if (!aud.some((a) => a.includes('vci') || a === expectedIssuer)) {
      return { valid: false, error: 'Invalid audience' };
    }

    // Check scope for credential issuance
    const scopes = payload.scope?.split(' ') || [];
    if (!scopes.includes('openid') && !scopes.includes('credential')) {
      return { valid: false, error: 'Missing required scope' };
    }

    // Verify signature using JWKS
    const signatureValid = await verifyTokenSignature(env, accessToken, header, payload);
    if (!signatureValid) {
      return { valid: false, error: 'Invalid signature' };
    }

    // Extract holder binding (cnf claim)
    const holderBinding = payload.cnf?.jwk;

    return {
      valid: true,
      userId: payload.sub,
      tenantId: payload.tenant_id || 'default',
      vct: payload.credential_configuration_id,
      claims: payload.credential_claims || {},
      holderBinding,
    };
  } catch (error) {
    log.error('VCI access token validation failed', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return {
      valid: false,
      error: 'Token validation failed',
    };
  }
}

/**
 * Verify token signature using JWKS
 */
async function verifyTokenSignature(
  env: Env,
  token: string,
  header: JWTHeader,
  payload: VCIAccessTokenPayload
): Promise<boolean> {
  try {
    // For self-issued tokens (iss = our identifier), use our own keys
    const expectedIssuer = env.ISSUER_IDENTIFIER || 'did:web:authrim.com';

    if (payload.iss === expectedIssuer || payload.iss.includes('authrim')) {
      // Get public key from KeyManager
      const doId = env.KEY_MANAGER.idFromName('issuer-keys');
      const stub = env.KEY_MANAGER.get(doId);

      const jwksResponse = await stub.fetch(new Request('https://internal/ec/jwks'));
      if (!jwksResponse.ok) {
        log.error('Failed to get JWKS from KeyManager', {});
        return false;
      }

      const jwks = (await jwksResponse.json()) as { keys: Array<{ kid?: string; kty: string }> };

      // Find the key by kid or use the first one
      const key = header.kid
        ? jwks.keys.find((k) => k.kid === header.kid)
        : jwks.keys.find((k) => k.kty === 'EC');

      if (!key) {
        log.error('Signing key not found in JWKS', {});
        return false;
      }

      // Import and verify
      const cryptoKey = await importJWKForVerify(key, header.alg);
      return await verifyJWTSignature(token, cryptoKey, header.alg);
    }

    // For external issuers, fetch their JWKS
    // This is a simplified implementation - production should cache JWKS
    const jwksUri = `${payload.iss}/.well-known/jwks.json`;
    // Use safeFetch for SSRF protection, timeout, and response size limits
    const jwksResponse = await safeFetch(jwksUri, {
      headers: { Accept: 'application/json' },
      requireHttps: true,
      timeoutMs: 10000,
      maxResponseSize: 256 * 1024, // 256 KB max for JWKS
    });
    if (!jwksResponse.ok) {
      log.error('Failed to fetch external JWKS', {});
      return false;
    }

    const text = await jwksResponse.text();
    const jwks = JSON.parse(text) as { keys: Array<{ kid?: string; kty: string }> };
    const key = header.kid ? jwks.keys.find((k) => k.kid === header.kid) : jwks.keys[0];

    if (!key) {
      return false;
    }

    const cryptoKey = await importJWKForVerify(key, header.alg);
    return await verifyJWTSignature(token, cryptoKey, header.alg);
  } catch (error) {
    log.error('Token signature verification failed', {}, error as Error);
    return false;
  }
}

/**
 * Validate proof of possession (JWT proof)
 */
export async function validateProofOfPossession(
  env: Env,
  proof: { proof_type: string; jwt?: string },
  expectedNonce: string,
  expectedAudience: string
): Promise<ProofValidationResult> {
  if (proof.proof_type !== 'jwt') {
    return { valid: false, error: 'Unsupported proof type' };
  }

  if (!proof.jwt) {
    return { valid: false, error: 'Missing JWT proof' };
  }

  try {
    const parts = proof.jwt.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWT format' };
    }

    // Decode header and payload
    const header = JSON.parse(decodeBase64Url(parts[0])) as JWTHeader;
    const payload = JSON.parse(decodeBase64Url(parts[1])) as {
      iss?: string;
      aud: string;
      iat: number;
      nonce?: string;
    };

    // Validate typ header
    if (header.typ !== 'openid4vci-proof+jwt') {
      return { valid: false, error: 'Invalid typ header' };
    }

    // Validate algorithm (HAIP requires ES256, ES384, or ES512)
    if (!['ES256', 'ES384', 'ES512'].includes(header.alg)) {
      return { valid: false, error: 'Unsupported algorithm' };
    }

    // Get holder public key from header
    const holderPublicKey = header.jwk;
    if (!holderPublicKey) {
      return { valid: false, error: 'Missing holder public key in JWT header' };
    }

    // Validate audience (should be the issuer identifier)
    if (payload.aud !== expectedAudience) {
      return { valid: false, error: 'Invalid audience' };
    }

    // Validate nonce (c_nonce)
    if (payload.nonce !== expectedNonce) {
      return { valid: false, error: 'Invalid nonce' };
    }

    // Validate iat (not too old, not in the future)
    // Get configurable values from KV > env > default
    const configManager = createVCConfigManager(env);
    const clockSkew = await configManager.getPopClockSkewSeconds();
    const validityPeriod = await configManager.getPopValiditySeconds();

    const now = Math.floor(Date.now() / 1000);
    if (payload.iat > now + clockSkew) {
      return { valid: false, error: 'Proof issued in the future' };
    }
    if (payload.iat < now - validityPeriod) {
      return { valid: false, error: 'Proof expired' };
    }

    // Verify signature using the holder's public key
    const cryptoKey = await importJWKForVerify(holderPublicKey, header.alg);
    const signatureValid = await verifyJWTSignature(proof.jwt, cryptoKey, header.alg);

    if (!signatureValid) {
      return { valid: false, error: 'Invalid proof signature' };
    }

    return {
      valid: true,
      holderPublicKey,
    };
  } catch (error) {
    log.error('Proof of possession validation failed', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return {
      valid: false,
      error: 'Proof validation failed',
    };
  }
}

/**
 * Import a JWK for signature verification
 */
async function importJWKForVerify(
  jwk: { kty: string; crv?: string; x?: string; y?: string; [key: string]: unknown },
  algorithm: string
): Promise<CryptoKey> {
  const algMap: Record<string, { name: string; namedCurve: string }> = {
    ES256: { name: 'ECDSA', namedCurve: 'P-256' },
    ES384: { name: 'ECDSA', namedCurve: 'P-384' },
    ES512: { name: 'ECDSA', namedCurve: 'P-521' },
  };

  const params = algMap[algorithm];
  if (!params) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  // JsonWebKey is a built-in Web Crypto API type
  return await crypto.subtle.importKey(
    'jwk',
    jwk as Parameters<typeof crypto.subtle.importKey>[1],
    params,
    false,
    ['verify']
  );
}

/**
 * Verify JWT signature
 */
async function verifyJWTSignature(
  token: string,
  publicKey: CryptoKey,
  algorithm: string
): Promise<boolean> {
  const parts = token.split('.');
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0)
  );

  const algMap: Record<string, { name: string; hash: string }> = {
    ES256: { name: 'ECDSA', hash: 'SHA-256' },
    ES384: { name: 'ECDSA', hash: 'SHA-384' },
    ES512: { name: 'ECDSA', hash: 'SHA-512' },
  };

  const params = algMap[algorithm];
  if (!params) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  return await crypto.subtle.verify(params, publicKey, signature, signedData);
}

/**
 * Get or create c_nonce for a user
 *
 * Key format: `cnonce:${userId}` - consistent with credential.ts and deferred.ts
 */
export async function getOrCreateCNonce(
  env: Env,
  userId: string
): Promise<{ nonce: string; expiresIn: number }> {
  const kvKey = `cnonce:${userId}`;
  const expiresIn = parseInt(env.C_NONCE_EXPIRY_SECONDS || '300', 10);

  // Try to get existing nonce
  const existing = await env.AUTHRIM_CONFIG.get(kvKey);
  if (existing) {
    return { nonce: existing, expiresIn };
  }

  // Generate new nonce
  const nonce = crypto.randomUUID();
  await env.AUTHRIM_CONFIG.put(kvKey, nonce, { expirationTtl: expiresIn });

  return { nonce, expiresIn };
}

/**
 * Consume a c_nonce (single use)
 *
 * Validates and deletes the c_nonce for a user.
 * Returns true if the nonce was valid and consumed.
 */
export async function consumeCNonce(
  env: Env,
  userId: string,
  expectedNonce: string
): Promise<boolean> {
  const kvKey = `cnonce:${userId}`;
  const storedNonce = await env.AUTHRIM_CONFIG.get(kvKey);

  if (!storedNonce || storedNonce !== expectedNonce) {
    return false;
  }

  await env.AUTHRIM_CONFIG.delete(kvKey);
  return true;
}
