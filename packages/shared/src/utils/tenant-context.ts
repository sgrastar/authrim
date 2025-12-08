/**
 * Tenant Context Utilities
 *
 * Single-tenant mode: always returns 'default'
 * Future MT: resolve from subdomain/header
 *
 * This module provides the foundation for future multi-tenant support
 * while keeping the system single-tenant for now.
 */

import type { Env } from '../types/env';

/**
 * Default tenant ID used in single-tenant mode.
 * All data is associated with this tenant by default.
 */
export const DEFAULT_TENANT_ID = 'default';

/**
 * Get the current tenant ID.
 * In single-tenant mode, this always returns 'default'.
 *
 * Future MT: This will extract tenant from request context.
 */
export function getTenantId(): string {
  // For now, always return default
  // Future: extract from request context
  return DEFAULT_TENANT_ID;
}

/**
 * Build a Durable Object key with tenant prefix.
 *
 * @param resourceType - Type of resource (e.g., 'session', 'auth-code')
 * @param resourceId - Unique identifier for the resource
 * @returns Tenant-prefixed key string
 *
 * @example
 * buildDOKey('session', 'abc123') // => 'tenant:default:session:abc123'
 */
export function buildDOKey(resourceType: string, resourceId: string): string {
  return `tenant:${DEFAULT_TENANT_ID}:${resourceType}:${resourceId}`;
}

/**
 * Build a KV key with tenant prefix.
 *
 * @param prefix - Key prefix (e.g., 'client', 'state')
 * @param key - Unique key value
 * @returns Tenant-prefixed key string
 *
 * @example
 * buildKVKey('client', 'my-client-id') // => 'tenant:default:client:my-client-id'
 */
export function buildKVKey(prefix: string, key: string): string {
  return `tenant:${DEFAULT_TENANT_ID}:${prefix}:${key}`;
}

/**
 * Build a Durable Object instance name with tenant prefix.
 * Used when creating DO instance IDs via idFromName().
 *
 * @param resourceType - Type of DO resource (e.g., 'session', 'key-manager')
 * @returns Tenant-prefixed instance name
 *
 * @example
 * buildDOInstanceName('session') // => 'tenant:default:session'
 * env.SESSION_STORE.idFromName(buildDOInstanceName('session'))
 */
export function buildDOInstanceName(resourceType: string): string {
  return `tenant:${DEFAULT_TENANT_ID}:${resourceType}`;
}

/**
 * Build a Durable Object instance name for a specific tenant.
 * For future use when tenant ID is dynamic.
 *
 * @param tenantId - Tenant identifier
 * @param resourceType - Type of DO resource
 * @returns Tenant-prefixed instance name
 */
export function buildDOInstanceNameForTenant(tenantId: string, resourceType: string): string {
  return `tenant:${tenantId}:${resourceType}`;
}

/**
 * Build a KV key for a specific tenant.
 * For future use when tenant ID is dynamic.
 *
 * @param tenantId - Tenant identifier
 * @param prefix - Key prefix
 * @param key - Unique key value
 * @returns Tenant-prefixed key string
 */
export function buildKVKeyForTenant(tenantId: string, prefix: string, key: string): string {
  return `tenant:${tenantId}:${prefix}:${key}`;
}

/**
 * Default shard count for authorization code sharding.
 * Can be overridden via AUTHRIM_CODE_SHARDS environment variable.
 */
export const DEFAULT_CODE_SHARD_COUNT = 64;

/**
 * FNV-1a 32-bit hash function.
 * Fast, synchronous hash with good distribution.
 * Used for sticky routing without blocking the event loop.
 *
 * @param str - String to hash
 * @returns 32-bit unsigned integer hash
 */
export function fnv1a32(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return hash >>> 0; // Convert to unsigned 32-bit
}

/**
 * Calculate shard index for authorization codes.
 * Uses FNV-1a hash of userId:clientId for sticky routing.
 * Same user+client always routes to same shard (colocated with RefreshToken).
 *
 * @param userId - User identifier (sub claim)
 * @param clientId - OAuth client identifier
 * @param shardCount - Number of shards (default: 64)
 * @returns Shard index (0 to shardCount - 1)
 */
export function getAuthCodeShardIndex(
  userId: string,
  clientId: string,
  shardCount: number = DEFAULT_CODE_SHARD_COUNT
): number {
  const key = `${userId}:${clientId}`;
  const hash = fnv1a32(key);
  return hash % shardCount;
}

/**
 * Create a sharded authorization code.
 * Format: {shardIndex}_{randomCode}
 *
 * @param shardIndex - Shard index (0 to shardCount - 1)
 * @param randomCode - Random opaque code string
 * @returns Sharded authorization code
 */
export function createShardedAuthCode(shardIndex: number, randomCode: string): string {
  return `${shardIndex}_${randomCode}`;
}

/**
 * Parse a sharded authorization code.
 * Extracts shard index and opaque code from the combined format.
 *
 * @param code - Sharded authorization code (format: {shardIndex}_{randomCode})
 * @returns Object containing shardIndex and opaqueCode, or null if invalid format
 */
export function parseShardedAuthCode(
  code: string
): { shardIndex: number; opaqueCode: string } | null {
  const underscorePos = code.indexOf('_');
  if (underscorePos === -1) {
    // Legacy format (no shard prefix) - fallback to global shard
    return null;
  }

  const shardPart = code.substring(0, underscorePos);
  const opaquePart = code.substring(underscorePos + 1);

  const shardIndex = parseInt(shardPart, 10);
  if (isNaN(shardIndex) || shardIndex < 0) {
    return null;
  }

  return {
    shardIndex,
    opaqueCode: opaquePart,
  };
}

