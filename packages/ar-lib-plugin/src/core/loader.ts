/**
 * Plugin Loader
 *
 * Responsible for loading, initializing, and managing plugin lifecycle.
 *
 * Initialization Order (fixed order):
 * 1. validate() - Configuration validation using Zod schema
 * 2. initialize() - External service connection, warmup, dependency checks
 * 3. register() - Capability registration (side-effect free)
 *
 * This order ensures:
 * - Invalid configurations are caught early (before any side effects)
 * - Failed initialization prevents registration (safety)
 * - register() is synchronous and purely declarative
 */

import type { AuthrimPlugin, PluginContext, HealthStatus } from './types';
import { CapabilityRegistry } from './registry';
import { validatePluginConfig } from './schema';

// =============================================================================
// Types
// =============================================================================

/**
 * Plugin load result
 */
export interface PluginLoadResult {
  pluginId: string;
  success: boolean;
  error?: string;
  loadTimeMs: number;
}

/**
 * Plugin status
 */
export interface PluginStatus {
  pluginId: string;
  loaded: boolean;
  enabled: boolean;
  health: HealthStatus;
  capabilities: string[];
  loadedAt?: number;
  config?: unknown;
}

/**
 * Loader options
 */
export interface PluginLoaderOptions {
  /** Continue loading other plugins if one fails */
  continueOnError?: boolean;

  /** Log loading progress */
  verbose?: boolean;

  /** Custom error handler */
  onError?: (pluginId: string, error: Error) => void;

  /** Health check timeout in milliseconds (default: 5000) */
  healthCheckTimeoutMs?: number;
}

// =============================================================================
// Plugin Loader
// =============================================================================

/**
 * Plugin Loader
 *
 * Manages plugin lifecycle: loading, initialization, and shutdown.
 *
 * Usage:
 * ```typescript
 * const loader = new PluginLoader(registry, ctx);
 *
 * // Load a single plugin
 * await loader.loadPlugin(resendEmailPlugin, config);
 *
 * // Load multiple plugins
 * await loader.loadPlugins([
 *   { plugin: consoleNotifierPlugin, config: {} },
 *   { plugin: resendEmailPlugin, config: { apiKey: '...' } },
 * ]);
 *
 * // Check status
 * const status = loader.getStatus('notifier-resend');
 *
 * // Shutdown all plugins
 * await loader.shutdown();
 * ```
 */
export class PluginLoader {
  private registry: CapabilityRegistry;
  private context: PluginContext;
  private loadedPlugins: Map<string, LoadedPlugin> = new Map();
  private options: Required<PluginLoaderOptions>;

