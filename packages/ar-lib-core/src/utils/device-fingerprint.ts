/**
 * Device Fingerprint Utilities
 *
 * Provides secure handling of device identifiers for anonymous authentication.
 * All identifiers are hashed using HMAC-SHA256 before storage - plaintext is never stored.
 *
 * Security Features:
 * - HMAC-SHA256 with per-tenant secret for device ID hashing
 * - Input validation to prevent injection attacks
 * - Challenge-response pattern for device verification
 *
 * @see architecture-decisions.md §17 for design details
 */

import type { DeviceStability } from '../types/contracts/client';

// =============================================================================
// Types
// =============================================================================

/**
 * Device identifiers provided by the client.
 * At least device_id is required; others are optional.
 */
export interface DeviceIdentifiers {
  /** Primary device identifier (required) */
  device_id: string;
  /** App installation ID (optional, more stable than device_id on some platforms) */
  installation_id?: string;
  /** Browser fingerprint hash from client (optional) */
  fingerprint?: string;
  /** Device platform */
  platform?: 'ios' | 'android' | 'web' | 'other';
}

/**
 * Hashed device signature for storage.
 * All values are HMAC-SHA256 hashes, never plaintext.
 */
export interface DeviceSignature {
  device_id_hash: string;
  installation_id_hash?: string;
  fingerprint_hash?: string;
  device_platform?: 'ios' | 'android' | 'web' | 'other';
}

/**
 * Device challenge for verification.
 */
