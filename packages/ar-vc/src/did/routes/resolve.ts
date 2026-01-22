/**
 * DID Resolution Route
 *
 * Resolves DIDs (did:web, did:key).
 *
 * Supports DID Core 1.0 compliant resolution with full multicodec support:
 * - Ed25519 (0xed01)
 * - P-256 (0x1200)
 * - P-384 (0x1201)
 * - P-521 (0x1202)
 * - secp256k1 (0xe7)
 *
 * @see https://www.w3.org/TR/did-core/
 * @see https://w3c-ccg.github.io/did-method-key/
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import {
  parseDID,
  didWebToUrl,
  isValidDID,
  D1Adapter,
  DIDDocumentCacheRepository,
  safeFetch,
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';

const standaloneLog = createLogger().module('VC-DID-RESOLVER');

/**
 * Multicodec identifiers for supported key types
 * @see https://github.com/multiformats/multicodec/blob/master/table.csv
 */
const MULTICODEC = {
  ED25519_PUB: 0xed, // ed25519-pub (0xed)
  P256_PUB: 0x1200, // p256-pub
  P384_PUB: 0x1201, // p384-pub
  P521_PUB: 0x1202, // p521-pub
  SECP256K1_PUB: 0xe7, // secp256k1-pub
} as const;

/**
 * Curve parameters for EC key decompression
 */
const CURVE_PARAMS: Record<string, { p: bigint; a: bigint; b: bigint; coordSize: number }> = {
  'P-256': {
    p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
    a: BigInt('0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc'),
    b: BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b'),
    coordSize: 32,
  },
  'P-384': {
    p: BigInt(
      '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff'
    ),
    a: BigInt(
      '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000fffffffc'
    ),
    b: BigInt(
      '0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef'
    ),
    coordSize: 48,
  },
  'P-521': {
    p: BigInt(
      '0x01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    ),
    a: BigInt(
      '0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc'
    ),
    b: BigInt(
      '0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00'
    ),
    coordSize: 66,
  },
  secp256k1: {
    p: BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f'),
    a: BigInt(0),
    b: BigInt(7),
    coordSize: 32,
  },
};

interface DIDResolutionResult {
  '@context': string;
  didDocument?: Record<string, unknown>;
  didResolutionMetadata: {
    contentType?: string;
    error?: string;
    message?: string;
  };
  didDocumentMetadata?: {
    created?: string;
    updated?: string;
    deactivated?: boolean;
  };
}

/**
 * GET /did/resolve/:did
 *
 * Resolves a DID and returns the DID document.
 * Supports did:web and did:key methods.
 */
export async function didResolveRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('VC');
  try {
    const did = c.req.param('did');

    if (!did) {
      return c.json(createErrorResult('invalidDid', 'DID is required'), 400);
    }

    // URL decode if needed
    const decodedDid = decodeURIComponent(did);

    // Validate DID format
    if (!isValidDID(decodedDid)) {
      return c.json(createErrorResult('invalidDid', 'Invalid DID format'), 400);
    }

    // Parse DID
    const parsed = parseDID(decodedDid);
    if (!parsed) {
      return c.json(createErrorResult('invalidDid', 'Failed to parse DID'), 400);
    }

    // Initialize repository
    const adapter = new D1Adapter({ db: c.env.DB });
    const cacheRepo = new DIDDocumentCacheRepository(adapter);

    // Check cache first
    const cached = await cacheRepo.getValidCache(decodedDid);
    if (cached) {
      return c.json(createSuccessResult(cached.document, cached.metadata));
    }

    // Resolve based on method
    let document: Record<string, unknown> | null = null;

    switch (parsed.method) {
      case 'web':
        document = await resolveDidWeb(decodedDid);
        break;
      case 'key':
        document = await resolveDidKey(decodedDid);
        break;
      default:
        return c.json(
          createErrorResult('methodNotSupported', `DID method '${parsed.method}' is not supported`),
          400
        );
    }

    if (!document) {
      return c.json(createErrorResult('notFound', 'DID document not found'), 404);
    }

    // Cache the result using repository
    await cacheRepo.cacheDocument(decodedDid, document, 3600); // 1 hour TTL

    return c.json(createSuccessResult(document));
  } catch (error) {
    log.error('DID resolution failed', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return c.json(
      createErrorResult('internalError', 'An error occurred while resolving the DID'),
      500
    );
  }
}

/**
 * Resolve did:web
 */
async function resolveDidWeb(did: string): Promise<Record<string, unknown> | null> {
  const url = didWebToUrl(did);
  if (!url) {
    return null;
  }

  try {
    // Use safeFetch for SSRF protection, timeout, and response size limits
    const response = await safeFetch(url, {
      headers: { Accept: 'application/did+json, application/json' },
      requireHttps: true, // did:web requires HTTPS
      timeoutMs: 10000, // 10 second timeout
      maxResponseSize: 512 * 1024, // 512 KB max for DID documents
    });

    if (!response.ok) {
      standaloneLog.warn('DID web resolution HTTP error', { httpStatus: response.status });
      return null;
    }

    // Parse response with size limit already enforced by safeFetch
    const text = await response.text();

    // SECURITY: Explicitly handle JSON parse errors for better error messages
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      standaloneLog.warn('Invalid JSON in DID document', {});
      return null;
    }
  } catch (error) {
    // Log detailed error for debugging
    if (error instanceof Error) {
      if (error.message.includes('SSRF protection')) {
        standaloneLog.warn('DID web SSRF blocked', {});
      } else if (error.message.includes('timeout')) {
        standaloneLog.warn('DID web resolution timeout', {});
      } else {
        standaloneLog.error('DID web fetch error', {}, error as Error);
      }
    }
    return null;
  }
}

