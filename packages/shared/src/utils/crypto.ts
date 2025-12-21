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
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); // Remove padding
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

/**
 * Decode a base64url string to a UTF-8 string
 *
 * @param base64url - Base64url-encoded string
 * @returns Decoded UTF-8 string
 */
export function decodeBase64Url(base64url: string): string {
  const bytes = base64UrlToArrayBuffer(base64url);
  return new TextDecoder().decode(bytes);
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
export function timingSafeEqual(a: string, b: string): boolean {
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
 * Password hashing configuration
 *
 * Uses PBKDF2 with SHA-256, which is supported by Cloudflare Workers' Web Crypto API.
 * Configuration follows NIST SP 800-132 and OWASP recommendations.
 */
const PASSWORD_HASH_CONFIG = {
  /** Salt length in bytes (128 bits) */
  SALT_LENGTH: 16,
  /** Number of PBKDF2 iterations (OWASP recommends 600,000 for SHA-256 in 2023) */
  ITERATIONS: 600000,
  /** Hash algorithm */
  HASH: 'SHA-256',
  /** Derived key length in bytes (256 bits) */
  KEY_LENGTH: 32,
  /** Version identifier for future algorithm upgrades */
  VERSION: 'pbkdf2v1',
} as const;

/**
 * Hash a password using PBKDF2 with SHA-256
 *
 * Uses cryptographically secure salt and high iteration count to resist
 * brute-force and rainbow table attacks.
 *
 * @param password - Plain text password
 * @returns Hashed password in format: version$iterations$salt$hash (all base64url encoded)
 *
 * @example
 * ```ts
 * const hash = await hashPassword('mySecurePassword');
 * // Returns: "pbkdf2v1$600000$<salt>$<hash>"
 * ```
 *
 * @see NIST SP 800-132: Recommendation for Password-Based Key Derivation
 * @see OWASP Password Storage Cheat Sheet
 */
export async function hashPassword(password: string): Promise<string> {
  // Generate cryptographically secure random salt
  const salt = new Uint8Array(PASSWORD_HASH_CONFIG.SALT_LENGTH);
  crypto.getRandomValues(salt);

  // Import password as key material
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Derive key using PBKDF2
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PASSWORD_HASH_CONFIG.ITERATIONS,
      hash: PASSWORD_HASH_CONFIG.HASH,
    },
    passwordKey,
    PASSWORD_HASH_CONFIG.KEY_LENGTH * 8 // bits
  );

  // Encode salt and hash as base64url
  const saltBase64 = arrayBufferToBase64Url(salt.buffer);
  const hashBase64 = arrayBufferToBase64Url(derivedBits);

  // Return formatted hash string
  return `${PASSWORD_HASH_CONFIG.VERSION}$${PASSWORD_HASH_CONFIG.ITERATIONS}$${saltBase64}$${hashBase64}`;
}

/**
 * Verify a password against a PBKDF2 hash
 *
 * Supports both new PBKDF2 format and legacy SHA-256 format for migration.
 *
 * @param password - Plain text password
 * @param hash - Hashed password (PBKDF2 or legacy SHA-256 format)
 * @returns True if password matches hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Check if this is a PBKDF2 hash (contains $ separators)
  if (hash.includes('$')) {
    return verifyPbkdf2Password(password, hash);
  }

  // Legacy SHA-256 hash (for migration - should be upgraded on next login)
  return verifyLegacySha256Password(password, hash);
}

/**
 * Verify password against PBKDF2 hash
 */
async function verifyPbkdf2Password(password: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 4) {
    return false;
  }

  const [version, iterationsStr, saltBase64, expectedHashBase64] = parts;

  // Validate version
  if (version !== PASSWORD_HASH_CONFIG.VERSION) {
    console.warn(`Unknown password hash version: ${version}`);
    return false;
  }

  const iterations = parseInt(iterationsStr, 10);
  if (isNaN(iterations) || iterations < 1) {
    return false;
  }

  // Decode salt from base64url
  const salt = base64UrlToArrayBuffer(saltBase64);

  // Import password as key material
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Derive key using PBKDF2 with stored parameters
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(salt),
      iterations: iterations,
      hash: PASSWORD_HASH_CONFIG.HASH,
    },
    passwordKey,
    PASSWORD_HASH_CONFIG.KEY_LENGTH * 8
  );

  // Compare using timing-safe comparison
  const computedHashBase64 = arrayBufferToBase64Url(derivedBits);
  return timingSafeEqual(computedHashBase64, expectedHashBase64);
}

/**
 * Verify password against legacy SHA-256 hash (for migration)
 *
 * @deprecated Use PBKDF2 hashing for new passwords
 */
async function verifyLegacySha256Password(password: string, hash: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const computedHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(computedHash, hash);
}

/**
 * Check if a password hash needs to be upgraded to the latest algorithm
 *
 * @param hash - Current password hash
 * @returns True if hash should be upgraded (e.g., on next successful login)
 */
export function passwordHashNeedsUpgrade(hash: string): boolean {
  // Legacy SHA-256 hashes need upgrade
  if (!hash.includes('$')) {
    return true;
  }

  const parts = hash.split('$');
  if (parts.length !== 4) {
    return true;
  }

  const [version, iterationsStr] = parts;
  const iterations = parseInt(iterationsStr, 10);

  // Upgrade if using old version or insufficient iterations
  if (version !== PASSWORD_HASH_CONFIG.VERSION) {
    return true;
  }

  if (iterations < PASSWORD_HASH_CONFIG.ITERATIONS) {
    return true;
  }

  return false;
}

/**
 * Generate a cryptographically secure session ID with 128 bits of entropy
 *
 * Uses 128 bits (16 bytes) of random data encoded as base64url, meeting OWASP
 * recommendations for session identifier entropy. The result is a 22-character
 * URL-safe string.
 *
 * Advantages over UUID v4:
 * - 128 bits of entropy (vs 122 bits for UUIDv4)
 * - Shorter representation (22 chars vs 36 chars)
 * - URL-safe encoding (no special characters)
 * - No predictable version/variant bits
 *
 * @returns A 22-character base64url-encoded random string
 *
 * @example
 * ```ts
 * const sessionId = generateSecureSessionId();
 * // Returns: "X7g9_kPq2Lm4Rn8sT1wZ-A"
 * ```
 *
 * @see OWASP Session Management Cheat Sheet
 * @see RFC 4086: Randomness Requirements for Security
 */
export function generateSecureSessionId(): string {
  // 128 bits = 16 bytes, encoded as base64url = 22 characters
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return arrayBufferToBase64Url(bytes);
}

/**
 * Generate PKCE code challenge from code verifier
 * Uses S256 method (SHA-256 hash, base64url-encoded)
 *
 * @param codeVerifier - The code verifier string
 * @returns Base64url-encoded SHA-256 hash of the code verifier
 *
 * @example
 * ```ts
 * const verifier = generateSecureRandomString(32); // 43-128 character string
 * const challenge = await generateCodeChallenge(verifier);
 * // Use challenge in authorization request
 * // Use verifier in token request
 * ```
 */
export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToBase64Url(hashBuffer);
}
