/**
 * SD-JWT VC (Verifiable Credential) Implementation
 *
 * Extends the base SD-JWT (RFC 9901) implementation for Verifiable Credentials.
 * Implements:
 * - SD-JWT VC format (dc+sd-jwt) per draft-ietf-oauth-sd-jwt-vc-13
 * - Key Binding JWT (KB-JWT) for holder binding
 * - Status List 2021 integration for revocation
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/
 * @see RFC 9901 (SD-JWT)
 */

import { SignJWT, jwtVerify, decodeJwt, base64url } from 'jose';
import type { JWTPayload, JWK } from 'jose';
import {
  createDisclosure,
  decodeDisclosure,
  decodeArrayElementDisclosure,
  SD_JWT_SEPARATOR,
  processNestedDisclosures,
  type SDJWTDisclosure,
} from '../utils/sd-jwt';
import { timingSafeEqual } from '../utils/crypto';
import type { ECAlgorithm } from '../utils/ec-keys';
import type { HaipPolicy, HaipSignatureAlgorithm } from './haip-policy';

// =============================================================================
// Types
// =============================================================================

/**
 * SD-JWT VC Header
 */
export interface SDJWTVCHeader {
  /** Algorithm (ES256, ES384, ES512 for HAIP) */
  alg: HaipSignatureAlgorithm;

  /** Type (must be 'dc+sd-jwt' for SD-JWT VC) */
  typ: 'dc+sd-jwt';

  /** Key ID */
  kid?: string;

  /** Trust chain */
  trust_chain?: string[];
}

/**
 * SD-JWT VC Payload
 */
export interface SDJWTVCPayload extends JWTPayload {
  /** Issuer (DID or URL) */
  iss: string;

  /** Subject (holder identifier) */
  sub?: string;

  /** Verifiable Credential Type */
  vct: string;

  /** Issued at */
  iat: number;

  /** Expiration */
  exp?: number;

  /** Not before */
  nbf?: number;

  /** JWT ID */
  jti?: string;

  /** Selective disclosure hashes */
  _sd?: string[];

  /** Hash algorithm */
  _sd_alg?: string;

  /** Confirmation claim (holder binding) */
  cnf?: ConfirmationClaim;

  /** Status (for revocation) */
  status?: StatusClaim;
}

/**
 * Confirmation Claim (cnf)
 * Used for holder binding
 */
export interface ConfirmationClaim {
  /** JWK thumbprint */
  jkt?: string;

  /** JWK (full key) */
  jwk?: JWK;
}

/**
 * Status Claim
 * For credential status (revocation) checking
 */
export interface StatusClaim {
  /** Status list index */
  status_list?: {
    idx: number;
    uri: string;
  };
}

/**
 * Key Binding JWT (KB-JWT) Payload
 */
export interface KBJWTPayload extends JWTPayload {
  /** Audience (Verifier identifier) */
  aud: string;

  /** Issued at */
  iat: number;

  /** Nonce from Verifier */
  nonce: string;

  /** Hash of SD-JWT */
  sd_hash: string;
}

/**
 * SD-JWT VC Creation Options
 */
export interface SDJWTVCCreateOptions {
  /** Verifiable Credential Type */
  vct: string;

  /** Claims to make selectively disclosable */
  selectiveDisclosureClaims: string[];

  /** Holder binding key (JWK) */
  holderBinding?: JWK;

  /** Credential expiration (Unix timestamp) */
  expiresAt?: number;

  /** Credential not before (Unix timestamp) */
  notBefore?: number;

  /** Status list for revocation */
  status?: StatusClaim;

  /** JWT ID */
  jti?: string;
}

/**
 * SD-JWT VC Result
 */
export interface SDJWTVC {
  /** Issuer-signed JWT */
  issuerJwt: string;

  /** Disclosures */
  disclosures: SDJWTDisclosure[];

  /** Combined SD-JWT VC (without KB-JWT) */
  combined: string;
}

