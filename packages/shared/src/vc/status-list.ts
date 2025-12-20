/**
 * Status List 2021 Implementation
 *
 * Implements Token Status List (draft-ietf-oauth-status-list) for credential revocation.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-oauth-status-list/
 */

import { jwtVerify, importJWK } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import { safeFetch } from '../utils/url-security';

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
    bitstring: Uint8Array;
    fetchedAt: number;
    ttl: number;
  }
>();

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
  const {
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    forceRefresh = false,
    verifySignature = true,
    keyResolver,
  } = options;

  // Run periodic cache cleanup to prevent memory leaks
  cleanupExpiredCaches();

  // Check cache
  const cached = statusListCache.get(statusListUri);
  if (cached && !forceRefresh) {
    const age = Date.now() - cached.fetchedAt;
    if (age < cached.ttl) {
      return cached.bitstring;
    }
    // Delete expired entry immediately
    statusListCache.delete(statusListUri);
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

  let bitstring: Uint8Array;

  if (
    contentType.includes('application/statuslist+jwt') ||
    contentType.includes('application/jwt')
  ) {
    // Parse as JWT with signature verification
    const jwt = await response.text();
    bitstring = await parseStatusListJWT(jwt, { verifySignature, keyResolver });
  } else if (contentType.includes('application/json')) {
    // Parse as JSON-LD credential (no JWT signature to verify)
    const credential = (await response.json()) as StatusListCredential;
    bitstring = await decodeStatusList(credential.credentialSubject.encodedList);
  } else {
    // Try to parse as JWT first, then JSON
    const text = await response.text();
    if (text.split('.').length === 3) {
      bitstring = await parseStatusListJWT(text, { verifySignature, keyResolver });
    } else {
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

      bitstring = await decodeStatusList(credential.credentialSubject.encodedList);
    }
  }

  // Cache the result
  statusListCache.set(statusListUri, {
    bitstring,
    fetchedAt: Date.now(),
    ttl: cacheTtlMs,
  });

  return bitstring;
}

/**
 * Status List JWT payload types
 */
interface StatusListJWTPayload extends JWTPayload {
  /** New format (draft-ietf-oauth-status-list) */
  status_list?: {
    bits: number;
    lst: string; // Base64url encoded GZIP compressed bitstring
  };
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

/**
 * Parse a Status List JWT and extract the bitstring
 *
 * SECURITY: By default, this function verifies the JWT signature.
 * Signature verification ensures the status list hasn't been tampered with.
 *
 * @param jwt - The Status List JWT to parse
 * @param options - Parsing options
 * @returns Decoded bitstring
 * @throws Error if signature verification fails or format is invalid
 */
async function parseStatusListJWT(
  jwt: string,
  options: ParseStatusListJWTOptions = {}
): Promise<Uint8Array> {
  const { verifySignature = true, keyResolver } = options;

  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Status List JWT format');
  }

  // Parse header to get kid and alg
  const headerStr = decodeBase64UrlString(parts[0]);
  const header = JSON.parse(headerStr) as { alg: string; kid?: string };

  // Parse payload to get issuer
  const payloadStr = decodeBase64UrlString(parts[1]);
  const payload = JSON.parse(payloadStr) as StatusListJWTPayload;

  // Verify signature if required
  if (verifySignature) {
    const issuer = payload.iss || payload.sub;
    if (!issuer) {
      throw new Error('Status List JWT missing issuer (iss or sub claim)');
    }

    await verifyStatusListJWTSignature(jwt, issuer, header.kid, header.alg, keyResolver);
  }

  // New format (draft-ietf-oauth-status-list)
  if (payload.status_list?.lst) {
    return await decodeStatusList(payload.status_list.lst);
  }

  // Legacy VC format
  if (payload.vc?.credentialSubject?.encodedList) {
    return await decodeStatusList(payload.vc.credentialSubject.encodedList);
  }