  constructor(
    registry: CapabilityRegistry,
    context: PluginContext,
    options: PluginLoaderOptions = {}
  ) {
    this.registry = registry;
    this.context = context;
    this.options = {
      continueOnError: options.continueOnError ?? true,
      verbose: options.verbose ?? false,
      onError:
        options.onError ??
        ((pluginId, error) => {
          context.logger.error(`[plugin-loader] Failed to load plugin: ${pluginId}`, {
            error: error.message,
          });
        }),
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? 5000,
    };
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /**
   * Load a single plugin
   *
   * Steps:
   * 1. Validate configuration against schema
   * 2. Call initialize() if present
   * 3. Call register() to register capabilities
   */
  async loadPlugin<T>(plugin: AuthrimPlugin<T>, config: unknown): Promise<PluginLoadResult> {
    const startTime = Date.now();
    const pluginId = plugin.id;

    // Check if already loaded
    if (this.loadedPlugins.has(pluginId)) {
      return {
        pluginId,
        success: false,
        error: `Plugin '${pluginId}' is already loaded`,
        loadTimeMs: 0,
      };
    }

    try {
      // Step 1: Validate configuration
      if (this.options.verbose) {
        this.context.logger.debug(`[plugin-loader] Validating config for: ${pluginId}`);
      }

      const validationResult = validatePluginConfig(plugin.configSchema, config);
      if (!validationResult.success) {
        const errorMessages = validationResult.errors
          .map((e: { message: string }) => e.message)
          .join('; ');
        throw new Error(`Configuration validation failed: ${errorMessages}`);
      }

      const validatedConfig = validationResult.data as T;

      // Step 2: Initialize (optional)
      if (plugin.initialize) {
        if (this.options.verbose) {
          this.context.logger.debug(`[plugin-loader] Initializing: ${pluginId}`);
        }

        await plugin.initialize(this.context, validatedConfig);
      }

      // Step 3: Register capabilities
      if (this.options.verbose) {
        this.context.logger.debug(`[plugin-loader] Registering capabilities: ${pluginId}`);
      }

      plugin.register(this.registry, validatedConfig);

      // Track loaded plugin
      const loadTimeMs = Date.now() - startTime;
      this.loadedPlugins.set(pluginId, {
        plugin,
        config: validatedConfig,
        loadedAt: Date.now(),
      });

      if (this.options.verbose) {
        this.context.logger.info(`[plugin-loader] Loaded plugin: ${pluginId}`, {
          loadTimeMs,
          capabilities: plugin.capabilities,
        });
      }

      return {
        pluginId,
        success: true,
        loadTimeMs,
      };
    } catch (error) {
      const loadTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.options.onError(pluginId, error instanceof Error ? error : new Error(errorMessage));

      return {
        pluginId,
        success: false,
        error: errorMessage,
        loadTimeMs,
      };
    }
  }

  /**
   * Load multiple plugins
   */
  async loadPlugins<T>(
    plugins: Array<{ plugin: AuthrimPlugin<T>; config: unknown }>
  ): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = [];

    for (const { plugin, config } of plugins) {
      const result = await this.loadPlugin(plugin, config);
      results.push(result);

      // Stop on error if continueOnError is false
      if (!result.success && !this.options.continueOnError) {
        break;
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Get plugin status
   */
  async getStatus(pluginId: string): Promise<PluginStatus | null> {
    const loaded = this.loadedPlugins.get(pluginId);
    if (!loaded) {
      return null;
    }

    // Get health status with timeout
    let health: HealthStatus = { status: 'healthy', message: 'No health check defined' };
    if (loaded.plugin.healthCheck) {
      try {
        const timeout = this.options.healthCheckTimeoutMs;
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timeout')), timeout)
        );
        health = await Promise.race([
          loaded.plugin.healthCheck(this.context, loaded.config),
          timeoutPromise,
        ]);
      } catch (error) {
        health = {
          status: 'unhealthy',
          message: error instanceof Error ? error.message : 'Health check failed',
        };
      }
    }

    return {
      pluginId,
      loaded: true,
      enabled: true, // TODO: Check enabled status from config store
      health,
      capabilities: loaded.plugin.capabilities,
      loadedAt: loaded.loadedAt,
    };
  }

  /**
   * Get all loaded plugin IDs
   */
  getLoadedPlugins(): string[] {
    return Array.from(this.loadedPlugins.keys());
  }

  /**
   * Check if a plugin is loaded
   */
  isLoaded(pluginId: string): boolean {
    return this.loadedPlugins.has(pluginId);
  }

  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  /**
   * Run health checks for all loaded plugins
   */
  async healthCheckAll(): Promise<Map<string, HealthStatus>> {
    const results = new Map<string, HealthStatus>();
    const timeout = this.options.healthCheckTimeoutMs;

    for (const [pluginId, loaded] of this.loadedPlugins) {
      if (loaded.plugin.healthCheck) {
        try {
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), timeout)
          );
          const health = await Promise.race([
            loaded.plugin.healthCheck(this.context, loaded.config),
            timeoutPromise,
          ]);
          results.set(pluginId, health);
        } catch (error) {
          results.set(pluginId, {
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Health check failed',
          });
        }
      } else {
        results.set(pluginId, {
          status: 'healthy',
          message: 'No health check defined',
        });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Shutdown all loaded plugins
   */
  async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    for (const [pluginId, loaded] of this.loadedPlugins) {
      if (loaded.plugin.shutdown) {
        if (this.options.verbose) {
          this.context.logger.debug(`[plugin-loader] Shutting down: ${pluginId}`);
        }

        shutdownPromises.push(
          loaded.plugin.shutdown().catch((error) => {
            this.context.logger.error(`[plugin-loader] Shutdown error for: ${pluginId}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          })
        );
      }
    }

    await Promise.all(shutdownPromises);
    this.loadedPlugins.clear();

    if (this.options.verbose) {
      this.context.logger.info('[plugin-loader] All plugins shut down');
    }
  }

  /**
   * Unload a specific plugin
   */
  async unloadPlugin(pluginId: string): Promise<boolean> {
    const loaded = this.loadedPlugins.get(pluginId);
    if (!loaded) {
      return false;
    }

    if (loaded.plugin.shutdown) {
      await loaded.plugin.shutdown();
    }

    this.loadedPlugins.delete(pluginId);
    return true;
  }
}

// =============================================================================
// Internal Types
// =============================================================================

interface LoadedPlugin {
  plugin: AuthrimPlugin<unknown>;
  config: unknown;
  loadedAt: number;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a plugin loader instance
 *
 * Convenience factory for creating a loader with default options.
 */
export function createPluginLoader(
  registry: CapabilityRegistry,
  context: PluginContext,
  options?: PluginLoaderOptions
): PluginLoader {
  return new PluginLoader(registry, context, options);
}
