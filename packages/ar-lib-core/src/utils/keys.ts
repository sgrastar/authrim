/**
 * Key Generation and Management Utilities
 *
 * Provides functions for generating and exporting RSA key pairs for JWT signing.
 * Uses the JOSE library for standards-compliant cryptographic operations.
 */

import { generateKeyPair, exportJWK, exportPKCS8 } from 'jose';
import type { JWK, CryptoKey } from 'jose';

export const DEFAULT_RSA_SIGNING_KEY_BITS = 3072;

/**
 * RSA key pair interface
 */
export interface RSAKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

/**
 * Generate RSA key pair for RS256 signing algorithm
 *
 * @param modulusLength - RSA key size in bits (default: 3072)
 * @returns Promise<RSAKeyPair>
 */
export async function generateRSAKeyPair(
  modulusLength: number = DEFAULT_RSA_SIGNING_KEY_BITS
): Promise<RSAKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    modulusLength,
    extractable: true,
  });

  return { publicKey, privateKey };
}

/**
 * Export public key as JWK (JSON Web Key) format
 *
 * @param publicKey - Public key to export
 * @param kid - Key ID (optional)
 * @returns Promise<JWK>
 */
export async function exportPublicJWK(publicKey: CryptoKey, kid?: string): Promise<JWK> {
  const jwk = await exportJWK(publicKey);

  // Add standard JWK parameters
  return {
    ...jwk,
    kty: 'RSA',
    use: 'sig',
    alg: 'RS256',
    ...(kid && { kid }),
  };
}

/**
 * Export private key as PEM format (PKCS#8)
 *
 * @param privateKey - Private key to export
 * @returns Promise<string> - PEM-formatted private key
 */
export async function exportPrivateKey(privateKey: CryptoKey): Promise<string> {
  return await exportPKCS8(privateKey);
}

/**
 * Generate a complete key set with public JWK and private PEM
 *
 * @param kid - Key ID
 * @param modulusLength - RSA key size in bits (default: 3072)
 * @returns Promise containing publicJWK and privatePEM
 */
export async function generateKeySet(
  kid: string,
  modulusLength: number = DEFAULT_RSA_SIGNING_KEY_BITS
): Promise<{
  publicJWK: JWK;
  privatePEM: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}> {
  const { publicKey, privateKey } = await generateRSAKeyPair(modulusLength);
  const publicJWK = await exportPublicJWK(publicKey, kid);
  const privatePEM = await exportPrivateKey(privateKey);

  return {
    publicJWK,
    privatePEM,
    publicKey,
    privateKey,
  };
}