/**
 * Parsed SD-JWT VC
 */
export interface ParsedSDJWTVC {
  /** Issuer-signed JWT */
  issuerJwt: string;

  /** Decoded issuer JWT payload */
  payload: SDJWTVCPayload;

  /** Disclosures */
  disclosures: SDJWTDisclosure[];

  /** Key Binding JWT (if present) */
  kbJwt?: string;

  /** Decoded KB-JWT payload (if present) */
  kbPayload?: KBJWTPayload;
}

/**
 * SD-JWT VC Verification Options
 */
export interface SDJWTVCVerifyOptions {
  /** Expected issuer */
  issuer: string;

  /** Expected VCT */
  vct?: string;

  /** HAIP policy to apply */
  haipPolicy?: HaipPolicy;

  /** Nonce (for KB-JWT verification) */
  nonce?: string;

  /** Audience (for KB-JWT verification) */
  audience?: string;

  /** Current time for expiration check */
  currentTime?: number;
}

/**
 * SD-JWT VC Verification Result
 */
export interface SDJWTVCVerifyResult {
  /** Verification success */
  verified: boolean;

  /** Issuer JWT payload */
  payload: SDJWTVCPayload;

  /** Disclosed claims */
  disclosedClaims: Record<string, unknown>;

  /** Holder binding verified */
  holderBindingVerified: boolean;

  /** Disclosures */
  disclosures: SDJWTDisclosure[];