/**
 * Build a sharded Durable Object instance name for auth codes.
 *
 * @param shardIndex - Shard index
 * @returns DO instance name for the shard
 */
export function buildAuthCodeShardInstanceName(shardIndex: number): string {
  return `tenant:${DEFAULT_TENANT_ID}:auth-code:shard-${shardIndex}`;
}

/**
 * Remap shard index for scale-down compatibility.
 *
 * When shard count is reduced (e.g., 64→32), codes from out-of-range shards
 * are remapped using modulo operation to ensure all existing codes remain valid.
 *
 * Example: 64→32 scale-down
 *   - Shard 0-31: No change (0-31 % 32 = 0-31)
 *   - Shard 32-63: Remapped (32 % 32 = 0, 33 % 32 = 1, ...)
 *
 * @param parsedShardIndex - Original shard index from authorization code
 * @param currentShardCount - Current configured shard count
 * @returns Actual shard index to use (0 to currentShardCount - 1)
 * @throws Error if currentShardCount is invalid (<= 0)
 */
export function remapShardIndex(parsedShardIndex: number, currentShardCount: number): number {
  if (currentShardCount <= 0) {
    throw new Error('Invalid shard count: must be greater than 0');
  }
  return parsedShardIndex % currentShardCount;
}

/**
 * Get current shard count from KV or environment variable.
 *
 * Priority:
 * 1. KV (AUTHRIM_CONFIG namespace, key: "code_shards")
 * 2. Environment variable (AUTHRIM_CODE_SHARDS)
 * 3. Default (DEFAULT_CODE_SHARD_COUNT = 64)
 *
 * @param env - Environment object with KV and variables
 * @returns Current shard count
 */
async function getCurrentShardCount(env: Env): Promise<number> {
  // KV が存在すれば優先（動的変更可能）
  if (env.AUTHRIM_CONFIG) {
    const kvValue = await env.AUTHRIM_CONFIG.get('code_shards');
    if (kvValue) {
      const parsed = parseInt(kvValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  // フォールバックとして env を使う
  if (env.AUTHRIM_CODE_SHARDS) {
    const parsed = parseInt(env.AUTHRIM_CODE_SHARDS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // デフォルト値
  return DEFAULT_CODE_SHARD_COUNT;
}

/**
 * Cached shard count to avoid repeated KV lookups.
 * Cache duration: 10 seconds
 */
let cachedShardCount: number | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10000; // 10 seconds

/**
 * Get shard count with caching.
 *
 * Caches the result for 10 seconds to minimize KV overhead.
 *
 * @param env - Environment object
 * @returns Current shard count
 */
export async function getShardCount(env: Env): Promise<number> {
  const now = Date.now();

  // Return cached value if within TTL
  if (cachedShardCount !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedShardCount;
  }

  // Fetch fresh value
  const count = await getCurrentShardCount(env);

  // Update cache
  cachedShardCount = count;
  cachedAt = now;

  return count;
}

// ============================================================
// Session Store Sharding (sessionId-based)
// ============================================================

/**
 * Default shard count for session store sharding.
 * Can be overridden via AUTHRIM_SESSION_SHARDS environment variable.
 */
export const DEFAULT_SESSION_SHARD_COUNT = 32;

/**
 * Cached session shard count to avoid repeated KV lookups.
 */
let cachedSessionShardCount: number | null = null;
let cachedSessionShardAt = 0;

/**
 * Get current session shard count from KV or environment variable.
 *
 * Priority:
 * 1. KV (AUTHRIM_CONFIG namespace, key: "session_shards")
 * 2. Environment variable (AUTHRIM_SESSION_SHARDS)
 * 3. Default (DEFAULT_SESSION_SHARD_COUNT = 32)
 *
 * @param env - Environment object with KV and variables
 * @returns Current session shard count
 */
async function getCurrentSessionShardCount(env: Env): Promise<number> {
  // KV が存在すれば優先（動的変更可能）
  if (env.AUTHRIM_CONFIG) {
    const kvValue = await env.AUTHRIM_CONFIG.get('session_shards');
    if (kvValue) {
      const parsed = parseInt(kvValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  // フォールバックとして env を使う
  if (env.AUTHRIM_SESSION_SHARDS) {
    const parsed = parseInt(env.AUTHRIM_SESSION_SHARDS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // デフォルト値
  return DEFAULT_SESSION_SHARD_COUNT;
}

/**
 * Get session shard count with caching.
 *
 * Caches the result for 10 seconds to minimize KV overhead.
 *
 * @param env - Environment object
 * @returns Current session shard count
 */
export async function getSessionShardCount(env: Env): Promise<number> {
  const now = Date.now();

  // Return cached value if within TTL
  if (cachedSessionShardCount !== null && now - cachedSessionShardAt < CACHE_TTL_MS) {
    return cachedSessionShardCount;
  }

  // Fetch fresh value
  const count = await getCurrentSessionShardCount(env);

  // Update cache
  cachedSessionShardCount = count;
  cachedSessionShardAt = now;

  return count;
}

/**
 * Build a sharded Durable Object instance name for sessions.
 *
 * @param shardIndex - Shard index
 * @returns DO instance name for the shard
 */
export function buildSessionShardInstanceName(shardIndex: number): string {
  return `tenant:${DEFAULT_TENANT_ID}:session:shard-${shardIndex}`;
}
