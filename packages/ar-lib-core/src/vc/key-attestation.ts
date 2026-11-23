/**
 * Key attestation (OpenID4VCI 1.0 Annex D), as HAIP 1.0 asks an issuer to require of the holder
 * key before it binds a credential to it (design D-C 3, S3).
 *
 * The wallet sends a key attestation JWT in the `key_attestation` header of its proof of
 * possession. A provider the tenant trusts (a `keyAttestationRoots` entry of the wallet's allowlist
 * entry) signed it with an `x5c` chain; it names the attested keys and how they are stored. The
 * issuer accepts the proof key only if the chain ends at one of those roots, the attestation is
 * bound to this request's `c_nonce`, names the proof key, and states a key storage at least as
 * strong as the configuration requires.
 *
 * Pure (no I/O); the clock is supplied by the caller. ES256 / P-256 only, like the certificate
 * reader of this package.
 */

import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';
import {
  loadWalletAttestationAnchors,
  p256JwkThumbprint,
  validateAttestationChain,
  type WalletAttestationAnchor,
} from './wallet-attestation';
import { p256PointFromJwk } from './x509-certificate';

export const KEY_ATTESTATION_JWT_TYP = 'key-attestation+jwt';

const MAX_JWT_LENGTH = 16 * 1024;
const MAX_ATTESTED_KEYS = 16;
const CLOCK_SKEW_SECONDS = 30;
/** An attestation older than this is refused whatever its nonce says. */
const MAX_AGE_SECONDS = 24 * 3600;

/** Key storage levels, weakest first (ISO/IEC 18045 attack potential resistance). */
export const KEY_STORAGE_LEVELS = [
  'iso_18045_basic',
  'iso_18045_enhanced-basic',
  'iso_18045_moderate',
  'iso_18045_high',
] as const;
export type KeyStorageLevel = (typeof KEY_STORAGE_LEVELS)[number];

export type KeyAttestationFailure =
  | 'key_attestation_malformed'
  | 'key_attestation_header_invalid'
  | 'key_attestation_chain_invalid'
  | 'key_attestation_chain_untrusted'
  | 'key_attestation_signature_invalid'
  | 'key_attestation_claims_invalid'
  | 'key_attestation_expired'
  | 'key_attestation_nonce_mismatch'
  | 'key_attestation_key_not_attested'
  | 'key_attestation_storage_insufficient';

export type KeyAttestationResult =
  | {
      ok: true;
      /** The strongest storage level the attestation states, when it states any. */
      keyStorage: KeyStorageLevel | null;
      anchorSha256: string;
      attestedKeyCount: number;
    }
  | { ok: false; error: KeyAttestationFailure };

export interface VerifyKeyAttestationInput {
  /** The `key_attestation` header value of the proof. */
  jwt: string;
  /** The roots the wallet type's key attestations may end at. */
  anchors: readonly WalletAttestationAnchor[];
  /** Epoch seconds. */
  now: number;
  /** The `c_nonce` of this request: the attestation must carry it. */
  expectedNonce: string;
  /** The credential issuer: an attestation that names an audience must name it. */
  expectedAudience?: string;
  /** The key the proof is signed with. */
  proofKey: JWK;
  /** The weakest storage level the credential configuration accepts; none means any. */
  requiredKeyStorage?: KeyStorageLevel;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  );
}

function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1] ?? '';
    const padded = part.replace(/-/gu, '+').replace(/_/gu, '/');
    const bytes = Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0)
    );
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    );
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPublicP256(jwk: unknown): jwk is JWK {
  if (!isPlainObject(jwk)) return false;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || 'd' in jwk) return false;
  try {
    p256PointFromJwk(jwk);
    return true;
  } catch {
    return false;
  }
}

function levelRank(level: string): number {
  return (KEY_STORAGE_LEVELS as readonly string[]).indexOf(level);
}

