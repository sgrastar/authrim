/**
 * Version Check Middleware
 *
 * @deprecated This middleware is deprecated and will be removed in a future version.
 * Use Cloudflare Versions Deploy with gradual rollout instead:
 * ```bash
 * ./scripts/deploy-with-retry.sh --env=prod --gradual
 * ```
 *
 * Reason for deprecation:
 * - Cloudflare Versions Deploy now provides native traffic splitting
 * - Gradual rollout (10% → 50% → 100%) is safer than hard 503 rejection
 * - wrangler rollback provides instant rollback without custom DO
 * - Eliminates need for VersionManager DO maintenance
 *
 * Migration:
 * 1. Remove versionCheckMiddleware from your Worker's middleware chain
 * 2. Use --gradual flag in deploy-with-retry.sh for production deployments
 * 3. VERSION_CHECK_ENABLED="false" is already the default (no action needed)
 *
 * ─────────────────────────────────────────────────────────────────────
 * Original Description (for reference):
 *
 * Validates that the Worker is running the latest deployed code version.
 * Rejects requests from stale bundles to ensure consistent behavior
 * across Cloudflare's globally distributed Points of Presence (PoPs).
 *
 * Key Features:
 * - Worker-specific version validation via VersionManager DO
 * - In-memory caching (5s TTL) to reduce DO access overhead
 * - Graceful handling for development (skips when version not set)
 * - Returns 503 + Retry-After for stale bundles
 * - Feature Flag: Set VERSION_CHECK_ENABLED="false" to disable (zero overhead)
 *
 * Security:
 * - Version UUIDs are never exposed in responses
 * - Logging is internal only (console.warn)
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { createLogger } from '../utils/logger';

const log = createLogger().module('VersionCheck');

/**
 * In-memory cache for version data
 * This cache is per-isolate and resets when the Worker isolate is recycled
 */
interface VersionCache {
  uuid: string;
  timestamp: number;
}

// Cache TTL in milliseconds
// Trade-off: Higher value = less DO queries but slower version propagation
// 5000ms (5 seconds) provides good balance between performance and consistency
const CACHE_TTL_MS = 5000;

/**
 * Maximum cache size to prevent memory exhaustion DoS
 * Security: Limits memory growth from malicious worker name enumeration
 */
const MAX_CACHE_SIZE = 50;

/**
 * Sanitize a string for safe log output
 *
 * Security: Prevents log injection attacks by removing control characters
 * (including newlines that could be used to spoof log entries)
 *
 * @param value - Value to sanitize
 * @param maxLength - Maximum length (default: 64)
 * @returns Sanitized string safe for logging
 */
function sanitizeForLog(value: string, maxLength = 64): string {
  // Remove control characters (ASCII 0-31 and 127-159)
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').substring(0, maxLength);
}

/**
 * Per-worker version cache (worker name -> cache entry)
 *
 * Threading model: Cloudflare Workers are single-threaded per isolate,
 * so there's no race condition within an isolate. Cache staleness across
 * isolates is acceptable given our TTL-based expiration strategy.
 *
 * Security: Bounded to MAX_CACHE_SIZE to prevent memory exhaustion
 */
const versionCaches = new Map<string, VersionCache>();

/**
 * Evict oldest entries when cache exceeds max size (simple LRU-like behavior)
 * Note: Map iteration order is insertion order in JavaScript
 */
function evictVersionCacheIfNeeded(): void {
  if (versionCaches.size >= MAX_CACHE_SIZE) {
    // Remove oldest 10% of entries
    const toRemove = Math.ceil(MAX_CACHE_SIZE * 0.1);
    let removed = 0;
    for (const key of versionCaches.keys()) {
      if (removed >= toRemove) break;
      versionCaches.delete(key);
      removed++;
    }
  }
}

/**
 * Get the latest version from VersionManager DO with caching
 */
