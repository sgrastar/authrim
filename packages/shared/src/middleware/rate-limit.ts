/**
 * Rate Limiting Middleware
 *
 * Provides per-IP rate limiting to protect against abuse and DDoS attacks.
 * Uses Cloudflare KV for distributed rate limit tracking.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  // Maximum number of requests allowed in the window
  maxRequests: number;
  // Time window in seconds
  windowSeconds: number;
  // Endpoints to apply rate limiting to (empty means all endpoints)
  endpoints?: string[];
  // Skip rate limiting for these IPs (e.g., trusted proxies, health checks)
  skipIPs?: string[];
}

/**
 * Rate limit record stored in KV
 */
interface RateLimitRecord {
  count: number;
  resetAt: number; // Unix timestamp when the window resets
}

/**
 * Get client IP address from request
 * Uses Cloudflare-specific headers when available
 */
function getClientIP(c: Context): string {
  // Cloudflare provides the client IP in CF-Connecting-IP header
  const cfIP = c.req.header('CF-Connecting-IP');
  if (cfIP) {
    return cfIP;
  }

  // Fallback to X-Forwarded-For header
  const xForwardedFor = c.req.header('X-Forwarded-For');
  if (xForwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first one
    return xForwardedFor.split(',')[0]?.trim() || 'unknown';
  }

  // Last resort: use X-Real-IP
  const xRealIP = c.req.header('X-Real-IP');
  if (xRealIP) {
    return xRealIP;
  }

  return 'unknown';
}

/**
 * Check if rate limit is exceeded
 *
 * Uses RateLimiterCounter DO for atomic, precise rate limiting (issue #6).
 * Falls back to KV-based rate limiting if DO is unavailable.
 */
async function checkRateLimit(
  env: Env,
  clientIP: string,
  config: RateLimitConfig
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  // Try DO-based rate limiting first
  try {
    if (env.RATE_LIMITER) {
      // Use DO ID based on IP to shard load
      const id = env.RATE_LIMITER.idFromName(clientIP);
      const stub = env.RATE_LIMITER.get(id);

      // Call DO to increment counter atomically
      const response = await stub.fetch('http://internal/increment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientIP,
          config: {
            windowSeconds: config.windowSeconds,
            maxRequests: config.maxRequests,
          },
        }),
      });

      if (response.ok) {
        const result = await response.json<{
          allowed: boolean;
          current: number;
          limit: number;
          resetAt: number;
          retryAfter: number;
        }>();

        return {
          allowed: result.allowed,
          remaining: Math.max(0, result.limit - result.current),
          resetAt: result.resetAt,
        };
      }

      // DO failed, fall through to KV fallback
      console.warn('RateLimiterCounter DO failed, falling back to KV');
    }
  } catch (error) {
    console.error('Rate limiting DO error, falling back to KV:', error);
  }

  // Fallback to KV-based rate limiting
  return await checkRateLimitKV(env, clientIP, config);
}

/**
 * KV-based rate limiting (fallback)
 * Used when RateLimiterCounter DO is unavailable
 */
async function checkRateLimitKV(
  env: Env,
  clientIP: string,
  config: RateLimitConfig
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const key = `ratelimit:${clientIP}`;

  // Get current rate limit record
  const recordJson = await env.STATE_STORE.get(key);
  let record: RateLimitRecord;

  if (recordJson) {
    record = JSON.parse(recordJson) as RateLimitRecord;

    // Check if window has expired
    if (now >= record.resetAt) {
      // Window expired, reset counter
      record = {
        count: 1,
        resetAt: now + config.windowSeconds,
      };
    } else {
      // Window still active, increment counter
      record.count++;
    }
  } else {
    // First request from this IP
    record = {
      count: 1,
      resetAt: now + config.windowSeconds,
    };
  }

  // Store updated record with TTL
  await env.STATE_STORE.put(key, JSON.stringify(record), {
    expirationTtl: config.windowSeconds + 60, // Extra 60s grace period
  });

  const allowed = record.count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - record.count);

  return { allowed, remaining, resetAt: record.resetAt };
}

/**
 * Rate limiting middleware factory
 *
 * @param config - Rate limit configuration
 * @returns Middleware function
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // If endpoints filter is specified, only apply to those endpoints
    if (config.endpoints && config.endpoints.length > 0) {
      const path = new URL(c.req.url).pathname;
      const shouldApply = config.endpoints.some((endpoint) => path.startsWith(endpoint));

      if (!shouldApply) {
        return await next();
      }
    }

    const clientIP = getClientIP(c);

    // Skip rate limiting for whitelisted IPs
    if (config.skipIPs && config.skipIPs.includes(clientIP)) {
      return await next();
    }

    try {
      const { allowed, remaining, resetAt } = await checkRateLimit(c.env, clientIP, config);

      // Add rate limit headers to response
      c.header('X-RateLimit-Limit', config.maxRequests.toString());
      c.header('X-RateLimit-Remaining', remaining.toString());
      c.header('X-RateLimit-Reset', resetAt.toString());

      if (!allowed) {
        const retryAfter = resetAt - Math.floor(Date.now() / 1000);

        c.header('Retry-After', retryAfter.toString());

        return c.json(
          {
            error: 'rate_limit_exceeded',
            error_description: 'Too many requests. Please try again later.',
            retry_after: retryAfter,
          },
          429
        );
      }

      return await next();
    } catch (error) {
      console.error('Rate limiting error:', error);
      // On error, allow request to proceed (fail open)
      return await next();
    }
  };
}

/**
 * Pre-configured rate limit profiles
 */
export const RateLimitProfiles = {
  /**
   * Strict rate limiting for sensitive endpoints (e.g., token, register)
   * 10 requests per minute
   */
  strict: {
    maxRequests: 10,
    windowSeconds: 60,
  },

  /**
   * Moderate rate limiting for API endpoints
   * 60 requests per minute
   */
  moderate: {
    maxRequests: 60,
    windowSeconds: 60,
  },

  /**
   * Lenient rate limiting for public endpoints (e.g., discovery, JWKS)
   * 300 requests per minute
   */
  lenient: {
    maxRequests: 300,
    windowSeconds: 60,
  },
} as const;
