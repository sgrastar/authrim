/**
 * Plugin Context Middleware
 *
 * This middleware provides access to the Authrim Plugin System.
 * It initializes the PluginContext for each request and makes it available to
 * all handlers via c.get('pluginContext').
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
import { createLogger } from '../utils/logger';

const log = createLogger().module('PluginContext');

function isFlowRuntimeTimingEnabled(env: Env): boolean {
  const value = env.AUTHRIM_FLOW_RUNTIME_TIMING?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function diagnosticTimingNowMs(): number {
  return Date.now();
}

function roundDiagnosticDurationMs(value: number): number {
  return Math.round(value * 10) / 10;
}

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
   * Capability scope loaded for this request.
   */
  scope: string;

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

export interface TenantEmailSettings {
  strategy: 'priority_failover';
  providerOrder: string[];
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
   * Capability scope for this plugin context.
   *
   * Scope is part of the registry cache key so lightweight bootstrap contexts
   * cannot shadow notification or other capability-specific plugin registries.
   */
  scope?: string;

  /**
   * Failure policy for this capability scope.
   *
   * fail_open keeps request handling alive with an empty registry. fail_closed
   * returns 500 when the scoped plugin loader fails.
   */
  failurePolicy?: 'fail_open' | 'fail_closed';

  /**
   * Custom plugin loader function
   * If provided, called during initialization to load custom plugins
   */
  loadPlugins?: (env: Env, tenantId: string) => Promise<PluginCapabilityRegistry>;
}

// =============================================================================
// State
// =============================================================================

interface CachedValue<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_TTL_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

let registryCacheByEnv = new WeakMap<Env, Map<string, CachedValue<PluginCapabilityRegistry>>>();
let runtimeValueCacheByEnv = new WeakMap<Env, Map<string, CachedValue<unknown>>>();

function getContextTenantId(c: Context<{ Bindings: Env }>): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const tenantId = ((c as any).get('tenantId') as string | null | undefined)?.trim();
    return tenantId || undefined;
  } catch {
    return undefined;
  }
}

function getCacheTTLMs(env: Env): number {
  const ttl = env.SETTINGS_CACHE_TTL;
  if (!ttl) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const ttlSeconds = parseInt(ttl, 10);
  if (Number.isNaN(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_CACHE_TTL_MS;
  }

  return Math.min(ttlSeconds, MAX_CACHE_TTL_SECONDS) * 1000;
}

function getRegistryCacheKey(scope: string, tenantId: string): string {
  return `${scope}\u0000${tenantId}`;
}

function cacheKeyMatchesTenant(key: string, tenantId: string): boolean {
  return key.endsWith(`\u0000${tenantId}`);
}

function getScopedMap<T>(
  store: WeakMap<Env, Map<string, CachedValue<T>>>,
  env: Env
): Map<string, CachedValue<T>> {
  let map = store.get(env);
  if (!map) {
    map = new Map<string, CachedValue<T>>();
    store.set(env, map);
  }
  return map;
}

function getCachedValue<T>(env: Env, key: string): T | undefined {
  const cache = getScopedMap(runtimeValueCacheByEnv, env);
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }

  return entry.value as T;
}

function setCachedValue<T>(env: Env, key: string, value: T): T {
  const cache = getScopedMap(runtimeValueCacheByEnv, env);
  cache.set(key, {
    value,
    expiresAt: Date.now() + getCacheTTLMs(env),
  });
  return value;
}

function getCachedRegistry(
  env: Env,
  scope: string,
  tenantId: string
): PluginCapabilityRegistry | undefined {
  const cache = getScopedMap(registryCacheByEnv, env);
  const cacheKey = getRegistryCacheKey(scope, tenantId);
  const entry = cache.get(cacheKey);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey);
    return undefined;
  }

  return entry.value;
}