/**
 * Resolve did:key
 *
 * Decodes multibase/multicodec encoded public keys.
 * Full DID Core 1.0 compliant implementation.
 *
 * Supports:
 * - Ed25519 (z6Mk prefix, multicodec 0xed)
 * - P-256/secp256r1 (zDn prefix, multicodec 0x1200)
 * - P-384 (z82 prefix, multicodec 0x1201)
 * - P-521 (z2J9 prefix, multicodec 0x1202)
 * - secp256k1 (zQ3s prefix, multicodec 0xe7)
 *
 * Features:
 * - Full varint decoding for multicodec prefixes
 * - Compressed EC key decompression (Y coordinate recovery)
 * - Uncompressed key support
 *
 * @see https://w3c-ccg.github.io/did-method-key/
 */
async function resolveDidKey(did: string): Promise<Record<string, unknown> | null> {
  // did:key format: did:key:<multibase-encoded-public-key>
  const multibaseKey = did.replace('did:key:', '');

  if (!multibaseKey.startsWith('z')) {
    // Only base58btc (z prefix) is commonly used
    standaloneLog.error('Unsupported multibase prefix for did:key', {});
    return null;
  }

  try {
    // Decode base58btc (skip 'z' prefix)
    const decoded = decodeBase58(multibaseKey.slice(1));

    // Parse multicodec prefix and extract public key
    const keyInfo = parseMulticodecKey(decoded);
    if (!keyInfo) {
      standaloneLog.error('Unsupported key type for did:key', {});
      return null;
    }

    // Build DID Document with decoded public key
    const keyId = `${did}#${multibaseKey}`;

    return {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
      id: did,
      verificationMethod: [
        {
          id: keyId,
          type: 'JsonWebKey2020',
          controller: did,
          publicKeyJwk: keyInfo.jwk,
        },
      ],
      authentication: [keyId],
      assertionMethod: [keyId],
      capabilityDelegation: [keyId],
      capabilityInvocation: [keyId],
    };
  } catch (e) {
    standaloneLog.error('did:key decoding error', {}, e as Error);
    return null;
  }
}

/**
 * Decode Base58 (Bitcoin alphabet)
 */
function decodeBase58(input: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  let result = BigInt(0);
  for (const char of input) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    result = result * BigInt(58) + BigInt(index);
  }

  // Convert BigInt to bytes
  // SECURITY: Ensure hex string has even length for proper byte parsing
  // An odd-length hex string would cause incorrect byte extraction
  const rawHex = result.toString(16);
  const hex = rawHex.length % 2 === 1 ? '0' + rawHex : rawHex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  // Handle leading zeros
  let leadingZeros = 0;
  for (const char of input) {
    if (char === '1') leadingZeros++;
    else break;
  }

  if (leadingZeros > 0) {
    const result = new Uint8Array(leadingZeros + bytes.length);
    result.set(bytes, leadingZeros);
    return result;
  }

  return bytes;
}

