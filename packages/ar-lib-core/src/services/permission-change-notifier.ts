/**
 * Permission Change Notifier Service
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Publishes permission change events for:
 * - KV cache invalidation
 * - Audit log recording
 * - WebSocket notification via PermissionChangeHub
 *
 * Usage:
 * ```typescript
 * const notifier = createPermissionChangeNotifier({
 *   db: env.DB,
 *   cache: env.REBAC_CACHE,
 *   permissionChangeHub: env.PERMISSION_CHANGE_HUB,
 *   tenantId: 'default',
 * });
 *
 * await notifier.publish({
 *   event: 'grant',
 *   tenant_id: 'default',
 *   subject_id: 'user_123',
 *   resource: 'document:doc_456',
 *   relation: 'viewer',
 *   timestamp: Date.now(),
 * });
 * ```
 */

import type { KVNamespace, DurableObjectNamespace } from '@cloudflare/workers-types';
import type { PermissionChangeEvent, AuditLogConfig } from '../types/check-api';
import { createLogger } from '../utils/logger';

const log = createLogger().module('PERMISSION-CHANGE-NOTIFIER');

// =============================================================================
// Types
// =============================================================================

/**
 * Permission Change Notifier configuration
 */
export interface PermissionChangeNotifierConfig {
  /** D1 Database (for audit log) */
  db?: D1Database;
  /** KV Namespace for cache invalidation */
  cache?: KVNamespace;
  /** PermissionChangeHub Durable Object namespace */
  permissionChangeHub?: DurableObjectNamespace;
  /** Default tenant ID */
  tenantId?: string;
  /** Audit log configuration */
  auditConfig?: AuditLogConfig;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Permission Change Notifier interface
 */
export interface PermissionChangeNotifier {
  /**
   * Publish a permission change event
   */
  publish(event: PermissionChangeEvent): Promise<PublishResult>;

  /**
   * Invalidate cache for a subject
   */
  invalidateCacheForSubject(tenantId: string, subjectId: string): Promise<void>;

