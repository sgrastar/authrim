/**
 * Rate Limiting Middleware for Check API
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Implements fixed-window rate limiting in the RateLimiterCounter Durable Object:
 * - Tracks request counts per client/API key, atomically
 * - Supports multiple rate limit tiers (strict, moderate, lenient), each a fixed limit
 *
 * Security features:
 * - Per-client isolation
 * - Tenant-aware rate limiting
 * - Fails closed when the limiter is unavailable
 */

import type { Env, RateLimiterCounter, RateLimitTier } from '@authrim/ar-lib-core';
import { createLogger } from '@authrim/ar-lib-core';
import type { CheckAuthResult } from './check-auth';

const log = createLogger().module('RATE-LIMIT');

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
  /** The atomic rate limiter (RATE_LIMITER binding) */
  limiter?: Env['RATE_LIMITER'];
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

// =============================================================================
// Configuration Helpers
// =============================================================================

/** The rate limit of a tier. */
export function getRateLimitConfig(tier: RateLimitTier): RateLimitConfig {
  return DEFAULT_RATE_LIMIT_CONFIG[tier];
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

/** The atomic rate limiter is unbound or failed: the request is refused (fail closed). */
export class RateLimiterUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Check API rate limiter is unavailable', options);
    this.name = 'RateLimiterUnavailableError';
  }
}

/**
 * Check rate limit for a request
 *
 * Counts in the RateLimiterCounter Durable Object, one instance per client key, so concurrent
 * requests cannot read the same count (a KV read-modify-write would let them, and KV allows
 * about one write per second per key). Without the limiter, or when it fails, the request is
 * refused with RateLimiterUnavailableError.
 */
export async function checkRateLimit(
  auth: CheckAuthResult,
  ctx: RateLimitContext
): Promise<RateLimitResult> {
  const tier = auth.rateLimitTier || 'strict';
  const config = getRateLimitConfig(tier);

  if (!ctx.limiter) {
    log.error('RATE_LIMITER binding is not configured; refusing Check API request', {});
    throw new RateLimiterUnavailableError();
  }

  const key = getRateLimitKey(auth);
  let result: Awaited<ReturnType<RateLimiterCounter['incrementRpc']>>;
  try {
    const stub = ctx.limiter.get(ctx.limiter.idFromName(key));
    result = await stub.incrementRpc(key, {
      windowSeconds: Math.ceil(config.windowMs / 1000),
      maxRequests: config.requests,
    });
  } catch (error) {
    log.error('Error checking rate limit', {}, error as Error);
    throw new RateLimiterUnavailableError({ cause: error });
  }

  return {
    allowed: result.allowed,
    current: result.current,
    limit: config.requests,
    remaining: Math.max(0, config.requests - result.current),
    resetAt: result.resetAt * 1000,
    ...(result.allowed ? {} : { retryAfter: Math.max(1, result.retryAfter) }),
  };
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