function setCachedRegistry(
  env: Env,
  scope: string,
  tenantId: string,
  registry: PluginCapabilityRegistry
): PluginCapabilityRegistry {
  const cache = getScopedMap(registryCacheByEnv, env);
  cache.set(getRegistryCacheKey(scope, tenantId), {
    value: registry,
    expiresAt: Date.now() + getCacheTTLMs(env),
  });
  return registry;
}

function clearRuntimeValueCache(env: Env, predicate: (key: string) => boolean): void {
  const cache = runtimeValueCacheByEnv.get(env);
  if (!cache) {
    return;
  }

  for (const key of cache.keys()) {
    if (predicate(key)) {
      cache.delete(key);
    }
  }
}

function clearRegistryCache(env: Env, tenantId?: string): void {
  const cache = registryCacheByEnv.get(env);
  if (cache) {
    if (tenantId) {
      for (const key of cache.keys()) {
        if (cacheKeyMatchesTenant(key, tenantId)) {
          cache.delete(key);
        }
      }
    } else {
      cache.clear();
    }
  }
}

function getPluginConfigGlobalCacheKey(pluginId: string): string {
  return `plugin-config:global:${pluginId}`;
}

function getPluginConfigTenantCacheKey(pluginId: string, tenantId: string): string {
  return `plugin-config:tenant:${tenantId}:${pluginId}`;
}

function getPluginEnabledCacheKey(pluginId: string, tenantId: string): string {
  return `plugin-enabled:tenant:${tenantId}:${pluginId}`;
}

function getEmailSettingsCacheKey(tenantId: string): string {
  return `email-settings:${tenantId}`;
}

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
 * This middleware initializes the plugin system lazily and provides access to
 * it via c.get('pluginContext').
 *
 * Registries are cached per tenant within the Worker isolate using the same
 * TTL policy as other settings caches. This keeps runtime KV reads low without
 * leaking one tenant's plugin state into another tenant.
 */
export function pluginContextMiddleware(options: PluginContextMiddlewareOptions = {}) {
  const {
    required = false,
    scope = 'default',
    failurePolicy = required ? 'fail_closed' : 'fail_open',
    loadPlugins,
  } = options;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const tenantId = getContextTenantId(c);
    if (!tenantId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Tenant context is required for plugin context',
        },
        400
      );
    }

    // Initialize or get cached registry
    let registry: PluginCapabilityRegistry;
    let initialized = false;
    const timingEnabled =
      isFlowRuntimeTimingEnabled(c.env) &&
      new URL(c.req.url).pathname === '/api/v1/login/interactions/start';
    const startedAtMs = timingEnabled ? diagnosticTimingNowMs() : 0;
    let cacheStatus: 'disabled' | 'hit' | 'miss' | 'empty' | 'error' = loadPlugins
      ? 'miss'
      : 'disabled';

    try {
      if (loadPlugins) {
        registry = getCachedRegistry(c.env, scope, tenantId) ?? emptyRegistry;
        if (registry !== emptyRegistry) {
          initialized = true;
          cacheStatus = 'hit';
        } else {
          cacheStatus = 'miss';
          registry = setCachedRegistry(c.env, scope, tenantId, await loadPlugins(c.env, tenantId));
          initialized = true;
          if (registry === emptyRegistry) {
            cacheStatus = 'empty';
          }
        }
      } else {
        // No custom loader, use empty registry
        registry = emptyRegistry;
      }
    } catch (error) {
      cacheStatus = 'error';
      log.error('Failed to initialize plugins', {}, error as Error);
      clearRegistryCache(c.env, tenantId);

      if (failurePolicy === 'fail_closed') {
        return c.json(
          {
            error: 'server_error',
            error_description: 'Plugin system initialization failed',
          },
          500
        );
      }

      registry = emptyRegistry;
    } finally {
      if (timingEnabled) {
        log.info('Plugin context timing', {
          path: new URL(c.req.url).pathname,
          cache_status: cacheStatus,
          initialized,
          duration_ms: roundDiagnosticDurationMs(diagnosticTimingNowMs() - startedAtMs),
        });
      }
    }

    // Create plugin context for this request
    const pluginContext: WorkerPluginContext = {
      registry,
      initialized,
      tenantId,
      scope,

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
    const tenantId = getContextTenantId(c);
    if (!tenantId) {
      throw new Error('Plugin context requires tenant context');
    }

    // Return a default context if middleware wasn't applied
    return {
      registry: emptyRegistry,
      initialized: false,
      tenantId,
      scope: 'default',
      getPluginConfig: async <T>(_pluginId: string, defaultValue: T) => defaultValue,
      isPluginEnabled: async () => true,
    };
  }

  return ctx;
}

