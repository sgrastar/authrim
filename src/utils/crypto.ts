/**
 * Cryptographic Utilities
 *
 * Provides helper functions for generating cryptographically secure random strings
 * and encoding them in base64url format.
 */

/**
 * Generate a cryptographically secure random string in base64url format
 *
 * @param byteLength - Number of random bytes to generate (default: 96, resulting in ~128 chars)
 * @returns A base64url-encoded random string
 *
 * @example
 * ```ts
 * const authCode = generateSecureRandomString(96); // ~128 characters
 * const token = generateSecureRandomString(192); // ~256 characters
 * ```
 */
export function generateSecureRandomString(byteLength: number = 96): string {
  // Generate cryptographically secure random bytes
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  // Convert to base64url format
  // Base64url is URL-safe: uses - and _ instead of + and /, and removes padding =
  return arrayBufferToBase64Url(bytes);
}

/**
 * Convert ArrayBuffer or Uint8Array to base64url string
 *
 * @param buffer - ArrayBuffer or Uint8Array to convert
 * @returns Base64url-encoded string
 */
export function arrayBufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // Convert bytes to binary string
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  // Convert to base64 and make it URL-safe (base64url)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, ''); // Remove padding
}

/**
 * Convert base64url string to Uint8Array
 *
 * @param base64url - Base64url-encoded string
 * @returns Uint8Array of decoded bytes
 */
export function base64UrlToArrayBuffer(base64url: string): Uint8Array {
  // Convert base64url to base64
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  const pad = base64.length % 4;
  if (pad) {
    base64 += '='.repeat(4 - pad);
  }

  // Decode base64 to binary string
  const binary = atob(base64);

  // Convert binary string to Uint8Array
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
