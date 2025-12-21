/**
 * CIBA (Client Initiated Backchannel Authentication) Utilities
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 */

import type { CIBARequestMetadata } from '../types/oidc';
import type { JWK } from 'jose';

// =============================================================================
// JWT Hint Validation Types
// =============================================================================

/**
 * Allowed asymmetric JWT algorithms for id_token_hint and login_hint_token
 * Symmetric algorithms (HS256, etc.) are not allowed per security best practices
 */
const ALLOWED_JWT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
] as const;

/**
 * JWT Header structure
 */
interface JWTHeader {
  alg: string;
  typ?: string;
  kid?: string;
}

/**
 * JWT Payload structure for CIBA hints
 */
interface CIBAJWTPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  jti?: string;
  [key: string]: unknown;
}

/**
 * Result of JWT hint validation
 */
export interface JWTHintValidationResult {
  valid: boolean;
  error?: string;
  error_description?: string;
  payload?: CIBAJWTPayload;
  subjectId?: string;
}

/**
 * Options for validating JWT hints
 */
export interface ValidateJWTHintOptions {
  /** Expected issuer (required for id_token_hint, this server's URL) */
  issuerUrl?: string;
  /** Expected audience (required for login_hint_token) */
  audience?: string;
  /** Clock skew tolerance in seconds (default: 60) */
  clockSkewSeconds?: number;
  /** JWKS for signature verification (optional, if not provided, signature is not verified) */
  jwks?: { keys: JWK[] };
}

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

// =============================================================================
// JWT Hint Validation Functions
// =============================================================================

/**
 * Parse JWT without signature verification (internal use)
 *
 * @param jwt - JWT string
 * @returns Parsed header and payload, or null if invalid format
 */
function parseJWTWithoutVerification(jwt: string): {
  header: JWTHeader;
  payload: CIBAJWTPayload;
} | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return null;
    }

    // Decode header (base64url -> JSON)
    const headerJson = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'));
    const header = JSON.parse(headerJson) as JWTHeader;

    // Decode payload (base64url -> JSON)
    const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson) as CIBAJWTPayload;

    return { header, payload };
  } catch {
    return null;
  }
}

/**
 * Validate id_token_hint JWT for CIBA flow
 *
 * Per CIBA spec, id_token_hint must be a valid ID token previously issued
 * by this authorization server. It's used to identify the end-user.
 *
 * Security validations:
 * - Algorithm must be asymmetric (RS256, ES256, etc.) - not 'none' or symmetric
 * - Issuer must match this authorization server
 * - Token must not be expired (with clock skew tolerance)
 * - Token must not be used before nbf (if present)
 * - Sub claim must be present
 *
 * @param idTokenHint - The id_token_hint JWT string
 * @param options - Validation options
 * @returns Validation result with extracted subject ID
 */
export function validateCIBAIdTokenHint(
  idTokenHint: string,
  options: ValidateJWTHintOptions = {}
): JWTHintValidationResult {
  const clockSkew = options.clockSkewSeconds ?? 60;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Parse JWT
  const parsed = parseJWTWithoutVerification(idTokenHint);
  if (!parsed) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'Invalid id_token_hint format: malformed JWT',
    };
  }

  const { header, payload } = parsed;

  // Validate algorithm (must be asymmetric)
  if (!ALLOWED_JWT_ALGORITHMS.includes(header.alg as (typeof ALLOWED_JWT_ALGORITHMS)[number])) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: `Invalid id_token_hint: algorithm '${header.alg}' is not allowed`,
    };
  }

  // Validate issuer (must match our authorization server)
  if (options.issuerUrl && payload.iss !== options.issuerUrl) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'Invalid id_token_hint: issuer does not match authorization server',
    };
  }

  // Validate expiration
  if (payload.exp !== undefined && nowSeconds > payload.exp + clockSkew) {
    return {
      valid: false,
      error: 'expired_token',
      error_description: 'Invalid id_token_hint: token has expired',
    };
  }

  // Validate not-before
  if (payload.nbf !== undefined && nowSeconds < payload.nbf - clockSkew) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'Invalid id_token_hint: token is not yet valid',
    };
  }

  // Validate sub claim (required to identify user)
  if (!payload.sub) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'Invalid id_token_hint: missing sub claim',
    };
  }

  // TODO: Implement signature verification when JWKS is provided
  // For now, log warning if JWKS not configured
  if (!options.jwks) {
    console.warn(
      '[CIBA] id_token_hint signature verification skipped - JWKS not configured. ' +
        'Configure JWKS for production security.'
    );
  }

  return {
    valid: true,
    payload,
    subjectId: payload.sub,
  };
}

/**
 * Validate login_hint_token JWT for CIBA flow
 *
 * Per CIBA spec, login_hint_token is a JWT that contains information about
 * the end-user. It may be issued by a third party that can identify users.
 *
 * Security validations:
 * - Algorithm must be asymmetric (RS256, ES256, etc.)
 * - Audience must match this authorization server
 * - Token must not be expired
 * - Token must not be used before nbf (if present)
 * - Sub or subject claim must be present
 *
 * @param loginHintToken - The login_hint_token JWT string
 * @param options - Validation options
 * @returns Validation result with extracted subject ID
 */
export function validateCIBALoginHintToken(
  loginHintToken: string,
  options: ValidateJWTHintOptions = {}
): JWTHintValidationResult {
  const clockSkew = options.clockSkewSeconds ?? 60;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Parse JWT
  const parsed = parseJWTWithoutVerification(loginHintToken);
  if (!parsed) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'Invalid login_hint_token format: malformed JWT',
    };
  }

  const { header, payload } = parsed;

  // Validate algorithm (must be asymmetric)
  if (!ALLOWED_JWT_ALGORITHMS.includes(header.alg as (typeof ALLOWED_JWT_ALGORITHMS)[number])) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: `Invalid login_hint_token: algorithm '${header.alg}' is not allowed`,
    };
  }

  // Validate audience (must include our authorization server)
  if (options.audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(options.audience)) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'Invalid login_hint_token: audience does not match authorization server',
      };
    }
  }

  // Validate expiration
  if (payload.exp !== undefined && nowSeconds > payload.exp + clockSkew) {
    return {
      valid: false,
      error: 'expired_token',
      error_description: 'Invalid login_hint_token: token has expired',
    };
  }

  // Validate not-before
  if (payload.nbf !== undefined && nowSeconds < payload.nbf - clockSkew) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'Invalid login_hint_token: token is not yet valid',
    };
  }

  // Validate sub claim (required to identify user)
  if (!payload.sub) {
    return {
      valid: false,
      error: 'invalid_request',
      error_description: 'Invalid login_hint_token: missing sub claim',
    };
  }

  // TODO: Implement signature verification when JWKS is provided
  // For login_hint_token, the issuer could be a third party
  if (!options.jwks) {
    console.warn(
      '[CIBA] login_hint_token signature verification skipped - JWKS not configured. ' +
        'Configure JWKS for production security.'
    );
  }

  return {
    valid: true,
    payload,
    subjectId: payload.sub,
  };
}

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
    // Check for NaN (parseInt of non-numeric string returns NaN)
    // NaN comparisons always return false, so explicit check is needed
    if (
      Number.isNaN(params.requested_expiry) ||
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
