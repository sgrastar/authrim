/**
 * Wallet attestation: OAuth 2.0 Attestation-Based Client Authentication
 * (draft-ietf-oauth-attestation-based-client-auth), the client authentication HAIP 1.0 asks of a
 * wallet at the issuer's PAR and token endpoints (design D-C, S2).
 *
 * A wallet sends two JWTs: the **client attestation** (signed by the wallet provider, carrying the
 * wallet type's identifier as `sub`, the instance key in `cnf.jwk` and a certificate chain in
 * `x5c`) and a **proof of possession** signed by that instance key and addressed to this issuer.
 *
 * Trust is a per-tenant allowlist of wallet-provider root certificates. A chain is accepted only if
 * it ends at one of them; nothing else makes a wallet trusted. Everything here is pure (no I/O),
 * with replay protection and the clock supplied by the caller.
 *
 * Scope: ECDSA P-256 / SHA-256 certificates and ES256 JWTs, as the certificate reader of this
 * package supports. A chain with anything else is refused, never guessed at.
 */

import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';
import {
  base64ToBytes,
  parseCertificate,
  verifyCertificateSignature,
  type ParsedCertificate,
} from './x509-certificate';

type Bytes = Uint8Array;

export const CLIENT_ATTESTATION_JWT_TYP = 'oauth-client-attestation+jwt';
export const CLIENT_ATTESTATION_POP_JWT_TYP = 'oauth-client-attestation-pop+jwt';
export const CLIENT_ATTESTATION_HEADER = 'OAuth-Client-Attestation';
export const CLIENT_ATTESTATION_POP_HEADER = 'OAuth-Client-Attestation-PoP';

const MAX_JWT_LENGTH = 16 * 1024;
const MAX_CHAIN_LENGTH = 5;
const MAX_ATTESTATION_LIFETIME_SECONDS = 24 * 3600;
const POP_MAX_AGE_SECONDS = 120;
const POP_MAX_FUTURE_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 30;

/** A wallet-provider trust anchor: a CA certificate (base64 DER), pinned by its SHA-256. */
export interface WalletAttestationAnchor {
  /** Base64 DER of the root (or other trust anchor) certificate. */
  certificate: string;
  /** Lower-case hex SHA-256 of that DER, checked against the certificate when loading. */
  sha256: string;
  /** Human label for the audit log and the allowlist UI. */
  label?: string;
}

export type AttestationFailure =
  | 'attestation_malformed'
  | 'attestation_header_invalid'
  | 'attestation_chain_invalid'
  | 'attestation_chain_untrusted'
  | 'attestation_signature_invalid'
  | 'attestation_claims_invalid'
  | 'attestation_expired'
  | 'attestation_client_mismatch'
  | 'pop_malformed'
  | 'pop_signature_invalid'
  | 'pop_claims_invalid'
  | 'pop_audience_mismatch'
  | 'pop_not_fresh'
  | 'pop_replayed';

export type WalletAttestationResult =
  | {
      ok: true;
      /** The wallet type's identifier (`sub`): this is the OAuth `client_id`. */
      clientId: string;
      /** RFC 7638 thumbprint of the instance key (`cnf.jwk`). */
      instanceKeyThumbprint: string;
      /** The anchor the chain ended at. */
      anchorSha256: string;
      /** The chain's leaf certificate hash, for audit. */
      leafSha256: string;
      attestationExpiresAt: number;
      popJti: string;
      /** Seconds the replay record of `popJti` must be kept. */
      popReplayTtlSeconds: number;
    }
  | { ok: false; error: AttestationFailure };

export interface VerifyWalletAttestationInput {
  /** Value of the `OAuth-Client-Attestation` header. */
  attestation: string;
  /** Value of the `OAuth-Client-Attestation-PoP` header. */
  pop: string;
  /** The issuer (authorization server) identifier the PoP must be addressed to. */
  audience: string;
  anchors: readonly WalletAttestationAnchor[];
  /** Epoch seconds. */
  now: number;
  /** When the request carries a `client_id`, it must equal the attestation's `sub`. */
  clientId?: string;
  /**
   * Records `jti` once; false if it was seen already. Absent means replay cannot be checked and
   * the attestation is refused: a caller must provide a store.
   */
  consumeJti: (jti: string, ttlSeconds: number) => Promise<boolean>;
  /** A `challenge` the PoP must echo (the issuer's nonce), when the issuer uses one. */
  expectedChallenge?: string;
}

