/**
 * Rate Limiting Middleware
 *
 * Provides per-IP rate limiting to protect against abuse and DDoS attacks.
 * Uses Cloudflare KV for distributed rate limit tracking.
 *
 * Configuration Priority:
 * 1. In-memory cache (default 5min TTL, configurable via SETTINGS_CACHE_TTL_SECONDS)
 * 2. KV (AUTHRIM_CONFIG namespace) - Dynamic override without deployment
 * 3. Environment variables (RATE_LIMIT_PROFILE)
 * 4. Default profiles (RateLimitProfiles)
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import { publishEvent } from '../utils/event-dispatcher-factory';
import { SECURITY_EVENTS, type SecurityEventData } from '../types/events';
import { getTenantIdFromContext } from './request-context';
import { createLogger } from '../utils/logger';

const log = createLogger().module('RATE-LIMIT');

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

// ============================================================
// Cloud Provider IP Extraction
// ============================================================

/**
 * Supported cloud providers for trusted IP extraction
 *
 * Each provider has different mechanisms for providing the real client IP:
 * - cloudflare: Uses CF-Connecting-IP header (most secure, single IP)
 * - aws: Uses X-Forwarded-For, ALB adds client IP at the end
 * - azure: Uses X-Forwarded-For, App Gateway adds client IP at the end
 * - gcp: Uses X-Forwarded-For, adds client IP + LB IP (2nd from end is client)
 * - none: No trusted proxy, uses X-Forwarded-For first IP (WARNING: spoofable!)
 */
export type CloudProvider = 'cloudflare' | 'aws' | 'azure' | 'gcp' | 'none';

/**
 * KV key for cloud provider setting
 */
const CLOUD_PROVIDER_KV_KEY = 'security_cloud_provider';

/**
 * Default cloud provider (Cloudflare - most secure)
 */
const DEFAULT_CLOUD_PROVIDER: CloudProvider = 'cloudflare';

/**
 * Cached cloud provider setting
 */
interface CachedCloudProviderSetting {
  provider: CloudProvider;
  cachedAt: number;
}
let cloudProviderCache: CachedCloudProviderSetting | null = null;

/**
 * Default cache TTL in milliseconds (5 minutes)
 * Can be overridden via SETTINGS_CACHE_TTL_SECONDS environment variable
 *
 * Design note: Admin API clears cache immediately on settings change,
 * so this TTL only affects direct KV edits (emergency operations).
 * Longer TTL = fewer KV reads = lower cost and latency.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get cache TTL from environment variable or use default
 * @param env - Environment bindings
 * @returns Cache TTL in milliseconds
 */
