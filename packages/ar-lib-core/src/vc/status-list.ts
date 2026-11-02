/**
 * Status List 2021 Implementation
 *
 * Implements Token Status List (draft-ietf-oauth-status-list) for credential revocation.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/
 */

import { jwtVerify, importJWK } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import { readResponseTextWithLimit, safeFetch, safeFetchJson } from '../utils/url-security';
import {
  IETF_TSL_FORMAT,
  W3C_BITSTRING_FORMAT,
  bitOrderForFormat,
  decodeStatusListBytes,
  isValidStatusBits,
  readStatusEntry,
  type StatusListBitOrder,
  type StatusListFormat,
} from './status-list-codec';

/**
 * Decode base64url to string
 * Local implementation to avoid module resolution issues in test environments
 */
function decodeBase64UrlString(base64url: string): string {
  // Convert base64url to base64
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return atob(padded);
}

/**
 * Status List credential structure
 */
export interface StatusListCredential {
  /** Credential type */
  type: string[];

  /** Issuer identifier */
  issuer: string;

  /** Issuance date */
  validFrom: string;

  /** Credential subject with encoded list */
  credentialSubject: {
    id: string;
    type: 'StatusList2021';
    statusPurpose: 'revocation' | 'suspension';
    encodedList: string; // Base64url encoded GZIP compressed bitstring
  };
}

/**
 * Status values
 */
export enum StatusValue {
  VALID = 0,
  INVALID = 1,
}

/**
 * JWKS response structure
 */
interface JWKSResponse {
  keys: JWK[];
}

/**
 * Key resolver function type
 * Used to get the issuer's public key for signature verification
 */
export type StatusListKeyResolver = (issuerUri: string, kid?: string) => Promise<CryptoKey | JWK>;

/**
 * Cache for status lists
 */
const statusListCache = new Map<
  string,
  {
    list: DecodedStatusList;
    fetchedAt: number;
    ttl: number;
    signatureVerified: boolean;
  }
>();

/**
 * A decoded status list with what the token declared about itself. Cache entries keep all of it so
 * every hit can be checked against what the credential expects.
 */
export interface DecodedStatusList {
  bitstring: Uint8Array;
  /** Bits per entry (1 for W3C lists) */
  bits: number;
  format: StatusListFormat;
  /** Verified `iss` of a Token Status List */
  issuer?: string;
  /** `sub` of a Token Status List (must equal the referenced URI) */
  subject?: string;
  /** Token expiry, epoch ms */
  expiresAtMs?: number;
  /** Token `ttl` (how often to re-fetch), ms */
  ttlMs?: number;
}

/**
 * Cache for issuer JWKS
 */
const issuerJwksCache = new Map<
  string,
  {
    keys: JWK[];
    fetchedAt: number;
    ttl: number;
  }
>();

/** Default cache TTL: 5 minutes */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Default JWKS cache TTL: 1 hour */
const DEFAULT_JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

/** Maximum cache size (LRU eviction threshold) */
const MAX_CACHE_SIZE = 1000;

/** Last cleanup timestamp */
let lastCleanupTime = 0;

/** Cleanup interval: 1 minute */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * Clean up expired cache entries to prevent memory leaks
 * Uses LRU eviction when cache exceeds maximum size
 */
function cleanupExpiredCaches(): void {
  const now = Date.now();

  // Only run cleanup if enough time has passed
  if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanupTime = now;

  // Clean expired entries from status list cache
  for (const [key, entry] of statusListCache.entries()) {
    if (now - entry.fetchedAt > entry.ttl) {
      statusListCache.delete(key);
    }
  }

  // Clean expired entries from JWKS cache
  for (const [key, entry] of issuerJwksCache.entries()) {
    if (now - entry.fetchedAt > entry.ttl) {
      issuerJwksCache.delete(key);
    }
  }

  // LRU eviction if cache is too large (keep newest entries)
  if (statusListCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(statusListCache.entries()).sort(
      (a, b) => b[1].fetchedAt - a[1].fetchedAt
    );
    const toKeep = entries.slice(0, MAX_CACHE_SIZE);
    statusListCache.clear();
    for (const [key, value] of toKeep) {
      statusListCache.set(key, value);
    }
  }

  if (issuerJwksCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(issuerJwksCache.entries()).sort(
      (a, b) => b[1].fetchedAt - a[1].fetchedAt
    );
    const toKeep = entries.slice(0, MAX_CACHE_SIZE);
    issuerJwksCache.clear();
    for (const [key, value] of toKeep) {
      issuerJwksCache.set(key, value);
    }
  }
}

