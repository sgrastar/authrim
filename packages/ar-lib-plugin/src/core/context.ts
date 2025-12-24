/**
 * Plugin Context Implementation
 *
 * Provides plugins with access to infrastructure and services.
 * This is the main interface plugins use to interact with Authrim.
 *
 * Usage:
 * ```typescript
 * // In Worker initialization
 * const ctx = await createPluginContext(env, { tenantId: 'default' });
 *
 * // Pass to plugins
 * await plugin.initialize(ctx, config);
 * ```
 */

import type {
  PluginContext,
  PluginConfigStore,
  Logger,
  AuditLogger,
  AuditEvent,
  Env,
} from './types';
import type { IStorageInfra, IPolicyInfra, InfraEnv } from '../infra/types';
import { createStorageInfra } from '../infra/storage';
import { createPolicyInfra } from '../infra/policy';
import { z } from 'zod';

// =============================================================================
// Plugin Context Implementation
// =============================================================================

/**
 * Default Plugin Context implementation
 */
export class DefaultPluginContext implements PluginContext {
  readonly storage: IStorageInfra;
  readonly policy: IPolicyInfra;
  readonly config: PluginConfigStore;
  readonly logger: Logger;
  readonly audit: AuditLogger;
  readonly tenantId: string;
  readonly env: Env;

  constructor(options: PluginContextOptions) {
    this.storage = options.storage;
    this.policy = options.policy;
    this.config = options.config;
    this.logger = options.logger;
    this.audit = options.audit;
    this.tenantId = options.tenantId;
    this.env = options.env;
  }
}

/**
 * Options for creating PluginContext
 */
export interface PluginContextOptions {
  storage: IStorageInfra;
  policy: IPolicyInfra;
  config: PluginConfigStore;
  logger: Logger;
  audit: AuditLogger;
  tenantId: string;
  env: Env;
}

// =============================================================================
// Plugin Config Store Implementation
// =============================================================================

/**
 * KV-based Plugin Configuration Store
 *
 * Priority: Cache → KV → Environment Variables → Default Values
 */
export class KVPluginConfigStore implements PluginConfigStore {
  private kv: KVNamespace | null;
  private env: Env;
  private cache: Map<string, { value: unknown; expires: number }> = new Map();
  private readonly CACHE_TTL_MS = 60000; // 1 minute

  constructor(kv: KVNamespace | null, env: Env) {
    this.kv = kv;
    this.env = env;
  }

  async get<T>(pluginId: string, schema: z.ZodSchema<T>): Promise<T> {
    const key = `plugins:config:${pluginId}`;

    // Check cache
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value as T;
    }

    // Try KV
    let config: unknown = null;
    if (this.kv) {
      const kvValue = await this.kv.get(key);
      if (kvValue) {
        try {
          config = JSON.parse(kvValue);
        } catch {
          // Invalid JSON, ignore
        }
      }
    }

    // Fall back to environment variables
    if (!config) {
      const envKey = `PLUGIN_${pluginId.toUpperCase().replace(/-/g, '_')}_CONFIG`;
      const envValue = this.env[envKey];
      if (typeof envValue === 'string') {
        try {
          config = JSON.parse(envValue);
        } catch {
          // Invalid JSON, ignore
        }
      }
    }

    // Parse with defaults from schema
    const result = schema.parse(config ?? {});

    // Cache the result
    this.cache.set(key, {
      value: result,
      expires: Date.now() + this.CACHE_TTL_MS,
    });

    return result;
  }

  async getForTenant<T>(pluginId: string, tenantId: string, schema: z.ZodSchema<T>): Promise<T> {
    const tenantKey = `plugins:config:${pluginId}:tenant:${tenantId}`;

    // Check cache
    const cached = this.cache.get(tenantKey);
    if (cached && cached.expires > Date.now()) {
      return cached.value as T;
    }

    // Try tenant-specific config first
    let config: unknown = null;
    if (this.kv) {
      const kvValue = await this.kv.get(tenantKey);
      if (kvValue) {
        try {
          config = JSON.parse(kvValue);
        } catch {
          // Invalid JSON, ignore
        }
      }
    }

    // Fall back to global config
    if (!config) {
      return this.get(pluginId, schema);
    }

    // Merge with global config (tenant overrides global)
    const globalConfig = await this.get(pluginId, schema);
    const mergedConfig = { ...globalConfig, ...config };
    const result = schema.parse(mergedConfig);

    // Cache the result
    this.cache.set(tenantKey, {
      value: result,
      expires: Date.now() + this.CACHE_TTL_MS,
    });

    return result;
  }

  async set<T>(pluginId: string, config: T): Promise<void> {
    if (!this.kv) {
      throw new Error('KV namespace not available for config storage');
    }

    const key = `plugins:config:${pluginId}`;
    await this.kv.put(key, JSON.stringify(config));

    // Invalidate cache
    this.cache.delete(key);
  }

  /**
   * Clear the in-memory cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// =============================================================================
// Logger Implementation
// =============================================================================

/**
 * Console-based Logger implementation
 */