/**
 * Read unsigned varint from byte array
 *
 * Varints are a method of serializing integers using one or more bytes.
 * The most significant bit (MSB) indicates whether more bytes follow.
 *
 * @see https://github.com/multiformats/unsigned-varint
 */
function readVarint(data: Uint8Array): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  for (let i = 0; i < data.length && i < 9; i++) {
    const byte = data[i];
    value |= (byte & 0x7f) << shift;
    bytesRead++;

    if ((byte & 0x80) === 0) {
      return { value, bytesRead };
    }

    shift += 7;
  }

  throw new Error('Invalid varint: too many bytes or missing termination');
}

/**
 * Convert bytes to base64url string
 */
function bytesToBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]/g, '');
}

/**
 * Convert bytes to BigInt
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (const byte of bytes) {
    result = (result << BigInt(8)) | BigInt(byte);
  }
  return result;
}

/**
 * Convert BigInt to bytes with specified length
 */
function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let temp = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(temp & BigInt(0xff));
    temp = temp >> BigInt(8);
  }
  return bytes;
}

/**
 * Modular exponentiation: (base ^ exp) mod mod
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1);
  base = base % mod;

  while (exp > BigInt(0)) {
    if (exp % BigInt(2) === BigInt(1)) {
      result = (result * base) % mod;
    }
    exp = exp >> BigInt(1);
    base = (base * base) % mod;
  }

  return result;
}

/**
 * Decompress EC point from compressed format
 *
 * Uses the curve equation: y² = x³ + ax + b (mod p)
 * Recovers Y coordinate from X and the sign bit (prefix 0x02 or 0x03)
 *
 * @param compressedKey - Compressed public key (33/49/67 bytes)
 * @param curve - Curve name ('P-256', 'P-384', 'P-521', 'secp256k1')
 * @returns Object with x and y coordinates as Uint8Array
 */
function decompressECPoint(
  compressedKey: Uint8Array,
  curve: string
): { x: Uint8Array; y: Uint8Array } | null {
  const params = CURVE_PARAMS[curve];
  if (!params) {
    standaloneLog.error('Unknown curve for EC point decompression', { curve });
    return null;
  }

  // SECURITY: Validate minimum length before accessing array elements
  // Compressed EC keys must have at least 1 byte (prefix) + coordSize bytes
  if (compressedKey.length < 2) {
    standaloneLog.error('EC key too short', { keyLength: compressedKey.length });
    return null;
  }

  const prefix = compressedKey[0];
  if (prefix !== 0x02 && prefix !== 0x03) {
    standaloneLog.error('Invalid EC key prefix', { prefix });
    return null;
  }

  const isOdd = prefix === 0x03;
  const xBytes = compressedKey.slice(1);
  const x = bytesToBigInt(xBytes);

  const { p, a, b, coordSize } = params;

  // Calculate y² = x³ + ax + b (mod p)
  const x3 = modPow(x, BigInt(3), p);
  const ax = (a * x) % p;
  let y2 = (x3 + ax + b) % p;
  if (y2 < BigInt(0)) y2 += p;

  // Calculate y = sqrt(y²) mod p using Tonelli-Shanks (for p ≡ 3 mod 4)
  // For P-256, P-384, P-521, secp256k1: p ≡ 3 mod 4, so y = y²^((p+1)/4) mod p
  const exp = (p + BigInt(1)) / BigInt(4);
  let y = modPow(y2, exp, p);

  // Verify the square root
  if (modPow(y, BigInt(2), p) !== y2) {
    standaloneLog.error('EC point not on curve', {});
    return null;
  }

  // Choose correct y based on parity
  const yIsOdd = y % BigInt(2) === BigInt(1);
  if (yIsOdd !== isOdd) {
    y = p - y;
  }

  return {
    x: bigIntToBytes(x, coordSize),
    y: bigIntToBytes(y, coordSize),
  };
}

