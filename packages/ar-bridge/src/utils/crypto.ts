/**
 * Cryptographic utilities for RP token encryption
 * Uses AES-256-GCM for authenticated encryption
 *
 * Key format: 32-byte hex string (64 characters)
 * Encrypted format: base64(iv || ciphertext || tag)
 *   - iv: 12 bytes (96 bits, recommended for GCM)
 *   - tag: 16 bytes (128 bits, included by WebCrypto automatically)
 */

const IV_LENGTH = 12; // 96 bits for GCM
const KEY_LENGTH = 32; // 256 bits
const HEX_KEY_LENGTH = KEY_LENGTH * 2; // 64 hex characters

/**
 * Error thrown when encryption key format is invalid
 */
export class EncryptionKeyInvalidError extends Error {
  constructor(reason: string) {
    super(
      `RP_TOKEN_ENCRYPTION_KEY format is invalid: ${reason}. ` +
        `Key must be exactly ${HEX_KEY_LENGTH} hex characters (256-bit key). ` +
        'Generate a valid key with: openssl rand -hex 32'
    );
    this.name = 'EncryptionKeyInvalidError';
  }
}

/**
 * Detect weak key patterns (low entropy)
 * Returns reason string if weak, undefined if OK
 */
function detectWeakKeyPattern(key: string): string | undefined {
  const lowerKey = key.toLowerCase();

  // Check for all identical characters (e.g., "0000...0000", "aaaa...aaaa")
  if (/^(.)\1+$/.test(lowerKey)) {
    return 'key contains all identical characters (zero entropy)';
  }

  // Check for short repeating patterns (2-8 chars)
  for (let patternLen = 2; patternLen <= 8; patternLen++) {
    const pattern = lowerKey.slice(0, patternLen);
    const repeated = pattern
      .repeat(Math.ceil(lowerKey.length / patternLen))
      .slice(0, lowerKey.length);
    if (lowerKey === repeated) {
      return `key is a repeating pattern of "${pattern}"`;
    }
  }

  return undefined;
}

/**
 * Validate encryption key format (hex string of correct length)
 * Also checks for obviously weak key patterns
 */
function isValidHexKey(key: string): { valid: boolean; reason?: string } {
  if (key.length !== HEX_KEY_LENGTH) {
    return {
      valid: false,
      reason: `expected ${HEX_KEY_LENGTH} characters, got ${key.length}`,
    };
  }
  if (!/^[0-9a-fA-F]+$/.test(key)) {
    return { valid: false, reason: 'contains non-hex characters' };
  }

  // Check for weak patterns
  const weakReason = detectWeakKeyPattern(key);
  if (weakReason) {
    return { valid: false, reason: weakReason };
  }

  return { valid: true };
}

/**
 * Derives a CryptoKey from hex-encoded key string
 */
async function deriveKey(hexKey: string): Promise<CryptoKey> {
  if (!hexKey || hexKey.length !== KEY_LENGTH * 2) {
    throw new Error(
      `Invalid encryption key: expected ${KEY_LENGTH * 2} hex characters, got ${hexKey?.length || 0}`
    );
  }

  // Convert hex to Uint8Array
  const keyBytes = new Uint8Array(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) {
    keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
  }

  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 *
 * @param plaintext - The string to encrypt
 * @param hexKey - 32-byte hex-encoded encryption key
 * @returns base64-encoded encrypted data (iv + ciphertext + tag)
 */
export async function encrypt(plaintext: string, hexKey: string): Promise<string> {
  const key = await deriveKey(hexKey);

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Encode plaintext to bytes
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // Encrypt with AES-GCM (tag is automatically appended)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    plaintextBytes
  );

  // Combine iv + ciphertext (includes tag)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // Base64 encode
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded ciphertext using AES-256-GCM
 *
 * @param encrypted - base64-encoded encrypted data (iv + ciphertext + tag)
 * @param hexKey - 32-byte hex-encoded encryption key
 * @returns Decrypted plaintext string
 */
export async function decrypt(encrypted: string, hexKey: string): Promise<string> {
  const key = await deriveKey(hexKey);

  // Base64 decode
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  if (combined.length < IV_LENGTH + 16) {
    // Minimum: IV + 16-byte tag
    throw new Error('Invalid encrypted data: too short');
  }

  // Extract IV and ciphertext (includes tag)
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  // Decrypt
  const plaintextBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    ciphertext
  );

  // Decode plaintext
  const decoder = new TextDecoder();
  return decoder.decode(plaintextBytes);
}

/**
 * Get encryption key from environment
 * Throws if not configured or invalid format
 */
export function getEncryptionKey(env: { RP_TOKEN_ENCRYPTION_KEY?: string }): string {
  const key = env.RP_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'RP_TOKEN_ENCRYPTION_KEY is not configured. ' + 'Generate one with: openssl rand -hex 32'
    );
  }

  // Validate key format
  const validation = isValidHexKey(key);
  if (!validation.valid) {
    throw new EncryptionKeyInvalidError(validation.reason!);
  }

  return key;
}

/**
 * Safe version that returns undefined if encryption is not configured
 * (for optional encryption scenarios)
 * Throws EncryptionKeyInvalidError if key is present but has invalid format
 */
export function getEncryptionKeyOrUndefined(env: {
  RP_TOKEN_ENCRYPTION_KEY?: string;
}): string | undefined {
  const key = env.RP_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    return undefined;
  }

  // Validate key format when present
  const validation = isValidHexKey(key);
  if (!validation.valid) {
    throw new EncryptionKeyInvalidError(validation.reason!);
  }

  return key;
}