/**
 * Clear all caches (for testing or manual cleanup)
 */
export function clearStatusListCaches(): void {
  statusListCache.clear();
  issuerJwksCache.clear();
}

/**
 * Options for fetching status lists
 */
export interface StatusListFetchOptions {
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs?: number;
  /** Force refresh even if cached */
  forceRefresh?: boolean;
  /**
   * Verify JWT signature (default: true for security)
   * IMPORTANT: Set to false ONLY when the Status List is self-issued or
   * the issuer key is not available (e.g., testing environments)
   */
  verifySignature?: boolean;
  /**
   * Custom key resolver for signature verification
   * If not provided, the default resolver will fetch JWKS from the issuer
   */
  keyResolver?: StatusListKeyResolver;
  /**
   * Format the credential's signed status claim declares (default: W3C Bitstring). Token Status
   * Lists are read only when the credential says so; there is no fallback between formats.
   */
  format?: StatusListFormat;
  /**
   * Issuer the credential declares. A Token Status List's verified `iss` must equal it; checked
   * again on every cache hit.
   */
  expectedIssuer?: string;
}

/**
 * Fetch and decode a status list
 *
 * @param statusListUri - URI to the status list credential
 * @param options - Fetch options including signature verification settings
 * @returns Decoded bitstring
 * @throws Error if fetch fails, signature verification fails, or format is invalid
 */
export async function fetchStatusList(
  statusListUri: string,
  options: StatusListFetchOptions = {}
): Promise<Uint8Array> {
  return (await fetchDecodedStatusList(statusListUri, options)).bitstring;
}

/** Cached lists are only reused for the same format and only while their own expiry allows. */
function statusListCacheKey(format: StatusListFormat, uri: string): string {
  return `${format}\n${uri}`;
}

/**
 * Check a decoded list against what the credential expects. Run on fresh fetches and on every
 * cache hit so a cached list can never answer for a different issuer, subject or format.
 */
function assertStatusListExpectations(
  list: DecodedStatusList,
  uri: string,
  format: StatusListFormat,
  expectedIssuer: string | undefined,
  now: number
): void {
  if (list.format !== format) throw new Error('Status list format mismatch');
  if (format === IETF_TSL_FORMAT && list.subject !== uri) {
    throw new Error('Status list subject does not match its URI');
  }
  // Both formats: the verified issuer and the token expiry are rechecked on every cache hit.
  if (expectedIssuer !== undefined && list.issuer !== expectedIssuer) {
    throw new Error('Status list issuer does not match the credential issuer');
  }
  if (list.expiresAtMs !== undefined && list.expiresAtMs <= now) {
    throw new Error('Status list token has expired');
  }
}

/**
 * Fetch, verify and decode a status list, keeping the bits per entry and the token's claims.
 */
