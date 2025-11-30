/**
 * Tenant Context Utilities
 *
 * Single-tenant mode: always returns 'default'
 * Future MT: resolve from subdomain/header
 *
 * This module provides the foundation for future multi-tenant support
 * while keeping the system single-tenant for now.
 */

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
 * Calculate shard index for authorization codes.
 * Uses random selection to distribute load across all shards.
 *
 * Note: Previously used user ID hash, but this caused all codes from a single user
 * to be on the same shard, defeating the purpose of sharding for load testing.
 *
 * @param shardCount - Number of shards (default: 64)
 * @returns Shard index (0 to shardCount - 1)
 */
export function getAuthCodeShardIndex(shardCount: number = DEFAULT_CODE_SHARD_COUNT): number {
  // Random shard selection for even distribution across all shards
  return Math.floor(Math.random() * shardCount);
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
