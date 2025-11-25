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
  return Date.now() >= metadata.expires_at;
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

  // Username format with explicit prefix
  if (loginHint.startsWith('username:')) {
    return { type: 'username', value: loginHint.substring('username:'.length) };
  }

  // Default to username
  return { type: 'username', value: loginHint };
}

/**
 * Validate binding message format
 * Should be human-readable and not too long
 *
 * @param bindingMessage - Binding message to validate
 * @returns Validation result with error if invalid
 */
export function validateBindingMessage(bindingMessage?: string): {
  valid: boolean;
  error?: string;
} {
  // Empty or undefined is valid
  if (!bindingMessage) {
    return { valid: true };
  }

  if (bindingMessage.length > CIBA_CONSTANTS.MAX_BINDING_MESSAGE_LENGTH) {
    return {
      valid: false,
      error: `Binding message too long (max ${CIBA_CONSTANTS.MAX_BINDING_MESSAGE_LENGTH} characters)`,
    };
  }

  return { valid: true };
}

/**
 * Determine token delivery mode from client configuration
 *
 * @param requestedMode - Requested delivery mode
 * @param notificationEndpoint - Client notification endpoint URL
 * @param clientNotificationToken - Client notification token
 * @returns Delivery mode
 */
export function determineDeliveryMode(
  requestedMode: string | null,
  notificationEndpoint: string | null,
  clientNotificationToken: string | null
): 'poll' | 'ping' | 'push' {
  // Ping mode: Requires both endpoint and token
  if (requestedMode === 'ping' && notificationEndpoint && clientNotificationToken) {
    return 'ping';
  }

  // Push mode: Requires both endpoint and token
  if (requestedMode === 'push' && notificationEndpoint && clientNotificationToken) {
    return 'push';
  }

  // Poll mode: Default fallback
  return 'poll';
}

/**
 * Calculate appropriate polling interval based on request expiry
 *
 * @param requestedInterval - Requested interval in seconds (null for default)
 * @returns Polling interval in seconds
 */
export function calculatePollingInterval(requestedInterval: number | null): number {
  // Use default if not specified
  if (requestedInterval === null || requestedInterval === undefined) {
    return CIBA_CONSTANTS.DEFAULT_INTERVAL;
  }

  // Enforce minimum
  if (requestedInterval < CIBA_CONSTANTS.MIN_INTERVAL) {
    return CIBA_CONSTANTS.MIN_INTERVAL;
  }

  // Enforce maximum
  if (requestedInterval > CIBA_CONSTANTS.MAX_INTERVAL) {
    return CIBA_CONSTANTS.MAX_INTERVAL;
  }

  return requestedInterval;
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
      error_description: 'One of login_hint, login_hint_token, or id_token_hint is required',
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
  if (params.binding_message) {
    const bindingValidation = validateBindingMessage(params.binding_message);
    if (!bindingValidation.valid) {
      return {
        valid: false,
        error: 'invalid_binding_message',
        error_description: bindingValidation.error,
      };
    }
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