  throw new Error('Invalid Status List JWT: no encoded list found');
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
    const key = 'kty' in publicKey ? await importJWK(publicKey as JWK, alg) : publicKey;

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
  const response = await safeFetch(jwksUri, {
    headers: { Accept: 'application/json' },
    requireHttps: true,
    timeoutMs: 10000,
    maxResponseSize: 256 * 1024, // 256 KB max for JWKS
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch issuer JWKS: HTTP ${response.status}`);
  }

  const text = await response.text();
  const jwks = JSON.parse(text) as JWKSResponse;

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
    throw new Error(`Key with kid '${kid}' not found in JWKS`);
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
 * Decode a base64url encoded, optionally GZIP compressed bitstring
 */
async function decodeStatusList(encodedList: string): Promise<Uint8Array> {
  // Decode base64url
  const decoded = Uint8Array.from(atob(encodedList.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0)
  );

  // Check for GZIP magic bytes (0x1f 0x8b)
  if (decoded.length >= 2 && decoded[0] === 0x1f && decoded[1] === 0x8b) {
    // Decompress GZIP
    try {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      // Write data and close
      await writer.write(decoded);
      await writer.close();

      const chunks: Uint8Array[] = [];
      let done = false;

      while (!done) {
        const result = await reader.read();
        if (result.value) {
          chunks.push(result.value);
        }
        done = result.done;
      }

      // Concatenate chunks
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const bitstring = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        bitstring.set(chunk, offset);
        offset += chunk.length;
      }

      return bitstring;
    } catch {
      // If GZIP decompression fails, return as-is
      return decoded;
    }
  }

  // Not GZIP compressed, return as-is
  return decoded;
}

/**
 * Get the status value at a specific index in the bitstring
 *
 * @param bitstring The decoded bitstring
 * @param index The index to check
 * @param bitsPerStatus Number of bits per status (default: 1)
 * @returns The status value at the index
 */
export function getStatusAtIndex(
  bitstring: Uint8Array,
  index: number,
  bitsPerStatus: number = 1
): number {
  // SECURITY: Validate index is a non-negative integer
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Index must be a non-negative integer, got: ${index}`);
  }

  if (bitsPerStatus !== 1 && bitsPerStatus !== 2 && bitsPerStatus !== 4 && bitsPerStatus !== 8) {
    throw new Error('bitsPerStatus must be 1, 2, 4, or 8');
  }

  const statusesPerByte = 8 / bitsPerStatus;
  const byteIndex = Math.floor(index / statusesPerByte);

  if (byteIndex >= bitstring.length) {
    throw new Error(
      `Index ${index} out of bounds (max: ${bitstring.length * statusesPerByte - 1})`
    );
  }

  const positionInByte = index % statusesPerByte;
  const byte = bitstring[byteIndex];

  // Extract the bits for this status
  // Bits are stored from most significant to least significant
  const shift = (statusesPerByte - 1 - positionInByte) * bitsPerStatus;
  const mask = (1 << bitsPerStatus) - 1;

  return (byte >> shift) & mask;
}

/**
 * Options for checking credential status
 */
export interface CheckStatusOptions extends StatusListFetchOptions {
  /** Bits per status value (default: 1) */
  bitsPerStatus?: number;
}

/**
 * Check if a credential is valid (not revoked/suspended)
 *
 * SECURITY: By default, this function verifies the Status List JWT signature.
 * This ensures the status list hasn't been tampered with (MITM protection).
 *
 * @param statusListUri URI to the status list
 * @param index Index in the status list
 * @param options Fetch and verification options
 * @returns true if valid, false if revoked/suspended
 * @throws Error if status list fetch or signature verification fails
 */
export async function checkCredentialStatus(
  statusListUri: string,
  index: number,
  options: CheckStatusOptions = {}
): Promise<boolean> {
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

  const { bitsPerStatus = 1, ...fetchOptions } = options;

  const bitstring = await fetchStatusList(statusListUri, fetchOptions);
  const status = getStatusAtIndex(bitstring, index, bitsPerStatus);

  // Status 0 = valid, any other value = invalid
  return status === StatusValue.VALID;
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