export async function fetchDecodedStatusList(
  statusListUri: string,
  options: StatusListFetchOptions = {}
): Promise<DecodedStatusList> {
  const {
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    forceRefresh = false,
    verifySignature = true,
    keyResolver,
    format = W3C_BITSTRING_FORMAT,
    expectedIssuer,
  } = options;

  // Run periodic cache cleanup to prevent memory leaks
  cleanupExpiredCaches();

  const cacheKey = statusListCacheKey(format, statusListUri);
  const cached = statusListCache.get(cacheKey);
  if (cached && !forceRefresh) {
    const now = Date.now();
    const expired =
      now - cached.fetchedAt >= cached.ttl ||
      (cached.list.expiresAtMs !== undefined && cached.list.expiresAtMs <= now);
    // An unverified entry never answers a request that requires a verified signature.
    if (!expired && (cached.signatureVerified || !verifySignature)) {
      assertStatusListExpectations(cached.list, statusListUri, format, expectedIssuer, now);
      return cached.list;
    }
    statusListCache.delete(cacheKey);
  }

  // Fetch status list with SSRF protection, timeout, and response size limits
  const response = await safeFetch(statusListUri, {
    headers: {
      Accept: 'application/statuslist+jwt, application/jwt',
    },
    requireHttps: true,
    timeoutMs: 10000,
    maxResponseSize: 2 * 1024 * 1024, // 2 MB max for status lists (can be large)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch status list: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let list: DecodedStatusList;

  if (format === IETF_TSL_FORMAT) {
    // The content type is not evidence of anything: the token's own checks decide.
    const jwt = await readResponseTextWithLimit(response, 2 * 1024 * 1024);
    list = await parseTokenStatusListJWT(jwt, statusListUri, {
      verifySignature,
      keyResolver,
      expectedIssuer,
    });
  } else if (
    contentType.includes('application/statuslist+jwt') ||
    contentType.includes('application/jwt')
  ) {
    // Parse as JWT with signature verification
    const jwt = await readResponseTextWithLimit(response, 2 * 1024 * 1024);
    list = await parseStatusListJWT(jwt, { verifySignature, keyResolver });
  } else if (contentType.includes('application/json')) {
    // A JSON-LD credential carries no signature this reader can verify.
    if (verifySignature) throw new Error('Unsigned status list cannot be verified');
    const credential = JSON.parse(
      await readResponseTextWithLimit(response, 2 * 1024 * 1024)
    ) as StatusListCredential;
    list = await decodeLegacyList(credential.credentialSubject.encodedList);
  } else {
    // Try to parse as JWT first, then JSON
    const text = await readResponseTextWithLimit(response, 2 * 1024 * 1024);
    if (text.split('.').length === 3) {
      list = await parseStatusListJWT(text, { verifySignature, keyResolver });
    } else {
      if (verifySignature) throw new Error('Unsigned status list cannot be verified');
      // SECURITY: Handle JSON parse errors consistently with explicit error message
      let credential: StatusListCredential;
      try {
        credential = JSON.parse(text) as StatusListCredential;
      } catch {
        throw new Error(
          'Invalid Status List format: response is neither a valid JWT nor valid JSON'
        );
      }

      // Validate required fields before accessing
      if (!credential.credentialSubject?.encodedList) {
        throw new Error('Invalid Status List credential: missing credentialSubject.encodedList');
      }

      list = await decodeLegacyList(credential.credentialSubject.encodedList);
    }
  }

  const now = Date.now();
  assertStatusListExpectations(list, statusListUri, format, expectedIssuer, now);

  // Cache for min(configured TTL, token ttl, time to token expiry)
  let ttl = cacheTtlMs;
  if (list.ttlMs !== undefined) ttl = Math.min(ttl, list.ttlMs);
  if (list.expiresAtMs !== undefined) ttl = Math.min(ttl, list.expiresAtMs - now);
  if (ttl > 0) {
    statusListCache.set(cacheKey, {
      list,
      fetchedAt: now,
      ttl,
      signatureVerified: verifySignature,
    });
  }

  return list;
}

/**
 * Status List JWT payload types
 */
interface StatusListJWTPayload extends JWTPayload {
  /** New format (draft-ietf-oauth-status-list) */
  status_list?: {
    bits: number;
    lst: string; // Base64url encoded compressed bitstring
  };
  /** Token Status List refresh hint, seconds */
  ttl?: unknown;
  /** Legacy VC format */
  sub?: string;
  vc?: StatusListCredential;
}

/**
 * Options for parsing Status List JWT
 */
interface ParseStatusListJWTOptions {
  verifySignature?: boolean;
  keyResolver?: StatusListKeyResolver;
}

function parseJwtParts(jwt: string): {
  header: { alg: string; kid?: string; typ?: string };
  payload: StatusListJWTPayload;
} {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Status List JWT format');
  }
  return {
    header: JSON.parse(decodeBase64UrlString(parts[0])) as {
      alg: string;
      kid?: string;
      typ?: string;
    },
    payload: JSON.parse(decodeBase64UrlString(parts[1])) as StatusListJWTPayload,
  };
}

/** Decode a W3C-format list (gzip, MSB-first, one bit per entry). */
async function decodeLegacyList(
  encoded: string,
  claims: { issuer?: string; expiresAtMs?: number } = {}
): Promise<DecodedStatusList> {
  return {
    bitstring: await decodeStatusListBytes(encoded, W3C_BITSTRING_FORMAT),
    bits: 1,
    format: W3C_BITSTRING_FORMAT,
    ...(claims.issuer !== undefined ? { issuer: claims.issuer } : {}),
    ...(claims.expiresAtMs !== undefined ? { expiresAtMs: claims.expiresAtMs } : {}),
  };
}

/**
 * Parse a W3C-format Status List JWT and extract the bitstring
 *
 * SECURITY: By default, this function verifies the JWT signature.
 * Signature verification ensures the status list hasn't been tampered with.
 *
 * @param jwt - The Status List JWT to parse
 * @param options - Parsing options
 * @returns Decoded list
 * @throws Error if signature verification fails or format is invalid
 */
async function parseStatusListJWT(
  jwt: string,
  options: ParseStatusListJWTOptions = {}
): Promise<DecodedStatusList> {
  const { verifySignature = true, keyResolver } = options;
  const { header, payload } = parseJwtParts(jwt);

  const issuer = payload.iss || payload.sub;
  // Verify signature if required
  if (verifySignature) {
    if (!issuer) {
      throw new Error('Status List JWT missing issuer (iss or sub claim)');
    }

    await verifyStatusListJWTSignature(jwt, issuer, header.kid, header.alg, keyResolver);
  }

  // A credential that declared a W3C status never accepts a Token Status List payload: the two
  // use different compression and bit order, and must not be read with each other's decoder.
  if (payload.status_list !== undefined) {
    throw new Error('Status list format mismatch');
  }

  if (payload.vc?.credentialSubject?.encodedList) {
    return decodeLegacyList(payload.vc.credentialSubject.encodedList, {
      // Only claims that the verified signature covers are kept for later cache checks.
      ...(verifySignature && typeof issuer === 'string' ? { issuer } : {}),
      ...(typeof payload.exp === 'number' ? { expiresAtMs: payload.exp * 1000 } : {}),
    });
  }

  throw new Error('Invalid Status List JWT: no encoded list found');
}

/**
 * Parse a Token Status List token (draft-14): `statuslist+jwt` header type, `sub` equal to the
 * referenced URI, `iat` and `status_list` present with the right types, a positive `ttl` when
 * present, `bits` in {1, 2, 4, 8}, and a zlib/LSB-first list.
 */
async function parseTokenStatusListJWT(
  jwt: string,
  statusListUri: string,
  options: ParseStatusListJWTOptions & { expectedIssuer?: string }
): Promise<DecodedStatusList> {
  const { verifySignature = true, keyResolver, expectedIssuer } = options;
  const { header, payload } = parseJwtParts(jwt);

  if (header.typ !== 'statuslist+jwt') throw new Error('Status List token type mismatch');
  if (typeof header.alg !== 'string' || header.alg === 'none') {
    throw new Error('Status List token algorithm is not allowed');
  }
  if (typeof payload.sub !== 'string' || payload.sub !== statusListUri) {
    throw new Error('Status List token subject does not match its URI');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new Error('Status List token iat is missing');
  }
  if (
    payload.exp !== undefined &&
    (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))
  ) {
    throw new Error('Status List token exp is malformed');
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
    throw new Error('Status List token has expired');
  }
  if (
    payload.ttl !== undefined &&
    (typeof payload.ttl !== 'number' || !Number.isFinite(payload.ttl) || payload.ttl <= 0)
  ) {
    throw new Error('Status List token ttl is malformed');
  }
  const statusList = payload.status_list;
  if (
    !statusList ||
    typeof statusList !== 'object' ||
    typeof statusList.lst !== 'string' ||
    !isValidStatusBits(statusList.bits)
  ) {
    throw new Error('Status List token status_list is malformed');
  }
  if (typeof payload.iss !== 'string' || payload.iss.length === 0) {
    throw new Error('Status List token missing issuer');
  }
  if (expectedIssuer !== undefined && payload.iss !== expectedIssuer) {
    throw new Error('Status List token issuer does not match the credential issuer');
  }

  if (verifySignature) {
    await verifyStatusListJWTSignature(jwt, payload.iss, header.kid, header.alg, keyResolver);
  }

  return {
    bitstring: await decodeStatusListBytes(statusList.lst, IETF_TSL_FORMAT),
    bits: statusList.bits,
    format: IETF_TSL_FORMAT,
    issuer: payload.iss,
    subject: payload.sub,
    expiresAtMs: typeof payload.exp === 'number' ? payload.exp * 1000 : undefined,
    ttlMs: typeof payload.ttl === 'number' ? payload.ttl * 1000 : undefined,
  };
}

