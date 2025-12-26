/**
 * Policy Cache Types
 *
 * Types for caching ResolvedPolicy to improve performance.
 * Includes cache key structure, invalidation triggers, and configuration.
 */

import type { ResolvedPolicy } from './resolved';

// =============================================================================
// Cache Key
// =============================================================================

/**
 * Cache key for resolved policies.
 * Uniquely identifies a policy resolution result.
 */
export interface PolicyCacheKey {
  /** Tenant ID */
  tenantId: string;
  /** Client ID */
  clientId: string;
  /** Tenant contract version */
  tenantVersion: number;
  /** Client contract version */
  clientVersion: number;
}

/**
 * Generate cache key string from PolicyCacheKey.
 */
export function generateCacheKeyString(key: PolicyCacheKey): string {
  return `policy:${key.tenantId}:${key.clientId}:t${key.tenantVersion}:c${key.clientVersion}`;
}

/**
 * Parse cache key string back to PolicyCacheKey.
 */
export function parseCacheKeyString(keyString: string): PolicyCacheKey | null {
  const match = keyString.match(/^policy:([^:]+):([^:]+):t(\d+):c(\d+)$/);
  if (!match) return null;
  return {
    tenantId: match[1],
    clientId: match[2],
    tenantVersion: parseInt(match[3], 10),
    clientVersion: parseInt(match[4], 10),
  };
}

// =============================================================================
// Cache Entry
// =============================================================================

/**
 * Cache entry containing resolved policy and metadata.
 */
export interface PolicyCacheEntry {
  /** The cached policy */
  policy: ResolvedPolicy;
  /** When the entry was cached (ISO 8601) */
  cachedAt: string;
  /** When the entry expires (ISO 8601) */
  expiresAt: string;
  /** Number of cache hits */
  hitCount: number;
  /** Last accessed time (ISO 8601) */
  lastAccessedAt: string;
  /** Cache entry size in bytes (approximate) */
  sizeBytes?: number;
}

/**
 * Check if a cache entry is expired.
 */
export function isCacheEntryExpired(entry: PolicyCacheEntry): boolean {
  return new Date(entry.expiresAt) < new Date();
}

// =============================================================================
// Cache Invalidation
// =============================================================================

/**
 * Trigger for cache invalidation.
 * Discriminated union of different invalidation causes.
 */
export type CacheInvalidationTrigger =
  | TenantUpdatedTrigger
  | ClientUpdatedTrigger
  | ManualTrigger
  | TtlExpiredTrigger
  | BulkInvalidationTrigger;

/**
 * Tenant contract was updated.
 */
export interface TenantUpdatedTrigger {
  type: 'tenant_updated';
  tenantId: string;
  oldVersion: number;
  newVersion: number;
}

/**
 * Client contract was updated.
 */
export interface ClientUpdatedTrigger {
  type: 'client_updated';
  clientId: string;
  oldVersion: number;
  newVersion: number;
}

/**
 * Manual invalidation requested.
 */
export interface ManualTrigger {
  type: 'manual';
  reason: string;
  requestedBy: string;
}

/**
 * Cache entry TTL expired.
 */
export interface TtlExpiredTrigger {
  type: 'ttl_expired';
}

/**
 * Bulk invalidation (e.g., tenant-wide clear).
 */
export interface BulkInvalidationTrigger {
  type: 'bulk_invalidation';
  scope: 'tenant' | 'all';
  tenantId?: string;
  reason: string;
}

/**
 * Event recording a cache invalidation.
 */
export interface CacheInvalidationEvent {
  /** Event ID */
  id: string;
  /** What triggered the invalidation */
  trigger: CacheInvalidationTrigger;
  /** Cache keys that were invalidated */
  invalidatedKeys: string[];
  /** When invalidation occurred (ISO 8601) */
  timestamp: string;
  /** Number of active sessions potentially affected */
  affectedSessionCount: number;
  /** Duration of invalidation operation (ms) */
  durationMs?: number;
}