function getCacheTTLMs(env: Env): number {
  if (env.SETTINGS_CACHE_TTL_SECONDS) {
    const seconds = parseInt(env.SETTINGS_CACHE_TTL_SECONDS, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * Get the KV key for cloud provider setting
 * Exported for use in Admin API
 */
export function getCloudProviderKVKey(): string {
  return CLOUD_PROVIDER_KV_KEY;
}

/**
 * Get the default cloud provider
 * Exported for use in Admin API
 */
export function getDefaultCloudProvider(): CloudProvider {
  return DEFAULT_CLOUD_PROVIDER;
}

/**
 * Valid cloud provider values
 */
export const VALID_CLOUD_PROVIDERS: CloudProvider[] = ['cloudflare', 'aws', 'azure', 'gcp', 'none'];

/**
 * Get the configured cloud provider
 * @param env - Environment with KV bindings
 * @returns Cloud provider setting
 */
async function getCloudProvider(env: Env): Promise<CloudProvider> {
  const now = Date.now();
  const cacheTTL = getCacheTTLMs(env);

  // Check cache first
  if (cloudProviderCache && now - cloudProviderCache.cachedAt < cacheTTL) {
    return cloudProviderCache.provider;
  }

  // Default: cloudflare (most secure)
  let provider: CloudProvider = DEFAULT_CLOUD_PROVIDER;

  // Check KV for setting
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await env.AUTHRIM_CONFIG.get(CLOUD_PROVIDER_KV_KEY);
      if (kvValue && VALID_CLOUD_PROVIDERS.includes(kvValue as CloudProvider)) {
        provider = kvValue as CloudProvider;
      }
    } catch {
      // KV read error - use default
    }
  }

  // Update cache
  cloudProviderCache = { provider, cachedAt: now };

  return provider;
}

/**
 * Clear the cloud provider cache
 * Useful for testing or immediate setting changes
 */
export function clearCloudProviderCache(): void {
  cloudProviderCache = null;
}

// Legacy export for backward compatibility
export function clearTrustCfIpCache(): void {
  clearCloudProviderCache();
}

// Legacy export for backward compatibility
export function getTrustCfIpHeaderKVKey(): string {
  return CLOUD_PROVIDER_KV_KEY;
}

/**
 * Get fallback IP from X-Forwarded-For or X-Real-IP
 * WARNING: These can be spoofed! Only used as fallback when primary method fails.
 *
 * @param c - Hono context
 * @returns IP address or 'unknown'
 */
function getFallbackIP(c: Context): string {
  const xff = c.req.header('X-Forwarded-For');
  if (xff) {
    return xff.split(',')[0]?.trim() || 'unknown';
  }
  const xRealIP = c.req.header('X-Real-IP');
  if (xRealIP) {
    return xRealIP;
  }
  return 'unknown';
}

/**
 * Get client IP address from request based on cloud provider
 *
 * IP Extraction Methods by Provider:
 *
 * **Cloudflare** (Default, Most Secure):
 * - Uses CF-Connecting-IP header which cannot be spoofed
 * - Falls back to X-Forwarded-For if CF header is missing (with warning)
 *
 * **AWS ALB**:
 * - Uses X-Forwarded-For, takes the LAST IP (ALB appends client IP)
 * - Ref: https://docs.aws.amazon.com/elasticloadbalancing/
 *
 * **Azure Application Gateway**:
 * - Uses X-Forwarded-For, takes the LAST IP (Gateway appends client IP)
 * - Ref: https://learn.microsoft.com/azure/application-gateway/
 *
 * **GCP Load Balancer**:
 * - Uses X-Forwarded-For, takes the 2nd from LAST IP
 * - GCP appends [client_ip, lb_ip] to the header
 * - Ref: https://cloud.google.com/load-balancing/docs/https/
 *
 * **None** (No Cloud/Direct):
 * - Uses X-Forwarded-For first IP or X-Real-IP
 * - WARNING: Can be spoofed! Recommend using WAF
 *
 * Security Note: When primary IP extraction fails, the system falls back to
 * X-Forwarded-For first IP which can be spoofed. This is preferable to returning
 * 'unknown' because 'unknown' causes all requests to share a single rate limit
 * bucket, which is a larger security issue.
 *
 * @param c - Hono context
 * @param provider - Cloud provider
 */
function getClientIP(c: Context, provider: CloudProvider): string {
  switch (provider) {
    case 'cloudflare': {
      // Cloudflare provides the client IP in CF-Connecting-IP header
      // This header cannot be spoofed when traffic goes through Cloudflare
      const cfIP = c.req.header('CF-Connecting-IP');
      if (cfIP) {
        return cfIP;
      }
      // Also check True-Client-IP (Cloudflare Enterprise feature)
      const trueClientIP = c.req.header('True-Client-IP');
      if (trueClientIP) {
        return trueClientIP;
      }
      // Not behind Cloudflare - fallback to X-Forwarded-For
      // Security: Log warning because this may indicate misconfiguration or bypass attempt
      const fallbackIP = getFallbackIP(c);
      if (fallbackIP !== 'unknown') {
        log.warn('CF-Connecting-IP header missing, falling back to X-Forwarded-For', {
          ip: fallbackIP.substring(0, 10) + '...',
        });
      }
      return fallbackIP;
    }

    case 'aws': {
      // AWS ALB appends client IP to the END of X-Forwarded-For
      // Format: "original_xff, client_ip" or just "client_ip"
      const xff = c.req.header('X-Forwarded-For');
      if (xff) {
        const ips = xff.split(',').map((ip) => ip.trim());
        // Take the last IP (added by ALB)
        const ip = ips[ips.length - 1];
        if (ip) return ip;
      }
      // No X-Forwarded-For - may be direct connection, use fallback
      return getFallbackIP(c);
    }

    case 'azure': {
      // Azure Application Gateway appends client IP to the END of X-Forwarded-For
      // Similar to AWS ALB behavior
      const xff = c.req.header('X-Forwarded-For');
      if (xff) {
        const ips = xff.split(',').map((ip) => ip.trim());
        // Take the last IP (added by App Gateway)
        const ip = ips[ips.length - 1];
        if (ip) return ip;
      }
      // No X-Forwarded-For - may be direct connection, use fallback
      return getFallbackIP(c);
    }

    case 'gcp': {
      // GCP Load Balancer appends TWO IPs: [client_ip, lb_ip]
      // So we need the 2nd from last IP
      const xff = c.req.header('X-Forwarded-For');
      if (xff) {
        const ips = xff.split(',').map((ip) => ip.trim());
        if (ips.length >= 2) {
          // Take the 2nd from last IP (client IP before LB IP)
          const ip = ips[ips.length - 2];
          if (ip) return ip;
        } else if (ips.length === 1 && ips[0]) {
          // Only one IP - use it (direct connection to LB)
          return ips[0];
        }
      }
      // No X-Forwarded-For - may be direct connection, use fallback
      return getFallbackIP(c);
    }

    case 'none':
    default: {
      // No trusted proxy - use first IP from X-Forwarded-For
      // WARNING: This can be spoofed by clients!
      // Users should configure WAF for additional protection
      return getFallbackIP(c);
    }
  }
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
    log.error('Rate limiting DO error, falling back to KV', {}, error as Error);
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

    // Get cloud provider setting for IP extraction
    const cloudProvider = await getCloudProvider(c.env);
    const clientIP = getClientIP(c, cloudProvider);

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

        // Publish rate limit exceeded event (non-blocking)
        // Hash client IP for privacy (simple hash, not cryptographically secure)
        const ipHash = await crypto.subtle
          .digest('SHA-256', new TextEncoder().encode(clientIP))
          .then((buf) =>
            Array.from(new Uint8Array(buf).slice(0, 8))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')
          )
          .catch(() => 'unknown');

        publishEvent(c, {
          type: SECURITY_EVENTS.RATE_LIMIT_EXCEEDED,
          tenantId: getTenantIdFromContext(c),
          data: {
            endpoint: c.req.path,
            clientIpHash: ipHash,
            rateLimit: {
              maxRequests: config.maxRequests,
              windowSeconds: config.windowSeconds,
              retryAfter,
            },
          } satisfies SecurityEventData,
        }).catch((err: unknown) => {
          log.error('Failed to publish security.rate_limit.exceeded event', {}, err as Error);
        });

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
      log.error('Rate limiting error', {}, error as Error);
      // Security: Fail-close - deny request on error to prevent bypass attacks
      // RFC 6749 5.2: Use 'temporarily_unavailable' for 503 responses
      // RFC 6749: All error responses MUST include Cache-Control: no-store
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The service is temporarily unavailable. Please try again later.',
        },
        503
      );
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
 * Cache duration controlled by SETTINGS_CACHE_TTL_SECONDS env var (default: 5 minutes)
 */
