/**
 * SD-JWT (Selective Disclosure JWT) Implementation
 *
 * Implements SD-JWT as specified in RFC 9901.
 * SD-JWT allows issuers to create JWTs where certain claims can be selectively
 * disclosed by the holder to verifiers.
 *
 * Key concepts:
 * - Issuer creates SD-JWT with hashed claims (_sd array)
 * - Holder receives SD-JWT + disclosures
 * - Holder presents SD-JWT + selected disclosures to verifier
 * - Verifier can only see disclosed claims
 *
 * Format: <JWT>~<Disclosure1>~<Disclosure2>~...~<DisclosureN>~
 *
 * @see https://www.rfc-editor.org/rfc/rfc9901.html
 */

import { SignJWT, jwtVerify, decodeJwt, base64url } from 'jose';
import type { JWTPayload, JWK } from 'jose';

// =============================================================================
// Types
// =============================================================================

/**
 * SD-JWT Disclosure
 * Format: base64url([salt, claim_name, claim_value])
 */
export interface SDJWTDisclosure {
  /** Base64url encoded disclosure */
  encoded: string;
  /** Salt used for hashing */
  salt: string;
  /** Claim name */
  claimName: string;
  /** Claim value */
  claimValue: unknown;
  /** SHA-256 hash of the disclosure */
  hash: string;
}

/**
 * SD-JWT with disclosures
 */
export interface SDJWT {
  /** The signed JWT containing _sd array */
  jwt: string;
  /** Array of disclosures */
  disclosures: SDJWTDisclosure[];
  /** Combined SD-JWT string (JWT~disclosure1~disclosure2~...~) */
  combined: string;
}

/**
 * SD-JWT Payload with selective disclosure metadata
 */
export interface SDJWTPayload extends JWTPayload {
  /** Array of disclosure hashes */
  _sd?: string[];
  /** Hash algorithm used (default: sha-256) */
  _sd_alg?: string;
  /** Confirmation claim for holder binding (optional) */
  cnf?: {
    jwk?: JWK;
    jkt?: string;
  };
}

/**
 * Verified SD-JWT result
 */
export interface VerifiedSDJWT {
  /** Original JWT payload */
  payload: SDJWTPayload;
  /** Disclosed claims (after processing disclosures) */
  disclosedClaims: Record<string, unknown>;
  /** All disclosure objects */
  disclosures: SDJWTDisclosure[];
  /** Claims that were not disclosed */
  undisclosedCount: number;
}

/**
 * Options for creating SD-JWT
 */
export interface SDJWTCreateOptions {
  /** Claims to make selectively disclosable */
  selectiveDisclosureClaims: string[];
  /** Hash algorithm (default: sha-256) */
  hashAlgorithm?: 'sha-256';
  /** Add holder binding with JWK */
  holderBinding?: JWK;
}

// =============================================================================
// Constants
// =============================================================================

/** SD-JWT disclosure separator */
export const SD_JWT_SEPARATOR = '~';

/** Default hash algorithm */
export const SD_JWT_DEFAULT_ALG = 'sha-256';

/** Salt length in bytes (128 bits as recommended by RFC 9901) */
const SALT_LENGTH = 16;

/** Reserved claim names that MUST NOT be used in disclosures (RFC 9901) */
const RESERVED_CLAIM_NAMES = ['_sd', '...'];

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Generate cryptographically secure salt
 */
function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  return base64url.encode(bytes);
}

/**
 * Calculate SHA-256 hash of disclosure
 */
async function hashDisclosure(disclosure: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(disclosure);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return base64url.encode(new Uint8Array(hashBuffer));
}

/**
 * Validate claim name per RFC 9901
 * Claim names MUST NOT be "_sd" or "..."
 */
function validateClaimName(claimName: string): void {
  if (RESERVED_CLAIM_NAMES.includes(claimName)) {
    throw new Error(
      `Claim name "${claimName}" is reserved and cannot be used in disclosures (RFC 9901)`
    );
  }
}

/**
 * Create a disclosure for a claim
 *
 * @param claimName - Name of the claim
 * @param claimValue - Value of the claim
 * @returns Disclosure object with encoded string and hash
 * @throws Error if claim name is reserved (_sd or ...)
 */
export async function createDisclosure(
  claimName: string,
  claimValue: unknown
): Promise<SDJWTDisclosure> {
  // RFC 9901: Claim names MUST NOT be "_sd" or "..."
  validateClaimName(claimName);

  const salt = generateSalt();

  // Disclosure format: [salt, claim_name, claim_value]
  const disclosureArray = [salt, claimName, claimValue];
  const disclosureJson = JSON.stringify(disclosureArray);
  const encoded = base64url.encode(new TextEncoder().encode(disclosureJson));

  const hash = await hashDisclosure(encoded);

  return {
    encoded,
    salt,
    claimName,
    claimValue,
    hash,
  };
}

