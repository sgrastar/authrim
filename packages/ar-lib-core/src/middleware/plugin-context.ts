/**
 * Plugin Context Middleware
 *
 * This middleware provides access to the Authrim Plugin System.
 * It initializes the PluginContext once per Worker lifecycle (singleton pattern)
 * and makes it available to all handlers via c.get('pluginContext').
 *
 * The PluginContext provides:
 * - Storage infrastructure (IStorageInfra)
 * - Policy infrastructure (IPolicyInfra)
 * - Plugin configuration store
 * - Capability registry (notifiers, idps, authenticators)
 *
 * Usage:
 * ```typescript
 * import { pluginContextMiddleware, getPluginContext } from '@authrim/ar-lib-core';
 *
 * app.use('*', pluginContextMiddleware());
 *
 * // In handler:
 * const pluginCtx = getPluginContext(c);
 * const notifier = pluginCtx.registry.getNotifier('email');
 * ```
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import { getTenantIdFromContext } from './request-context';

// =============================================================================
// Types
// =============================================================================

/**
 * Plugin context available to handlers
 */
export interface WorkerPluginContext {
  /**
   * Capability registry for accessing registered plugins
   */
  registry: PluginCapabilityRegistry;

  /**
   * Whether the plugin system is initialized
   */
  initialized: boolean;

  /**
   * Tenant ID for this request
   */
  tenantId: string;

  /**
   * Get plugin configuration
   */
  getPluginConfig<T>(pluginId: string, defaultValue: T): Promise<T>;

  /**
   * Check if a plugin is enabled
   */
  isPluginEnabled(pluginId: string): Promise<boolean>;
}

/**
 * Simplified capability registry interface for Workers
 * (avoids importing the full ar-lib-plugin in ar-lib-core)
 */
export interface PluginCapabilityRegistry {
  /**
   * Get a notifier by channel
   */
  getNotifier(channel: string): NotifierHandler | undefined;

  /**
   * Get an IdP handler by provider ID
   */
  getIdP(providerId: string): IdPHandler | undefined;

  /**
   * Get an authenticator by type
   */
  getAuthenticator(type: string): AuthenticatorHandler | undefined;

  /**
   * List all available capabilities
   */
  listCapabilities(): string[];
}

/**
 * Notifier handler interface (simplified)
 */
export interface NotifierHandler {
  send(notification: {
    channel: string;
    to: string;
    from?: string;
    subject?: string;
    body: string;
    templateId?: string;
    templateVars?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
    retryable?: boolean;
  }>;
}

/**
 * IdP handler interface (simplified)
 */
export interface IdPHandler {
  getAuthorizationUrl(params: {
    redirectUri: string;
    state: string;
    nonce?: string;
    scopes?: string[];
  }): Promise<string>;

  exchangeCode(params: { code: string; redirectUri: string; codeVerifier?: string }): Promise<{
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresIn?: number;
    tokenType: string;
  }>;

  getUserInfo(accessToken: string): Promise<{
    sub: string;
    email?: string;
    emailVerified?: boolean;
    name?: string;
    picture?: string;
  }>;
}

/**
 * Authenticator handler interface (simplified)
 */
export interface AuthenticatorHandler {
  createChallenge(params: {
    userId: string;
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    challengeId: string;
    challenge: unknown;
    expiresAt: number;
  }>;

  verifyResponse(params: {
    challengeId: string;
    response: unknown;
    userId: string;
    sessionId: string;
  }): Promise<{
    success: boolean;
    userId?: string;
    error?: string;
  }>;
}

/**
 * Options for plugin context middleware
 */
export interface PluginContextMiddlewareOptions {
  /**
   * Whether to fail if plugin system cannot be initialized
   * Default: false (continue without plugins)
   */
  required?: boolean;

