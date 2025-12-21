/**
 * Rate Limiting Middleware for Check API
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Implements sliding window rate limiting using KV storage:
 * - Tracks request counts per client/API key
 * - Supports multiple rate limit tiers (strict, moderate, lenient)
 * - Configurable via KV for dynamic updates without redeployment
 *
 * Security features:
 * - Per-client isolation
 * - Tenant-aware rate limiting
 * - Graceful degradation when KV is unavailable
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { RateLimitTier } from '@authrim/shared';
import type { CheckAuthResult } from './check-auth';

// =============================================================================
// Types
// =============================================================================

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in window */
  requests: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current request count in window */
  current: number;
  /** Maximum requests allowed */
  limit: number;
  /** Remaining requests */
  remaining: number;
  /** Unix timestamp when the window resets */
  resetAt: number;
  /** Retry-After header value (seconds) */
  retryAfter?: number;
}

/**
 * Rate limit context
 */
export interface RateLimitContext {
  /** KV namespace for rate limit storage */
  cache?: KVNamespace;
  /** Optional KV namespace for config overrides */
  configKv?: KVNamespace;
}

// =============================================================================
// Constants
// =============================================================================

/** Default rate limit configurations by tier */
export const DEFAULT_RATE_LIMIT_CONFIG: Record<RateLimitTier, RateLimitConfig> = {
  strict: { requests: 100, windowMs: 60000 }, // 100/min
  moderate: { requests: 500, windowMs: 60000 }, // 500/min
  lenient: { requests: 2000, windowMs: 60000 }, // 2000/min
};

/** KV key prefix for rate limit counters */
const RATE_LIMIT_KEY_PREFIX = 'ratelimit:check:';

/** KV key prefix for rate limit config overrides */
const RATE_LIMIT_CONFIG_PREFIX = 'ratelimit:config:';

/** Counter expiration padding (extra time after window expires) */
const COUNTER_EXPIRATION_PADDING_MS = 5000;

// =============================================================================
// Configuration Helpers
// =============================================================================

/**
 * Get rate limit configuration for a tier
 * Priority: KV → Default
 */
export async function getRateLimitConfig(
  tier: RateLimitTier,
  configKv?: KVNamespace
): Promise<RateLimitConfig> {
  // Try KV override first
  if (configKv) {
    try {
      const cached = await configKv.get(`${RATE_LIMIT_CONFIG_PREFIX}${tier}`);
      if (cached) {
        const config = JSON.parse(cached) as RateLimitConfig;
        if (typeof config.requests === 'number' && typeof config.windowMs === 'number') {
          return config;
        }
      }
    } catch {
      // KV error - fall through to defaults
    }
  }

  return DEFAULT_RATE_LIMIT_CONFIG[tier];
}

/**
 * Set rate limit configuration override
 */
export async function setRateLimitConfig(
  tier: RateLimitTier,
  config: RateLimitConfig,
  configKv: KVNamespace
): Promise<void> {
  await configKv.put(`${RATE_LIMIT_CONFIG_PREFIX}${tier}`, JSON.stringify(config));
}

/**
 * Clear rate limit configuration override
 */
export async function clearRateLimitConfig(
  tier: RateLimitTier,
  configKv: KVNamespace
): Promise<void> {
  await configKv.delete(`${RATE_LIMIT_CONFIG_PREFIX}${tier}`);
}

// =============================================================================
// Rate Limiting Logic
// =============================================================================

/**
 * Generate rate limit key for a client
 */
function getRateLimitKey(auth: CheckAuthResult): string {
  // Key components for isolation
  const components: string[] = [RATE_LIMIT_KEY_PREFIX];

  // Tenant isolation
  if (auth.tenantId) {
    components.push(`t:${auth.tenantId}`);
  }

  // Client/key isolation
  if (auth.apiKeyId) {
    // API key - use key ID
    components.push(`k:${auth.apiKeyId}`);
  } else if (auth.clientId) {
    // Access token - use client ID
    components.push(`c:${auth.clientId}`);
    if (auth.subjectId) {
      // Add subject for user-specific limits
      components.push(`s:${auth.subjectId}`);
    }
  } else if (auth.method === 'policy_secret') {
    // Internal service - use method
    components.push('internal');
  }

  return components.join(':');
}

/**
 * Get current window timestamp
 */
function getWindowTimestamp(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

/**
 * Check rate limit for a request
 *
 * Uses a simple sliding window algorithm:
 * - Count requests in the current window
 * - If count exceeds limit, deny the request
 */
export async function checkRateLimit(
  auth: CheckAuthResult,
  ctx: RateLimitContext
): Promise<RateLimitResult> {
  // Get tier and configuration
  const tier = auth.rateLimitTier || 'strict';
  const config = await getRateLimitConfig(tier, ctx.configKv);

  // If no cache available, allow but log warning
  if (!ctx.cache) {
    console.warn('[Rate Limit] KV cache not available - rate limiting disabled');
    return {
      allowed: true,
      current: 0,
      limit: config.requests,
      remaining: config.requests,
      resetAt: getWindowTimestamp(config.windowMs) + config.windowMs,
    };
  }

  const key = getRateLimitKey(auth);
  const windowStart = getWindowTimestamp(config.windowMs);
  const windowKey = `${key}:${windowStart}`;

  try {
    // Get current count
    const currentStr = await ctx.cache.get(windowKey);
    let current = currentStr ? parseInt(currentStr, 10) : 0;

    // Check if over limit
    if (current >= config.requests) {
      const resetAt = windowStart + config.windowMs;
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);

      return {
        allowed: false,
        current,
        limit: config.requests,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Increment counter
    current += 1;

    // Store with expiration (window duration + padding)
    const expirationTtl = Math.ceil((config.windowMs + COUNTER_EXPIRATION_PADDING_MS) / 1000);
    await ctx.cache.put(windowKey, current.toString(), { expirationTtl });

    return {
      allowed: true,
      current,
      limit: config.requests,
      remaining: Math.max(0, config.requests - current),
      resetAt: windowStart + config.windowMs,
    };
  } catch (error) {
    // On error, allow the request but log
    console.error('[Rate Limit] Error checking rate limit:', error);
    return {
      allowed: true,
      current: 0,
      limit: config.requests,
      remaining: config.requests,
      resetAt: getWindowTimestamp(config.windowMs) + config.windowMs,
    };
  }
}

/**
 * Add rate limit headers to response
 */
export function addRateLimitHeaders(headers: Headers, result: RateLimitResult): void {
  headers.set('X-RateLimit-Limit', result.limit.toString());
  headers.set('X-RateLimit-Remaining', result.remaining.toString());
  headers.set('X-RateLimit-Reset', Math.floor(result.resetAt / 1000).toString());

  if (!result.allowed && result.retryAfter) {
    headers.set('Retry-After', result.retryAfter.toString());
  }
}
