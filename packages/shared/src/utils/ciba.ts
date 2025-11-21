/**
 * CIBA (Client Initiated Backchannel Authentication) Utilities
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 */

import type { CIBARequestMetadata } from '../types/oidc';

/**
 * Generate an authentication request ID (auth_req_id)
 * Should be cryptographically random and unique
 *
 * @returns Authentication request ID (UUID v4)
 */
export function generateAuthReqId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a user code for CIBA (optional)
 * Similar to device flow user code but for CIBA binding message
 *
 * Examples: "WDJB-MJHT", "BDSD-HQMK", "PPZZ-JJKK"
 *
 * Character set: Excludes ambiguous characters (0, O, 1, I, L)
 *
 * @returns User code string (format: XXXX-XXXX)
 */
export function generateCIBAUserCode(): string {
  const charset = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const codeLength = 8;
  const separatorPosition = 4;

  let code = '';
  const randomBytes = new Uint8Array(codeLength);
  crypto.getRandomValues(randomBytes);

  for (let i = 0; i < codeLength; i++) {
    const index = randomBytes[i] % charset.length;
    code += charset[index];

    if (i === separatorPosition - 1 && i < codeLength - 1) {
      code += '-';
    }
  }

  return code;
}

/**
 * Check if CIBA request has expired
 *
 * @param metadata - CIBA request metadata
 * @returns true if expired, false otherwise
 */
export function isCIBARequestExpired(metadata: CIBARequestMetadata): boolean {
  return Date.now() > metadata.expires_at;
}

/**
 * Check if client is polling too frequently (slow down detection)
 * CIBA spec: Clients should wait at least the interval specified
 *
 * @param metadata - CIBA request metadata
 * @returns true if polling too fast, false otherwise
 */
export function isPollingTooFast(metadata: CIBARequestMetadata): boolean {
  if (!metadata.last_poll_at) {
    return false;
  }

  const timeSinceLastPoll = Date.now() - metadata.last_poll_at;
  const minimumIntervalMs = metadata.interval * 1000;

  return timeSinceLastPoll < minimumIntervalMs;
}

/**
 * Extract user identifier from login_hint
 * Supports formats:
 * - Email: user@example.com
 * - Phone: +1234567890 or tel:+1234567890
 * - Subject: sub:user123
 * - Username: username
 *
 * @param loginHint - Login hint string
 * @returns Parsed login hint info
 */
export function parseLoginHint(loginHint: string): {
  type: 'email' | 'phone' | 'sub' | 'username';
  value: string;
} {
  // Email format
  if (loginHint.includes('@')) {
    return { type: 'email', value: loginHint.toLowerCase() };
  }

  // Phone format (E.164)
  if (loginHint.startsWith('+') || loginHint.startsWith('tel:')) {
    const phoneNumber = loginHint.replace('tel:', '').trim();
    return { type: 'phone', value: phoneNumber };
  }

  // Subject format
  if (loginHint.startsWith('sub:')) {
    return { type: 'sub', value: loginHint.substring(4) };
  }

  // Default to username
  return { type: 'username', value: loginHint };
}

/**
 * Validate binding message format
 * Should be human-readable and not too long
 *
 * @param bindingMessage - Binding message to validate
 * @returns true if valid, false otherwise
 */
export function validateBindingMessage(bindingMessage: string): boolean {
  // Maximum length (implementation-specific, typically 20-140 chars)
  const MAX_LENGTH = 140;
  const MIN_LENGTH = 1;

  if (bindingMessage.length < MIN_LENGTH || bindingMessage.length > MAX_LENGTH) {
    return false;
  }

  // Should contain printable characters only
  // Allow Unicode letters, numbers, punctuation, and spaces
  const printablePattern = /^[\p{L}\p{N}\p{P}\p{Z}]+$/u;
  return printablePattern.test(bindingMessage);
}

/**
 * Determine token delivery mode from client configuration
 *
 * @param hasNotificationEndpoint - Whether client has notification endpoint
 * @param hasNotificationToken - Whether client provided notification token
 * @returns Delivery mode
 */
