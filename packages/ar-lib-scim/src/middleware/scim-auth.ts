/**
 * SCIM 2.0 Authentication Middleware
 *
 * Implements Bearer token authentication for SCIM endpoints
 * as per RFC 7644 Section 2
 *
 * Security features:
 * - Rate limiting for failed authentication attempts (brute force protection)
 * - Logging of failed attempts for security monitoring
 * - Timing-safe token comparison (via hash comparison)
 * - Configurable delay on failed attempts
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7644#section-2
 */

import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { SCIM_SCHEMAS } from '../types/scim';
import type { ScimError } from '../types/scim';

/**
 * Default SCIM authentication rate limit configuration
 * Limits failed authentication attempts per IP
 *
 * These values can be overridden via environment variables:
 * - SCIM_AUTH_MAX_FAILED_ATTEMPTS: Maximum failed attempts before lockout (default: 5)
 * - SCIM_AUTH_WINDOW_SECONDS: Time window for counting failures (default: 300)
 * - SCIM_AUTH_LOCKOUT_SECONDS: Lockout duration after exceeding limit (default: 900)
 * - SCIM_AUTH_FAILURE_DELAY_MS: Base delay on failed attempt (default: 200)
 * - SCIM_AUTH_RATE_LIMIT_DISABLED: Set to "true" to disable rate limiting (for testing)
 */
const DEFAULT_SCIM_AUTH_RATE_LIMIT = {
  maxFailedAttempts: 5, // Maximum failed attempts before lockout
  windowSeconds: 300, // 5 minutes window
  lockoutSeconds: 900, // 15 minutes lockout after exceeding limit
  failureDelayMs: 200, // Base delay on failed attempt (ms)
};

/**
 * Get rate limit configuration from environment variables
 * Falls back to defaults if not specified
 */
function getScimAuthRateLimitConfig(env: Env): typeof DEFAULT_SCIM_AUTH_RATE_LIMIT & {
  disabled: boolean;
} {
  return {
    maxFailedAttempts:
      parseInt(env.SCIM_AUTH_MAX_FAILED_ATTEMPTS as string, 10) ||
      DEFAULT_SCIM_AUTH_RATE_LIMIT.maxFailedAttempts,
    windowSeconds:
      parseInt(env.SCIM_AUTH_WINDOW_SECONDS as string, 10) ||
      DEFAULT_SCIM_AUTH_RATE_LIMIT.windowSeconds,
    lockoutSeconds:
      parseInt(env.SCIM_AUTH_LOCKOUT_SECONDS as string, 10) ||
      DEFAULT_SCIM_AUTH_RATE_LIMIT.lockoutSeconds,
    failureDelayMs:
      parseInt(env.SCIM_AUTH_FAILURE_DELAY_MS as string, 10) ||
      DEFAULT_SCIM_AUTH_RATE_LIMIT.failureDelayMs,
    disabled: env.SCIM_AUTH_RATE_LIMIT_DISABLED === 'true',
  };
}

/**
 * Get client IP address from request (Cloudflare-aware)
 */
function getClientIP(c: Context): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

/**
 * Check if IP is rate limited for SCIM auth failures
 */
async function checkAuthRateLimit(
  env: Env,
  clientIP: string,
  config: ReturnType<typeof getScimAuthRateLimitConfig>
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  // Skip rate limiting if disabled (for testing)
  if (config.disabled) {
    return { allowed: true, remaining: config.maxFailedAttempts, retryAfter: 0 };
  }

  try {
    // Use RATE_LIMITER DO for atomic rate limiting (RPC)
    if (env.RATE_LIMITER) {
      const id = env.RATE_LIMITER.idFromName(`scim-auth:${clientIP}`);
      const stub = env.RATE_LIMITER.get(id);

      // RPC call to increment counter atomically
      const result = await stub.incrementRpc(clientIP, {
        windowSeconds: config.windowSeconds,
        maxRequests: config.maxFailedAttempts,
      });

      return {
        allowed: result.allowed,
        remaining: Math.max(0, result.limit - result.current),
        retryAfter: result.retryAfter,
      };
    }

    // Fallback to KV-based rate limiting
    return await checkAuthRateLimitKV(env, clientIP, config);
  } catch (error) {
    console.error('[SCIM Auth] Rate limit check error:', error);
    // Fail open - allow request on rate limit error
    return { allowed: true, remaining: config.maxFailedAttempts, retryAfter: 0 };
  }
}

/**
 * KV-based fallback for auth rate limiting
 */
async function checkAuthRateLimitKV(
  env: Env,
  clientIP: string,
  config: ReturnType<typeof getScimAuthRateLimitConfig>
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const key = `scim-auth-fail:${clientIP}`;

  try {
    const recordJson = await env.STATE_STORE?.get(key);

    if (recordJson) {
      const record = JSON.parse(recordJson) as { count: number; resetAt: number };

      if (now < record.resetAt) {
        // Window still active
        const remaining = Math.max(0, config.maxFailedAttempts - record.count);
        const retryAfter = record.count >= config.maxFailedAttempts ? record.resetAt - now : 0;

        return {
          allowed: record.count < config.maxFailedAttempts,
          remaining,
          retryAfter,
        };
      }
    }

    // No record or window expired - allowed
    return { allowed: true, remaining: config.maxFailedAttempts, retryAfter: 0 };
  } catch (error) {
    console.error('[SCIM Auth] KV rate limit check error:', error);
    return { allowed: true, remaining: config.maxFailedAttempts, retryAfter: 0 };
  }
}