  /**
   * Custom plugin loader function
   * If provided, called during initialization to load custom plugins
   */
  loadPlugins?: (env: Env, tenantId: string) => Promise<PluginCapabilityRegistry>;
}

// =============================================================================
// State
// =============================================================================

/**
 * Cached plugin registry (singleton per Worker isolate)
 */
let cachedRegistry: PluginCapabilityRegistry | null = null;
let registryInitPromise: Promise<PluginCapabilityRegistry> | null = null;

/**
 * Default empty registry (used when plugins are not loaded)
 */
const emptyRegistry: PluginCapabilityRegistry = {
  getNotifier: () => undefined,
  getIdP: () => undefined,
  getAuthenticator: () => undefined,
  listCapabilities: () => [],
};

// =============================================================================
// Middleware
// =============================================================================

/**
 * Plugin context middleware
 *
 * This middleware initializes the plugin system once per Worker lifecycle
 * and provides access to it via c.get('pluginContext').
 *
 * The initialization is lazy - it happens on the first request.
 * Subsequent requests reuse the cached registry.
 */
export function pluginContextMiddleware(options: PluginContextMiddlewareOptions = {}) {
  const { required = false, loadPlugins } = options;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const tenantId = getTenantIdFromContext(c);

    // Initialize or get cached registry
    let registry: PluginCapabilityRegistry;
    let initialized = false;

    try {
      if (cachedRegistry) {
        registry = cachedRegistry;
        initialized = true;
      } else if (registryInitPromise) {
        // Wait for ongoing initialization
        registry = await registryInitPromise;
        initialized = true;
      } else if (loadPlugins) {
        // Start initialization
        registryInitPromise = loadPlugins(c.env, tenantId);
        registry = await registryInitPromise;
        cachedRegistry = registry;
        registryInitPromise = null;
        initialized = true;
      } else {
        // No custom loader, use empty registry
        registry = emptyRegistry;
      }
    } catch (error) {
      console.error('[PluginContext] Failed to initialize plugins:', error);
      registryInitPromise = null;

      if (required) {
        return c.json(
          {
            error: 'server_error',
            error_description: 'Plugin system initialization failed',
          },
          500
        );
      }

      registry = emptyRegistry;
    }

    // Create plugin context for this request
    const pluginContext: WorkerPluginContext = {
      registry,
      initialized,
      tenantId,

      async getPluginConfig<T>(pluginId: string, defaultValue: T): Promise<T> {
        return getPluginConfigFromKV(c.env, pluginId, tenantId, defaultValue);
      },

      async isPluginEnabled(pluginId: string): Promise<boolean> {
        return isPluginEnabledInKV(c.env, pluginId, tenantId);
      },
    };

    // Set context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('pluginContext', pluginContext);

    await next();
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get plugin context from Hono context
 */
export function getPluginContext(c: Context<{ Bindings: Env }>): WorkerPluginContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (c as any).get('pluginContext') as WorkerPluginContext | undefined;

  if (!ctx) {
    // Return a default context if middleware wasn't applied
    return {
      registry: emptyRegistry,
      initialized: false,
      tenantId: 'default',
      getPluginConfig: async <T>(_pluginId: string, defaultValue: T) => defaultValue,
      isPluginEnabled: async () => true,
    };
  }

  return ctx;
}

/**
 * Get plugin configuration from KV
 */
async function getPluginConfigFromKV<T>(
  env: Env,
  pluginId: string,
  tenantId: string,
  defaultValue: T
): Promise<T> {
  const kv = env.SETTINGS;
  if (!kv) {
    return defaultValue;
  }

  try {
    // Try tenant-specific first
    const tenantKey = `plugins:config:${pluginId}:tenant:${tenantId}`;
    const tenantValue = await kv.get(tenantKey);
    if (tenantValue) {
      const tenantConfig = JSON.parse(tenantValue);
      // Get global config and merge
      const globalConfig = await getGlobalPluginConfig(kv, pluginId, defaultValue);
      return { ...globalConfig, ...tenantConfig } as T;
    }

    // Fall back to global
    return getGlobalPluginConfig(kv, pluginId, defaultValue);
  } catch {
    return defaultValue;
  }
}

/**
 * Get global plugin configuration from KV
 */
async function getGlobalPluginConfig<T>(
  kv: KVNamespace,
  pluginId: string,
  defaultValue: T
): Promise<T> {
  try {
    const key = `plugins:config:${pluginId}`;
    const value = await kv.get(key);
    if (value) {
      return JSON.parse(value) as T;
    }
  } catch {
    // Ignore parse errors
  }
  return defaultValue;
}

/**
 * Check if a plugin is enabled in KV
 */
async function isPluginEnabledInKV(env: Env, pluginId: string, tenantId: string): Promise<boolean> {
  const kv = env.SETTINGS;
  if (!kv) {
    return true; // Default: enabled
  }

  try {
    // Check tenant-specific first
    const tenantKey = `plugins:enabled:${pluginId}:tenant:${tenantId}`;
    const tenantValue = await kv.get(tenantKey);
    if (tenantValue !== null) {
      return tenantValue === 'true';
    }

    // Fall back to global
    const globalKey = `plugins:enabled:${pluginId}`;
    const globalValue = await kv.get(globalKey);
    if (globalValue !== null) {
      return globalValue === 'true';
    }
  } catch {
    // Ignore errors
  }

  return true; // Default: enabled
}

/**
 * Reset the cached registry (for testing)
 */
export function resetPluginRegistryCache(): void {
  cachedRegistry = null;
  registryInitPromise = null;
}

// =============================================================================
// Plugin Loader Factory
// =============================================================================

/**
 * Create a plugin loader function that loads built-in plugins
 *
 * This is a convenience function that creates a loader compatible with
 * pluginContextMiddleware's loadPlugins option.
 *
 * @param plugins - Array of plugin configurations to load
 * @returns Loader function
 *
 * @example
 * ```typescript
 * import { pluginContextMiddleware, createPluginLoader } from '@authrim/ar-lib-core';
 * import { consoleNotifierPlugin, resendEmailPlugin } from '@authrim/ar-lib-plugin';
 *
 * const loadPlugins = createPluginLoader([
 *   { plugin: consoleNotifierPlugin },
 *   { plugin: resendEmailPlugin, configOverride: { apiKey: 'from-env' } },
 * ]);
 *
 * app.use('*', pluginContextMiddleware({ loadPlugins }));
 * ```
 */
export interface PluginLoaderConfig {
  /**
   * The plugin to load
   */
  plugin: {
    id: string;
    version: string;
    capabilities: string[];
    configSchema: { parse: (input: unknown) => unknown };
    register: (registry: unknown, config: unknown) => void;
    initialize?: (ctx: unknown, config: unknown) => Promise<void>;
  };

