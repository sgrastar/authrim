/**
 * JWE (JSON Web Encryption) Utilities
 * RFC 7516: https://datatracker.ietf.org/doc/html/rfc7516
 *
 * Provides functions for encrypting and decrypting JWTs using JWE.
 * Supports ID Token encryption and UserInfo response encryption per OIDC Core 5.1.
 */

import { CompactEncrypt, compactDecrypt, importJWK, type JWK } from 'jose';
import { isInternalUrl, safeFetchJson } from './url-security';
import { createLogger } from './logger';

const log = createLogger().module('JWE');

/**
 * Supported JWE Key Management Algorithms (alg)
 * https://datatracker.ietf.org/doc/html/rfc7518#section-4.1
 */
export const SUPPORTED_JWE_ALG = [
  'RSA-OAEP', // RSAES OAEP using default parameters
  'RSA-OAEP-256', // RSAES OAEP using SHA-256 and MGF1 with SHA-256
  'ECDH-ES', // Elliptic Curve Diffie-Hellman Ephemeral Static key agreement
  'ECDH-ES+A128KW', // ECDH-ES with AES Key Wrap
  'ECDH-ES+A192KW',
  'ECDH-ES+A256KW',
] as const;

export type JWEAlgorithm = (typeof SUPPORTED_JWE_ALG)[number];

/**
 * Supported JWE Content Encryption Algorithms (enc)
 * https://datatracker.ietf.org/doc/html/rfc7518#section-5.1
 */
export const SUPPORTED_JWE_ENC = [
  'A128GCM', // AES GCM using 128-bit key
  'A192GCM', // AES GCM using 192-bit key
  'A256GCM', // AES GCM using 256-bit key
  'A128CBC-HS256', // AES CBC using 128-bit key with HMAC SHA-256
  'A192CBC-HS384', // AES CBC using 192-bit key with HMAC SHA-384
  'A256CBC-HS512', // AES CBC using 256-bit key with HMAC SHA-512
] as const;

export type JWEEncryption = (typeof SUPPORTED_JWE_ENC)[number];

/**
 * Select a client public key that can be used with the requested JWE key-management algorithm.
 *
 * A JWK Set can contain signing keys, decryption-only keys, and keys for different algorithms.
 * Selecting by `use=enc` alone is therefore insufficient and can cause algorithm/key confusion.
 * When several rotation keys are eligible, each key must have a distinct `kid` so the recipient
 * can identify the key used from the JWE protected header.
 */
export function selectJWEEncryptionKey(keys: unknown, alg: JWEAlgorithm, kid?: string): JWK | null {
  if (!Array.isArray(keys)) {
    return null;
  }

  const expectedKeyOperations = alg.startsWith('RSA-')
    ? new Set(['encrypt', 'wrapKey'])
    : new Set(['deriveKey', 'deriveBits']);

  const candidates = keys.filter((value): value is JWK => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const key = value as JWK;
    if (key.use !== undefined && key.use !== 'enc') {
      return false;
    }
    if (
      Array.isArray(key.key_ops) &&
      !key.key_ops.some((operation) => expectedKeyOperations.has(operation))
    ) {
      return false;
    }
    if (key.alg !== undefined && key.alg !== alg) {
      return false;
    }
    if (kid !== undefined && key.kid !== kid) {
      return false;
    }

    if (alg.startsWith('RSA-')) {
      return key.kty === 'RSA' && typeof key.n === 'string' && typeof key.e === 'string';
    }

    if (key.kty === 'EC') {
      return typeof key.crv === 'string' && typeof key.x === 'string' && typeof key.y === 'string';
    }
    return (
      key.kty === 'OKP' && (key.crv === 'X25519' || key.crv === 'X448') && typeof key.x === 'string'
    );
  });

  const exactAlgorithmMatches = candidates.filter((key) => key.alg === alg);
  const eligible =
    exactAlgorithmMatches.length > 0
      ? exactAlgorithmMatches
      : candidates.filter((key) => key.alg === undefined);

  if (eligible.length === 0) {
    return null;
  }
  if (eligible.length === 1) {
    return eligible[0];
  }

  const kids = eligible.map((key) => key.kid).filter((kid): kid is string => !!kid);
  if (kids.length !== eligible.length || new Set(kids).size !== eligible.length) {
    return null;
  }

  return [...eligible].sort((left, right) => left.kid!.localeCompare(right.kid!))[0];
}

/**
 * JWE Encryption Options
 */
export interface JWEEncryptionOptions {
  /** Key management algorithm */
  alg: JWEAlgorithm;
  /** Content encryption algorithm */
  enc: JWEEncryption;
  /** Content type (typ header) - e.g., 'JWT' for encrypted ID tokens */
  cty?: string;
  /** Key ID (kid header) - identifies the client's public key */
  kid?: string;
}

/**
 * Encrypt a JWT payload using JWE
 *
 * This function takes a signed JWT (or any payload) and encrypts it using the client's public key.
 * The result is a JWE in compact serialization format (5 base64url-encoded parts separated by dots).
 *
 * @param payload - The payload to encrypt (typically a signed JWT string)
 * @param publicKey - Client's public key in JWK format
 * @param options - JWE encryption options (alg, enc, etc.)
 * @returns Promise<string> - JWE compact serialization
 *
 * @example
 * ```typescript
 * const signedIdToken = await createIDToken(...);
 * const encryptedIdToken = await encryptJWT(signedIdToken, clientPublicKey, {
 *   alg: 'RSA-OAEP-256',
 *   enc: 'A256GCM',
 *   cty: 'JWT',
 * });
 * ```
 */
