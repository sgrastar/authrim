/**
 * Plugin Context Utilities
 *
 * Provides utility classes for creating PluginContext.
 * The actual PluginContext creation is done by the Worker using ar-lib-core.
 *
 * ar-lib-plugin provides:
 * - Interfaces (PluginContext, PluginConfigStore, Logger, etc.)
 * - Utility implementations (KVPluginConfigStore, ConsoleLogger, NoopAuditLogger)
 *
 * ar-lib-core provides:
 * - Storage implementations (CloudflareStorageAdapter, UserStore, etc.)
 * - Policy implementations (ReBACService, etc.)
 *
 * Worker creates PluginContext by combining both.
 */

import type {
  PluginContext,
  PluginConfigStore,
  PluginStorageAccess,
  IPolicyInfra,
  Logger,
  AuditLogger,
  AuditEvent,
  Env,
} from './types';
import { z } from 'zod';
import { legacyZodErrorMessage } from '@authrim/ar-lib-core/utils/zod-legacy-errors';

// =============================================================================
// Plugin Context Options
// =============================================================================

/**
 * Options for creating PluginContext
 *
 * Worker provides storage and policy implementations from ar-lib-core.
 */
export interface PluginContextOptions {
  /** Storage access (implementation from ar-lib-core) */
  storage: PluginStorageAccess;

  /** Policy infrastructure (implementation from ar-lib-core) */
  policy: IPolicyInfra;

  /** Plugin configuration store */
  config: PluginConfigStore;

  /** Logger */
  logger: Logger;

  /** Audit logger */
  audit: AuditLogger;

  /** Tenant ID */
  tenantId: string;

  /** Environment bindings */
  env: Env;
}

/**
 * Create a PluginContext from options
 *
 * This is a simple factory function. The Worker is responsible for
 * providing storage and policy implementations from ar-lib-core.
 */
export function createPluginContext(options: PluginContextOptions): PluginContext {
  return {
    storage: options.storage,
    policy: options.policy,
    config: options.config,
    logger: options.logger,
    audit: options.audit,
    tenantId: options.tenantId,
    env: options.env,
  };
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

  async get<T>(pluginId: string, schema: z.ZodType<T>): Promise<T> {
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
    const result = schema.parse(config ?? {}, { error: legacyZodErrorMessage });

    // Cache the result
    this.cache.set(key, {
      value: result,
      expires: Date.now() + this.CACHE_TTL_MS,
    });

    return result;
  }

  async getForTenant<T>(pluginId: string, tenantId: string, schema: z.ZodType<T>): Promise<T> {
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
    const result = schema.parse(mergedConfig, { error: legacyZodErrorMessage });

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
 * No-op Audit Logger (for testing or when audit is disabled)
 */
export class NoopAuditLogger implements AuditLogger {
  async log(_event: AuditEvent): Promise<void> {
    // No-op
  }
}

// =============================================================================
// Exports
// =============================================================================

export type { PluginContext, PluginConfigStore, Logger, AuditLogger, AuditEvent };