/**
 * Parse multicodec-prefixed key and return JWK
 *
 * Supports full varint decoding and all major EC curves.
 *
 * @param data - Multicodec-prefixed key bytes
 * @returns Key type and JWK, or null if unsupported
 */
function parseMulticodecKey(
  data: Uint8Array
): { type: string; jwk: Record<string, string> } | null {
  if (data.length < 2) return null;

  // Read multicodec prefix as varint
  const { value: codec, bytesRead } = readVarint(data);
  const keyBytes = data.slice(bytesRead);

  switch (codec) {
    case MULTICODEC.ED25519_PUB: {
      // Ed25519: 32 bytes
      if (keyBytes.length !== 32) {
        standaloneLog.error('Invalid Ed25519 key length', { keyLength: keyBytes.length });
        return null;
      }
      return {
        type: 'Ed25519',
        jwk: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: bytesToBase64url(keyBytes),
        },
      };
    }

    case MULTICODEC.P256_PUB: {
      // P-256: 33 bytes compressed or 65 bytes uncompressed
      return parseECKey(keyBytes, 'P-256', 32);
    }

    case MULTICODEC.P384_PUB: {
      // P-384: 49 bytes compressed or 97 bytes uncompressed
      return parseECKey(keyBytes, 'P-384', 48);
    }

    case MULTICODEC.P521_PUB: {
      // P-521: 67 bytes compressed or 133 bytes uncompressed
      return parseECKey(keyBytes, 'P-521', 66);
    }

    case MULTICODEC.SECP256K1_PUB: {
      // secp256k1: 33 bytes compressed or 65 bytes uncompressed
      return parseECKey(keyBytes, 'secp256k1', 32);
    }

    default:
      standaloneLog.warn('Unknown multicodec', { codec: `0x${codec.toString(16)}` });
      return null;
  }
}

/**
 * Parse EC key bytes and return JWK
 *
 * @param keyBytes - Raw key bytes (without multicodec prefix)
 * @param curve - Curve name
 * @param coordSize - Size of each coordinate in bytes
 */
function parseECKey(
  keyBytes: Uint8Array,
  curve: string,
  coordSize: number
): { type: string; jwk: Record<string, string> } | null {
  const compressedSize = coordSize + 1;
  const uncompressedSize = coordSize * 2 + 1;

  if (keyBytes.length === compressedSize) {
    // Compressed format (0x02 or 0x03 prefix)
    const decompressed = decompressECPoint(keyBytes, curve);
    if (!decompressed) {
      standaloneLog.error('Failed to decompress EC key', { curve });
      return null;
    }

    return {
      type: curve,
      jwk: {
        kty: 'EC',
        crv: curve,
        x: bytesToBase64url(decompressed.x),
        y: bytesToBase64url(decompressed.y),
      },
    };
  } else if (keyBytes.length === uncompressedSize) {
    // Uncompressed format (0x04 prefix)
    if (keyBytes[0] !== 0x04) {
      standaloneLog.error('Invalid uncompressed EC key prefix', { prefix: keyBytes[0] });
      return null;
    }

    return {
      type: curve,
      jwk: {
        kty: 'EC',
        crv: curve,
        x: bytesToBase64url(keyBytes.slice(1, coordSize + 1)),
        y: bytesToBase64url(keyBytes.slice(coordSize + 1, coordSize * 2 + 1)),
      },
    };
  }

  standaloneLog.error('Invalid EC key size', {
    curve,
    keyLength: keyBytes.length,
    expectedCompressed: compressedSize,
    expectedUncompressed: uncompressedSize,
  });
  return null;
}

/**
 * Create error resolution result
 */
function createErrorResult(error: string, message: string): DIDResolutionResult {
  return {
    '@context': 'https://w3id.org/did-resolution/v1',
    didResolutionMetadata: {
      error,
      message,
    },
  };
}

/**
 * Create success resolution result
 */
function createSuccessResult(
  document: Record<string, unknown>,
  metadata?: Record<string, unknown>
): DIDResolutionResult {
  return {
    '@context': 'https://w3id.org/did-resolution/v1',
    didDocument: document,
    didResolutionMetadata: {
      contentType: 'application/did+json',
    },
    didDocumentMetadata: metadata as DIDResolutionResult['didDocumentMetadata'],
  };
}