export class ConsoleLogger implements Logger {
  private prefix: string;

  constructor(prefix: string = '[authrim]') {
    this.prefix = prefix;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    console.debug(this.prefix, message, data ?? '');
  }

  info(message: string, data?: Record<string, unknown>): void {
    console.info(this.prefix, message, data ?? '');
  }

  warn(message: string, data?: Record<string, unknown>): void {
    console.warn(this.prefix, message, data ?? '');
  }

  error(message: string, data?: Record<string, unknown>): void {
    console.error(this.prefix, message, data ?? '');
  }
}

// =============================================================================
// Audit Logger Implementation
// =============================================================================

/**
 * D1-based Audit Logger implementation
 */
export class D1AuditLogger implements AuditLogger {
  private storage: IStorageInfra;
  private tenantId: string;

  constructor(storage: IStorageInfra, tenantId: string) {
    this.storage = storage;
    this.tenantId = tenantId;
  }

  async log(event: AuditEvent): Promise<void> {
    const id = crypto.randomUUID();
    const timestamp = event.timestamp ?? Date.now();

    try {
      await this.storage.adapter.execute(
        `INSERT INTO audit_logs (id, tenant_id, event_type, actor_id, actor_type, target_type, target_id, metadata, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          this.tenantId,
          event.eventType,
          event.actorId ?? null,
          event.actorType,
          event.targetType ?? null,
          event.targetId ?? null,
          event.metadata ? JSON.stringify(event.metadata) : null,
          timestamp,
        ]
      );
    } catch (error) {
      // Don't throw on audit log failures, just log to console
      console.error('[audit] Failed to write audit log:', error);
    }
  }
}

/**
 * No-op Audit Logger (for testing or when audit is disabled)
 */
export class NoopAuditLogger implements AuditLogger {
  async log(_event: AuditEvent): Promise<void> {
    // No-op
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Options for creating PluginContext
 */
export interface CreatePluginContextOptions {
  /** Tenant ID */
  tenantId: string;

  /** Custom logger (optional) */
  logger?: Logger;

  /** Custom audit logger (optional) */
  auditLogger?: AuditLogger;

  /** Enable audit logging (defaults to true) */
  enableAudit?: boolean;
}

/**
 * Create a PluginContext instance
 *
 * This is the main entry point for initializing the plugin infrastructure.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param options - Context options
 * @returns Initialized PluginContext
 *
 * @example
 * ```typescript
 * // In Worker fetch handler
 * export default {
 *   async fetch(request, env) {
 *     const ctx = await createPluginContext(env, { tenantId: 'default' });
 *
 *     // Use context
 *     const user = await ctx.storage.user.get(userId);
 *
 *     // Pass to plugins
 *     await somePlugin.initialize(ctx, config);
 *   }
 * };
 * ```
 */
export async function createPluginContext(
  env: InfraEnv & Env,
  options: CreatePluginContextOptions
): Promise<PluginContext> {
  // Initialize storage
  const storage = await createStorageInfra(env);

  // Initialize policy
  const policy = await createPolicyInfra(env, storage);

  // Create config store
  const config = new KVPluginConfigStore(env.AUTHRIM_CONFIG ?? null, env);

  // Create logger
  const logger = options.logger ?? new ConsoleLogger();

  // Create audit logger
  let audit: AuditLogger;
  if (options.auditLogger) {
    audit = options.auditLogger;
  } else if (options.enableAudit !== false) {
    audit = new D1AuditLogger(storage, options.tenantId);
  } else {
    audit = new NoopAuditLogger();
  }

  return new DefaultPluginContext({
    storage,
    policy,
    config,
    logger,
    audit,
    tenantId: options.tenantId,
    env,
  });
}

// =============================================================================
// Exports
// =============================================================================

export type { PluginContext, PluginConfigStore, Logger, AuditLogger, AuditEvent };