interface CachedRateLimitConfig {
  config: RateLimitConfig;
  cachedAt: number;
}
const rateLimitConfigCache = new Map<string, CachedRateLimitConfig>();

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
  const cacheTTL = getCacheTTLMs(env);
  if (cached && now - cached.cachedAt < cacheTTL) {
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
      log.error('Failed to read rate limit config from KV', {}, error as Error);
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
 * KV key for global profile override
 * When set, all rate limiting uses this profile instead of endpoint-specific profiles
 */
const PROFILE_OVERRIDE_KV_KEY = 'rate_limit_profile_override';

/**
 * Get rate limit profile with KV override support (async version)
 *
 * Priority:
 * 1. Cache (default 5min TTL, configurable via SETTINGS_CACHE_TTL_SECONDS)
 * 2. KV profile override (rate_limit_profile_override) - switches ALL endpoints to specified profile
 * 3. KV per-profile settings (rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds)
 * 4. Environment variable (RATE_LIMIT_PROFILE for profile selection)
 * 5. Default profile values
 *
 * @param env - Environment bindings with AUTHRIM_CONFIG KV
 * @param profileName - Profile name (strict, moderate, lenient, loadTest)
 * @returns Rate limit config with KV overrides applied
 *
 * @example
 * // Set global profile override via KV (no deployment required):
 * // npx wrangler kv key put "rate_limit_profile_override" "loadTest" --namespace-id=... --remote
 * // Or via Admin API: PUT /api/admin/settings/rate-limit/profile-override {"profile": "loadTest"}
 *
 * // Set per-profile settings via KV:
 * // npx wrangler kv key put "rate_limit_loadtest_max_requests" "20000" --namespace-id=... --remote
 *
 * const config = await getRateLimitProfileAsync(env, 'strict');
 * // If rate_limit_profile_override=loadTest, returns loadTest config instead of strict
 */
export async function getRateLimitProfileAsync(
  env: Env,
  profileName: keyof typeof RateLimitProfiles
): Promise<RateLimitConfig> {
  let effectiveProfile: keyof typeof RateLimitProfiles = profileName;

  // Priority 1: Check KV for global profile override
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvProfileOverride = await env.AUTHRIM_CONFIG.get(PROFILE_OVERRIDE_KV_KEY);
      if (kvProfileOverride && kvProfileOverride in RateLimitProfiles) {
        effectiveProfile = kvProfileOverride as keyof typeof RateLimitProfiles;
      }
    } catch {
      // KV read error - continue with other sources
    }
  }

  // Priority 2: Check environment variable (only if no KV override)
  if (effectiveProfile === profileName) {
    if (env.RATE_LIMIT_PROFILE && env.RATE_LIMIT_PROFILE in RateLimitProfiles) {
      effectiveProfile = env.RATE_LIMIT_PROFILE as keyof typeof RateLimitProfiles;
    }
  }

  return await getRateLimitConfigFromKV(env, effectiveProfile);
}

/**
 * Get the KV key for profile override
 * Exported for use in Admin API
 */
export function getProfileOverrideKVKey(): string {
  return PROFILE_OVERRIDE_KV_KEY;
}

/**
 * Clear rate limit config cache.
 * Useful for testing or when immediate KV changes are needed.
 */
export function clearRateLimitConfigCache(): void {
  rateLimitConfigCache.clear();
}
