/**
 * DID (Decentralized Identifier) Types
 *
 * Type definitions for DID Core 1.0 (W3C Recommendation)
 * Supports did:web and did:key methods for Phase 9.
 *
 * @see https://www.w3.org/TR/did-core/
 */

/**
 * DID Document
 * The core data model for a DID
 */
export interface DIDDocument {
  /** JSON-LD context */
  '@context': string | string[];

  /** The DID subject */
  id: string;

  /** Alternative identifiers */
  alsoKnownAs?: string[];

  /** Controllers of this DID */
  controller?: string | string[];

  /** Verification methods (public keys) */
  verificationMethod?: VerificationMethod[];

  /** Authentication verification relationships */
  authentication?: (string | VerificationMethod)[];

  /** Assertion method verification relationships */
  assertionMethod?: (string | VerificationMethod)[];

  /** Key agreement verification relationships */
  keyAgreement?: (string | VerificationMethod)[];

  /** Capability invocation verification relationships */
  capabilityInvocation?: (string | VerificationMethod)[];

  /** Capability delegation verification relationships */
  capabilityDelegation?: (string | VerificationMethod)[];

  /** Service endpoints */
  service?: ServiceEndpoint[];
}

/**
 * Verification Method
 * A public key or other verification material
 */
export interface VerificationMethod {
  /** Verification method ID (usually DID#key-id) */
  id: string;

  /** Type of verification method */
  type: VerificationMethodType;

  /** Controller of this verification method */
  controller: string;

  /** Public key in JWK format */
  publicKeyJwk?: JsonWebKey2020;

  /** Public key in multibase format */
  publicKeyMultibase?: string;

  /** Blockchain account ID (for blockchain-based DIDs) */
  blockchainAccountId?: string;
}

/**
 * Verification Method Types
 */
export type VerificationMethodType =
  | 'JsonWebKey2020'
  | 'Ed25519VerificationKey2020'
  | 'EcdsaSecp256k1VerificationKey2019'
  | 'X25519KeyAgreementKey2020'
  | 'Multikey';

/**
 * JWK for verification methods
 */
export interface JsonWebKey2020 {
  /** Key type */
  kty: 'EC' | 'OKP' | 'RSA';

  /** Curve (for EC/OKP) */
  crv?: 'P-256' | 'P-384' | 'P-521' | 'Ed25519' | 'X25519' | 'secp256k1';

  /** X coordinate (for EC) */
  x?: string;

  /** Y coordinate (for EC) */
  y?: string;

  /** RSA modulus */
  n?: string;

  /** RSA exponent */
  e?: string;

  /** Key ID */
  kid?: string;

  /** Key use */
  use?: 'sig' | 'enc';

  /** Algorithm */
  alg?: string;
}

/**
 * Service Endpoint
 */
export interface ServiceEndpoint {
  /** Service ID */
  id: string;

  /** Service type */
  type: string | string[];

  /** Service endpoint URL(s) */
  serviceEndpoint: string | string[] | ServiceEndpointMap;
}

/**
 * Service Endpoint Map (for complex endpoints)
 */
export interface ServiceEndpointMap {
  [key: string]: string | string[];
}

/**
 * DID Resolution Result
 */
export interface DIDResolutionResult {
  /** Resolution context */
  '@context'?: string;

  /** The resolved DID Document */
  didDocument: DIDDocument | null;

  /** Resolution metadata */
  didResolutionMetadata: DIDResolutionMetadata;

  /** Document metadata */
  didDocumentMetadata: DIDDocumentMetadata;
}

/**
 * DID Resolution Metadata
 */
export interface DIDResolutionMetadata {
  /** Content type of the document */
  contentType?: string;

  /** Error code if resolution failed */
  error?: DIDResolutionError;

  /** Error message */
  message?: string;

  /** Duration of resolution in milliseconds */
  duration?: number;
}

/**
 * DID Resolution Errors
 */
export type DIDResolutionError =
  | 'invalidDid'
  | 'notFound'
  | 'representationNotSupported'
  | 'methodNotSupported'
  | 'internalError';

/**
 * DID Document Metadata
 */
export interface DIDDocumentMetadata {
  /** Created timestamp */
  created?: string;

  /** Updated timestamp */
  updated?: string;

  /** Deactivated flag */
  deactivated?: boolean;

  /** Next update hint */
  nextUpdate?: string;

  /** Version ID */
  versionId?: string;

  /** Next version ID */
  nextVersionId?: string;

  /** Equivalent IDs */
  equivalentId?: string[];