export async function encryptJWT(
  payload: string,
  publicKey: JWK,
  options: JWEEncryptionOptions
): Promise<string> {
  // Import the client's public key
  const cryptoKey = await importJWK(publicKey, options.alg);

  // Encode payload as UTF-8 bytes
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payload);

  // Build JWE protected header
  const jwe = new CompactEncrypt(payloadBytes).setProtectedHeader({
    alg: options.alg,
    enc: options.enc,
    ...(options.cty && { cty: options.cty }),
    ...(options.kid && { kid: options.kid }),
  });

  // Encrypt and return compact JWE
  return await jwe.encrypt(cryptoKey);
}

/**
 * Decrypt a JWE using a private key
 *
 * This function is primarily for testing purposes.
 * In production, the client decrypts the JWE using their private key.
 *
 * @param jwe - JWE in compact serialization format
 * @param privateKey - Private key in JWK format
 * @returns Promise<string> - Decrypted payload
 */
export async function decryptJWT(jwe: string, privateKey: JWK): Promise<string> {
  // Import the private key
  const cryptoKey = await importJWK(privateKey);

  // Decrypt the JWE
  const { plaintext } = await compactDecrypt(jwe, cryptoKey);

  // Decode plaintext bytes to string
  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}

/**
 * Validate JWE encryption options
 *
 * Ensures that the requested algorithm and encryption method are supported.
 *
 * @param alg - Key management algorithm
 * @param enc - Content encryption algorithm
 * @returns boolean - True if valid
 * @throws Error if invalid
 */
export function validateJWEOptions(alg: string, enc: string): boolean {
  if (!SUPPORTED_JWE_ALG.includes(alg as JWEAlgorithm)) {
    throw new Error(
      `Unsupported JWE key management algorithm: ${alg}. Supported: ${SUPPORTED_JWE_ALG.join(', ')}`
    );
  }

  if (!SUPPORTED_JWE_ENC.includes(enc as JWEEncryption)) {
    throw new Error(
      `Unsupported JWE content encryption algorithm: ${enc}. Supported: ${SUPPORTED_JWE_ENC.join(', ')}`
    );
  }

  return true;
}

/**
 * Check if a client requires ID Token encryption
 *
 * @param clientMetadata - Client metadata from registration
 * @returns boolean - True if encryption is required
 */
export function isIDTokenEncryptionRequired(clientMetadata: {
  id_token_encrypted_response_alg?: string;
  id_token_encrypted_response_enc?: string;
}): boolean {
  return !!(
    clientMetadata.id_token_encrypted_response_alg && clientMetadata.id_token_encrypted_response_enc
  );
}

/**
 * Check if a client requires UserInfo encryption
 *
 * @param clientMetadata - Client metadata from registration
 * @returns boolean - True if encryption is required
 */
export function isUserInfoEncryptionRequired(clientMetadata: {
  userinfo_encrypted_response_alg?: string;
  userinfo_encrypted_response_enc?: string;
}): boolean {
  return !!(
    clientMetadata.userinfo_encrypted_response_alg && clientMetadata.userinfo_encrypted_response_enc
  );
}

/**
 * Get client's public JWK for encryption
 *
 * Retrieves the client's public key from either:
 * 1. jwks (embedded JWK Set in client metadata)
 * 2. jwks_uri (URL to client's published JWK Set)
 *
 * @param clientMetadata - Client metadata
 * @param kid - Optional Key ID to select specific key
 * @returns Promise<JWK | null> - Public key or null if not found
 */
export async function getClientPublicKey(
  clientMetadata: {
    jwks?: { keys: JWK[] };
    jwks_uri?: string;
  },
  kid?: string,
  algorithm?: JWEAlgorithm
): Promise<JWK | null> {
  // Option 1: Use embedded jwks
  if (clientMetadata.jwks?.keys) {
    if (algorithm) {
      return selectJWEEncryptionKey(clientMetadata.jwks.keys, algorithm, kid);
    }
    const key = kid
      ? clientMetadata.jwks.keys.find((k) => k.kid === kid)
      : clientMetadata.jwks.keys[0];
    return key || null;
  }

  // Option 2: Fetch from jwks_uri
  if (clientMetadata.jwks_uri) {
    try {
      // SSRF protection: Block requests to internal addresses
      if (isInternalUrl(clientMetadata.jwks_uri)) {
        log.error('SSRF protection: jwks_uri cannot point to internal addresses');
        return null;
      }

      const jwks = await safeFetchJson<{ keys?: unknown }>(clientMetadata.jwks_uri, {
        timeoutMs: 5000,
        maxResponseSize: 256 * 1024,
        redirect: 'error',
      });
      if (algorithm) {
        return selectJWEEncryptionKey(jwks.keys, algorithm, kid);
      }
      if (!Array.isArray(jwks.keys)) {
        return null;
      }
      const key = kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0];
      return key || null;
    } catch (error) {
      // PII Protection: Don't log full error object (may contain client JWKS URI)
      log.error('Error fetching client JWKS', {}, error as Error);
      return null;
    }
  }

  return null;
}
