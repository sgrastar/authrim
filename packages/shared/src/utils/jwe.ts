/**
 * JWE (JSON Web Encryption) Utilities
 * RFC 7516: https://datatracker.ietf.org/doc/html/rfc7516
 *
 * Provides functions for encrypting and decrypting JWTs using JWE.
 * Supports ID Token encryption and UserInfo response encryption per OIDC Core 5.1.
 */

import { CompactEncrypt, compactDecrypt, importJWK, type JWK } from 'jose';

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
  kid?: string
): Promise<JWK | null> {
  // Option 1: Use embedded jwks
  if (clientMetadata.jwks?.keys) {
    const key = kid
      ? clientMetadata.jwks.keys.find((k) => k.kid === kid)
      : clientMetadata.jwks.keys[0];
    return key || null;
  }

  // Option 2: Fetch from jwks_uri
  if (clientMetadata.jwks_uri) {
    try {
      const response = await fetch(clientMetadata.jwks_uri);
      if (!response.ok) {
        throw new Error(`Failed to fetch JWKS: ${response.status}`);
      }
      const jwks = (await response.json()) as { keys: JWK[] };
      const key = kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0];
      return key || null;
    } catch (error) {
      console.error('Error fetching client JWKS:', error);
      return null;
    }
  }

  return null;
}