export function getRequiredPluginContext(
  c: Context<{ Bindings: Env }>,
  expectedScope?: string
): WorkerPluginContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (c as any).get('pluginContext') as WorkerPluginContext | undefined;
  if (!ctx) {
    throw new Error('Plugin context middleware is required for this route');
  }

  if (expectedScope && ctx.scope !== expectedScope) {
    throw new Error(`Plugin context scope mismatch: expected ${expectedScope}, got ${ctx.scope}`);
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
  try {
    const [globalConfig, tenantConfig] = await Promise.all([
      getGlobalPluginConfigRecord(env, pluginId),
      getTenantPluginConfigRecord(env, pluginId, tenantId),
    ]);
    return {
      ...defaultValue,
      ...globalConfig,
      ...tenantConfig,
    } as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Get global plugin configuration from KV
 */
async function getGlobalPluginConfigRecord(
  env: Env,
  pluginId: string
): Promise<Record<string, unknown>> {
  const cacheKey = getPluginConfigGlobalCacheKey(pluginId);
  const cached = getCachedValue<Record<string, unknown>>(env, cacheKey);
  if (cached) {
    return cached;
  }

  const kv = env.SETTINGS;
  if (!kv) {
    return setCachedValue(env, cacheKey, {});
  }

  try {
    const key = `plugins:config:${pluginId}`;
    const value = await kv.get(key);
    if (value) {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return setCachedValue(env, cacheKey, parsed as Record<string, unknown>);
      }
    }
  } catch {
    // Ignore parse errors
  }

  return setCachedValue(env, cacheKey, {});
}

async function getTenantPluginConfigRecord(
  env: Env,
  pluginId: string,
  tenantId: string
): Promise<Record<string, unknown>> {
  const cacheKey = getPluginConfigTenantCacheKey(pluginId, tenantId);
  const cached = getCachedValue<Record<string, unknown>>(env, cacheKey);
  if (cached) {
    return cached;
  }

  const kv = env.SETTINGS;
  if (!kv) {
    return setCachedValue(env, cacheKey, {});
  }

  try {
    const tenantKey = `plugins:config:${pluginId}:tenant:${tenantId}`;
    const tenantValue = await kv.get(tenantKey);
    if (tenantValue) {
      const parsed = JSON.parse(tenantValue);
      if (parsed && typeof parsed === 'object') {
        return setCachedValue(env, cacheKey, parsed as Record<string, unknown>);
      }
    }
  } catch {
    // Ignore malformed tenant config; admin API validation should prevent this.
  }

  return setCachedValue(env, cacheKey, {});
}

/**
 * Convert plugin ID to settings-v2 key format
 * e.g. "notifier-resend" → "plugin.notifier_resend_enabled"
 */
function pluginIdToSettingsKey(pluginId: string): string {
  return `plugin.${pluginId.replace(/-/g, '_')}_enabled`;
}

/**
 * Check if a plugin is enabled
 *
 * Resolution order:
 * 1. settings-v2 (AUTHRIM_CONFIG KV): `plugin.{plugin_id_underscore}_enabled`
 * 2. Legacy (SETTINGS KV): `plugins:enabled:{pluginId}` (tenant-specific → global)
 * 3. Default: true
 */
async function isPluginEnabledInKV(env: Env, pluginId: string, tenantId: string): Promise<boolean> {
  const cacheKey = getPluginEnabledCacheKey(pluginId, tenantId);
  const cached = getCachedValue<boolean>(env, cacheKey);
  if (typeof cached === 'boolean') {
    return cached;
  }

  // 1. Check settings-v2 (AUTHRIM_CONFIG KV)
  try {
    const configKV = env.AUTHRIM_CONFIG;
    if (configKV) {
      const settingsKey = pluginIdToSettingsKey(pluginId);
      const kvJson = await configKV.get(`settings:tenant:${tenantId}:plugin`);
      if (kvJson) {
        const settings = JSON.parse(kvJson) as Record<string, unknown>;
        if (typeof settings[settingsKey] === 'boolean') {
          return setCachedValue(env, cacheKey, settings[settingsKey] as boolean);
        }
        // Also check string form (KV stores may serialize as string)
        if (typeof settings[settingsKey] === 'string') {
          return setCachedValue(env, cacheKey, settings[settingsKey] === 'true');
        }
      }
    }
  } catch {
    // Ignore errors, fall through
  }

  // 2. Check legacy SETTINGS KV
  const kv = env.SETTINGS;
  if (kv) {
    try {
      // Check tenant-specific first
      const tenantKey = `plugins:enabled:${pluginId}:tenant:${tenantId}`;
      const tenantValue = await kv.get(tenantKey);
      if (tenantValue !== null) {
        return setCachedValue(env, cacheKey, tenantValue === 'true');
      }

      // Fall back to global
      const globalKey = `plugins:enabled:${pluginId}`;
      const globalValue = await kv.get(globalKey);
      if (globalValue !== null) {
        return setCachedValue(env, cacheKey, globalValue === 'true');
      }
    } catch {
      // Ignore errors
    }
  }

  // 3. Default: enabled
  return setCachedValue(env, cacheKey, true);
}

const EMAIL_SETTINGS_KEY = 'email-settings';
const DEFAULT_EMAIL_SETTINGS: TenantEmailSettings = {
  strategy: 'priority_failover',
  providerOrder: [],
};

function getEmailSettingsKv(env: Env): KVNamespace | undefined {
  return env.AUTHRIM_CONFIG || env.SETTINGS;
}

function normalizeTenantEmailSettings(
  value: unknown,
  availableProviderIds?: string[]
): TenantEmailSettings {
  const input =
    value && typeof value === 'object' ? (value as Partial<TenantEmailSettings>) : undefined;

  const rawOrder = Array.isArray(input?.providerOrder)
    ? input.providerOrder.filter(
        (providerId): providerId is string => typeof providerId === 'string'
      )
    : [];

  const dedupedOrder = Array.from(new Set(rawOrder));
  const available = availableProviderIds ?? [];
  const providerOrder =
    available.length === 0
      ? dedupedOrder
      : [
          ...dedupedOrder.filter((providerId) => available.includes(providerId)),
          ...available.filter((providerId) => !dedupedOrder.includes(providerId)),
        ];

  return {
    strategy: input?.strategy === 'priority_failover' ? 'priority_failover' : 'priority_failover',
    providerOrder,
  };
}

export async function getTenantEmailSettings(
  env: Env,
  tenantId: string,
  availableProviderIds?: string[]
): Promise<TenantEmailSettings> {
  const cacheKey = getEmailSettingsCacheKey(tenantId);
  const cached = getCachedValue<TenantEmailSettings>(env, cacheKey);
  if (cached) {
    return normalizeTenantEmailSettings(cached, availableProviderIds);
  }

  const kv = getEmailSettingsKv(env);
  if (!kv) {
    return normalizeTenantEmailSettings(DEFAULT_EMAIL_SETTINGS, availableProviderIds);
  }

  try {
    const raw = await kv.get(`settings:tenant:${tenantId}:${EMAIL_SETTINGS_KEY}`);
    if (!raw) {
      const normalized = normalizeTenantEmailSettings(DEFAULT_EMAIL_SETTINGS);
      setCachedValue(env, cacheKey, normalized);
      return normalizeTenantEmailSettings(normalized, availableProviderIds);
    }

    const normalized = normalizeTenantEmailSettings(JSON.parse(raw));
    setCachedValue(env, cacheKey, normalized);
    return normalizeTenantEmailSettings(normalized, availableProviderIds);
  } catch {
    const normalized = normalizeTenantEmailSettings(DEFAULT_EMAIL_SETTINGS);
    setCachedValue(env, cacheKey, normalized);
    return normalizeTenantEmailSettings(normalized, availableProviderIds);
  }
}

export async function putTenantEmailSettings(
  env: Env,
  tenantId: string,
  settings: TenantEmailSettings
): Promise<void> {
  const kv = getEmailSettingsKv(env);
  if (!kv) {
    throw new Error('Email settings KV is not configured');
  }

  const normalized = normalizeTenantEmailSettings(settings);
  await kv.put(`settings:tenant:${tenantId}:${EMAIL_SETTINGS_KEY}`, JSON.stringify(normalized));
  invalidateTenantEmailSettingsCache(env, tenantId);
}

export function invalidateTenantEmailSettingsCache(env: Env, tenantId: string): void {
  clearRuntimeValueCache(env, (key) => key === getEmailSettingsCacheKey(tenantId));
}

export function invalidatePluginRuntimeCaches(
  env: Env,
  scope: {
    tenantId?: string;
    pluginId?: string;
  } = {}
): void {
  const { tenantId, pluginId } = scope;

  clearRuntimeValueCache(env, (key) => {
    if (!pluginId && !tenantId) {
      return true;
    }

    if (pluginId && key === getPluginConfigGlobalCacheKey(pluginId)) {
      return true;
    }

    if (pluginId && tenantId && key === getPluginConfigTenantCacheKey(pluginId, tenantId)) {
      return true;
    }

    if (pluginId && key.endsWith(`:${pluginId}`) && key.startsWith('plugin-config:tenant:')) {
      return !tenantId || key.startsWith(`plugin-config:tenant:${tenantId}:`);
    }

    if (pluginId && key.endsWith(`:${pluginId}`) && key.startsWith('plugin-enabled:tenant:')) {
      return !tenantId || key.startsWith(`plugin-enabled:tenant:${tenantId}:`);
    }

    if (!pluginId && tenantId) {
      return (
        key.startsWith(`plugin-config:tenant:${tenantId}:`) ||
        key.startsWith(`plugin-enabled:tenant:${tenantId}:`)
      );
    }

    return false;
  });

  if (tenantId) {
    clearRegistryCache(env, tenantId);
  } else {
    clearRegistryCache(env);
  }
}

/**
 * Reset the cached registry (for testing)
 */
export function resetPluginRegistryCache(): void {
  registryCacheByEnv = new WeakMap<Env, Map<string, CachedValue<PluginCapabilityRegistry>>>();
  runtimeValueCacheByEnv = new WeakMap<Env, Map<string, CachedValue<unknown>>>();
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: {
    id: string;
    version: string;
    capabilities: string[];
    configSchema: { parse: (input: unknown) => unknown };
    register: (registry: any, config: any) => void;
    initialize?: (ctx: any, config: any) => Promise<void>;
  };

  /**
   * Configuration override (merged with KV/env config)
   */
  configOverride?: Record<string, unknown>;

  /**
   * Resolve bootstrap defaults from Worker bindings/environment.
   *
   * These values are merged before KV config so tenant/global plugin settings
   * can override the deployment-time bootstrap when needed.
   */
  envConfigResolver?: (env: Env) => Record<string, unknown>;

  /**
   * Whether this plugin is required (fail if load fails)
   */
  required?: boolean;

  /**
   * Skip loading when no bootstrap/KV/override config is available.
   */
  skipIfConfigEmpty?: boolean;

  /**
   * Skip loading when the resolved config is intentionally incomplete for this plugin.
   */
  skipIfConfig?: (config: Record<string, unknown>) => boolean;
}

/**
 * Create a simple in-memory registry for Workers
 * This is a lightweight alternative to the full ar-lib-plugin registry
 */
class SimpleCapabilityRegistry implements PluginCapabilityRegistry {
  private notifiers = new Map<string, Array<{ pluginId: string; handler: NotifierHandler }>>();
  private idps = new Map<string, IdPHandler>();
  private authenticators = new Map<string, AuthenticatorHandler>();

  constructor(
    private readonly env: Env,
    private readonly tenantId: string
  ) {}

  registerNotifier(channel: string, handler: NotifierHandler, pluginId?: string): void {
    if (handler && typeof handler === 'object') {
      Object.defineProperty(handler, '__authrimWorkerEnv', {
        value: this.env,
        configurable: true,
        enumerable: false,
      });
    }
    const entries = this.notifiers.get(channel) ?? [];
    entries.push({ pluginId: pluginId ?? `unknown:${channel}:${entries.length}`, handler });
    this.notifiers.set(channel, entries);
  }

  registerIdP(providerId: string, handler: IdPHandler): void {
    this.idps.set(providerId, handler);
  }

  registerAuthenticator(type: string, handler: AuthenticatorHandler): void {
    this.authenticators.set(type, handler);
  }

  getNotifier(channel: string): NotifierHandler | undefined {
    const handlers = this.notifiers.get(channel);
    if (!handlers || handlers.length === 0) {
      return undefined;
    }

    if (handlers.length === 1 || channel !== 'email') {
      return handlers[0]?.handler;
    }

    return createCompositeEmailNotifier(this.env, this.tenantId, handlers);
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

function createCompositeEmailNotifier(
  env: Env,
  tenantId: string,
  handlers: Array<{ pluginId: string; handler: NotifierHandler }>
): NotifierHandler {
  return {
    async send(notification) {
      const availableProviderIds = handlers.map((entry) => entry.pluginId);
      const emailSettings = await getTenantEmailSettings(env, tenantId, availableProviderIds);

      // TODO: Extend this strategy switch when round-robin or send-count based
      // routing is added to the Email Settings page.
      if (emailSettings.strategy !== 'priority_failover') {
        log.warn('Unsupported email strategy, falling back to priority_failover', {
          tenantId,
          strategy: emailSettings.strategy,
        });
      }

      const priorityOrder = new Map(
        emailSettings.providerOrder.map((providerId, index) => [providerId, index])
      );

      const orderedHandlers = [...handlers].sort((a, b) => {
        const aIndex = priorityOrder.get(a.pluginId) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = priorityOrder.get(b.pluginId) ?? Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      });

      let lastFailure:
        | {
            success: false;
            error: string;
            retryable?: boolean;
          }
        | undefined;

      for (const provider of orderedHandlers) {
        try {
          const result = await provider.handler.send(notification);
          if (result.success) {
            return result;
          }

          lastFailure = {
            success: false,
            error: `[${provider.pluginId}] ${result.error ?? 'Unknown email delivery failure'}`,
            retryable: result.retryable,
          };
        } catch (error) {
          lastFailure = {
            success: false,
            error: `[${provider.pluginId}] ${error instanceof Error ? error.message : 'Unknown error'}`,
            retryable: true,
          };
        }
      }

      return {
        success: false,
        error: lastFailure?.error ?? 'No email providers are available',
        retryable: lastFailure?.retryable ?? false,
      };
    },
  };
}

function getPluginEnvConfig(env: Env, pluginId: string): Record<string, unknown> {
  const envKey = `PLUGIN_${pluginId.toUpperCase().replace(/-/g, '_')}_CONFIG`;
  const envValue = (env as unknown as Record<string, unknown>)[envKey];
  if (typeof envValue !== 'string' || envValue.trim() === '') {
    return {};
  }

  try {
    const parsed = JSON.parse(envValue);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function getPluginKvConfig(
  env: Env,
  pluginId: string,
  tenantId: string
): Promise<Record<string, unknown>> {
  const [globalConfig, tenantConfig] = await Promise.all([
    getGlobalPluginConfigRecord(env, pluginId),
    getTenantPluginConfigRecord(env, pluginId, tenantId),
  ]);

  return {
    ...globalConfig,
    ...tenantConfig,
  };
}

class WorkerPluginConfigStore {
  constructor(private readonly env: Env) {}

  async get<T>(
    pluginId: string,
    schema: {
      parse: (input: unknown) => T;
    }
  ): Promise<T> {
    const config = {
      ...getPluginEnvConfig(this.env, pluginId),
      ...(await getGlobalPluginConfigRecord(this.env, pluginId)),
    };
    return schema.parse(config);
  }

  async getForTenant<T>(
    pluginId: string,
    tenantId: string,
    schema: {
      parse: (input: unknown) => T;
    }
  ): Promise<T> {
    const config = {
      ...getPluginEnvConfig(this.env, pluginId),
      ...(await getPluginKvConfig(this.env, pluginId, tenantId)),
    };
    return schema.parse(config);
  }

  async set<T>(_pluginId: string, _config: T): Promise<void> {
    throw new Error(
      'Worker plugin loader does not support writing plugin config during initialize()'
    );
  }
}

function createUnsupportedService<T>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `Worker plugin loader does not provide ${serviceName} during initialize(); attempted to access ${String(property)}`
        );
      },
      set() {
        throw new Error(`Worker plugin loader does not provide ${serviceName} during initialize()`);
      },
    }
  ) as T;
}