// =============================================================================
// Cache Configuration
// =============================================================================

/**
 * Policy cache configuration.
 */
export interface PolicyCacheConfig {
  /** Cache TTL in seconds */
  ttlSeconds: number;
  /** Maximum number of entries */
  maxEntries: number;
  /** Invalidation strategy */
  invalidationStrategy: CacheInvalidationStrategy;
  /** Enable cache warming */
  warmingEnabled: boolean;
  /** Cache storage type */
  storageType: CacheStorageType;
}

/**
 * Cache invalidation strategy.
 */
export type CacheInvalidationStrategy =
  | 'immediate' // Invalidate immediately on contract change
  | 'lazy' // Mark as stale, refresh on next access
  | 'scheduled'; // Batch invalidations at intervals

/**
 * Cache storage type.
 */
export type CacheStorageType =
  | 'memory' // In-memory (Worker global)
  | 'kv' // Cloudflare KV
  | 'durable_object'; // Cloudflare Durable Object

/**
 * Default cache configuration.
 */
export const DEFAULT_POLICY_CACHE_CONFIG: PolicyCacheConfig = {
  ttlSeconds: 300, // 5 minutes
  maxEntries: 10000,
  invalidationStrategy: 'immediate',
  warmingEnabled: false,
  storageType: 'kv',
};

// =============================================================================
// Cache Statistics
// =============================================================================

/**
 * Cache statistics for monitoring.
 */
export interface PolicyCacheStats {
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Hit rate (hits / total) */
  hitRate: number;
  /** Current number of entries */
  entryCount: number;
  /** Total size in bytes */
  totalSizeBytes: number;
  /** Average entry size */
  avgEntrySizeBytes: number;
  /** Number of evictions */
  evictions: number;
  /** Number of invalidations */
  invalidations: number;
  /** Stats collection period start */
  periodStart: string;
  /** Stats collection period end */
  periodEnd: string;
}

/**
 * Cache health status.
 */
export interface PolicyCacheHealth {
  /** Whether cache is healthy */
  healthy: boolean;
  /** Health status code */
  status: 'ok' | 'degraded' | 'unhealthy';
  /** Issues detected */
  issues: CacheHealthIssue[];
  /** Last check time */
  checkedAt: string;
}

/**
 * Cache health issue.
 */
export interface CacheHealthIssue {
  /** Issue type */
  type: 'high_miss_rate' | 'low_memory' | 'high_eviction_rate' | 'stale_entries';
  /** Issue description */
  message: string;
  /** Severity */
  severity: 'warning' | 'error';
  /** Suggested action */
  suggestion?: string;
}

// =============================================================================
// Cache Warming
// =============================================================================

/**
 * Cache warming request.
 */
export interface CacheWarmingRequest {
  /** Tenant IDs to warm */
  tenantIds?: string[];
  /** Client IDs to warm */
  clientIds?: string[];
  /** Warm all active policies */
  warmAll?: boolean;
  /** Priority level */
  priority: 'low' | 'normal' | 'high';
}

/**
 * Cache warming result.
 */
export interface CacheWarmingResult {
  /** Whether warming completed successfully */
  success: boolean;
  /** Number of policies warmed */
  warmedCount: number;
  /** Number of failures */
  failedCount: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Errors encountered */
  errors?: string[];
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if trigger is tenant update.
 */
export function isTenantUpdatedTrigger(
  trigger: CacheInvalidationTrigger
): trigger is TenantUpdatedTrigger {
  return trigger.type === 'tenant_updated';
}

/**
 * Check if trigger is client update.
 */
export function isClientUpdatedTrigger(
  trigger: CacheInvalidationTrigger
): trigger is ClientUpdatedTrigger {
  return trigger.type === 'client_updated';
}

/**
 * Check if trigger is manual.
 */
export function isManualTrigger(trigger: CacheInvalidationTrigger): trigger is ManualTrigger {
  return trigger.type === 'manual';
}
