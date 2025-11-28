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