/**
 * Verify Status List JWT signature
 *
 * @param jwt - The JWT to verify
 * @param issuer - The issuer identifier (DID or URL)
 * @param kid - The key ID from the JWT header
 * @param alg - The algorithm from the JWT header
 * @param keyResolver - Optional custom key resolver
 * @throws Error if verification fails
 */
async function verifyStatusListJWTSignature(
  jwt: string,
  issuer: string,
  kid: string | undefined,
  alg: string,
  keyResolver?: StatusListKeyResolver
): Promise<void> {
  let publicKey: CryptoKey | JWK;

  if (keyResolver) {
    // Use custom key resolver
    publicKey = await keyResolver(issuer, kid);
  } else {
    // Use default JWKS resolver
    publicKey = await fetchIssuerKey(issuer, kid, alg);
  }

  try {
    // Convert JWK to CryptoKey if needed
    const key = 'kty' in publicKey ? await importJWK(publicKey, alg) : publicKey;

    // Verify the JWT signature
    await jwtVerify(jwt, key, {
      algorithms: [alg],
    });
  } catch (error) {
    throw new Error(
      `Status List JWT signature verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Fetch issuer's public key from JWKS endpoint
 *
 * @param issuer - The issuer identifier (URL or DID)
 * @param kid - The key ID to find
 * @param alg - The expected algorithm
 * @returns The public key as JWK
 */
async function fetchIssuerKey(issuer: string, kid: string | undefined, alg: string): Promise<JWK> {
  // Derive JWKS URI from issuer
  let jwksUri: string;

  if (issuer.startsWith('did:web:')) {
    // did:web:example.com → https://example.com/.well-known/jwks.json
    const domain = issuer.replace('did:web:', '').split(':')[0];
    jwksUri = `https://${domain}/.well-known/jwks.json`;
  } else if (issuer.startsWith('did:')) {
    // Other DID methods - try to resolve DID document
    throw new Error(
      `DID method not supported for automatic key resolution: ${issuer.split(':')[1]}`
    );
  } else {
    // Assume HTTPS URL issuer → try .well-known/jwks.json
    const issuerUrl = new URL(issuer);
    jwksUri = `${issuerUrl.origin}/.well-known/jwks.json`;
  }

  // Check JWKS cache
  const cached = issuerJwksCache.get(jwksUri);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < cached.ttl) {
      return findKeyInJWKS(cached.keys, kid, alg);
    }
    // Delete expired entry immediately
    issuerJwksCache.delete(jwksUri);
  }

  // Fetch JWKS with SSRF protection, timeout, and response size limits
  const jwks = await safeFetchJson<JWKSResponse>(jwksUri, {
    headers: { Accept: 'application/json' },
    requireHttps: true,
    timeoutMs: 10000,
    maxResponseSize: 256 * 1024, // 256 KB max for JWKS
  });

  // Cache JWKS
  issuerJwksCache.set(jwksUri, {
    keys: jwks.keys,
    fetchedAt: Date.now(),
    ttl: DEFAULT_JWKS_CACHE_TTL_MS,
  });

  return findKeyInJWKS(jwks.keys, kid, alg);
}

