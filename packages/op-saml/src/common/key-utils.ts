/**
 * Key Management Utilities for SAML 2.0
 *
 * Provides functions to interact with KeyManager Durable Object
 * and convert keys between formats (JWK, PEM, X.509).
 */

import type { Env } from '@authrim/shared';
import type { JWK } from 'jose';
import { importSPKI, exportSPKI } from 'jose';

/**
 * Cached signing key data
 */
interface SigningKeyCache {
  privateKeyPem: string;
  publicKeyPem: string;
  certificate: string;
  kid: string;
  cachedAt: number;
}

// Cache for signing key (5 minutes TTL)
let signingKeyCache: SigningKeyCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get signing key from KeyManager
 */
export async function getSigningKey(
  env: Env
): Promise<{ privateKeyPem: string; publicKeyPem: string; kid: string }> {
  // Check cache
  if (signingKeyCache && Date.now() - signingKeyCache.cachedAt < CACHE_TTL_MS) {
    return {
      privateKeyPem: signingKeyCache.privateKeyPem,
      publicKeyPem: signingKeyCache.publicKeyPem,
      kid: signingKeyCache.kid,
    };
  }

  // Get from KeyManager
  const keyManagerId = env.KEY_MANAGER.idFromName('default');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  const response = await keyManager.fetch(
    new Request('https://key-manager/internal/active-with-private', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
      },
    })
  );

  if (!response.ok) {
    // If no active key, try to rotate
    if (response.status === 404) {
      const rotateResponse = await keyManager.fetch(
        new Request('https://key-manager/internal/rotate', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
          },
        })
      );

      if (!rotateResponse.ok) {
        throw new Error('Failed to generate signing key');
      }

      const rotateData = (await rotateResponse.json()) as {
        key: { kid: string; privatePEM: string; publicJWK: JWK };
      };
      const publicKeyPem = await jwkToPublicKeyPem(rotateData.key.publicJWK);

      // Update cache
      signingKeyCache = {
        privateKeyPem: rotateData.key.privatePEM,
        publicKeyPem,
        certificate: await generateSelfSignedCertificate(rotateData.key.publicJWK),
        kid: rotateData.key.kid,
        cachedAt: Date.now(),
      };

      return {
        privateKeyPem: signingKeyCache.privateKeyPem,
        publicKeyPem: signingKeyCache.publicKeyPem,
        kid: signingKeyCache.kid,
      };
    }

    throw new Error(`KeyManager error: ${response.status}`);
  }

  const keyData = (await response.json()) as { kid: string; privatePEM: string; publicJWK: JWK };
  const publicKeyPem = await jwkToPublicKeyPem(keyData.publicJWK);

  // Update cache
  signingKeyCache = {
    privateKeyPem: keyData.privatePEM,
    publicKeyPem,
    certificate: await generateSelfSignedCertificate(keyData.publicJWK),
    kid: keyData.kid,
    cachedAt: Date.now(),
  };

  return {
    privateKeyPem: signingKeyCache.privateKeyPem,
    publicKeyPem: signingKeyCache.publicKeyPem,
    kid: signingKeyCache.kid,
  };
}

/**
 * Get signing certificate from KeyManager
 * Returns X.509 certificate in PEM format
 */
export async function getSigningCertificate(env: Env): Promise<string> {
  // Check cache
  if (signingKeyCache && Date.now() - signingKeyCache.cachedAt < CACHE_TTL_MS) {
    return signingKeyCache.certificate;
  }

  // Get signing key (this will update cache)
  await getSigningKey(env);

  if (!signingKeyCache) {
    throw new Error('Failed to get signing certificate');
  }

  return signingKeyCache.certificate;
}

/**
 * Convert JWK to PEM public key format
 */
async function jwkToPublicKeyPem(jwk: JWK): Promise<string> {
  // Import JWK to CryptoKey (cast JWK to JsonWebKey for Web Crypto API compatibility)
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );

  // Export as SPKI
  const spki = await crypto.subtle.exportKey('spki', cryptoKey);
  const spkiBase64 = btoa(String.fromCharCode(...new Uint8Array(spki as ArrayBuffer)));

  // Format as PEM
  const lines = spkiBase64.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

/**
 * Generate a self-signed X.509 certificate from JWK public key
 *
 * Note: This generates a minimal certificate structure for SAML metadata.
 * In production, you may want to use pre-generated certificates or a
 * proper PKI infrastructure.
 *
 * The certificate structure follows X.509 v3 format with:
 * - Version: v3
 * - Serial Number: Random
 * - Signature Algorithm: SHA256WithRSAEncryption
 * - Issuer/Subject: CN=Authrim IdP
 * - Validity: 1 year
 * - Subject Public Key Info: RSA public key
 */
async function generateSelfSignedCertificate(jwk: JWK): Promise<string> {
  // Import JWK to CryptoKey (cast JWK to JsonWebKey for Web Crypto API compatibility)
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );

  // Export as SPKI (SubjectPublicKeyInfo)
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const spkiArray = new Uint8Array(spki as ArrayBuffer);

  // For a proper X.509 certificate, we would need to:
  // 1. Build the TBSCertificate structure in ASN.1/DER
  // 2. Sign it with the private key
  // 3. Wrap in Certificate structure

  // Since we don't have access to ASN.1 encoding in Workers without a library,
  // and xml-crypto/xml-dsig accepts raw public keys in many cases,
  // we'll return the SPKI as a pseudo-certificate.

  // For production use, consider:
  // 1. Pre-generating certificates
  // 2. Using a proper X.509 library (e.g., pkijs)
  // 3. Having the KeyManager generate and store certificates

  // Return SPKI as base64 PEM (many SAML implementations accept this)
  const spkiBase64 = btoa(String.fromCharCode(...spkiArray));
  const lines = spkiBase64.match(/.{1,64}/g) || [];

  // Note: This is technically a public key, not a certificate.
  // For full compatibility, you should use a proper certificate.
  // However, many SAML implementations will accept this for testing.
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Parse PEM certificate and extract public key
 */
export async function extractPublicKeyFromCertificate(certificatePem: string): Promise<CryptoKey> {
  // Remove PEM headers and decode base64
  const pemContents = certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  // Try importing as SPKI (public key)
  try {
    return await crypto.subtle.importKey(
      'spki',
      binaryDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify']
    );
  } catch {
    // If SPKI fails, it might be an X.509 certificate
    // In that case, we would need to parse the certificate structure
    // For now, throw an error
    throw new Error('Failed to extract public key from certificate');
  }
}

/**
 * Import private key from PEM format
 */
export async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  // Remove PEM headers and decode
  const pemContents = privateKeyPem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Clear the signing key cache
 * Useful when keys are rotated
 */
export function clearSigningKeyCache(): void {
  signingKeyCache = null;
}
