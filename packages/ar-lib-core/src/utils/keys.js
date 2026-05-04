/**
 * Key Generation and Management Utilities
 *
 * Provides functions for generating and exporting RSA key pairs for JWT signing.
 * Uses the JOSE library for standards-compliant cryptographic operations.
 */
import { generateKeyPair, exportJWK, exportPKCS8 } from 'jose';
/**
 * Generate RSA key pair for RS256 signing algorithm
 *
 * @param modulusLength - RSA key size in bits (default: 2048)
 * @returns Promise<RSAKeyPair>
 */
export async function generateRSAKeyPair(modulusLength = 2048) {
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
export async function exportPublicJWK(publicKey, kid) {
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
export async function exportPrivateKey(privateKey) {
    return await exportPKCS8(privateKey);
}
/**
 * Generate a complete key set with public JWK and private PEM
 *
 * @param kid - Key ID
 * @param modulusLength - RSA key size in bits (default: 2048)
 * @returns Promise containing publicJWK and privatePEM
 */
export async function generateKeySet(kid, modulusLength = 2048) {
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