/**
 * Find a key in JWKS by kid and algorithm
 */
function findKeyInJWKS(keys: JWK[], kid: string | undefined, alg: string): JWK {
  // If kid is specified, find exact match
  if (kid) {
    const key = keys.find((k) => k.kid === kid);
    if (key) {
      return key;
    }
    // SECURITY: Do not expose kid value in error to prevent key enumeration
    throw new Error('Key verification failed');
  }

  // Otherwise, find a key matching the algorithm
  const algToKty: Record<string, string> = {
    ES256: 'EC',
    ES384: 'EC',
    ES512: 'EC',
    RS256: 'RSA',
    RS384: 'RSA',
    RS512: 'RSA',
  };

  const expectedKty = algToKty[alg];
  const key = keys.find((k) => k.kty === expectedKty && (!k.use || k.use === 'sig'));

  if (!key) {
    throw new Error(`No suitable signing key found for algorithm '${alg}'`);
  }

  return key;
}

/**
 * Get the status value at a specific index in the bitstring
 *
 * @param bitstring The decoded bitstring
 * @param index The index to check
 * @param bitsPerStatus Number of bits per status (default: 1)
 * @param bitOrder Entry order inside a byte: 'msb' for W3C lists (default), 'lsb' for Token
 *   Status Lists
 * @returns The status value at the index
 */
