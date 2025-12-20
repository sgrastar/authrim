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
 * Array element disclosure marker per RFC 9901
 * Format: {"...": "<hash>"}
 */
export interface ArrayDisclosureMarker {
  '...': string;
}

/**
 * Nested selective disclosure path
 * Supports dot notation for nested claims (e.g., "address.street")
 */
export type SDClaimPath = string | { path: string; isArray?: boolean };

/**
 * Options for creating SD-JWT with nested/array disclosure
 */
export interface SDJWTAdvancedCreateOptions {
  /** Simple flat claims to make selectively disclosable */
  selectiveDisclosureClaims?: string[];

  /** Nested claim paths using dot notation (e.g., "address.street", "address.city") */
  nestedSelectiveDisclosureClaims?: string[];

  /** Array element disclosure - specify path and indices (e.g., { "nationalities": [0, 2] }) */
  arrayElementDisclosure?: Record<string, number[]>;

  /** Hash algorithm (default: sha-256) */
  hashAlgorithm?: 'sha-256';

  /** Add holder binding with JWK */
  holderBinding?: JWK;
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
// Helper: Disclosure Lookup Map
// =============================================================================

/**
 * Build a Map for O(1) disclosure lookup by hash
 *
 * This optimizes repeated lookups during verification/processing
 * from O(n) per lookup to O(1) per lookup.
 *
 * @param disclosures - Array of disclosures
 * @returns Map from hash to disclosure
 */
export function buildDisclosureMap(disclosures: SDJWTDisclosure[]): Map<string, SDJWTDisclosure> {
  const map = new Map<string, SDJWTDisclosure>();
  for (const disclosure of disclosures) {
    map.set(disclosure.hash, disclosure);
  }
  return map;
}

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
  // Supports both regular disclosures (3-element) and array element disclosures (2-element)
  const disclosures: SDJWTDisclosure[] = [];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '') continue; // Skip empty parts

    // Try regular disclosure first (3-element format)
    let disclosure = await decodeDisclosure(parts[i]);
    if (!disclosure) {
      // Try array element disclosure (2-element format)
      disclosure = await decodeArrayElementDisclosure(parts[i]);
    }
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

  // Build disclosure map for O(1) lookups
  const disclosureMap = buildDisclosureMap(disclosures);

  // Build hash set for O(1) existence check
  const sdHashSet = new Set(sdHashes);

  // Get existing claim names at payload level (excluding _sd and _sd_alg)
  const { _sd, _sd_alg, ...otherClaims } = sdPayload;
  const existingClaimNames = new Set(Object.keys(otherClaims));

  for (const hash of sdHashes) {
    const matchingDisclosure = disclosureMap.get(hash);
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
    if (!sdHashSet.has(disclosure.hash)) {
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

// =============================================================================
// Nested/Array Disclosure Functions (RFC 9901 Advanced)
// =============================================================================

/**
 * Create an array element disclosure
 *
 * Array elements use a different format: [salt, value] (no claim name)
 *
 * @param value - The array element value
 * @returns Disclosure object
 */
export async function createArrayElementDisclosure(value: unknown): Promise<SDJWTDisclosure> {
  const salt = generateSalt();

  // Array element disclosure format: [salt, value] (no claim name per RFC 9901)
  const disclosureArray = [salt, value];
  const disclosureJson = JSON.stringify(disclosureArray);
  const encoded = base64url.encode(new TextEncoder().encode(disclosureJson));

  const hash = await hashDisclosure(encoded);

  return {
    encoded,
    salt,
    claimName: '', // Empty for array elements
    claimValue: value,
    hash,
  };
}

/**
 * Decode an array element disclosure
 *
 * @param encoded - Base64url encoded disclosure
 * @returns Decoded disclosure or null if invalid
 */
export async function decodeArrayElementDisclosure(
  encoded: string
): Promise<SDJWTDisclosure | null> {
  try {
    const decoded = new TextDecoder().decode(base64url.decode(encoded));
    const disclosureArray = JSON.parse(decoded);

    if (!Array.isArray(disclosureArray)) {
      return null;
    }

    // Array element format: [salt, value] - 2 elements
    if (disclosureArray.length === 2) {
      const [salt, value] = disclosureArray;
      if (typeof salt !== 'string') {
        return null;
      }

      const hash = await hashDisclosure(encoded);

      return {
        encoded,
        salt,
        claimName: '', // Empty for array elements
        claimValue: value,
        hash,
      };
    }

    // Regular disclosure format: [salt, claim_name, value] - 3 elements
    if (disclosureArray.length === 3) {
      return decodeDisclosure(encoded);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if an object is an array disclosure marker
 *
 * @param obj - Object to check
 * @returns True if it's an array disclosure marker
 */
export function isArrayDisclosureMarker(obj: unknown): obj is ArrayDisclosureMarker {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const keys = Object.keys(obj);
  return (
    keys.length === 1 &&
    keys[0] === '...' &&
    typeof (obj as Record<string, unknown>)['...'] === 'string'
  );
}

/**
 * Process nested object for selective disclosure
 *
 * Recursively processes an object to add selective disclosure at nested levels.
 *
 * @param obj - Object to process
 * @param nestedPaths - Paths to make selectively disclosable (e.g., ["street", "city"])
 * @param disclosures - Array to collect disclosures
 * @returns Processed object with _sd array
 */
export async function processNestedObjectForSD(
  obj: Record<string, unknown>,
  nestedPaths: string[],
  disclosures: SDJWTDisclosure[]
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const sdHashes: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (nestedPaths.includes(key)) {
      // Make this claim selectively disclosable
      const disclosure = await createDisclosure(key, value);
      disclosures.push(disclosure);
      sdHashes.push(disclosure.hash);
    } else {
      result[key] = value;
    }
  }

  if (sdHashes.length > 0) {
    result._sd = sdHashes.sort();
  }

  return result;
}

/**
 * Process array for selective disclosure
 *
 * Replaces specified array elements with disclosure markers.
 *
 * @param arr - Array to process
 * @param indicesToHide - Indices to make selectively disclosable
 * @param disclosures - Array to collect disclosures
 * @returns Processed array with disclosure markers
 */
export async function processArrayForSD(
  arr: unknown[],
  indicesToHide: number[],
  disclosures: SDJWTDisclosure[]
): Promise<unknown[]> {
  const result: unknown[] = [];

  for (let i = 0; i < arr.length; i++) {
    if (indicesToHide.includes(i)) {
      // Create array element disclosure
      const disclosure = await createArrayElementDisclosure(arr[i]);
      disclosures.push(disclosure);

      // Add marker in place of the element
      result.push({ '...': disclosure.hash });
    } else {
      result.push(arr[i]);
    }
  }

  return result;
}

/**
 * Reconstruct array from disclosures
 *
 * Processes an array with disclosure markers and replaces them with actual values.
 * Accepts either a Map (O(1) lookups) or an array (O(n) lookups) for flexibility.
 *
 * @param arr - Array with potential disclosure markers
 * @param disclosures - Available disclosures (array or Map for O(1) lookups)
 * @returns Reconstructed array and count of undisclosed elements
 */
export function reconstructArrayFromDisclosures(
  arr: unknown[],
  disclosures: SDJWTDisclosure[] | Map<string, SDJWTDisclosure>
): { result: unknown[]; undisclosedCount: number } {
  const result: unknown[] = [];
  let undisclosedCount = 0;

  // Use Map for O(1) lookups if not already provided
  const disclosureMap = disclosures instanceof Map ? disclosures : buildDisclosureMap(disclosures);

  for (const element of arr) {
    if (isArrayDisclosureMarker(element)) {
      const hash = element['...'];
      const matchingDisclosure = disclosureMap.get(hash);

      if (matchingDisclosure) {
        result.push(matchingDisclosure.claimValue);
      } else {
        // Element not disclosed - skip it
        undisclosedCount++;
      }
    } else {
      result.push(element);
    }
  }

  return { result, undisclosedCount };
}

/**
 * Recursively process claims with nested _sd arrays
 *
 * Handles nested selective disclosure by walking through the object
 * and processing _sd arrays at each level.
 *
 * Uses Map for O(1) disclosure lookups instead of O(n) find().
 *
 * @param claims - Claims object (may contain nested _sd arrays)
 * @param disclosures - All available disclosures (array or Map for O(1) lookups)
 * @returns Processed claims with disclosed values and undisclosed count
 */
export function processNestedDisclosures(
  claims: Record<string, unknown>,
  disclosures: SDJWTDisclosure[] | Map<string, SDJWTDisclosure>
): { result: Record<string, unknown>; undisclosedCount: number } {
  const result: Record<string, unknown> = {};
  let totalUndisclosed = 0;

  // Use Map for O(1) lookups if not already provided
  const disclosureMap = disclosures instanceof Map ? disclosures : buildDisclosureMap(disclosures);

  // Get _sd array at this level
  const sdHashes = (claims._sd as string[]) || [];
  const existingClaimNames = new Set(
    Object.keys(claims).filter((k) => k !== '_sd' && k !== '_sd_alg')
  );

  // Process _sd array for disclosed claims at this level
  for (const hash of sdHashes) {
    const matchingDisclosure = disclosureMap.get(hash);
    if (matchingDisclosure) {
      if (matchingDisclosure.claimName && !existingClaimNames.has(matchingDisclosure.claimName)) {
        // Add disclosed claim
        let value = matchingDisclosure.claimValue;

        // Recursively process if value is an object with _sd
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          '_sd' in (value as object)
        ) {
          const nested = processNestedDisclosures(value as Record<string, unknown>, disclosureMap);
          value = nested.result;
          totalUndisclosed += nested.undisclosedCount;
        }

        // Process arrays with disclosure markers
        if (Array.isArray(value)) {
          const processed = reconstructArrayFromDisclosures(value, disclosureMap);
          value = processed.result;
          totalUndisclosed += processed.undisclosedCount;
        }

        result[matchingDisclosure.claimName] = value;
      }
    } else {
      totalUndisclosed++;
    }
  }

  // Process existing claims (non-_sd)
  for (const [key, value] of Object.entries(claims)) {
    if (key === '_sd' || key === '_sd_alg') {
      continue; // Skip SD-JWT metadata
    }

    if (key in result) {
      continue; // Already added from disclosure
    }

    let processedValue = value;

    // Recursively process nested objects with _sd
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const objValue = value as Record<string, unknown>;
      if ('_sd' in objValue) {
        const nested = processNestedDisclosures(objValue, disclosureMap);
        processedValue = nested.result;
        totalUndisclosed += nested.undisclosedCount;
      }
    }

    // Process arrays with disclosure markers
    if (Array.isArray(value)) {
      const processed = reconstructArrayFromDisclosures(value, disclosureMap);
      processedValue = processed.result;
      totalUndisclosed += processed.undisclosedCount;
    }

    result[key] = processedValue;
  }

  return { result, undisclosedCount: totalUndisclosed };
}

/**
 * Create SD-JWT with advanced nested/array disclosure support
 *
 * @param claims - All claims to include
 * @param privateKey - Private key for signing
 * @param kid - Key ID
 * @param options - Advanced SD-JWT creation options
 * @returns SD-JWT with disclosures
 */
export async function createAdvancedSDJWT(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
  options: SDJWTAdvancedCreateOptions
): Promise<SDJWT> {
  const {
    selectiveDisclosureClaims = [],
    nestedSelectiveDisclosureClaims = [],
    arrayElementDisclosure = {},
    hashAlgorithm = 'sha-256',
    holderBinding,
  } = options;

  const disclosures: SDJWTDisclosure[] = [];
  const sdHashes: string[] = [];
  const processedClaims: Record<string, unknown> = {};

  // Group nested paths by parent
  const nestedPathsByParent = new Map<string, string[]>();
  for (const path of nestedSelectiveDisclosureClaims) {
    const parts = path.split('.');
    if (parts.length === 2) {
      const [parent, child] = parts;
      if (!nestedPathsByParent.has(parent)) {
        nestedPathsByParent.set(parent, []);
      }
      nestedPathsByParent.get(parent)!.push(child);
    }
  }

  // Process each claim
  for (const [key, value] of Object.entries(claims)) {
    // Check if this is a flat selective disclosure claim
    if (selectiveDisclosureClaims.includes(key)) {
      const disclosure = await createDisclosure(key, value);
      disclosures.push(disclosure);
      sdHashes.push(disclosure.hash);
      continue;
    }

    // Check if this has nested selective disclosure
    if (
      nestedPathsByParent.has(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const nestedPaths = nestedPathsByParent.get(key)!;
      const processedNested = await processNestedObjectForSD(
        value as Record<string, unknown>,
        nestedPaths,
        disclosures
      );
      processedClaims[key] = processedNested;
      continue;
    }

    // Check if this is an array with element disclosure
    if (key in arrayElementDisclosure && Array.isArray(value)) {
      const indicesToHide = arrayElementDisclosure[key];
      const processedArray = await processArrayForSD(value, indicesToHide, disclosures);
      processedClaims[key] = processedArray;
      continue;
    }

    // Keep as regular claim
    processedClaims[key] = value;
  }

  // Build JWT payload
  const payload: SDJWTPayload = {
    ...processedClaims,
    _sd_alg: hashAlgorithm,
  };

  // Add top-level _sd if there are flat disclosures
  if (sdHashes.length > 0) {
    payload._sd = sdHashes.sort();
  }

  // Add holder binding
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
 * Verify SD-JWT with nested/array disclosure support
 *
 * @param combined - Combined SD-JWT string
 * @param publicKey - Public key for verification
 * @param issuer - Expected issuer
 * @param audience - Expected audience
 * @returns Verified SD-JWT with all disclosed claims (including nested)
 */
export async function verifyAdvancedSDJWT(
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

  // Process all disclosures including nested and array elements
  const { result: disclosedClaims, undisclosedCount } = processNestedDisclosures(
    sdPayload as Record<string, unknown>,
    disclosures
  );

  // Remove SD-JWT metadata from result
  delete (disclosedClaims as Record<string, unknown>)._sd;
  delete (disclosedClaims as Record<string, unknown>)._sd_alg;

  return {
    payload: sdPayload,
    disclosedClaims,
    disclosures,
    undisclosedCount,
  };
}
