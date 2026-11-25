/**
 * Claim builders and JWS assembly for the two JWTs the Authrim OP verifies
 * (`verifyWalletAttestation`,
 * `verifyKeyAttestation` in ar-lib-core). The signer (secret on Cloudflare, KMS on AWS) only
 * receives
 * the finished signing input; the header and the claims are fixed here and validated against an
 * exact
 * shape, so a caller cannot make the provider sign anything else.
 */

import { fromBase64Url, toBase64, toBase64Url, utf8, type Bytes } from './bytes';
import { isPrintableToken, normalizeJwk, type PublicP256Jwk } from './client-data';
import { parseCertificate } from './x509';

export const WALLET_ATTESTATION_TYP = 'oauth-client-attestation+jwt';
export const KEY_ATTESTATION_TYP = 'key-attestation+jwt';
const MAX_JWT_LENGTH = 16 * 1024;
const MIN_REMAINING_SECONDS = 60;

export interface WalletAttestationClaims {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  cnf: { jwk: PublicP256Jwk };
}

export interface KeyAttestationClaims {
  iat: number;
  exp: number;
  nonce: string;
  attested_keys: [PublicP256Jwk];
  key_storage: string[];
}

/**
 * The earliest `notAfter` (epoch seconds) of the chain, or null if a certificate cannot be read.
 */
export function chainLimit(chain: readonly Bytes[]): number | null {
  try {
    return Math.min(...chain.map((der) => parseCertificate(der).notAfter));
  } catch {
    return null;
  }
}

/**
 * `exp = min(iat + ttl, chainLimit - margin)`. Returns null when the chain leaves less than the
 * minimum lifetime, so the caller answers `provider_unavailable` instead of issuing a short-lived
 * JWT.
 */
export function boundedExpiry(input: {
  now: number;
  ttlSeconds: number;
  chainLimit: number;
  marginSeconds?: number;
}): number | null {
  const exp = Math.min(
    input.now + input.ttlSeconds,
    input.chainLimit - (input.marginSeconds ?? 3600)
  );
  return exp - input.now >= MIN_REMAINING_SECONDS ? exp : null;
}

export function walletAttestationClaims(input: {
  issuer: string;
  clientId: string;
  now: number;
  exp: number;
  jwk: PublicP256Jwk;
}): WalletAttestationClaims {
  return {
    iss: input.issuer,
    sub: input.clientId,
    iat: input.now,
    exp: input.exp,
    cnf: { jwk: input.jwk },
  };
}

export function keyAttestationClaims(input: {
  now: number;
  exp: number;
  nonce: string;
  jwk: PublicP256Jwk;
  keyStorage: readonly string[];
}): KeyAttestationClaims {
  if (!isPrintableToken(input.nonce)) throw new Error('key_attestation_nonce_invalid');
  return {
    iat: input.now,
    exp: input.exp,
    nonce: input.nonce,
    attested_keys: [input.jwk],
    key_storage: [...input.keyStorage],
  };
}

export interface SigningInput {
  signingInput: string;
  signingBytes: Bytes;
}

const KEY_STORAGE_LEVELS = [
  'iso_18045_basic',
  'iso_18045_enhanced-basic',
  'iso_18045_moderate',
  'iso_18045_high',
];
const MAX_WALLET_LIFETIME = 24 * 3600;
const MAX_KEY_LIFETIME = 3600;

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index])
  );
}

function validTimes(iat: unknown, exp: unknown, maxLifetime: number): boolean {
  return (
    typeof iat === 'number' &&
    typeof exp === 'number' &&
    Number.isSafeInteger(iat) &&
    Number.isSafeInteger(exp) &&
    iat > 0 &&
    exp > iat &&
    exp - iat <= maxLifetime
  );
}

function minimalJwk(value: unknown): boolean {
  const jwk = normalizeJwk(value);
  return jwk !== null && exactKeys(value as object, ['kty', 'crv', 'x', 'y']);
}

/** Exact shape of the wallet attestation payload; throws `wallet_claims_invalid` otherwise. */
export function assertWalletAttestationClaims(claims: WalletAttestationClaims): void {
  const jwk: unknown = claims.cnf?.jwk;
  if (
    !exactKeys(claims, ['iss', 'sub', 'iat', 'exp', 'cnf']) ||
    typeof claims.iss !== 'string' ||
    claims.iss.length === 0 ||
    claims.iss.length > 512 ||
    typeof claims.sub !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(claims.sub) ||
    !validTimes(claims.iat, claims.exp, MAX_WALLET_LIFETIME) ||
    !exactKeys(claims.cnf, ['jwk']) ||
    !minimalJwk(jwk)
  ) {
    throw new Error('wallet_claims_invalid');
  }
}