export interface DeviceChallenge {
  challenge_id: string;
  challenge: string;
  expires_at: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Valid device ID formats (UUID v4, IDFV, Android ID patterns) */
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

/** UUID v4 pattern for strict validation */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum length for any identifier */
const MAX_IDENTIFIER_LENGTH = 256;

/** Challenge TTL in seconds */
const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

// =============================================================================
// Hashing Functions
// =============================================================================

/**
 * Hash device identifiers using HMAC-SHA256.
 * Uses per-tenant secret for additional security.
 *
 * @param identifiers - Device identifiers from client
 * @param hmacSecret - Per-tenant HMAC secret
 * @returns Hashed device signature for storage
 */
export async function hashDeviceIdentifiers(
  identifiers: DeviceIdentifiers,
  hmacSecret: string
): Promise<DeviceSignature> {
  // Validate input
  if (!validateDeviceId(identifiers.device_id)) {
    throw new Error('Invalid device_id format');
  }

  // Import HMAC key
  const encoder = new TextEncoder();
  const keyData = encoder.encode(hmacSecret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Hash device_id (required)
  const device_id_hash = await hmacSha256(key, identifiers.device_id);

  // Hash optional identifiers
  let installation_id_hash: string | undefined;
  if (identifiers.installation_id) {
    if (!validateIdentifier(identifiers.installation_id)) {
      throw new Error('Invalid installation_id format');
    }
    installation_id_hash = await hmacSha256(key, identifiers.installation_id);
  }

  let fingerprint_hash: string | undefined;
  if (identifiers.fingerprint) {
    if (!validateIdentifier(identifiers.fingerprint)) {
      throw new Error('Invalid fingerprint format');
    }
    fingerprint_hash = await hmacSha256(key, identifiers.fingerprint);
  }

  return {
    device_id_hash,
    installation_id_hash,
    fingerprint_hash,
    device_platform: identifiers.platform,
  };
}

/**
 * Verify device signature matches stored hashes.
 *
 * @param identifiers - Device identifiers from client
 * @param storedSignature - Previously stored signature
 * @param hmacSecret - Per-tenant HMAC secret
 * @returns true if device matches
 */
export async function verifyDeviceSignature(
  identifiers: DeviceIdentifiers,
  storedSignature: DeviceSignature,
  hmacSecret: string
): Promise<boolean> {
  try {
    const currentSignature = await hashDeviceIdentifiers(identifiers, hmacSecret);

    // Primary check: device_id_hash must match
    if (!timingSafeEqual(currentSignature.device_id_hash, storedSignature.device_id_hash)) {
      return false;
    }

    // Optional checks: if stored, must match
    if (
      storedSignature.installation_id_hash &&
      currentSignature.installation_id_hash &&
      !timingSafeEqual(currentSignature.installation_id_hash, storedSignature.installation_id_hash)
    ) {
      return false;
    }

    if (
      storedSignature.fingerprint_hash &&
      currentSignature.fingerprint_hash &&
      !timingSafeEqual(currentSignature.fingerprint_hash, storedSignature.fingerprint_hash)
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Challenge Functions
// =============================================================================

/**
 * Generate a cryptographic challenge for device verification.
 *
 * @returns Challenge ID and random challenge string
 */
export function generateDeviceChallenge(): DeviceChallenge {
  const challenge_id = crypto.randomUUID();
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = bytesToBase64Url(challengeBytes);

  return {
    challenge_id,
    challenge,
    expires_at: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS,
  };
}

/**
 * Create a signed challenge response.
 * Client signs the challenge with their device key.
 *
 * @param challenge - Challenge string from server
 * @param deviceId - Device ID
 * @param timestamp - Current timestamp
 * @param hmacSecret - Per-tenant HMAC secret
 * @returns Signed response
 */
export async function createChallengeResponse(
  challenge: string,
  deviceId: string,
  timestamp: number,
  hmacSecret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(hmacSecret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const message = `${challenge}:${deviceId}:${timestamp}`;
  return await hmacSha256(key, message);
}

/**
 * Verify a challenge response.
 *
 * @param challenge - Original challenge
 * @param response - Client's signed response
 * @param deviceId - Device ID
 * @param timestamp - Timestamp from client
 * @param hmacSecret - Per-tenant HMAC secret
 * @param maxAgeSec - Maximum age of response in seconds (default: 60)
 * @returns true if response is valid
 */
export async function verifyChallengeResponse(
  challenge: string,
  response: string,
  deviceId: string,
  timestamp: number,
  hmacSecret: string,
  maxAgeSec: number = 60
): Promise<boolean> {
  // Check timestamp is within acceptable range
  const now = Math.floor(Date.now() / 1000);
  if (timestamp < now - maxAgeSec || timestamp > now + 5) {
    return false; // Too old or in the future
  }

  const expectedResponse = await createChallengeResponse(
    challenge,
    deviceId,
    timestamp,
    hmacSecret
  );
  return timingSafeEqual(response, expectedResponse);
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate device ID format.
 * Accepts UUID v4, IDFV, Android ID, and similar formats.
 *
 * @param deviceId - Device ID to validate
 * @returns true if format is valid
 */
export function validateDeviceId(deviceId: string): boolean {
  if (!deviceId || typeof deviceId !== 'string') {
    return false;
  }

  if (deviceId.length > MAX_IDENTIFIER_LENGTH) {
    return false;
  }

  // Must match allowed pattern
  return DEVICE_ID_PATTERN.test(deviceId);
}

/**
 * Validate any identifier (installation_id, fingerprint, etc.)
 *
 * @param identifier - Identifier to validate
 * @returns true if format is valid
 */
export function validateIdentifier(identifier: string): boolean {
  if (!identifier || typeof identifier !== 'string') {
    return false;
  }

  if (identifier.length > MAX_IDENTIFIER_LENGTH) {
    return false;
  }

  // Allow alphanumeric, dash, underscore, equals (for base64)
  return /^[a-zA-Z0-9_=-]+$/.test(identifier);
}

/**
 * Check if a device ID is a valid UUID v4.
 *
 * @param deviceId - Device ID to check
 * @returns true if it's a valid UUID v4
 */
export function isValidUuidV4(deviceId: string): boolean {
  return UUID_V4_PATTERN.test(deviceId);
}

/**
 * Validate device stability level.
 *
 * @param stability - Stability level to validate
 * @returns true if valid
 */
export function validateDeviceStability(stability: string): stability is DeviceStability {
  return stability === 'session' || stability === 'installation' || stability === 'device';
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Compute HMAC-SHA256 and return as hex string.
 */
async function hmacSha256(key: CryptoKey, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Convert bytes to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert bytes to base64url string.
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
}

/**
 * Timing-safe string comparison.
 * Prevents timing attacks by always comparing all characters.
 *
 * Security: This function MUST:
 * 1. Take constant time regardless of where strings differ
 * 2. Not leak length information through timing
 * 3. Return false for different-length strings
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Store original length comparison result BEFORE any modifications
  const lengthsMatch = a.length === b.length;

  // Use the longer length to ensure we always iterate the same amount
  // regardless of which string is longer (prevents length-based timing leaks)
  const compareLength = Math.max(a.length, b.length);

  let result = 0;
  for (let i = 0; i < compareLength; i++) {
    // Use 0 as padding for shorter string to maintain constant time
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  // Both conditions must be true:
  // 1. All character XORs resulted in 0 (strings are identical where they overlap)
  // 2. Lengths were equal (no padding was used)
  return result === 0 && lengthsMatch;
}