async function getLatestVersion(env: Env, workerName: string): Promise<string | null> {
  // Check cache first
  const cached = versionCaches.get(workerName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    // LRU: Re-insert to move to end (most recently used)
    versionCaches.delete(workerName);
    versionCaches.set(workerName, cached);
    return cached.uuid;
  }

  try {
    // Access VersionManager DO
    const vmId = env.VERSION_MANAGER.idFromName('global');
    const vm = env.VERSION_MANAGER.get(vmId);

    // Security: Include auth header for defense-in-depth
    const response = await vm.fetch(
      new Request(`https://do/version/${workerName}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${env.ADMIN_API_SECRET || ''}`,
        },
      })
    );

    if (!response.ok) {
      // Version not registered yet - allow request to proceed
      if (response.status === 404) {
        return null;
      }
      // Security: Log authentication failures as potential security events
      if (response.status === 401 || response.status === 403) {
        log.error('SECURITY: Auth failure for VersionManager DO', {
          status: response.status,
          action: 'security_auth_failure',
        });
      } else {
        log.error('Failed to get version', { status: response.status });
      }
      // Fail-open for availability - allow request to proceed
      return null;
    }

    const data = (await response.json()) as { uuid: string };

    // Security: Evict old entries before adding new ones to prevent unbounded growth
    evictVersionCacheIfNeeded();

    // Update cache
    versionCaches.set(workerName, {
      uuid: data.uuid,
      timestamp: Date.now(),
    });

    return data.uuid;
  } catch (error) {
    // Fail-safe: log sanitized error and return null
    // Security: Only log error type/message, not full stack traces
    log.error('Error fetching version', {}, error as Error);
    // On error, allow request to proceed (fail-open for availability)
    return null;
  }
}

/**
 * Version check middleware factory
 *
 * @deprecated Use Cloudflare Versions Deploy with --gradual flag instead.
 * See module documentation for migration instructions.
 *
 * @param workerName - The name of the Worker (e.g., 'op-auth', 'op-token')
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * // DEPRECATED: Remove this middleware and use --gradual deployment instead
 * import { versionCheckMiddleware } from '@authrim/ar-lib-core';
 *
 * app.use('*', logger());
 * // app.use('*', versionCheckMiddleware('op-auth')); // Remove this line
 * ```
 */
export function versionCheckMiddleware(workerName: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Feature Flag: Skip all version check logic when disabled
    // Set VERSION_CHECK_ENABLED="false" to completely bypass (zero overhead)
    if (c.env.VERSION_CHECK_ENABLED === 'false') {
      return next();
    }

    // Skip version check for internal version management endpoints
    // This prevents chicken-and-egg problems during deployment:
    // - New Workers are deployed with new UUID
    // - Deploy script needs to register new UUID in VersionManager DO
    // - But if version check blocks this, registration can never succeed
    const path = c.req.path;
    if (path.startsWith('/api/internal/version')) {
      return next();
    }

    const myVersion = c.env.CODE_VERSION_UUID;

    // Skip version check if not configured (development environment)
    if (!myVersion) {
      return next();
    }

    // Skip if VERSION_MANAGER binding is not available
    if (!c.env.VERSION_MANAGER) {
      return next();
    }

    const latestVersion = await getLatestVersion(c.env, workerName);

    // If no version is registered yet, allow request to proceed
    if (!latestVersion) {
      return next();
    }

    // Check if this Worker's version matches the latest
    if (myVersion !== latestVersion) {
      // Log for internal tracking (never exposed to clients)
      // Security: Sanitize workerName to prevent log injection
      log.warn('Outdated bundle detected', {
        workerName: sanitizeForLog(workerName),
        myVersion: myVersion.substring(0, 8) + '...', // Truncate for log safety
        latestVersion: latestVersion.substring(0, 8) + '...',
      });

      // Return 503 Service Unavailable with Retry-After header
      // This signals to clients that they should retry shortly
      return c.json({ error: 'service_unavailable' }, 503, { 'Retry-After': '5' });
    }

    // Version is up-to-date, proceed with request
    return next();
  };
}

/**
 * Clear the version cache for a specific worker
 * Useful for testing or forcing a refresh
 */
export function clearVersionCache(workerName?: string): void {
  if (workerName) {
    versionCaches.delete(workerName);
  } else {
    versionCaches.clear();
  }
}