/**
 * Decode a disclosure string
 *
 * @param encoded - Base64url encoded disclosure
 * @returns Decoded disclosure or null if invalid
 */
export async function decodeDisclosure(encoded: string): Promise<SDJWTDisclosure | null> {
  try {
    const decoded = new TextDecoder().decode(base64url.decode(encoded));
    const disclosureArray = JSON.parse(decoded);

    if (!Array.isArray(disclosureArray) || disclosureArray.length !== 3) {
      return null;
    }

    const [salt, claimName, claimValue] = disclosureArray;

    if (typeof salt !== 'string' || typeof claimName !== 'string') {
      return null;
    }

    // RFC 9901: Claim names MUST NOT be "_sd" or "..."
    if (RESERVED_CLAIM_NAMES.includes(claimName)) {
      return null;
    }

    const hash = await hashDisclosure(encoded);

    return {
      encoded,
      salt,
      claimName,
      claimValue,
      hash,
    };
  } catch {
    return null;
  }
}

/**
 * Create an SD-JWT from claims
 *
 * @param claims - All claims to include in the JWT
 * @param privateKey - Private key for signing
 * @param kid - Key ID
 * @param options - SD-JWT creation options
 * @returns SD-JWT with disclosures
 */
export async function createSDJWT(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
  options: SDJWTCreateOptions
): Promise<SDJWT> {
  const { selectiveDisclosureClaims, hashAlgorithm = 'sha-256', holderBinding } = options;

  const disclosures: SDJWTDisclosure[] = [];
  const sdHashes: string[] = [];
  const remainingClaims: Record<string, unknown> = {};

  // Separate selective disclosure claims from regular claims
  for (const [key, value] of Object.entries(claims)) {
    if (selectiveDisclosureClaims.includes(key)) {
      // Create disclosure for this claim
      const disclosure = await createDisclosure(key, value);
      disclosures.push(disclosure);
      sdHashes.push(disclosure.hash);
    } else {
      // Keep as regular claim
      remainingClaims[key] = value;
    }
  }

  // Build JWT payload with _sd array
  const payload: SDJWTPayload = {
    ...remainingClaims,
    _sd_alg: hashAlgorithm,
  };

  // Only add _sd if there are selective disclosure claims
  if (sdHashes.length > 0) {
    // Sort hashes for consistency (recommended by spec)
    payload._sd = sdHashes.sort();
  }

  // Add holder binding if provided
  if (holderBinding) {
    payload.cnf = { jwk: holderBinding };
  }

  // Sign the JWT
  const jwt = await new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'RS256', typ: 'sd+jwt', kid })
    .sign(privateKey);

  // Combine JWT and disclosures
  const disclosureStrings = disclosures.map((d) => d.encoded);
  const combined = [jwt, ...disclosureStrings, ''].join(SD_JWT_SEPARATOR);

  return {
    jwt,
    disclosures,
    combined,
  };
}

/**
 * Create SD-JWT for ID Token
 *
 * Convenience function that handles standard OIDC claims appropriately.
 * Required claims (iss, sub, aud, exp, iat) are never made selective.
 *
 * @param claims - ID Token claims
 * @param privateKey - Private key for signing
 * @param kid - Key ID
 * @param selectiveClaims - Claims to make selectively disclosable
 * @returns SD-JWT
 */
export async function createSDJWTIDToken(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
  selectiveClaims: string[] = ['email', 'phone_number', 'address', 'birthdate']
): Promise<SDJWT> {
  // Required OIDC claims that must not be selective
  const requiredClaims = ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'auth_time', 'acr', 'amr'];

  // Filter out required claims from selective disclosure
  const allowedSelectiveClaims = selectiveClaims.filter(
    (claim) => !requiredClaims.includes(claim) && claim in claims
  );

  return createSDJWT(claims, privateKey, kid, {
    selectiveDisclosureClaims: allowedSelectiveClaims,
  });
}

/**
 * Parse an SD-JWT combined string
 *
 * @param combined - Combined SD-JWT string (JWT~disclosure1~...~)
 * @returns Parsed JWT and disclosures
 */