/**
 * Record a failed authentication attempt
 */
async function recordFailedAttempt(
  env: Env,
  clientIP: string,
  config: ReturnType<typeof getScimAuthRateLimitConfig>
): Promise<void> {
  // Skip recording if rate limiting is disabled
  if (config.disabled) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const key = `scim-auth-fail:${clientIP}`;

  try {
    const recordJson = await env.STATE_STORE?.get(key);
    let record: { count: number; resetAt: number };

    if (recordJson) {
      record = JSON.parse(recordJson);
      if (now >= record.resetAt) {
        // Window expired, reset
        record = { count: 1, resetAt: now + config.windowSeconds };
      } else {
        record.count++;
      }
    } else {
      record = { count: 1, resetAt: now + config.windowSeconds };
    }

    await env.STATE_STORE?.put(key, JSON.stringify(record), {
      expirationTtl: config.windowSeconds + 60,
    });
  } catch (error) {
    console.error('[SCIM Auth] Failed to record failed attempt:', error);
  }
}

/**
 * Log authentication attempt for security monitoring
 */
function logAuthAttempt(
  clientIP: string,
  success: boolean,
  reason?: string,
  details?: Record<string, unknown>
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event: 'scim_auth_attempt',
    clientIP,
    success,
    reason,
    ...details,
  };

  if (success) {
    console.log('[SCIM Auth]', JSON.stringify(logEntry));
  } else {
    console.warn('[SCIM Auth] Failed:', JSON.stringify(logEntry));
  }
}

/**
 * Add delay to slow down brute force attacks
 * Uses exponential backoff based on recent failure count
 */
async function applyFailureDelay(
  failureCount: number,
  config: ReturnType<typeof getScimAuthRateLimitConfig>
): Promise<void> {
  // Skip delay if rate limiting is disabled
  if (config.disabled) {
    return;
  }

  // Base delay with exponential backoff (capped at 2 seconds)
  const delay = Math.min(config.failureDelayMs * Math.pow(1.5, failureCount - 1), 2000);

  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * SCIM Bearer Token Authentication Middleware
 *
 * Validates Bearer tokens against configured SCIM tokens in KV storage
 * or database. Tokens should be generated and stored securely.
 *
 * Security features:
 * - Rate limiting for failed attempts (configurable via env vars)
 * - Exponential backoff delay on failures
 * - Detailed logging for security monitoring
 *
 * Environment variables for rate limiting:
 * - SCIM_AUTH_MAX_FAILED_ATTEMPTS: Max failures before lockout (default: 5)
 * - SCIM_AUTH_WINDOW_SECONDS: Time window for counting failures (default: 300)
 * - SCIM_AUTH_LOCKOUT_SECONDS: Lockout duration (default: 900)
 * - SCIM_AUTH_FAILURE_DELAY_MS: Base delay on failure (default: 200)
 * - SCIM_AUTH_RATE_LIMIT_DISABLED: Set to "true" to disable rate limiting
 */
export async function scimAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const clientIP = getClientIP(c);
  const authHeader = c.req.header('Authorization');

  // Get rate limit configuration from environment
  const rateLimitConfig = getScimAuthRateLimitConfig(c.env);

  // Check rate limit before processing
  const rateLimit = await checkAuthRateLimit(c.env, clientIP, rateLimitConfig);

  if (!rateLimit.allowed) {
    logAuthAttempt(clientIP, false, 'rate_limited', { retryAfter: rateLimit.retryAfter });

    c.header('Retry-After', rateLimit.retryAfter.toString());

    return scimErrorResponse(
      c,
      401,
      `Too many failed authentication attempts. Please try again in ${rateLimit.retryAfter} seconds.`
    );
  }

  if (!authHeader) {
    await recordFailedAttempt(c.env, clientIP, rateLimitConfig);
    logAuthAttempt(clientIP, false, 'missing_auth_header');
    await applyFailureDelay(
      rateLimitConfig.maxFailedAttempts - rateLimit.remaining + 1,
      rateLimitConfig
    );

    // Security: Generic message to prevent authentication enumeration
    return scimErrorResponse(c, 401, 'Authentication failed');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    await recordFailedAttempt(c.env, clientIP, rateLimitConfig);
    logAuthAttempt(clientIP, false, 'invalid_auth_format');
    await applyFailureDelay(
      rateLimitConfig.maxFailedAttempts - rateLimit.remaining + 1,
      rateLimitConfig
    );

    // Security: Generic message to prevent authentication enumeration
    return scimErrorResponse(c, 401, 'Authentication failed');
  }

  const token = parts[1];

  try {
    // Validate token against stored SCIM tokens
    const isValid = await validateScimToken(c.env, token);

    if (!isValid) {
      await recordFailedAttempt(c.env, clientIP, rateLimitConfig);
      logAuthAttempt(clientIP, false, 'invalid_token');
      await applyFailureDelay(
        rateLimitConfig.maxFailedAttempts - rateLimit.remaining + 1,
        rateLimitConfig
      );

      // Security: Generic message to prevent token enumeration
      return scimErrorResponse(c, 401, 'Authentication failed');
    }

    // Token is valid
    logAuthAttempt(clientIP, true);

    // Token is valid, proceed to next middleware
    await next();
  } catch (error) {
    console.error('[SCIM Auth] Validation error:', error);
    return scimErrorResponse(c, 500, 'Internal server error during authentication');
  }
}