export function getStatusAtIndex(
  bitstring: Uint8Array,
  index: number,
  bitsPerStatus: number = 1,
  bitOrder: StatusListBitOrder = 'msb'
): number {
  return readStatusEntry(bitstring, index, bitsPerStatus, bitOrder);
}

/**
 * Options for checking credential status
 */
export interface CheckStatusOptions extends StatusListFetchOptions {
  /** Bits per status value; defaults to what the status list declares (1 for W3C lists) */
  bitsPerStatus?: number;
}

/**
 * Read the status value of a credential from its status list.
 *
 * SECURITY: By default, this function verifies the Status List JWT signature.
 * This ensures the status list hasn't been tampered with (MITM protection).
 *
 * @param statusListUri URI to the status list
 * @param index Index in the status list
 * @param options Fetch and verification options
 * @returns The status value (0 = valid; any other value is not usable)
 * @throws Error if the status list can't be fetched or validated, or the index is out of range
 */
export async function getCredentialStatusValue(
  statusListUri: string,
  index: number,
  options: CheckStatusOptions = {}
): Promise<number> {
  // SECURITY: Validate index early before expensive fetch operation
  // This prevents DoS via malformed index values
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid status list index: must be a non-negative integer, got: ${index}`);
  }

  // Reasonable upper bound to prevent memory issues (16MB status list = 128M entries max)
  const MAX_STATUS_LIST_INDEX = 134217728; // 2^27
  if (index > MAX_STATUS_LIST_INDEX) {
    throw new Error(
      `Status list index ${index} exceeds maximum allowed value ${MAX_STATUS_LIST_INDEX}`
    );
  }

  const { bitsPerStatus, ...fetchOptions } = options;

  const list = await fetchDecodedStatusList(statusListUri, fetchOptions);
  return getStatusAtIndex(
    list.bitstring,
    index,
    bitsPerStatus ?? list.bits,
    bitOrderForFormat(list.format)
  );
}

/**
 * Check if a credential is valid (not revoked/suspended)
 *
 * @returns true if valid (status 0), false for any other status or an index outside the list
 * @throws Error if status list fetch or signature verification fails
 */
export async function checkCredentialStatus(
  statusListUri: string,
  index: number,
  options: CheckStatusOptions = {}
): Promise<boolean> {
  try {
    return (await getCredentialStatusValue(statusListUri, index, options)) === StatusValue.VALID;
  } catch (error) {
    if (error instanceof Error && error.message.includes('out of bounds')) return false;
    throw error;
  }
}

/**
 * Clear the status list cache
 */
export function clearStatusListCache(): void {
  statusListCache.clear();
}

/**
 * Clear the issuer JWKS cache
 */
export function clearIssuerJwksCache(): void {
  issuerJwksCache.clear();
}

/**
 * Clear all status list related caches
 */
export function clearAllStatusListCaches(): void {
  statusListCache.clear();
  issuerJwksCache.clear();
}

/**
 * Get cache statistics
 */
export function getStatusListCacheStats(): { size: number; entries: string[] } {
  return {
    size: statusListCache.size,
    entries: Array.from(statusListCache.keys()),
  };
}
