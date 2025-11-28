/**
 * Version Check Middleware
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
 *
 * Security:
 * - Version UUIDs are never exposed in responses
 * - Logging is internal only (console.warn)
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';

/**
 * In-memory cache for version data
 * This cache is per-isolate and resets when the Worker isolate is recycled
 */
interface VersionCache {
  uuid: string;
  timestamp: number;
}

// Cache TTL in milliseconds (5 seconds)
const CACHE_TTL_MS = 5000;

// Per-worker version cache (worker name -> cache entry)
const versionCaches = new Map<string, VersionCache>();

/**
 * Get the latest version from VersionManager DO with caching
 */
async function getLatestVersion(env: Env, workerName: string): Promise<string | null> {
  // Check cache first
  const cached = versionCaches.get(workerName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.uuid;
  }

  try {
    // Access VersionManager DO
    const vmId = env.VERSION_MANAGER.idFromName('global');
    const vm = env.VERSION_MANAGER.get(vmId);

    const response = await vm.fetch(
      new Request(`https://do/version/${workerName}`, {
        method: 'GET',
      })
    );

    if (!response.ok) {
      // Version not registered yet - allow request to proceed
      if (response.status === 404) {
        return null;
      }
      console.error(`[VersionCheck] Failed to get version: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { uuid: string };

    // Update cache
    versionCaches.set(workerName, {
      uuid: data.uuid,
      timestamp: Date.now(),
    });

    return data.uuid;
  } catch (error) {
    console.error('[VersionCheck] Error fetching version:', error);
    // On error, allow request to proceed (fail-open for availability)
    return null;
  }
}

/**
 * Version check middleware factory
 *
 * @param workerName - The name of the Worker (e.g., 'op-auth', 'op-token')
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * import { versionCheckMiddleware } from '@authrim/shared';
 *
 * app.use('*', logger());
 * app.use('*', versionCheckMiddleware('op-auth'));
 * ```
 */
export function versionCheckMiddleware(workerName: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
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
      console.warn(`[VersionCheck] Outdated bundle detected`, {
        workerName,
        myVersion: myVersion.substring(0, 8) + '...', // Truncate for log safety
        latestVersion: latestVersion.substring(0, 8) + '...',
        timestamp: new Date().toISOString(),
      });

      // Return 503 Service Unavailable with Retry-After header
      // This signals to clients that they should retry shortly
      return c.json(
        { error: 'service_unavailable' },
        503,
        { 'Retry-After': '5' }
      );
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