  /** Number of undisclosed claims */
  undisclosedCount: number;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Create an SD-JWT VC
 *
 * @param claims - All claims to include
 * @param issuer - Issuer identifier (DID or URL)
 * @param privateKey - Issuer's private key
 * @param algorithm - Signing algorithm
 * @param kid - Key ID
 * @param options - Creation options
 * @returns SD-JWT VC
 */
export async function createSDJWTVC(
  claims: Record<string, unknown>,
  issuer: string,
  privateKey: CryptoKey,
  algorithm: ECAlgorithm,
  kid: string,
  options: SDJWTVCCreateOptions
): Promise<SDJWTVC> {
  const { vct, selectiveDisclosureClaims, holderBinding, expiresAt, notBefore, status, jti } =
    options;

  const now = Math.floor(Date.now() / 1000);
  const disclosures: SDJWTDisclosure[] = [];
  const sdHashes: string[] = [];
  const remainingClaims: Record<string, unknown> = {};

  // Separate selective disclosure claims from regular claims
  for (const [key, value] of Object.entries(claims)) {
    if (selectiveDisclosureClaims.includes(key)) {
      const disclosure = await createDisclosure(key, value);
      disclosures.push(disclosure);
      sdHashes.push(disclosure.hash);
    } else {
      remainingClaims[key] = value;
    }
  }

  // Build SD-JWT VC payload
  const payload: SDJWTVCPayload = {
    ...remainingClaims,
    iss: issuer,
    vct,
    iat: now,
    _sd_alg: 'sha-256',
  };

  // Add optional claims
  if (expiresAt) {
    payload.exp = expiresAt;
  }

  if (notBefore) {
    payload.nbf = notBefore;
  }

  if (jti) {
    payload.jti = jti;
  }

  // Add selective disclosure hashes
  if (sdHashes.length > 0) {
    payload._sd = sdHashes.sort();
  }

  // Add holder binding
  if (holderBinding) {
    // Use JWK thumbprint for cnf
    const thumbprint = await generateJWKThumbprint(holderBinding);
    payload.cnf = { jkt: thumbprint };
  }

  // Add status claim
  if (status) {
    payload.status = status;
  }

  // Sign the JWT with dc+sd-jwt type
  const issuerJwt = await new SignJWT(payload as JWTPayload)
    .setProtectedHeader({
      alg: algorithm,
      typ: 'dc+sd-jwt',
      kid,
    })
    .sign(privateKey);

  // Combine JWT and disclosures
  const disclosureStrings = disclosures.map((d) => d.encoded);
  const combined = [issuerJwt, ...disclosureStrings, ''].join(SD_JWT_SEPARATOR);

  return {
    issuerJwt,
    disclosures,
    combined,
  };
}

/**
 * Parse an SD-JWT VC string
 *
 * @param sdjwtvc - SD-JWT VC string
 * @returns Parsed SD-JWT VC
 */
export async function parseSDJWTVC(sdjwtvc: string): Promise<ParsedSDJWTVC | null> {
  const parts = sdjwtvc.split(SD_JWT_SEPARATOR);

  if (parts.length < 2) {
    return null;
  }

  const issuerJwt = parts[0];
  let kbJwt: string | undefined;

  // Check if last non-empty part is a KB-JWT
  const lastPart = parts[parts.length - 1];
  const secondLastPart = parts[parts.length - 2];

  // If last part is empty and second-last looks like a JWT, it might be KB-JWT
  if (lastPart === '' && secondLastPart && secondLastPart.split('.').length === 3) {
    // Check if it's a disclosure or KB-JWT by trying to decode as disclosure
    const decoded = await decodeDisclosure(secondLastPart);
    if (!decoded) {
      // It's a KB-JWT
      kbJwt = secondLastPart;
    }
  }

  // Parse disclosures (supports both regular and array element disclosures)
  const disclosures: SDJWTDisclosure[] = [];
  const startIdx = 1;
  const endIdx = kbJwt ? parts.length - 2 : parts.length - 1;

  for (let i = startIdx; i < endIdx; i++) {
    if (parts[i] === '') continue;

    // Try regular disclosure first
    let disclosure = await decodeDisclosure(parts[i]);
    if (!disclosure) {
      // Try array element disclosure (2-element format)
      disclosure = await decodeArrayElementDisclosure(parts[i]);
    }
    if (disclosure) {
      disclosures.push(disclosure);
    }
  }

  // Decode issuer JWT
  let payload: SDJWTVCPayload;
  try {
    payload = decodeJwt(issuerJwt) as SDJWTVCPayload;
  } catch {
    return null;
  }

  // Decode KB-JWT if present
  let kbPayload: KBJWTPayload | undefined;
  if (kbJwt) {
    try {
      kbPayload = decodeJwt(kbJwt) as KBJWTPayload;
    } catch {
      // Invalid KB-JWT, ignore
    }
  }

  return {
    issuerJwt,
    payload,
    disclosures,
    kbJwt,
    kbPayload,
  };
}

/**
 * Verify an SD-JWT VC
 *
 * @param sdjwtvc - SD-JWT VC string
 * @param issuerKey - Issuer's public key
 * @param holderKey - Holder's public key (for KB-JWT verification)
 * @param options - Verification options
 * @returns Verification result
 */
export async function verifySDJWTVC(
  sdjwtvc: string,
  issuerKey: CryptoKey,
  holderKey: CryptoKey | null,
  options: SDJWTVCVerifyOptions
): Promise<SDJWTVCVerifyResult> {
  const parsed = await parseSDJWTVC(sdjwtvc);

  if (!parsed) {
    throw new Error('Invalid SD-JWT VC format');
  }

  const { issuerJwt, disclosures, kbJwt, payload } = parsed;
  const { issuer, vct, nonce, audience, currentTime } = options;

  // Verify issuer JWT signature
  await jwtVerify(issuerJwt, issuerKey, {
    issuer,
    currentDate: currentTime ? new Date(currentTime * 1000) : undefined,
  });

  // Verify VCT if specified
  if (vct && payload.vct !== vct) {
    throw new Error(`VCT mismatch: expected ${vct}, got ${payload.vct}`);
  }

  // Check expiration
  if (payload.exp && (currentTime || Math.floor(Date.now() / 1000)) > payload.exp) {
    throw new Error('Credential has expired');
  }

  // Verify holder binding (KB-JWT)
  let holderBindingVerified = false;

  if (kbJwt && holderKey && nonce && audience) {
    // Verify KB-JWT with timing-safe comparisons and expiration check
    await verifyKeyBindingJWT(kbJwt, holderKey, {
      nonce,
      audience,
      sdjwtvc: sdjwtvc.substring(0, sdjwtvc.lastIndexOf(SD_JWT_SEPARATOR + kbJwt)),
      currentTime,
    });
    holderBindingVerified = true;
  }

  // Process disclosures with nested/array support (RFC 9901)
  // Use processNestedDisclosures to handle nested _sd arrays and array disclosure markers
  // Note: cnf (confirmation) and status are NOT selectively disclosable per SD-JWT VC spec
  // They are always present top-level claims, so we exclude them from disclosure processing
  // but preserve them in the final result for verifier access
  const { _sd, _sd_alg, cnf, status, ...otherClaims } = payload;
  // Suppress unused variable warnings - these are intentionally extracted to exclude from otherClaims
  void _sd;
  void _sd_alg;

  // Build a complete payload for nested processing (excluding cnf/status - not SD claims)
  const payloadForProcessing: Record<string, unknown> = {
    ...otherClaims,
    _sd: payload._sd,
    _sd_alg: payload._sd_alg,
  };

  const { result: processedClaims, undisclosedCount } = processNestedDisclosures(
    payloadForProcessing,
    disclosures
  );

  // Remove SD-JWT metadata from result
  delete processedClaims._sd;
  delete processedClaims._sd_alg;

  // Build final disclosed claims, preserving cnf and status if present
  // These are essential for holder binding verification and status checking
  const allDisclosedClaims: Record<string, unknown> = { ...processedClaims };
  if (cnf !== undefined) {
    allDisclosedClaims.cnf = cnf;
  }
  if (status !== undefined) {
    allDisclosedClaims.status = status;
  }

  return {
    verified: true,
    payload,
    disclosedClaims: allDisclosedClaims,
    holderBindingVerified,
    disclosures,
    undisclosedCount,
  };
}

/**
 * Create a Key Binding JWT
 *
 * @param holderPrivateKey - Holder's private key
 * @param algorithm - Signing algorithm
 * @param nonce - Nonce from Verifier
 * @param audience - Verifier identifier
 * @param sdjwtvc - SD-JWT VC string (without KB-JWT)
 * @returns KB-JWT string
 */
export async function createKeyBindingJWT(
  holderPrivateKey: CryptoKey,
  algorithm: ECAlgorithm,
  nonce: string,
  audience: string,
  sdjwtvc: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Calculate SD-JWT hash
  const sdHash = await calculateSDHash(sdjwtvc);

  const payload: KBJWTPayload = {
    aud: audience,
    iat: now,
    nonce,
    sd_hash: sdHash,
  };

  return await new SignJWT(payload as JWTPayload)
    .setProtectedHeader({
      alg: algorithm,
      typ: 'kb+jwt',
    })
    .sign(holderPrivateKey);
}

/**
 * Verify a Key Binding JWT
 *
 * Verification order is optimized for security and performance:
 * 1. Decode payload (no signature verification yet)
 * 2. Validate low-cost claims first (iat, exp, nonce, sd_hash)
 * 3. Only then perform expensive signature verification
 *
 * This prevents DoS attacks where invalid tokens waste CPU on signature verification.
 *
 * @param kbJwt - KB-JWT string
 * @param holderKey - Holder's public key
 * @param options - Verification options
 */
/** Default maximum age for KB-JWT in seconds (5 minutes) */
const KB_JWT_MAX_AGE_SECONDS = 300;

/** Allowed algorithms for KB-JWT (HAIP compliant) */
const ALLOWED_KB_JWT_ALGORITHMS = ['ES256', 'ES384', 'ES512'];

async function verifyKeyBindingJWT(
  kbJwt: string,
  holderKey: CryptoKey,
  options: {
    nonce: string;
    audience: string;
    sdjwtvc: string;
    /** Maximum age of KB-JWT in seconds (default: 300 = 5 minutes) */
    maxAge?: number;
    /** Current time for verification (Unix seconds), defaults to now */
    currentTime?: number;
  }
): Promise<void> {
  const { nonce, audience, sdjwtvc, maxAge = KB_JWT_MAX_AGE_SECONDS, currentTime } = options;
  const now = currentTime ?? Math.floor(Date.now() / 1000);
  const clockSkewTolerance = 60;

  // Generic error message to prevent information leakage
  const INVALID_KB_JWT = 'Invalid Key Binding JWT';

  // Step 0: Validate JWT structure and typ header (lowest cost check)
  // SD-JWT VC spec requires KB-JWT to have typ: "kb+jwt"
  const parts = kbJwt.split('.');
  if (parts.length !== 3) {
    throw new Error(INVALID_KB_JWT);
  }

  let header: { typ?: string; alg?: string };
  try {
    // Decode header (base64url) with proper padding
    const headerBase64 = parts[0];
    const padded = headerBase64.padEnd(
      headerBase64.length + ((4 - (headerBase64.length % 4)) % 4),
      '='
    );
    const headerStr = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    header = JSON.parse(headerStr) as { typ?: string; alg?: string };
  } catch {
    throw new Error(INVALID_KB_JWT);
  }

  // REQUIRED: typ MUST be "kb+jwt" per SD-JWT VC spec (draft-ietf-oauth-sd-jwt-vc)
  if (header.typ !== 'kb+jwt') {
    throw new Error(INVALID_KB_JWT);
  }

  // Validate algorithm is in allowed list (pre-check before expensive signature verification)
  if (!header.alg || !ALLOWED_KB_JWT_ALGORITHMS.includes(header.alg)) {
    throw new Error(INVALID_KB_JWT);
  }

  // Step 1: Decode payload WITHOUT signature verification (low cost)
  // This allows us to reject obviously invalid tokens before expensive crypto
  let unsafePayload: KBJWTPayload;
  try {
    unsafePayload = decodeJwt(kbJwt) as KBJWTPayload;
  } catch {
    throw new Error(INVALID_KB_JWT);
  }

  // Step 2: Validate iat (issued at) - REQUIRED claim
  // SECURITY: Check for NaN, non-integer, and unreasonable values
  // Note: typeof NaN === 'number' is true, so we need explicit NaN check
  if (
    typeof unsafePayload.iat !== 'number' ||
    !Number.isFinite(unsafePayload.iat) ||
    unsafePayload.iat <= 0
  ) {
    throw new Error(INVALID_KB_JWT);
  }

  // Check if KB-JWT is from the future
  if (unsafePayload.iat > now + clockSkewTolerance) {
    throw new Error(INVALID_KB_JWT);
  }

  // Check if KB-JWT is too old
  // SECURITY: Explicitly check for negative age (defense in depth)
  const age = now - unsafePayload.iat;
  if (age < 0 || age > maxAge) {
    throw new Error(INVALID_KB_JWT);
  }

  // Step 3: Validate exp (expiration) if present - RFC 7519 requires this
  if (typeof unsafePayload.exp === 'number') {
    if (unsafePayload.exp < now - clockSkewTolerance) {
      throw new Error(INVALID_KB_JWT);
    }
  }

  // Step 4: Validate nonce (timing-safe comparison to prevent timing attacks)
  if (!unsafePayload.nonce || !timingSafeEqual(unsafePayload.nonce, nonce)) {
    throw new Error(INVALID_KB_JWT);
  }

  // Step 5: Validate sd_hash (timing-safe comparison to prevent timing attacks)
  const expectedSdHash = await calculateSDHash(sdjwtvc);
  if (!unsafePayload.sd_hash || !timingSafeEqual(unsafePayload.sd_hash, expectedSdHash)) {
    throw new Error(INVALID_KB_JWT);
  }

  // Step 6: Validate audience
  if (unsafePayload.aud !== audience) {
    throw new Error(INVALID_KB_JWT);
  }

  // Step 7: Now perform expensive signature verification
  // All cheap checks have passed, so it's worth the CPU cost
  try {
    await jwtVerify(kbJwt, holderKey, {
      audience,
      algorithms: ALLOWED_KB_JWT_ALGORITHMS,
      currentDate: currentTime !== undefined ? new Date(currentTime * 1000) : undefined,
    });
  } catch {
    throw new Error(INVALID_KB_JWT);
  }
}

/**
 * Create a presentation from SD-JWT VC with Key Binding
 *
 * @param sdjwtvc - Original SD-JWT VC
 * @param claimsToDisclose - Claims to include in presentation
 * @param holderPrivateKey - Holder's private key
 * @param algorithm - Signing algorithm
 * @param nonce - Nonce from Verifier
 * @param audience - Verifier identifier
 * @returns Presentation string (SD-JWT VC + KB-JWT)
 */
export async function createVCPresentation(
  sdjwtvc: SDJWTVC,
  claimsToDisclose: string[],
  holderPrivateKey: CryptoKey,
  algorithm: ECAlgorithm,
  nonce: string,
  audience: string
): Promise<string> {
  // Select disclosures to include
  const selectedDisclosures = sdjwtvc.disclosures.filter((d) =>
    claimsToDisclose.includes(d.claimName)
  );

  // Build SD-JWT VC without KB-JWT
  const disclosureStrings = selectedDisclosures.map((d) => d.encoded);
  const sdjwtWithoutKb = [sdjwtvc.issuerJwt, ...disclosureStrings, ''].join(SD_JWT_SEPARATOR);

  // Create KB-JWT
  const kbJwt = await createKeyBindingJWT(
    holderPrivateKey,
    algorithm,
    nonce,
    audience,
    sdjwtWithoutKb.slice(0, -1) // Remove trailing ~
  );

  // Combine with KB-JWT
  return sdjwtWithoutKb + kbJwt;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate SHA-256 hash of SD-JWT for KB-JWT
 */
async function calculateSDHash(sdjwtvc: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(sdjwtvc);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return base64url.encode(new Uint8Array(hashBuffer));
}

/**
 * Generate JWK Thumbprint (RFC 7638)
 */
async function generateJWKThumbprint(jwk: JWK): Promise<string> {
  let thumbprintInput: string;

  if (jwk.kty === 'EC') {
    // EC key thumbprint
    thumbprintInput = JSON.stringify({
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
      y: jwk.y,
    });
  } else if (jwk.kty === 'RSA') {
    // RSA key thumbprint
    thumbprintInput = JSON.stringify({
      e: jwk.e,
      kty: jwk.kty,
      n: jwk.n,
    });
  } else if (jwk.kty === 'OKP') {
    // OKP key thumbprint
    thumbprintInput = JSON.stringify({
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
    });
  } else {
    throw new Error(`Unsupported key type: ${jwk.kty}`);
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(thumbprintInput);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return base64url.encode(new Uint8Array(hashBuffer));
}

/**
 * Check if an SD-JWT VC is valid (type check only)
 */
export function isSDJWTVC(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length < 3) return false;

    // Decode header
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    return header.typ === 'dc+sd-jwt';
  } catch {
    return false;
  }
}

/**
 * Extract VCT from an SD-JWT VC without full verification
 */
export function extractVCT(token: string): string | null {
  try {
    const jwtPart = token.split(SD_JWT_SEPARATOR)[0];
    const payload = decodeJwt(jwtPart) as SDJWTVCPayload;
    return payload.vct || null;
  } catch {
    return null;
  }
}