/**
 * Validate SCIM token
 *
 * This implementation checks against KV storage where SCIM tokens are stored.
 * You can customize this to use database or other storage.
 */
async function validateScimToken(env: Env, token: string): Promise<boolean> {
  try {
    // Hash the token to match stored format
    const tokenHash = await hashToken(token);

    // Check in INITIAL_ACCESS_TOKENS KV namespace (reusing existing infrastructure)
    // or create a dedicated SCIM_TOKENS namespace
    const storedToken = await env.INITIAL_ACCESS_TOKENS?.get(`scim:${tokenHash}`);

    if (!storedToken) {
      return false;
    }

    // Parse token metadata
    const tokenData = JSON.parse(storedToken);

    // Check if token is expired
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return false;
    }

    // Check if token is enabled
    if (tokenData.enabled === false) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('Token validation error:', error);
    return false;
  }
}

/**
 * Hash token for secure storage comparison
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return SCIM-compliant error response
 */
function scimErrorResponse(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 500,
  detail: string,
  scimType?: string
) {
  const error: ScimError = {
    schemas: [SCIM_SCHEMAS.ERROR],
    status: status.toString(),
    detail,
  };

  if (scimType) {
    error.scimType = scimType as any;
  }

  return c.json(error, status);
}

/**
 * Generate a new SCIM token (for admin use)
 */
export async function generateScimToken(
  env: Env,
  options: {
    description?: string;
    expiresInDays?: number;
    enabled?: boolean;
  } = {}
): Promise<{ token: string; tokenHash: string }> {
  // Generate a cryptographically secure random token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const tokenHash = await hashToken(token);

  const expiresAt = options.expiresInDays
    ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const tokenData = {
    description: options.description || 'SCIM provisioning token',
    createdAt: new Date().toISOString(),
    expiresAt,
    enabled: options.enabled !== false,
    type: 'scim',
  };

  // Store in KV
  await env.INITIAL_ACCESS_TOKENS?.put(`scim:${tokenHash}`, JSON.stringify(tokenData), {
    expirationTtl: options.expiresInDays ? options.expiresInDays * 24 * 60 * 60 : undefined,
  });

  return { token, tokenHash };
}

/**
 * Revoke a SCIM token
 */
export async function revokeScimToken(env: Env, tokenHash: string): Promise<boolean> {
  try {
    await env.INITIAL_ACCESS_TOKENS?.delete(`scim:${tokenHash}`);
    return true;
  } catch (error) {
    console.error('Token revocation error:', error);
    return false;
  }
}

/**
 * List all SCIM tokens (admin function)
 */
export async function listScimTokens(env: Env): Promise<
  Array<{
    tokenHash: string;
    description: string;
    createdAt: string;
    expiresAt: string | null;
    enabled: boolean;
  }>
> {
  const tokens: Array<any> = [];

  try {
    const list = await env.INITIAL_ACCESS_TOKENS?.list({ prefix: 'scim:' });

    if (!list) {
      return [];
    }

    for (const key of list.keys) {
      const value = await env.INITIAL_ACCESS_TOKENS?.get(key.name);
      if (value) {
        const tokenData = JSON.parse(value);
        tokens.push({
          tokenHash: key.name.replace('scim:', ''),
          description: tokenData.description,
          createdAt: tokenData.createdAt,
          expiresAt: tokenData.expiresAt,
          enabled: tokenData.enabled,
        });
      }
    }
  } catch (error) {
    console.error('List tokens error:', error);
  }

  return tokens;
}

/**
 * Optional: Database-based token validation
 *
 * If you prefer to store SCIM tokens in the database instead of KV,
 * you can create a `scim_tokens` table and use this function.
 */
export async function validateScimTokenFromDB(db: D1Database, token: string): Promise<boolean> {
  try {
    const tokenHash = await hashToken(token);

    const result = await db
      .prepare(
        `SELECT id, expires_at, enabled FROM scim_tokens
         WHERE token_hash = ? AND enabled = 1`
      )
      .bind(tokenHash)
      .first<{ id: string; expires_at: string | null; enabled: number }>();

    if (!result) {
      return false;
    }

    // Check expiration
    if (result.expires_at && new Date(result.expires_at) < new Date()) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('DB token validation error:', error);
    return false;
  }
}