  /** Canonical ID */
  canonicalId?: string;
}

/**
 * DID Method
 */
export type DIDMethod = 'web' | 'key' | 'ion' | 'ethr' | 'pkh';

/**
 * Parsed DID
 */
export interface ParsedDID {
  /** Full DID string */
  did: string;

  /** DID method */
  method: DIDMethod;

  /** Method-specific identifier */
  methodSpecificId: string;

  /** Path (if present) */
  path?: string;

  /** Query (if present) */
  query?: string;

  /** Fragment (if present) */
  fragment?: string;
}

/**
 * DID Resolver interface
 */
export interface DIDResolver {
  /**
   * Resolve a DID to its DID Document
   *
   * @param did - The DID to resolve
   * @returns Resolution result
   */
  resolve(did: string): Promise<DIDResolutionResult>;

  /**
   * Check if this resolver supports the given DID method
   *
   * @param method - DID method
   * @returns True if supported
   */
  supportsMethod(method: DIDMethod): boolean;
}

/**
 * Parse a DID string into components
 *
 * @param did - DID string to parse
 * @returns Parsed DID or null if invalid
 */
export function parseDID(did: string): ParsedDID | null {
  // DID syntax: did:<method>:<method-specific-id>[/<path>][?<query>][#<fragment>]
  const regex = /^did:([a-z0-9]+):([^?#\/]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;
  const match = did.match(regex);

  if (!match) {
    return null;
  }

  const [, method, methodSpecificId, path, query, fragment] = match;

  return {
    did,
    method: method as DIDMethod,
    methodSpecificId,
    path: path?.substring(1), // Remove leading /
    query: query?.substring(1), // Remove leading ?
    fragment: fragment?.substring(1), // Remove leading #
  };
}

/**
 * Validate a DID string
 *
 * @param did - DID string to validate
 * @returns True if valid
 */
export function isValidDID(did: string): boolean {
  return parseDID(did) !== null;
}

/**
 * Check if a DID uses a supported method
 *
 * @param did - DID string
 * @param supportedMethods - List of supported methods
 * @returns True if method is supported
 */
export function isDIDMethodSupported(did: string, supportedMethods: DIDMethod[]): boolean {
  const parsed = parseDID(did);
  return parsed !== null && supportedMethods.includes(parsed.method);
}

/**
 * Resolve a DID to its DID Document
 *
 * Supports:
 * - did:web - fetches from HTTPS URL
 * - did:key - decodes multibase key (basic implementation)
 *
 * @param did - DID string to resolve
 * @returns DID Document
 * @throws Error if resolution fails
 */
export async function resolveDID(did: string): Promise<DIDDocument> {
  const parsed = parseDID(did);

  if (!parsed) {
    throw new Error(`Invalid DID format: ${did}`);
  }

  switch (parsed.method) {
    case 'web':
      return resolveDidWeb(did);
    case 'key':
      return resolveDidKey(did);
    default:
      throw new Error(`Unsupported DID method: ${parsed.method}`);
  }
}

/**
 * Resolve did:web to DID Document
 *
 * Uses safeFetch for SSRF protection:
 * - Blocks private IP ranges (RFC 1918, RFC 4193, loopback)
 * - Enforces HTTPS
 * - Timeout and response size limits
 */
async function resolveDidWeb(did: string): Promise<DIDDocument> {
  const url = didWebToUrl(did);
  if (!url) {
    throw new Error(`Failed to convert did:web to URL: ${did}`);
  }

  // Import safeFetch dynamically to avoid circular dependency
  const { safeFetch } = await import('../utils/url-security');

  const response = await safeFetch(url, {
    headers: { Accept: 'application/did+json, application/json' },
    requireHttps: true,
    timeoutMs: 10000,
    maxResponseSize: 512 * 1024, // 512 KB max for DID documents
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch DID document: ${response.status}`);
  }

  const text = await response.text();
  const document = JSON.parse(text) as DIDDocument;

  // Validate basic structure
  if (!document.id || document.id !== did) {
    throw new Error('DID document id does not match the DID');
  }

  return document;
}

/**
 * Base58btc alphabet for multibase decoding
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode base58btc encoded string to Uint8Array
 */
function decodeBase58btc(encoded: string): Uint8Array {
  const alphabet = BASE58_ALPHABET;
  const base = BigInt(58);

  let num = BigInt(0);
  for (const char of encoded) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * base + BigInt(index);
  }

  // Convert BigInt to bytes
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num = num / 256n;
  }

  // Handle leading zeros (represented as '1' in base58)
  let leadingZeros = 0;
  for (const char of encoded) {
    if (char === '1') {
      leadingZeros++;
    } else {
      break;
    }
  }

  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}

/**
 * Encode Uint8Array to base64url
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Multicodec prefixes for did:key
 * @see https://github.com/multiformats/multicodec/blob/master/table.csv
 */
const MULTICODEC = {
  ED25519_PUB: 0xed, // ed25519-pub (varint: 0xed01)
  P256_PUB: 0x1200, // p256-pub
  P384_PUB: 0x1201, // p384-pub
  P521_PUB: 0x1202, // p521-pub
} as const;

/**
 * Decode multibase key and convert to JWK
 * Supports Ed25519, P-256, P-384, P-521
 */
function multibaseToJwk(
  multibaseKey: string
): { jwk: JsonWebKey2020; keyType: 'Ed25519' | 'P-256' | 'P-384' | 'P-521' } | null {
  // Multibase 'z' prefix indicates base58btc
  if (!multibaseKey.startsWith('z')) {
    return null;
  }

  const decoded = decodeBase58btc(multibaseKey.slice(1));

  if (decoded.length < 2) {
    return null;
  }

  // Read multicodec prefix (varint)
  // Ed25519: 0xed, 0x01 (2 bytes)
  // P-256: 0x80, 0x24 (2 bytes, varint for 0x1200)
  // P-384: 0x81, 0x24 (2 bytes, varint for 0x1201)
  // P-521: 0x82, 0x24 (2 bytes, varint for 0x1202)

  // Ed25519 (multicodec: 0xed01)
  if (decoded[0] === 0xed && decoded[1] === 0x01) {
    const publicKeyBytes = decoded.slice(2);
    if (publicKeyBytes.length !== 32) {
      return null;
    }
    return {
      keyType: 'Ed25519',
      jwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: toBase64Url(publicKeyBytes),
        alg: 'EdDSA',
        use: 'sig',
      },
    };
  }

  // P-256 (multicodec: 0x1200, varint encoded as 0x80 0x24)
  if (decoded[0] === 0x80 && decoded[1] === 0x24) {
    const publicKeyBytes = decoded.slice(2);
    // Compressed key: 33 bytes, Uncompressed: 65 bytes
    if (publicKeyBytes.length === 33) {
      // Compressed format - decompress
      const decompressed = decompressP256Point(publicKeyBytes);
      if (!decompressed) return null;
      return {
        keyType: 'P-256',
        jwk: {
          kty: 'EC',
          crv: 'P-256',
          x: toBase64Url(decompressed.x),
          y: toBase64Url(decompressed.y),
          alg: 'ES256',
          use: 'sig',
        },
      };
    } else if (publicKeyBytes.length === 65 && publicKeyBytes[0] === 0x04) {
      // Uncompressed format
      return {
        keyType: 'P-256',
        jwk: {
          kty: 'EC',
          crv: 'P-256',
          x: toBase64Url(publicKeyBytes.slice(1, 33)),
          y: toBase64Url(publicKeyBytes.slice(33, 65)),
          alg: 'ES256',
          use: 'sig',
        },
      };
    }
    return null;
  }

  // P-384 (multicodec: 0x1201, varint encoded as 0x81 0x24)
  if (decoded[0] === 0x81 && decoded[1] === 0x24) {
    const publicKeyBytes = decoded.slice(2);
    if (publicKeyBytes.length === 97 && publicKeyBytes[0] === 0x04) {
      return {
        keyType: 'P-384',
        jwk: {
          kty: 'EC',
          crv: 'P-384',
          x: toBase64Url(publicKeyBytes.slice(1, 49)),
          y: toBase64Url(publicKeyBytes.slice(49, 97)),
          alg: 'ES384',
          use: 'sig',
        },
      };
    }
    return null;
  }

  // P-521 (multicodec: 0x1202, varint encoded as 0x82 0x24)
  if (decoded[0] === 0x82 && decoded[1] === 0x24) {
    const publicKeyBytes = decoded.slice(2);
    if (publicKeyBytes.length === 133 && publicKeyBytes[0] === 0x04) {
      return {
        keyType: 'P-521',
        jwk: {
          kty: 'EC',
          crv: 'P-521',
          x: toBase64Url(publicKeyBytes.slice(1, 67)),
          y: toBase64Url(publicKeyBytes.slice(67, 133)),
          alg: 'ES512',
          use: 'sig',
        },
      };
    }
    return null;
  }

  return null;
}

/**
 * Decompress a P-256 compressed point
 * Uses the formula: y² = x³ - 3x + b (mod p)
 */
function decompressP256Point(compressed: Uint8Array): { x: Uint8Array; y: Uint8Array } | null {
  if (compressed.length !== 33) return null;

  const prefix = compressed[0];
  if (prefix !== 0x02 && prefix !== 0x03) return null;

  const isOdd = prefix === 0x03;
  const x = compressed.slice(1);

  // P-256 curve parameters
  const p = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const a = BigInt('0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc');
  const b = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');

  // Convert x to BigInt
  let xBigInt = BigInt(0);
  for (const byte of x) {
    xBigInt = (xBigInt << 8n) | BigInt(byte);
  }

  // Calculate y² = x³ + ax + b (mod p)
  const x3 = modPow(xBigInt, 3n, p);
  const ax = (a * xBigInt) % p;
  let y2 = (x3 + ax + b) % p;
  if (y2 < 0n) y2 += p;

  // Calculate y = √(y²) using Tonelli-Shanks (for p ≡ 3 mod 4, y = y²^((p+1)/4))
  const exp = (p + 1n) / 4n;
  let y = modPow(y2, exp, p);

  // Check parity
  const yIsOdd = y % 2n === 1n;
  if (yIsOdd !== isOdd) {
    y = p - y;
  }

  // Convert y back to bytes
  const yBytes = new Uint8Array(32);
  let tempY = y;
  for (let i = 31; i >= 0; i--) {
    yBytes[i] = Number(tempY & 0xffn);
    tempY >>= 8n;
  }

  return { x, y: yBytes };
}

/**
 * Modular exponentiation: base^exp mod mod
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod;
    }
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Resolve did:key to DID Document
 *
 * Fully implements multibase/multicodec decoding for:
 * - Ed25519 (z6Mk... prefix)
 * - P-256 (zDn... prefix)
 * - P-384 (z82... prefix)
 * - P-521 (z2J... prefix)
 *
 * Returns publicKeyJwk for compatibility with JWT verification.
 */
async function resolveDidKey(did: string): Promise<DIDDocument> {
  const parsed = parseDID(did);
  if (!parsed || parsed.method !== 'key') {
    throw new Error(`Invalid did:key format: ${did}`);
  }

  const multibaseKey = parsed.methodSpecificId;

  // Try to decode multibase key to JWK
  const decoded = multibaseToJwk(multibaseKey);

  if (decoded) {
    const { jwk, keyType } = decoded;

    // Use appropriate verification method type based on key type
    const vmType: VerificationMethodType =
      keyType === 'Ed25519' ? 'Ed25519VerificationKey2020' : 'JsonWebKey2020';

    const context =
      keyType === 'Ed25519'
        ? ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1']
        : ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'];

    return {
      '@context': context,
      id: did,
      verificationMethod: [
        {
          id: `${did}#${multibaseKey}`,
          type: vmType,
          controller: did,
          publicKeyJwk: jwk,
          publicKeyMultibase: multibaseKey,
        },
      ],
      authentication: [`${did}#${multibaseKey}`],
      assertionMethod: [`${did}#${multibaseKey}`],
    };
  }

  // Fallback: Return document with publicKeyMultibase only
  // This maintains backwards compatibility but logs a warning
  console.warn(
    `[resolveDidKey] Could not decode multibase key to JWK: ${multibaseKey.substring(0, 10)}...`
  );

  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [
      {
        id: `${did}#${multibaseKey}`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: multibaseKey,
      },
    ],
    authentication: [`${did}#${multibaseKey}`],
    assertionMethod: [`${did}#${multibaseKey}`],
  };
}

/**
 * Convert did:web to HTTPS URL
 *
 * @param did - did:web DID string
 * @returns HTTPS URL for the DID document
 */
export function didWebToUrl(did: string): string | null {
  const parsed = parseDID(did);

  if (!parsed || parsed.method !== 'web') {
    return null;
  }

  // Decode percent-encoded characters in method-specific-id
  const decoded = decodeURIComponent(parsed.methodSpecificId);

  // Split by colons to get domain and path
  const parts = decoded.split(':');
  const domain = parts[0];
  const pathParts = parts.slice(1);

  // Build URL
  let url = `https://${domain}`;

  if (pathParts.length > 0) {
    url += `/${pathParts.join('/')}`;
  }

  // Append did.json
  if (pathParts.length === 0) {
    url += '/.well-known/did.json';
  } else {
    url += '/did.json';
  }

  return url;
}