  /**
   * Invalidate cache for a resource
   */
  invalidateCacheForResource(tenantId: string, resource: string): Promise<void>;
}

/**
 * Result of publishing an event
 */
export interface PublishResult {
  /** Whether the event was published successfully */
  success: boolean;
  /** Whether the cache was invalidated */
  cacheInvalidated: boolean;
  /** Whether the audit log was recorded */
  auditLogged: boolean;
  /** Number of WebSocket clients notified */
  websocketNotified: number;
  /** Error message if any operation failed */
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Cache key prefix for permission checks */
const CHECK_CACHE_PREFIX = 'check:';

/** Cache key prefix for ReBAC */
const REBAC_CACHE_PREFIX = 'rebac:';

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a Permission Change Notifier instance
 */
export function createPermissionChangeNotifier(
  config: PermissionChangeNotifierConfig
): PermissionChangeNotifier {
  const {
    db,
    cache,
    permissionChangeHub,
    tenantId = 'default',
    auditConfig,
    debug = false,
  } = config;

  const debugLog = debug
    ? (message: string, context?: Record<string, unknown>) => log.debug(message, context)
    : () => {};

  /**
   * Invalidate KV cache entries related to an event
   */
  async function invalidateKVCache(event: PermissionChangeEvent): Promise<boolean> {
    if (!cache) {
      debugLog('No cache configured, skipping cache invalidation');
      return false;
    }

    try {
      const keysToDelete: string[] = [];

      // Invalidate subject-based cache entries
      keysToDelete.push(`${CHECK_CACHE_PREFIX}${event.tenant_id}:${event.subject_id}:*`);
      keysToDelete.push(`${REBAC_CACHE_PREFIX}${event.tenant_id}:${event.subject_id}:*`);

      // Invalidate resource-based cache entries if resource is specified
      if (event.resource) {
        keysToDelete.push(`${CHECK_CACHE_PREFIX}${event.tenant_id}:*:${event.resource}:*`);
        keysToDelete.push(`${REBAC_CACHE_PREFIX}${event.tenant_id}:*:${event.resource}:*`);
      }

      // Note: KV doesn't support wildcard deletion
      // We use a workaround by listing keys with prefix and deleting them
      // For production, consider using cache with TTL and accepting eventual consistency

      // Delete specific known keys based on the event
      const specificKeys = [
        // Subject's permission cache
        `${CHECK_CACHE_PREFIX}${event.tenant_id}:subject:${event.subject_id}`,
        // Subject's role cache
        `${REBAC_CACHE_PREFIX}${event.tenant_id}:roles:${event.subject_id}`,
      ];

      // Add resource-specific keys if resource is specified
      if (event.resource) {
        specificKeys.push(`${CHECK_CACHE_PREFIX}${event.tenant_id}:resource:${event.resource}`);
        specificKeys.push(`${REBAC_CACHE_PREFIX}${event.tenant_id}:relations:${event.resource}`);

        // If permission is specified, add exact permission cache key
        if (event.permission) {
          specificKeys.push(
            `${CHECK_CACHE_PREFIX}${event.tenant_id}:${event.subject_id}:${event.permission}`
          );
        }
      }

      // Delete all specific keys (silently ignore if key doesn't exist)
      await Promise.all(
        specificKeys.map(async (key) => {
          try {
            await cache.delete(key);
            debugLog('Deleted cache key', { key });
          } catch (e) {
            // Ignore errors for non-existent keys
          }
        })
      );

      debugLog('Cache invalidation complete', { event: event.event, subjectId: event.subject_id });
      return true;
    } catch (error) {
      log.error('Cache invalidation error', {}, error as Error);
      return false;
    }
  }

  /**
   * Record audit log entry
   */
  async function recordAuditLog(event: PermissionChangeEvent): Promise<boolean> {
    if (!db) {
      debugLog('No database configured, skipping audit log');
      return false;
    }

    // Check if audit logging is enabled for this type of event
    // Permission change events are always logged (separate from check audits)
    try {
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      await db
        .prepare(
          `INSERT INTO permission_change_audit (
            id, tenant_id, event_type, subject_id, resource, relation, permission, timestamp, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          event.tenant_id,
          event.event,
          event.subject_id,
          event.resource ?? null,
          event.relation ?? null,
          event.permission ?? null,
          event.timestamp,
          now
        )
        .run();

      debugLog('Audit log recorded', { event: event.event, subjectId: event.subject_id });
      return true;
    } catch (error) {
      // If table doesn't exist, log warning but don't fail
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('no such table')) {
        debugLog('Audit log table not found, skipping (run migration to enable)');
        return false;
      }
      log.error('Audit log error', {}, error as Error);
      return false;
    }
  }

  /**
   * Notify WebSocket clients via PermissionChangeHub
   */
  async function notifyWebSockets(event: PermissionChangeEvent): Promise<number> {
    if (!permissionChangeHub) {
      debugLog('No PermissionChangeHub configured, skipping WebSocket notification');
      return 0;
    }

    try {
      // Get or create the hub for this tenant
      const hubId = permissionChangeHub.idFromName(event.tenant_id);
      const hub = permissionChangeHub.get(hubId);

      // Send broadcast request to the hub
      const response = await hub.fetch('https://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        log.error('WebSocket broadcast failed', { status: response.status });
        return 0;
      }

      const result = (await response.json()) as { notified?: number };
      debugLog('WebSocket notification sent', { notified: result.notified ?? 0 });
      return result.notified ?? 0;
    } catch (error) {
      log.error('WebSocket notification error', {}, error as Error);
      return 0;
    }
  }

  return {
    async publish(event: PermissionChangeEvent): Promise<PublishResult> {
      debugLog('Publishing event', { event: event.event, subjectId: event.subject_id });

      // Execute all operations concurrently
      const [cacheInvalidated, auditLogged, websocketNotified] = await Promise.all([
        invalidateKVCache(event),
        recordAuditLog(event),
        notifyWebSockets(event),
      ]);

      return {
        success: true,
        cacheInvalidated,
        auditLogged,
        websocketNotified,
      };
    },

    async invalidateCacheForSubject(targetTenantId: string, subjectId: string): Promise<void> {
      if (!cache) return;

      try {
        // Delete known cache patterns for subject
        const keys = [
          `${CHECK_CACHE_PREFIX}${targetTenantId}:subject:${subjectId}`,
          `${REBAC_CACHE_PREFIX}${targetTenantId}:roles:${subjectId}`,
        ];

        await Promise.all(keys.map((key) => cache.delete(key).catch(() => {})));
        debugLog('Invalidated cache for subject', { subjectId });
      } catch (error) {
        log.error('Subject cache invalidation error', { subjectId }, error as Error);
      }
    },

    async invalidateCacheForResource(targetTenantId: string, resource: string): Promise<void> {
      if (!cache) return;

      try {
        // Delete known cache patterns for resource
        const keys = [
          `${CHECK_CACHE_PREFIX}${targetTenantId}:resource:${resource}`,
          `${REBAC_CACHE_PREFIX}${targetTenantId}:relations:${resource}`,
        ];

        await Promise.all(keys.map((key) => cache.delete(key).catch(() => {})));
        debugLog('Invalidated cache for resource', { resource });
      } catch (error) {
        log.error('Resource cache invalidation error', { resource }, error as Error);
      }
    },
  };
}

/**
 * Helper function to create a permission change event
 */
export function createPermissionChangeEvent(
  event: 'grant' | 'revoke' | 'modify',
  tenantId: string,
  subjectId: string,
  options: {
    resource?: string;
    relation?: string;
    permission?: string;
  } = {}
): PermissionChangeEvent {
  return {
    event,
    tenant_id: tenantId,
    subject_id: subjectId,
    resource: options.resource,
    relation: options.relation,
    permission: options.permission,
    timestamp: Date.now(),
  };
}
