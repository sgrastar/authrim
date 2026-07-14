/**
 * Crypto Utilities
 *
 * Cryptographic utility functions for the VC package.
 */

/**
 * Generate a secure random nonce
 */
export async function generateSecureNonce(length: number = 32): Promise<string> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a secure random string (URL-safe base64)
 */
export function generateRandomString(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');
}

/**
 * Calculate SHA-256 hash and return as base64url
 */
export async function sha256Base64url(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = new Uint8Array(hashBuffer);
  return btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');
}

/** HMAC verifier for low-entropy transaction codes. */
export async function hmacSha256Base64url(
  secret: string | undefined,
  data: string
): Promise<string> {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('VC transaction-code HMAC secret must contain at least 32 bytes');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const bytes = new Uint8Array(signature);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function hashTransactionCode(
  secret: string | undefined,
  tenantId: string,
  offerId: string,
  transactionCode: string
): Promise<string> {
  return hmacSha256Base64url(secret, `${tenantId}\u0000${offerId}\u0000${transactionCode}`);
}