function bytesToHex(bytes: Bytes): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Bytes): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

function bytesToBase64Url(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function jwkOfPoint(point: Bytes): JWK {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(point.slice(1, 33)),
    y: bytesToBase64Url(point.slice(33, 65)),
  };
}

/** RFC 7638 thumbprint of a P-256 public JWK. */
export async function p256JwkThumbprint(jwk: JWK): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  );
}

function decodeJsonPart(part: string): Record<string, unknown> | null {
  try {
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

function splitJwt(token: string): [string, string, string] | null {
  if (token.length === 0 || token.length > MAX_JWT_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return null;
  return parts as [string, string, string];
}

/** Loads anchors, dropping none silently: an entry whose hash does not match its DER is an error. */
export async function loadWalletAttestationAnchors(
  entries: readonly WalletAttestationAnchor[]
): Promise<{ anchor: WalletAttestationAnchor; parsed: ParsedCertificate }[]> {
  const loaded: { anchor: WalletAttestationAnchor; parsed: ParsedCertificate }[] = [];
  for (const anchor of entries) {
    const der = base64ToBytes(anchor.certificate);
    if ((await sha256Hex(der)) !== anchor.sha256.toLowerCase()) {
      throw new Error('attestation_anchor_hash_mismatch');
    }
    const parsed = parseCertificate(der);
    if (!parsed.isCA || !parsed.keyCertSign || parsed.hasExtendedKeyUsage) {
      throw new Error('attestation_anchor_not_a_ca');
    }
    loaded.push({ anchor, parsed });
  }
  return loaded;
}

interface ChainOk {
  ok: true;
  leaf: ParsedCertificate;
  leafSha256: string;
  anchorSha256: string;
}

/**
 * Validates `x5c` (leaf first) against the anchors: every certificate valid at `now`, each one
 * signed by the next, intermediates are CAs allowed to sign certificates and within their path
 * length, the leaf is not a CA, and the last certificate is an anchor or is signed by one.
 */
export async function validateAttestationChain(
  x5c: readonly string[],
  anchors: readonly { anchor: WalletAttestationAnchor; parsed: ParsedCertificate }[],
  nowSeconds: number
): Promise<
  ChainOk | { ok: false; error: 'attestation_chain_invalid' | 'attestation_chain_untrusted' }
> {
  const invalid = { ok: false, error: 'attestation_chain_invalid' } as const;
  if (x5c.length === 0 || x5c.length > MAX_CHAIN_LENGTH) return invalid;
  let ders: Bytes[];
  let certs: ParsedCertificate[];
  try {
    ders = x5c.map((entry) => base64ToBytes(entry));
    certs = ders.map((der) => parseCertificate(der));
  } catch {
    return invalid;
  }
  const nowMs = nowSeconds * 1000;
  for (const cert of certs) {
    if (nowMs < cert.notBefore.getTime() || nowMs > cert.notAfter.getTime()) return invalid;
  }
  const leaf = certs[0];
  if (leaf.isCA || !leaf.digitalSignature) return invalid;
  // An extended key usage anywhere in the chain limits what the certificates may be used for;
  // the profile read here has no use for it, so such a chain is not a wallet signing chain.
  if (certs.some((cert) => cert.hasExtendedKeyUsage)) return invalid;
  for (let index = 1; index < certs.length; index += 1) {
    const ca = certs[index];
    if (!ca.isCA || !ca.keyCertSign) return invalid;
    // Certificates below this CA that are themselves CAs: index - 1 minus the leaf.
    if (ca.pathLength !== undefined && index - 1 > ca.pathLength) return invalid;
  }
  for (let index = 0; index + 1 < certs.length; index += 1) {
    const issuer = certs[index + 1];
    if (!equalBytes(certs[index].issuerName, issuer.subjectName)) return invalid;
    if (!(await verifyCertificateSignature(certs[index], issuer.publicPoint))) return invalid;
  }
  const last = certs[certs.length - 1];
  const lastSha = await sha256Hex(ders[ders.length - 1]);
  const leafSha256 = await sha256Hex(ders[0]);
  for (const { anchor, parsed } of anchors) {
    if (lastSha === anchor.sha256.toLowerCase()) {
      return { ok: true, leaf, leafSha256, anchorSha256: anchor.sha256.toLowerCase() };
    }
    if (
      equalBytes(last.issuerName, parsed.subjectName) &&
      // The anchor must allow this many CAs below it (the chain's CAs, excluding the leaf).
      (parsed.pathLength === undefined || certs.length - 1 <= parsed.pathLength) &&
      nowMs >= parsed.notBefore.getTime() &&
      nowMs <= parsed.notAfter.getTime() &&
      (await verifyCertificateSignature(last, parsed.publicPoint))
    ) {
      return { ok: true, leaf, leafSha256, anchorSha256: anchor.sha256.toLowerCase() };
    }
  }
  return { ok: false, error: 'attestation_chain_untrusted' };
}

function equalBytes(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function audienceIs(value: unknown, expected: string): boolean {
  return typeof value === 'string'
    ? value === expected
    : Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function numericDate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Verifies a wallet's client attestation and proof of possession. Returns the authenticated
 * `client_id` (the attestation's `sub`) and the instance key's thumbprint; nothing about the
 * wallet is trusted before every check has passed.
 */
export async function verifyWalletAttestation(
  input: VerifyWalletAttestationInput
): Promise<WalletAttestationResult> {
  const fail = (error: AttestationFailure): WalletAttestationResult => ({ ok: false, error });
  const attestationParts = splitJwt(input.attestation);
  if (!attestationParts) return fail('attestation_malformed');
  const popParts = splitJwt(input.pop);
  if (!popParts) return fail('pop_malformed');

  // --- the attestation -------------------------------------------------------------------
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(input.attestation);
  } catch {
    return fail('attestation_malformed');
  }
  if (
    header.alg !== 'ES256' ||
    header.typ !== CLIENT_ATTESTATION_JWT_TYP ||
    !Array.isArray(header.x5c) ||
    header.x5c.some((entry) => typeof entry !== 'string') ||
    'jwk' in header ||
    'jku' in header ||
    'crit' in header
  ) {
    return fail('attestation_header_invalid');
  }
  let anchors: Awaited<ReturnType<typeof loadWalletAttestationAnchors>>;
  try {
    anchors = await loadWalletAttestationAnchors(input.anchors);
  } catch {
    return fail('attestation_chain_untrusted');
  }
  if (anchors.length === 0) return fail('attestation_chain_untrusted');
  const chain = await validateAttestationChain(header.x5c, anchors, input.now);
  if (!chain.ok) return fail(chain.error);

  try {
    const key = await importJWK(jwkOfPoint(chain.leaf.publicPoint), 'ES256');
    await compactVerify(input.attestation, key);
  } catch {
    return fail('attestation_signature_invalid');
  }
  const claims = decodeJsonPart(attestationParts[1]);
  if (!claims) return fail('attestation_claims_invalid');
  const exp = numericDate(claims.exp);
  if (exp === null) return fail('attestation_claims_invalid');
  if (exp <= input.now - CLOCK_SKEW_SECONDS) return fail('attestation_expired');
  const iat = claims.iat === undefined ? null : numericDate(claims.iat);
  if (claims.iat !== undefined && iat === null) return fail('attestation_claims_invalid');
  const nbf = claims.nbf === undefined ? null : numericDate(claims.nbf);
  if (claims.nbf !== undefined && nbf === null) return fail('attestation_claims_invalid');
  if (nbf !== null && nbf > input.now + CLOCK_SKEW_SECONDS)
    return fail('attestation_claims_invalid');
  if (iat !== null && iat > input.now + CLOCK_SKEW_SECONDS)
    return fail('attestation_claims_invalid');
  if (iat !== null && iat >= exp) return fail('attestation_claims_invalid');
  // The provider signs for one issuer at most: an `aud` that is not this issuer is for another.
  if (claims.aud !== undefined && !audienceIs(claims.aud, input.audience)) {
    return fail('attestation_claims_invalid');
  }
  // The lifetime limit needs a signed starting point; without one it cannot be applied.
  if (iat === null && nbf === null) return fail('attestation_claims_invalid');
  // A lifetime long enough to outlive a compromise window is refused, whatever the issuer says.
  if (exp - (iat ?? nbf ?? input.now) > MAX_ATTESTATION_LIFETIME_SECONDS) {
    return fail('attestation_claims_invalid');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 512) {
    return fail('attestation_claims_invalid');
  }
  if (typeof claims.iss !== 'string' || claims.iss.length === 0) {
    return fail('attestation_claims_invalid');
  }
  const cnf = claims.cnf;
  if (!isPlainObject(cnf) || !isPlainObject(cnf.jwk)) return fail('attestation_claims_invalid');
  const instanceJwk = cnf.jwk as JWK;
  if (
    instanceJwk.kty !== 'EC' ||
    instanceJwk.crv !== 'P-256' ||
    typeof instanceJwk.x !== 'string' ||
    typeof instanceJwk.y !== 'string' ||
    'd' in instanceJwk
  ) {
    return fail('attestation_claims_invalid');
  }
  if (input.clientId !== undefined && input.clientId !== claims.sub) {
    return fail('attestation_client_mismatch');
  }

  // --- the proof of possession -----------------------------------------------------------
  let popHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    popHeader = decodeProtectedHeader(input.pop);
  } catch {
    return fail('pop_malformed');
  }
  if (
    popHeader.alg !== 'ES256' ||
    popHeader.typ !== CLIENT_ATTESTATION_POP_JWT_TYP ||
    'jwk' in popHeader ||
    'x5c' in popHeader ||
    'crit' in popHeader
  ) {
    return fail('pop_malformed');
  }
  try {
    await compactVerify(input.pop, await importJWK(instanceJwk, 'ES256'));
  } catch {
    return fail('pop_signature_invalid');
  }
  const popClaims = decodeJsonPart(popParts[1]);
  if (!popClaims) return fail('pop_claims_invalid');
  if (popClaims.iss !== claims.sub) return fail('pop_claims_invalid');
  if (!audienceIs(popClaims.aud, input.audience)) return fail('pop_audience_mismatch');
  const popExp = popClaims.exp === undefined ? null : numericDate(popClaims.exp);
  if (
    popClaims.exp !== undefined &&
    (popExp === null || popExp <= input.now - CLOCK_SKEW_SECONDS)
  ) {
    return fail('pop_not_fresh');
  }
  const popNbf = popClaims.nbf === undefined ? null : numericDate(popClaims.nbf);
  if (popClaims.nbf !== undefined && (popNbf === null || popNbf > input.now + CLOCK_SKEW_SECONDS)) {
    return fail('pop_not_fresh');
  }
  const popIat = numericDate(popClaims.iat);
  if (popIat === null) return fail('pop_claims_invalid');
  if (popIat < input.now - POP_MAX_AGE_SECONDS || popIat > input.now + POP_MAX_FUTURE_SECONDS) {
    return fail('pop_not_fresh');
  }
  if (
    typeof popClaims.jti !== 'string' ||
    popClaims.jti.length === 0 ||
    popClaims.jti.length > 256
  ) {
    return fail('pop_claims_invalid');
  }
  if (input.expectedChallenge !== undefined && popClaims.challenge !== input.expectedChallenge) {
    return fail('pop_claims_invalid');
  }
  // Replay: the same proof is never accepted twice, for as long as it could still be fresh.
  const ttl = POP_MAX_AGE_SECONDS + POP_MAX_FUTURE_SECONDS + 5;
  let fresh: boolean;
  try {
    fresh = await input.consumeJti(`${claims.sub}:${popClaims.jti}`, ttl);
  } catch {
    return fail('pop_replayed');
  }
  if (!fresh) return fail('pop_replayed');

  return {
    ok: true,
    clientId: claims.sub,
    instanceKeyThumbprint: await p256JwkThumbprint(instanceJwk),
    anchorSha256: chain.anchorSha256,
    leafSha256: chain.leafSha256,
    attestationExpiresAt: exp,
    popJti: popClaims.jti,
    popReplayTtlSeconds: ttl,
  };
}
