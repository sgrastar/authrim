/**
 * VCI Token Validation Service
 *
 * Validates access tokens and proofs of possession for credential issuance.
 */

import type { Env } from '../../types';
import { decodeBase64Url, createLogger, buildIssuerUrl } from '@authrim/ar-lib-core';
import { createVCConfigManager } from '../../utils/vc-config';

const log = createLogger().module('VCI-TOKEN');

const MAX_VCI_ACCESS_TOKEN_SIZE = 8 * 1024;
const MAX_VCI_PROOF_JWT_SIZE = 8 * 1024;

function requireTenantId(tenantId: string | undefined, context: string): string {
  const normalized = tenantId?.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

export interface TokenValidationResult {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  credentialConfigurationId?: string;
  /** Deprecated internal alias retained until all repository callers use the explicit name. */
  vct?: string;
  jti?: string;
  offerId?: string;
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
  offer_id?: string;
  cnf?: {
    jwk?: { kty: string; crv: string; x: string; y?: string };
  };
}

function isValidPublicEcJwk(jwk: JWTHeader['jwk'], algorithm: string): boolean {
  const expectedCurve: Record<string, string> = {
    ES256: 'P-256',
    ES384: 'P-384',
    ES512: 'P-521',
  };
  return (
    !!jwk &&
    jwk.kty === 'EC' &&
    jwk.crv === expectedCurve[algorithm] &&
    typeof jwk.x === 'string' &&
    jwk.x.length > 0 &&
    typeof jwk.y === 'string' &&
    jwk.y.length > 0 &&
    !Object.prototype.hasOwnProperty.call(jwk, 'd')
  );
}

function resolveCNonceExpiry(env: Env): number {
  const parsed = Number(env.C_NONCE_EXPIRY_SECONDS);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 3600 ? parsed : 300;
}

function resolveExpectedIssuerIdentifier(
  env: Env,
  expectedTenantId: string,
  expectedIssuerOverride?: string
): string {
  if (expectedIssuerOverride) {
    return expectedIssuerOverride;
  }

  if (env.ISSUER_IDENTIFIER && !env.ISSUER_IDENTIFIER.startsWith('did:web:')) {
    return env.ISSUER_IDENTIFIER;
  }

  try {
    const issuerUrl = buildIssuerUrl(
      env as unknown as Parameters<typeof buildIssuerUrl>[0],
      requireTenantId(expectedTenantId, 'VCI issuer identifier')
    );
    return `did:web:${new URL(issuerUrl).hostname}`;
  } catch {
    return env.ISSUER_IDENTIFIER || 'did:web:authrim.com';
  }
}

/**
 * Validate a VCI access token
 */
export async function validateVCIAccessToken(
  env: Env,
  accessToken: string,
  expectedIssuerOverride: string | undefined,
  expectedTenantId: string
): Promise<TokenValidationResult> {
  try {
    const normalizedExpectedTenantId = requireTenantId(expectedTenantId, 'VCI access token');
    if (accessToken.length > MAX_VCI_ACCESS_TOKEN_SIZE) {
      return { valid: false, error: 'Token too large' };
    }

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
    const expectedIssuer = resolveExpectedIssuerIdentifier(
      env,
      normalizedExpectedTenantId,
      expectedIssuerOverride
    );
    // Allow issuer to be URL or DID format
    if (payload.iss !== expectedIssuer) {
      return { valid: false, error: 'Invalid issuer' };
    }

    // Validate audience (should include this VCI endpoint)
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const vciAudience = `${expectedIssuer}/vci`;
    if (!aud.some((a) => a === vciAudience || a === expectedIssuer)) {
      return { valid: false, error: 'Invalid audience' };
    }

    // Check scope for credential issuance
    const scopes = payload.scope?.split(' ') || [];
    if (!scopes.includes('credential')) {
      return { valid: false, error: 'Missing required scope' };
    }

    // Verify signature using JWKS
    const tenantId = payload.tenant_id;
    if (!tenantId || tenantId !== normalizedExpectedTenantId) {
      return { valid: false, error: 'Invalid tenant' };
    }

    const signatureValid = await verifyTokenSignature(env, accessToken, header, tenantId);
    if (!signatureValid) {
      return { valid: false, error: 'Invalid signature' };
    }

    // Extract holder binding (cnf claim)
    const holderBinding = payload.cnf?.jwk;
    if (holderBinding && !isValidPublicEcJwk(holderBinding, header.alg)) {
      return { valid: false, error: 'Invalid holder binding' };
    }

    return {
      valid: true,
      userId: payload.sub,
      tenantId,
      credentialConfigurationId: payload.credential_configuration_id,
      vct: payload.credential_configuration_id,
      jti: payload.jti,
      offerId: payload.offer_id,
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
  expectedTenantId: string
): Promise<boolean> {
  try {
    // validateVCIAccessToken accepts only the expected Authrim issuer. Keep key resolution tenant-
    // local so this helper cannot later turn an untrusted JWT iss claim into a JWKS fetch target.
    const tenantId = requireTenantId(expectedTenantId, 'VCI access token signature');
    const doId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
    const stub = env.KEY_MANAGER.get(doId);

    const jwksResponse = await stub.fetch(new Request('https://internal/ec/jwks'));
    if (!jwksResponse.ok) {
      log.error('Failed to get JWKS from KeyManager', {});
      return false;
    }

    const jwks = (await jwksResponse.json()) as { keys: Array<{ kid?: string; kty: string }> };

    const key = header.kid
      ? jwks.keys.find((k) => k.kid === header.kid)
      : jwks.keys.find((k) => k.kty === 'EC');

    if (!key) {
      log.error('Signing key not found in JWKS', {});
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
    if (proof.jwt.length > MAX_VCI_PROOF_JWT_SIZE) {
      return { valid: false, error: 'Proof too large' };
    }

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
    if (!isValidPublicEcJwk(holderPublicKey, header.alg)) {
      return { valid: false, error: 'Invalid holder public key' };
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

/** Decode only the routing nonce from a proof. Cryptographic validation must follow. */
export function decodeVCIProofNonce(proofJwt: string): string | null {
  if (!proofJwt || proofJwt.length > MAX_VCI_PROOF_JWT_SIZE) return null;
  const parts = proofJwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { nonce?: unknown };
    return typeof payload.nonce === 'string' && payload.nonce.length <= 512 ? payload.nonce : null;
  } catch {
    return null;
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
  const expiresIn = resolveCNonceExpiry(env);

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