/** Exact shape of the key attestation payload; throws `key_claims_invalid` otherwise. */
export function assertKeyAttestationClaims(claims: KeyAttestationClaims): void {
  if (
    !exactKeys(claims, ['iat', 'exp', 'nonce', 'attested_keys', 'key_storage']) ||
    !validTimes(claims.iat, claims.exp, MAX_KEY_LIFETIME) ||
    !isPrintableToken(claims.nonce) ||
    !Array.isArray(claims.attested_keys) ||
    claims.attested_keys.length !== 1 ||
    !minimalJwk(claims.attested_keys[0]) ||
    !Array.isArray(claims.key_storage) ||
    claims.key_storage.length < 1 ||
    claims.key_storage.length > 8 ||
    !claims.key_storage.every((level) => KEY_STORAGE_LEVELS.includes(level))
  ) {
    throw new Error('key_claims_invalid');
  }
}

function jwsSigningInput(typ: string, chain: readonly Bytes[], claims: object): SigningInput {
  if (chain.length < 1 || chain.length > 3) throw new Error('chain_length');
  const header = { alg: 'ES256', typ, x5c: chain.map((der) => toBase64(der)) };
  const encode = (value: object): string => toBase64Url(utf8(JSON.stringify(value)));
  const signingInput = `${encode(header)}.${encode(claims)}`;
  return { signingInput, signingBytes: utf8(signingInput) };
}

/**
 * Signing input of a wallet attestation. Every value is read once into a fresh object, that copy is
 * validated, and only the copy is serialised, so an input with a `toJSON`, getters or inherited
 * members
 * cannot make the signed payload differ from the validated one.
 */
export function walletAttestationSigningInput(
  chain: readonly Bytes[],
  claims: WalletAttestationClaims
): SigningInput {
  const jwk = claims.cnf?.jwk;
  const payload: WalletAttestationClaims = {
    iss: claims.iss,
    sub: claims.sub,
    iat: claims.iat,
    exp: claims.exp,
    cnf: { jwk: { kty: jwk?.kty, crv: jwk?.crv, x: jwk?.x, y: jwk?.y } },
  };
  if (!exactKeys(claims, ['iss', 'sub', 'iat', 'exp', 'cnf']))
    throw new Error('wallet_claims_invalid');
  if (!exactKeys(claims.cnf, ['jwk']) || !exactKeys(jwk as object, ['kty', 'crv', 'x', 'y'])) {
    throw new Error('wallet_claims_invalid');
  }
  assertWalletAttestationClaims(payload);
  return jwsSigningInput(WALLET_ATTESTATION_TYP, chain, payload);
}

/** Signing input of a key attestation; same copy-then-validate rule. */
export function keyAttestationSigningInput(
  chain: readonly Bytes[],
  claims: KeyAttestationClaims
): SigningInput {
  const keys: unknown = claims.attested_keys;
  const jwk: PublicP256Jwk | undefined = Array.isArray(keys)
    ? (keys[0] as PublicP256Jwk)
    : undefined;
  const storage: unknown = claims.key_storage;
  const payload: KeyAttestationClaims = {
    iat: claims.iat,
    exp: claims.exp,
    nonce: claims.nonce,
    attested_keys: [{ kty: jwk?.kty, crv: jwk?.crv, x: jwk?.x, y: jwk?.y }] as [PublicP256Jwk],
    key_storage: Array.isArray(storage) ? ([...storage] as string[]) : (storage as string[]),
  };
  if (!exactKeys(claims, ['iat', 'exp', 'nonce', 'attested_keys', 'key_storage'])) {
    throw new Error('key_claims_invalid');
  }
  if (
    !Array.isArray(keys) ||
    keys.length !== 1 ||
    !exactKeys(jwk as object, ['kty', 'crv', 'x', 'y'])
  ) {
    throw new Error('key_claims_invalid');
  }
  assertKeyAttestationClaims(payload);
  return jwsSigningInput(KEY_ATTESTATION_TYP, chain, payload);
}

/** Appends the raw `r || s` signature (64 bytes) and checks the size limit of the OP. */
export function finishJws(signingInput: string, rawSignature: Bytes): string | null {
  if (rawSignature.length !== 64) return null;
  const jwt = `${signingInput}.${toBase64Url(rawSignature)}`;
  return jwt.length <= MAX_JWT_LENGTH ? jwt : null;
}

export function decodeJwtPart(part: string): unknown {
  const bytes = fromBase64Url(part);
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}