export function determineDeliveryMode(
  hasNotificationEndpoint: boolean,
  hasNotificationToken: boolean
): 'poll' | 'ping' | 'push' {
  // Push mode: Client has notification endpoint and provided token
  if (hasNotificationEndpoint && hasNotificationToken) {
    return 'push';
  }

  // Ping mode: Client has notification endpoint but no token
  if (hasNotificationEndpoint && !hasNotificationToken) {
    return 'ping';
  }

  // Poll mode: Default fallback
  return 'poll';
}

/**
 * Calculate appropriate polling interval based on request expiry
 *
 * @param expiresIn - Expiration time in seconds
 * @returns Polling interval in seconds
 */
export function calculatePollingInterval(expiresIn: number): number {
  // For shorter expirations, use shorter intervals
  if (expiresIn <= 60) {
    return CIBA_CONSTANTS.MIN_INTERVAL;
  }
  if (expiresIn <= 300) {
    return 3;
  }
  // Default interval for longer expirations
  return CIBA_CONSTANTS.DEFAULT_INTERVAL;
}

/**
 * CIBA Flow Constants
 * OpenID Connect CIBA Core 1.0 recommended values
 */
export const CIBA_CONSTANTS = {
  // Request expiration time in seconds
  DEFAULT_EXPIRES_IN: 300, // 5 minutes
  MIN_EXPIRES_IN: 60, // 1 minute
  MAX_EXPIRES_IN: 600, // 10 minutes

  // Polling interval in seconds (poll mode)
  DEFAULT_INTERVAL: 5, // 5 seconds
  MIN_INTERVAL: 2, // 2 seconds
  MAX_INTERVAL: 60, // 1 minute

  // Slow down increment when polling too fast
  SLOW_DOWN_INCREMENT: 5, // Add 5 seconds to interval

  // Maximum poll attempts
  MAX_POLL_COUNT: 120, // 120 polls × 5s = 10 minutes max

  // Binding message constraints
  MAX_BINDING_MESSAGE_LENGTH: 140,
  MIN_BINDING_MESSAGE_LENGTH: 1,

  // User code constraints (optional)
  USER_CODE_LENGTH: 9, // 8 chars + 1 hyphen (XXXX-XXXX)

  // Auth req ID format
  AUTH_REQ_ID_FORMAT: 'uuid', // UUID v4

  // Token delivery modes
  DELIVERY_MODES: ['poll', 'ping', 'push'] as const,

  // Default auth_req_id TTL in cache (should match expires_in)
  DEFAULT_AUTH_REQ_TTL: 300, // 5 minutes
} as const;

/**
 * Validate CIBA authentication request parameters
 *
 * @param params - Request parameters
 * @returns Validation result
 */
export function validateCIBARequest(params: {
  scope?: string;
  login_hint?: string;
  login_hint_token?: string;
  id_token_hint?: string;
  binding_message?: string;
  user_code?: string;
  requested_expiry?: number;
}): { valid: boolean; error?: string; error_description?: string } {
  // At least one hint must be provided
  if (!params.login_hint && !params.login_hint_token && !params.id_token_hint) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description:
        'One of login_hint, login_hint_token, or id_token_hint is required',
    };
  }

  // Scope is required
  if (!params.scope) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'scope is required',
    };
  }

  // Validate binding message if provided
  if (params.binding_message && !validateBindingMessage(params.binding_message)) {
    return {
      valid: false,
      error: 'invalid_binding_message',
      error_description: `binding_message must be between ${CIBA_CONSTANTS.MIN_BINDING_MESSAGE_LENGTH} and ${CIBA_CONSTANTS.MAX_BINDING_MESSAGE_LENGTH} characters`,
    };
  }

  // Validate requested_expiry if provided
  if (params.requested_expiry !== undefined) {
    if (
      params.requested_expiry < CIBA_CONSTANTS.MIN_EXPIRES_IN ||
      params.requested_expiry > CIBA_CONSTANTS.MAX_EXPIRES_IN
    ) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: `requested_expiry must be between ${CIBA_CONSTANTS.MIN_EXPIRES_IN} and ${CIBA_CONSTANTS.MAX_EXPIRES_IN} seconds`,
      };
    }
  }

  return { valid: true };
}