export async function parseSDJWT(
  combined: string
): Promise<{ jwt: string; disclosures: SDJWTDisclosure[] } | null> {
  const parts = combined.split(SD_JWT_SEPARATOR);

  if (parts.length < 2) {
    return null;
  }

  const jwt = parts[0];

  // Parse disclosures (skip JWT and trailing empty string)
  const disclosures: SDJWTDisclosure[] = [];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '') continue; // Skip empty parts

    const disclosure = await decodeDisclosure(parts[i]);
    if (disclosure) {
      disclosures.push(disclosure);
    }
  }

  return { jwt, disclosures };
}

/**
 * Verify an SD-JWT and extract disclosed claims
 *
 * @param combined - Combined SD-JWT string
 * @param publicKey - Public key for verification
 * @param issuer - Expected issuer
 * @param audience - Expected audience
 * @returns Verified SD-JWT with disclosed claims
 */
export async function verifySDJWT(
  combined: string,
  publicKey: CryptoKey,
  issuer: string,
  audience: string
): Promise<VerifiedSDJWT> {
  // Parse the SD-JWT
  const parsed = await parseSDJWT(combined);
  if (!parsed) {
    throw new Error('Invalid SD-JWT format');
  }

  const { jwt, disclosures } = parsed;

  // Verify the JWT signature
  const { payload } = await jwtVerify(jwt, publicKey, {
    issuer,
    audience,
  });

  const sdPayload = payload as SDJWTPayload;

  // Build disclosed claims map
  const disclosedClaims: Record<string, unknown> = {};

  // Verify disclosures match _sd hashes
  const sdHashes = sdPayload._sd || [];
  let undisclosedCount = 0;

  // Get existing claim names at payload level (excluding _sd and _sd_alg)
  const { _sd, _sd_alg, ...otherClaims } = sdPayload;
  const existingClaimNames = new Set(Object.keys(otherClaims));

  for (const hash of sdHashes) {
    const matchingDisclosure = disclosures.find((d) => d.hash === hash);
    if (matchingDisclosure) {
      // RFC 9901: If the claim name already exists at the level of the _sd key, reject
      if (existingClaimNames.has(matchingDisclosure.claimName)) {
        throw new Error(
          `Duplicate claim name "${matchingDisclosure.claimName}": disclosure claim conflicts with existing payload claim (RFC 9901)`
        );
      }
      disclosedClaims[matchingDisclosure.claimName] = matchingDisclosure.claimValue;
    } else {
      undisclosedCount++;
    }
  }

  // Check for invalid disclosures (not in _sd array)
  for (const disclosure of disclosures) {
    if (!sdHashes.includes(disclosure.hash)) {
      throw new Error(`Invalid disclosure: hash ${disclosure.hash} not found in _sd array`);
    }
  }

  // Merge with non-selective claims
  const allDisclosedClaims = { ...otherClaims, ...disclosedClaims };

  return {
    payload: sdPayload,
    disclosedClaims: allDisclosedClaims,
    disclosures,
    undisclosedCount,
  };
}

/**
 * Create a presentation from SD-JWT with selected disclosures
 *
 * Allows holder to choose which claims to disclose.
 *
 * @param sdJwt - Original SD-JWT
 * @param claimsToDisclose - Names of claims to include in presentation
 * @returns New combined SD-JWT string with only selected disclosures
 */
export function createPresentation(sdJwt: SDJWT, claimsToDisclose: string[]): string {
  const selectedDisclosures = sdJwt.disclosures.filter((d) =>
    claimsToDisclose.includes(d.claimName)
  );

  const disclosureStrings = selectedDisclosures.map((d) => d.encoded);
  return [sdJwt.jwt, ...disclosureStrings, ''].join(SD_JWT_SEPARATOR);
}

/**
 * Check if a JWT is an SD-JWT
 *
 * @param token - JWT or SD-JWT string
 * @returns True if the token is an SD-JWT
 */
export function isSDJWT(token: string): boolean {
  // Check if it contains the separator
  if (token.includes(SD_JWT_SEPARATOR)) {
    return true;
  }

  // Check JWT header for sd+jwt type
  try {
    const payload = decodeJwt(token);
    return '_sd' in payload || '_sd_alg' in payload;
  } catch {
    return false;
  }
}

/**
 * Get the JWT part from an SD-JWT (strips disclosures)
 *
 * @param sdJwtOrJwt - SD-JWT combined string or regular JWT
 * @returns The JWT part only
 */
export function getJWTFromSDJWT(sdJwtOrJwt: string): string {
  const separatorIndex = sdJwtOrJwt.indexOf(SD_JWT_SEPARATOR);
  if (separatorIndex === -1) {
    return sdJwtOrJwt;
  }
  return sdJwtOrJwt.substring(0, separatorIndex);
}