/**
 * Create a plugin loader function
 */
export function createPluginLoader(
  plugins: PluginLoaderConfig[]
): (env: Env, tenantId: string) => Promise<PluginCapabilityRegistry> {
  return async (env: Env, tenantId: string): Promise<PluginCapabilityRegistry> => {
    const registry = new SimpleCapabilityRegistry(env, tenantId);
    const configStore = new WorkerPluginConfigStore(env);

    for (const {
      plugin,
      configOverride,
      envConfigResolver,
      required,
      skipIfConfigEmpty,
      skipIfConfig,
    } of plugins) {
      try {
        // Check if plugin is enabled
        const enabled = await isPluginEnabledInKV(env, plugin.id, tenantId);
        if (!enabled) {
          log.info('Plugin is disabled, skipping', { pluginId: plugin.id });
          continue;
        }

        const config = {
          ...getPluginEnvConfig(env, plugin.id),
          ...(envConfigResolver?.(env) ?? {}),
          ...(await getPluginKvConfig(env, plugin.id, tenantId)),
          ...(configOverride ?? {}),
        };

        if (skipIfConfigEmpty && Object.keys(config).length === 0) {
          log.info('Plugin has no resolved configuration, skipping', { pluginId: plugin.id });
          continue;
        }

        if (skipIfConfig?.(config)) {
          log.info('Plugin resolved configuration requested skip', { pluginId: plugin.id });
          continue;
        }

        // Parse config through schema (applies defaults)
        const parsedConfig = plugin.configSchema.parse(config);

        if (plugin.initialize) {
          await plugin.initialize(
            {
              storage: createUnsupportedService('storage'),
              policy: createUnsupportedService('policy'),
              config: configStore,
              logger: log,
              audit: {
                async log() {
                  // Worker-side loader does not emit audit events during initialize().
                },
              },
              tenantId,
              env,
            },
            parsedConfig
          );
        }

        // Register the plugin
        plugin.register(registry, parsedConfig);

        log.info('Loaded plugin', { pluginId: plugin.id, version: plugin.version });
      } catch (error) {
        log.error('Failed to load plugin', { pluginId: plugin.id }, error as Error);
        if (required) {
          throw error;
        }
      }
    }

    return registry;
  };
}
