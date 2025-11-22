/**
 * Device Flow Utilities
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628
 */

import type { DeviceCodeMetadata } from '../types/oidc';

/**
 * Generate a device code (opaque, unique identifier)
 * Uses UUID v4 for uniqueness and unpredictability
 *
 * @returns Device code string (UUID v4)
 */
export function generateDeviceCode(): string {
  return crypto.randomUUID();
}

/**
 * Generate a user code (short, human-readable code)
 * RFC 8628 recommends: Short, case-insensitive, human-readable
 * Common format: 8 characters, uppercase letters and digits, with hyphen separator
 *
 * Examples: "WDJB-MJHT", "BDSD-HQMK", "PPZZ-JJKK"
 *
 * Character set: Excludes ambiguous characters (0, O, 1, I, L)
 * to reduce user input errors
 *
 * @returns User code string (format: XXXX-XXXX)
 */
export function generateUserCode(): string {
  // Character set excluding ambiguous characters
  // Removed: 0 (zero), O (letter O), 1 (one), I (letter I), L (letter L)
  const charset = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const codeLength = 8;
  const separatorPosition = 4;

  let code = '';
  const randomBytes = new Uint8Array(codeLength);
  crypto.getRandomValues(randomBytes);

  for (let i = 0; i < codeLength; i++) {
    // Use modulo to map random byte to charset index
    const index = randomBytes[i] % charset.length;
    code += charset[index];

    // Add hyphen separator for readability
    if (i === separatorPosition - 1 && i < codeLength - 1) {
      code += '-';
    }
  }

  return code;
}

/**
 * Validate user code format
 * Checks if the user code matches the expected format: XXXX-XXXX
 *
 * @param userCode - User code to validate
 * @returns true if valid, false otherwise
 */
export function validateUserCodeFormat(userCode: string): boolean {
  // Expected format: 4 chars, hyphen, 4 chars
  // Only allowed characters from our charset (excluding 0, O, 1, I, L)
  const pattern = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
  return pattern.test(userCode.toUpperCase());
}

/**
 * Normalize user code
 * Converts to uppercase and adds hyphen if missing
 *
 * @param userCode - User code to normalize
 * @returns Normalized user code
 */
export function normalizeUserCode(userCode: string): string {
  // Remove any existing hyphens and convert to uppercase
  const cleaned = userCode.replace(/-/g, '').toUpperCase();

  // Add hyphen at position 4 if code is 8 characters
  if (cleaned.length === 8) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
  }

  return cleaned;
}

/**
 * Check if device code has expired
 *
 * @param metadata - Device code metadata
 * @returns true if expired, false otherwise
 */
export function isDeviceCodeExpired(metadata: DeviceCodeMetadata): boolean {
  return Date.now() > metadata.expires_at;
}

/**
 * Check if device is polling too frequently (slow down detection)
 * RFC 8628: Clients should wait at least the interval specified
 *
 * @param metadata - Device code metadata
 * @param minimumInterval - Minimum interval in seconds (default 5)
 * @returns true if polling too fast, false otherwise
 */
export function isDeviceFlowPollingTooFast(
  metadata: DeviceCodeMetadata,
  minimumInterval: number = 5
): boolean {
  if (!metadata.last_poll_at) {
    return false;
  }

  const timeSinceLastPoll = Date.now() - metadata.last_poll_at;
  const minimumIntervalMs = minimumInterval * 1000;

  return timeSinceLastPoll < minimumIntervalMs;
}

/**
 * Get verification URI with user code embedded
 * Useful for QR codes and direct links
 *
 * @param baseUri - Base verification URI
 * @param userCode - User code to embed
 * @returns Complete verification URI
 */
export function getVerificationUriComplete(
  baseUri: string,
  userCode: string
): string {
  const url = new URL(baseUri);
  url.searchParams.set('user_code', userCode);
  return url.toString();
}

/**
 * Device Flow Constants
 * RFC 8628 recommended values
 */
export const DEVICE_FLOW_CONSTANTS = {
  // Code expiration time in seconds (5-10 minutes recommended)
  DEFAULT_EXPIRES_IN: 600, // 10 minutes
  MIN_EXPIRES_IN: 300, // 5 minutes
  MAX_EXPIRES_IN: 1800, // 30 minutes

  // Polling interval in seconds
  DEFAULT_INTERVAL: 5, // 5 seconds
  MIN_INTERVAL: 1, // 1 second (not recommended)
  MAX_INTERVAL: 60, // 1 minute

  // Slow down increment when polling too fast
  SLOW_DOWN_INCREMENT: 5, // Add 5 seconds to interval

  // Maximum poll attempts before giving up
  MAX_POLL_COUNT: 120, // 120 polls × 5s = 10 minutes max
} as const;