/** Verifies a key attestation for the proof key of one credential request. */
export async function verifyKeyAttestation(
  input: VerifyKeyAttestationInput
): Promise<KeyAttestationResult> {
  const fail = (error: KeyAttestationFailure): KeyAttestationResult => ({ ok: false, error });
  const { jwt } = input;
  if (
    typeof jwt !== 'string' ||
    jwt.length === 0 ||
    jwt.length > MAX_JWT_LENGTH ||
    jwt.split('.').length !== 3
  ) {
    return fail('key_attestation_malformed');
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(jwt);
  } catch {
    return fail('key_attestation_malformed');
  }
  if (
    header.alg !== 'ES256' ||
    header.typ !== KEY_ATTESTATION_JWT_TYP ||
    !Array.isArray(header.x5c) ||
    header.x5c.some((entry) => typeof entry !== 'string') ||
    'jwk' in header ||
    'jku' in header ||
    'crit' in header
  ) {
    return fail('key_attestation_header_invalid');
  }
  let anchors: Awaited<ReturnType<typeof loadWalletAttestationAnchors>>;
  try {
    anchors = await loadWalletAttestationAnchors(input.anchors);
  } catch {
    return fail('key_attestation_chain_untrusted');
  }
  if (anchors.length === 0) return fail('key_attestation_chain_untrusted');
  const chain = await validateAttestationChain(header.x5c, anchors, input.now);
  if (!chain.ok) {
    return fail(
      chain.error === 'attestation_chain_invalid'
        ? 'key_attestation_chain_invalid'
        : 'key_attestation_chain_untrusted'
    );
  }
  try {
    const leafJwk = {
      kty: 'EC',
      crv: 'P-256',
      ...jwkCoordinates(chain.leaf.publicPoint),
    } as JWK;
    await compactVerify(jwt, await importJWK(leafJwk, 'ES256'));
  } catch {
    return fail('key_attestation_signature_invalid');
  }

  const claims = decodePayload(jwt);
  if (!claims) return fail('key_attestation_claims_invalid');
  const iat = typeof claims.iat === 'number' && Number.isFinite(claims.iat) ? claims.iat : null;
  if (iat === null || iat > input.now + CLOCK_SKEW_SECONDS) {
    return fail('key_attestation_claims_invalid');
  }
  if (iat < input.now - MAX_AGE_SECONDS) return fail('key_attestation_expired');
  // Annex D.1: a key attestation carried in a proof states its own expiry.
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return fail('key_attestation_claims_invalid');
  }
  if (claims.exp <= input.now - CLOCK_SKEW_SECONDS) return fail('key_attestation_expired');
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) {
      return fail('key_attestation_claims_invalid');
    }
    if (claims.nbf > input.now + CLOCK_SKEW_SECONDS) return fail('key_attestation_claims_invalid');
  }
  if (claims.aud !== undefined && input.expectedAudience !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(input.expectedAudience)) return fail('key_attestation_claims_invalid');
  }
  // The issuer has a nonce endpoint, so the attestation must be bound to the nonce of this request.
  if (typeof claims.nonce !== 'string' || claims.nonce !== input.expectedNonce) {
    return fail('key_attestation_nonce_mismatch');
  }

  const attested = claims.attested_keys;
  if (
    !Array.isArray(attested) ||
    attested.length === 0 ||
    attested.length > MAX_ATTESTED_KEYS ||
    !attested.every(isPublicP256)
  ) {
    return fail('key_attestation_claims_invalid');
  }
  const proofThumbprint = isPublicP256(input.proofKey)
    ? await p256JwkThumbprint(input.proofKey)
    : null;
  if (proofThumbprint === null) return fail('key_attestation_key_not_attested');
  const thumbprints = await Promise.all(attested.map((key) => p256JwkThumbprint(key)));
  if (!thumbprints.includes(proofThumbprint)) return fail('key_attestation_key_not_attested');

  let keyStorage: KeyStorageLevel | null = null;
  if (claims.key_storage !== undefined) {
    if (!Array.isArray(claims.key_storage) || claims.key_storage.length > 8) {
      return fail('key_attestation_claims_invalid');
    }
    const known = claims.key_storage
      .filter((value): value is string => typeof value === 'string')
      .filter((value) => levelRank(value) >= 0);
    // The attestation states the levels it supports; the strongest one it claims is its level.
    keyStorage =
      known.length > 0
        ? (known.reduce((best, next) =>
            levelRank(next) > levelRank(best) ? next : best
          ) as KeyStorageLevel)
        : null;
  }
  if (input.requiredKeyStorage !== undefined) {
    if (keyStorage === null || levelRank(keyStorage) < levelRank(input.requiredKeyStorage)) {
      return fail('key_attestation_storage_insufficient');
    }
  }
  return {
    ok: true,
    keyStorage,
    anchorSha256: chain.anchorSha256,
    attestedKeyCount: attested.length,
  };
}

function jwkCoordinates(point: Uint8Array): { x: string; y: string } {
  const url = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  };
  return { x: url(point.slice(1, 33)), y: url(point.slice(33, 65)) };
}
