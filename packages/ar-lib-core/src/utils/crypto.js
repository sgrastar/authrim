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
export function generateSecureRandomString(byteLength = 96) {
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
export function arrayBufferToBase64Url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // Convert bytes to binary string
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // Convert to base64 and make it URL-safe (base64url)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, ''); // Remove padding
}
/**
 * Convert base64url string to Uint8Array
 *
 * @param base64url - Base64url-encoded string
 * @returns Uint8Array of decoded bytes
 */
export function base64UrlToArrayBuffer(base64url) {
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
/**
 * Timing-safe string comparison
 *
 * Compares two strings in constant time to prevent timing attacks.
 * This is critical for comparing sensitive values like client secrets,
 * passwords, or authentication tokens.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal, false otherwise
 *
 * @example
 * ```ts
 * const isValid = timingSafeEqual(clientSecret, providedSecret);
 * if (!isValid) {
 *   return c.json({ error: 'invalid_client' }, 401);
 * }
 * ```
 */
export function timingSafeEqual(a, b) {
  // Convert strings to Uint8Array
  const encoder = new TextEncoder();
  const aBuffer = encoder.encode(a);
  const bBuffer = encoder.encode(b);
  // If lengths differ, still compare to prevent timing leaks
  // We'll compare up to the longer length, padding the shorter one
  const length = Math.max(aBuffer.length, bBuffer.length);
  // Always perform the same number of comparisons regardless of input
  let result = aBuffer.length === bBuffer.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    // Use modulo to safely handle different lengths without branching
    const aValue = aBuffer[i % aBuffer.length] || 0;
    const bValue = bBuffer[i % bBuffer.length] || 0;
    result |= aValue ^ bValue;
  }
  return result === 0;
}
/**
 * Hash a password using SHA-256
 *
 * Note: In production, you should use a proper password hashing algorithm
 * like bcrypt, scrypt, or Argon2. This is a simplified implementation
 * suitable for demo/development purposes.
 *
 * For production use, consider using Cloudflare Workers' crypto API with
 * a proper key derivation function.
 *
 * @param password - Plain text password
 * @returns Hashed password (hex string)
 */
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * Verify a password against a hash
 *
 * @param password - Plain text password
 * @param hash - Hashed password
 * @returns True if password matches hash
 */
export async function verifyPassword(password, hash) {
  const passwordHash = await hashPassword(password);
  return timingSafeEqual(passwordHash, hash);
}

/**
 * Generate PKCE code challenge from code verifier
 * Uses S256 method (SHA-256 hash, base64url-encoded)
 *
 * @param {string} codeVerifier - The code verifier string
 * @returns {Promise<string>} Base64url-encoded SHA-256 hash of the code verifier
 */
export async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToBase64Url(hashBuffer);
}
