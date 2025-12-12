/**
 * Rate Limiting Middleware
 *
 * Provides per-IP rate limiting to protect against abuse and DDoS attacks.
 * Uses Cloudflare KV for distributed rate limit tracking.
 *
 * Configuration Priority:
 * 1. In-memory cache (10s TTL)
 * 2. KV (AUTHRIM_CONFIG namespace) - Dynamic override without deployment
 * 3. Environment variables (RATE_LIMIT_PROFILE)
 * 4. Default profiles (RateLimitProfiles)
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

      // RPC call to increment counter atomically
      const result = await stub.incrementRpc(clientIP, {
        windowSeconds: config.windowSeconds,
        maxRequests: config.maxRequests,
      });

      return {
        allowed: result.allowed,
        remaining: Math.max(0, result.limit - result.current),
        resetAt: result.resetAt,
      };
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
 * Pre-configured rate limit profiles (defaults)
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

  /**
   * Load testing profile - very high limits
   * Default: 10000 requests per minute
   * Can be overridden via KV: rate_limit_loadtest_max_requests, rate_limit_loadtest_window_seconds
   */
  loadTest: {
    maxRequests: 10000,
    windowSeconds: 60,
  },
} as const;

// ============================================================
// KV-based Dynamic Rate Limit Configuration
// ============================================================

/**
 * Cached rate limit config to avoid repeated KV lookups.
 * Cache duration: 10 seconds (same as shard count cache)
 */
interface CachedRateLimitConfig {
  config: RateLimitConfig;
  cachedAt: number;
}
const rateLimitConfigCache = new Map<string, CachedRateLimitConfig>();
const RATE_LIMIT_CACHE_TTL_MS = 10000; // 10 seconds

/**
 * KV keys for rate limit configuration
 *
 * KV Key Format:
 * - rate_limit_{profile}_max_requests - Max requests for profile
 * - rate_limit_{profile}_window_seconds - Time window for profile
 *
 * Example:
 * npx wrangler kv key put "rate_limit_loadtest_max_requests" "20000" --namespace-id=... --remote
 * npx wrangler kv key put "rate_limit_loadtest_window_seconds" "60" --namespace-id=... --remote
 */
function getRateLimitKVKeys(profileName: string): {
  maxRequestsKey: string;
  windowSecondsKey: string;
} {
  const normalizedName = profileName
    .toLowerCase()
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase();
  return {
    maxRequestsKey: `rate_limit_${normalizedName}_max_requests`,
    windowSecondsKey: `rate_limit_${normalizedName}_window_seconds`,
  };
}

/**
 * Get rate limit config from KV with fallback to defaults.
 *
 * Priority:
 * 1. Cache (if within TTL)
 * 2. KV (AUTHRIM_CONFIG namespace)
 * 3. Environment variable (RATE_LIMIT_PROFILE for profile selection)
 * 4. Default profile
 *
 * @param env - Environment object with KV bindings
 * @param profileName - Profile name
 * @returns Rate limit configuration
 */
async function getRateLimitConfigFromKV(
  env: Env,
  profileName: keyof typeof RateLimitProfiles
): Promise<RateLimitConfig> {
  const cacheKey = profileName;
  const now = Date.now();

  // Check cache first
  const cached = rateLimitConfigCache.get(cacheKey);
  if (cached && now - cached.cachedAt < RATE_LIMIT_CACHE_TTL_MS) {
    return cached.config;
  }

  // Get default values from profile (widen type from const literals to number)
  const defaultConfig = RateLimitProfiles[profileName];
  let maxRequests: number = defaultConfig.maxRequests;
  let windowSeconds: number = defaultConfig.windowSeconds;

  // Try to get from KV
  if (env.AUTHRIM_CONFIG) {
    const { maxRequestsKey, windowSecondsKey } = getRateLimitKVKeys(profileName);

    try {
      const [maxRequestsValue, windowSecondsValue] = await Promise.all([
        env.AUTHRIM_CONFIG.get(maxRequestsKey),
        env.AUTHRIM_CONFIG.get(windowSecondsKey),
      ]);

      if (maxRequestsValue) {
        const parsed = parseInt(maxRequestsValue, 10);
        if (!isNaN(parsed) && parsed > 0) {
          maxRequests = parsed;
        }
      }

      if (windowSecondsValue) {
        const parsed = parseInt(windowSecondsValue, 10);
        if (!isNaN(parsed) && parsed > 0) {
          windowSeconds = parsed;
        }
      }
    } catch (error) {
      console.error('Failed to read rate limit config from KV:', error);
      // Fall through to use defaults
    }
  }

  const config: RateLimitConfig = {
    maxRequests,
    windowSeconds,
  };

  // Update cache
  rateLimitConfigCache.set(cacheKey, { config, cachedAt: now });

  return config;
}

/**
 * Get rate limit profile with environment variable override (synchronous version)
 *
 * @param env - Environment bindings
 * @param profileName - Profile name (strict, moderate, lenient, loadTest)
 * @returns Rate limit config (may be overridden by RATE_LIMIT_PROFILE env var)
 * @deprecated Use getRateLimitProfileAsync for KV-based dynamic configuration
 */
export function getRateLimitProfile(
  env: { RATE_LIMIT_PROFILE?: string },
  profileName: keyof typeof RateLimitProfiles
): RateLimitConfig {
  // Check if load testing mode is enabled via environment variable
  if (env.RATE_LIMIT_PROFILE === 'loadTest') {
    return RateLimitProfiles.loadTest;
  }

  return RateLimitProfiles[profileName];
}

/**
 * Get rate limit profile with KV override support (async version)
 *
 * Priority:
 * 1. Cache (10s TTL)
 * 2. KV (AUTHRIM_CONFIG namespace) - rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds
 * 3. Environment variable (RATE_LIMIT_PROFILE for profile selection)
 * 4. Default profile values
 *
 * @param env - Environment bindings with AUTHRIM_CONFIG KV
 * @param profileName - Profile name (strict, moderate, lenient, loadTest)
 * @returns Rate limit config with KV overrides applied
 *
 * @example
 * // Set via KV (no deployment required):
 * // npx wrangler kv key put "rate_limit_loadtest_max_requests" "20000" --namespace-id=... --remote
 *
 * const config = await getRateLimitProfileAsync(env, 'loadTest');
 * // config.maxRequests = 20000 (from KV) instead of default 10000
 */
export async function getRateLimitProfileAsync(
  env: Env,
  profileName: keyof typeof RateLimitProfiles
): Promise<RateLimitConfig> {
  // Check if a different profile is selected via environment variable
  const effectiveProfile =
    env.RATE_LIMIT_PROFILE && env.RATE_LIMIT_PROFILE in RateLimitProfiles
      ? (env.RATE_LIMIT_PROFILE as keyof typeof RateLimitProfiles)
      : profileName;

  return await getRateLimitConfigFromKV(env, effectiveProfile);
}

/**
 * Clear rate limit config cache.
 * Useful for testing or when immediate KV changes are needed.
 */
export function clearRateLimitConfigCache(): void {
  rateLimitConfigCache.clear();
}