  /**
   * Configuration override (merged with KV/env config)
   */
  configOverride?: Record<string, unknown>;

  /**
   * Whether this plugin is required (fail if load fails)
   */
  required?: boolean;
}

/**
 * Create a simple in-memory registry for Workers
 * This is a lightweight alternative to the full ar-lib-plugin registry
 */
class SimpleCapabilityRegistry implements PluginCapabilityRegistry {
  private notifiers = new Map<string, NotifierHandler>();
  private idps = new Map<string, IdPHandler>();
  private authenticators = new Map<string, AuthenticatorHandler>();

  registerNotifier(channel: string, handler: NotifierHandler): void {
    this.notifiers.set(channel, handler);
  }

  registerIdP(providerId: string, handler: IdPHandler): void {
    this.idps.set(providerId, handler);
  }

  registerAuthenticator(type: string, handler: AuthenticatorHandler): void {
    this.authenticators.set(type, handler);
  }

  getNotifier(channel: string): NotifierHandler | undefined {
    return this.notifiers.get(channel);
  }

  getIdP(providerId: string): IdPHandler | undefined {
    return this.idps.get(providerId);
  }

  getAuthenticator(type: string): AuthenticatorHandler | undefined {
    return this.authenticators.get(type);
  }

  listCapabilities(): string[] {
    return [
      ...Array.from(this.notifiers.keys()).map((k) => `notifier.${k}`),
      ...Array.from(this.idps.keys()).map((k) => `idp.${k}`),
      ...Array.from(this.authenticators.keys()).map((k) => `authenticator.${k}`),
    ];
  }
}

/**
 * Create a plugin loader function
 */
export function createPluginLoader(
  plugins: PluginLoaderConfig[]
): (env: Env, tenantId: string) => Promise<PluginCapabilityRegistry> {
  return async (env: Env, tenantId: string): Promise<PluginCapabilityRegistry> => {
    const registry = new SimpleCapabilityRegistry();

    for (const { plugin, configOverride, required } of plugins) {
      try {
        // Get config from KV/env
        let config: Record<string, unknown> = {};
        const kv = env.SETTINGS;

        if (kv) {
          // Try tenant-specific config
          const tenantKey = `plugins:config:${plugin.id}:tenant:${tenantId}`;
          const tenantValue = await kv.get(tenantKey);
          if (tenantValue) {
            try {
              config = JSON.parse(tenantValue);
            } catch {
              // Ignore parse errors
            }
          }

          // Try global config
          if (Object.keys(config).length === 0) {
            const globalKey = `plugins:config:${plugin.id}`;
            const globalValue = await kv.get(globalKey);
            if (globalValue) {
              try {
                config = JSON.parse(globalValue);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }

        // Try environment variable
        if (Object.keys(config).length === 0) {
          const envKey = `PLUGIN_${plugin.id.toUpperCase().replace(/-/g, '_')}_CONFIG`;
          const envValue = (env as unknown as Record<string, unknown>)[envKey];
          if (typeof envValue === 'string') {
            try {
              config = JSON.parse(envValue);
            } catch {
              // Ignore parse errors
            }
          }
        }

        // Apply config override
        if (configOverride) {
          config = { ...config, ...configOverride };
        }

        // Parse config through schema (applies defaults)
        const parsedConfig = plugin.configSchema.parse(config);

        // Check if plugin is enabled
        const enabled = await isPluginEnabledInKV(env, plugin.id, tenantId);
        if (!enabled) {
          console.log(`[PluginLoader] Plugin ${plugin.id} is disabled, skipping`);
          continue;
        }

        // Register the plugin
        plugin.register(registry, parsedConfig);

        console.log(`[PluginLoader] Loaded plugin: ${plugin.id} v${plugin.version}`);
      } catch (error) {
        console.error(`[PluginLoader] Failed to load plugin ${plugin.id}:`, error);
        if (required) {
          throw error;
        }
      }
    }

    return registry;
  };
}
