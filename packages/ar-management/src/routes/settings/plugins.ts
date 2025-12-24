/**
 * Plugin Management Admin API
 *
 * GET    /api/admin/plugins                  - List all registered plugins
 * GET    /api/admin/plugins/:id              - Get plugin details
 * GET    /api/admin/plugins/:id/config       - Get plugin configuration
 * PUT    /api/admin/plugins/:id/config       - Update plugin configuration
 * PUT    /api/admin/plugins/:id/enable       - Enable plugin
 * PUT    /api/admin/plugins/:id/disable      - Disable plugin
 * GET    /api/admin/plugins/:id/health       - Plugin health check
 * GET    /api/admin/plugins/:id/schema       - Get plugin JSON Schema (for UI)
 *
 * KV Key Structure:
 * - plugins:registry                           - Registered plugin metadata
 * - plugins:config:{pluginId}                  - Global configuration
 * - plugins:config:{pluginId}:tenant:{tenantId} - Tenant-specific override
 * - plugins:enabled:{pluginId}                 - Global enable/disable flag
 * - plugins:enabled:{pluginId}:tenant:{tenantId} - Tenant-specific enable/disable
 *
 * Security:
 * - All endpoints require admin authentication
 * - Configuration changes are audit logged
 * - Sensitive fields (API keys) are masked in responses
 */

import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import { createRFCErrorResponse, RFC_ERROR_CODES } from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

interface PluginRegistryEntry {
  id: string;
  version: string;
  capabilities: string[];
  official: boolean;
  meta?: {
    name: string;
    description: string;
    icon?: string;
    category: string;
    documentationUrl?: string;
  };
  registeredAt: number;
}

interface PluginStatus {
  pluginId: string;
  enabled: boolean;
  configSource: 'kv' | 'env' | 'default';
  loadedAt?: number;
  lastHealthCheck?: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: number;
    message?: string;
  };
}

interface PluginListResponse {
  plugins: Array<PluginRegistryEntry & PluginStatus>;
  total: number;
}

interface PluginDetailResponse {
  plugin: PluginRegistryEntry;
  status: PluginStatus;
  config: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get admin auth context from request
 */
function getAdminAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).get('adminAuth') as AdminAuthContext | null;
}

/**
 * Get the KV namespace for plugin settings
 */
function getPluginKV(env: Env): KVNamespace | undefined {
  return env.SETTINGS;
}

/**
 * Mask sensitive fields in configuration for API responses
 */
function maskSensitiveFields(config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  const sensitiveKeys = ['apiKey', 'apiSecret', 'secretKey', 'password', 'token', 'authToken'];

  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
      const value = masked[key];
      if (typeof value === 'string' && value.length > 8) {
        masked[key] = value.substring(0, 4) + '****' + value.substring(value.length - 4);
      } else if (typeof value === 'string') {
        masked[key] = '****';
      }
    }
  }

  return masked;
}

/**
 * Log plugin configuration change for audit
 */
function logPluginConfigChange(
  action: 'update' | 'enable' | 'disable',
  adminId: string | undefined,
  details: Record<string, unknown>
): void {
  console.log(`[Plugin Admin] ${action}`, {
    adminId: adminId ?? 'unknown',
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Get plugin registry from KV
 */
async function getPluginRegistry(kv: KVNamespace): Promise<Record<string, PluginRegistryEntry>> {
  try {
    const data = await kv.get('plugins:registry');
    if (data) {
      return JSON.parse(data);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * Get plugin enabled status
 */
async function isPluginEnabled(
  kv: KVNamespace,
  pluginId: string,
  tenantId?: string
): Promise<boolean> {
  // Check tenant-specific first
  if (tenantId) {
    const tenantKey = `plugins:enabled:${pluginId}:tenant:${tenantId}`;
    const tenantValue = await kv.get(tenantKey);
    if (tenantValue !== null) {
      return tenantValue === 'true';
    }
  }

  // Fall back to global
  const globalKey = `plugins:enabled:${pluginId}`;
  const globalValue = await kv.get(globalKey);
  if (globalValue !== null) {
    return globalValue === 'true';
  }

  // Default: enabled
  return true;
}

/**
 * Get plugin configuration
 */
async function getPluginConfig(
  kv: KVNamespace,
  env: Env,
  pluginId: string,
  tenantId?: string
): Promise<{ config: Record<string, unknown>; source: 'kv' | 'env' | 'default' }> {
  // Check tenant-specific first
  if (tenantId) {
    const tenantKey = `plugins:config:${pluginId}:tenant:${tenantId}`;
    const tenantValue = await kv.get(tenantKey);
    if (tenantValue) {
      try {
        const tenantConfig = JSON.parse(tenantValue);
        // Merge with global config
        const globalConfig = await getPluginConfig(kv, env, pluginId);
        return {
          config: { ...globalConfig.config, ...tenantConfig },
          source: 'kv',
        };
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Check global KV
  const globalKey = `plugins:config:${pluginId}`;
  const kvValue = await kv.get(globalKey);
  if (kvValue) {
    try {
      return { config: JSON.parse(kvValue), source: 'kv' };
    } catch {
      // Ignore parse errors
    }
  }

  // Check environment variable
  const envKey = `PLUGIN_${pluginId.toUpperCase().replace(/-/g, '_')}_CONFIG`;
  const envValue = (env as unknown as Record<string, unknown>)[envKey];
  if (typeof envValue === 'string') {
    try {
      return { config: JSON.parse(envValue), source: 'env' };
    } catch {
      // Ignore parse errors
    }
  }

  return { config: {}, source: 'default' };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/plugins
 * List all registered plugins with their status
 */
export async function listPluginsHandler(c: Context<{ Bindings: Env }>) {
  const kv = getPluginKV(c.env);
  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  const registry = await getPluginRegistry(kv);
  const plugins: Array<PluginRegistryEntry & PluginStatus> = [];

  for (const [pluginId, entry] of Object.entries(registry)) {
    const enabled = await isPluginEnabled(kv, pluginId);
    const { source } = await getPluginConfig(kv, c.env, pluginId);

    // Try to get last health check from KV
    let lastHealthCheck: PluginStatus['lastHealthCheck'];
    try {
      const healthData = await kv.get(`plugins:health:${pluginId}`);
      if (healthData) {
        lastHealthCheck = JSON.parse(healthData);
      }
    } catch {
      // Ignore
    }

    plugins.push({
      ...entry,
      pluginId,
      enabled,
      configSource: source,
      lastHealthCheck,
    });
  }

  // Sort by name or id
  plugins.sort((a, b) => (a.meta?.name ?? a.id).localeCompare(b.meta?.name ?? b.id));

  const response: PluginListResponse = {
    plugins,
    total: plugins.length,
  };

  return c.json(response);
}

/**
 * GET /api/admin/plugins/:id
 * Get plugin details including configuration and schema
 */
export async function getPluginHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id');
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  const registry = await getPluginRegistry(kv);
  const entry = registry[pluginId];

  if (!entry) {
    return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 404, 'Plugin not found');
  }

  const enabled = await isPluginEnabled(kv, pluginId);
  const { config, source } = await getPluginConfig(kv, c.env, pluginId);

  // Get schema from registry (stored when plugin was registered)
  let configSchema: Record<string, unknown> | undefined;
  try {
    const schemaData = await kv.get(`plugins:schema:${pluginId}`);
    if (schemaData) {
      configSchema = JSON.parse(schemaData);
    }
  } catch {
    // Ignore
  }

  // Get last health check
  let lastHealthCheck: PluginStatus['lastHealthCheck'];
  try {
    const healthData = await kv.get(`plugins:health:${pluginId}`);
    if (healthData) {
      lastHealthCheck = JSON.parse(healthData);
    }
  } catch {
    // Ignore
  }

  const response: PluginDetailResponse = {
    plugin: entry,
    status: {
      pluginId,
      enabled,
      configSource: source,
      lastHealthCheck,
    },
    config: maskSensitiveFields(config),
    configSchema,
  };

  return c.json(response);
}

/**
 * GET /api/admin/plugins/:id/config
 * Get plugin configuration (with masked sensitive fields)
 */
export async function getPluginConfigHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id');
  const tenantId = c.req.query('tenant_id');
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  const { config, source } = await getPluginConfig(kv, c.env, pluginId, tenantId);

  return c.json({
    pluginId,
    tenantId: tenantId ?? null,
    config: maskSensitiveFields(config),
    source,
  });
}

/**
 * PUT /api/admin/plugins/:id/config
 * Update plugin configuration
 */
export async function updatePluginConfigHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id');
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 404, 'Plugin not found');
  }

  const body = await c.req.json<{
    config: Record<string, unknown>;
    tenant_id?: string;
  }>();

  if (!body.config || typeof body.config !== 'object') {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.INVALID_REQUEST,
      400,
      'config must be an object'
    );
  }

  // Get existing config for audit logging
  const { config: existingConfig } = await getPluginConfig(kv, c.env, pluginId, body.tenant_id);

  // Determine the key
  const configKey = body.tenant_id
    ? `plugins:config:${pluginId}:tenant:${body.tenant_id}`
    : `plugins:config:${pluginId}`;

  // Merge with existing config
  const newConfig = { ...existingConfig, ...body.config };

  // Save to KV
  await kv.put(configKey, JSON.stringify(newConfig));

  // Log the change
  logPluginConfigChange('update', adminId, {
    pluginId,
    tenantId: body.tenant_id ?? null,
    changedFields: Object.keys(body.config),
  });

  return c.json({
    success: true,
    pluginId,
    tenantId: body.tenant_id ?? null,
    config: maskSensitiveFields(newConfig),
  });
}

/**
 * PUT /api/admin/plugins/:id/enable
 * Enable a plugin
 */
export async function enablePluginHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id');
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 404, 'Plugin not found');
  }

  let tenantId: string | undefined;
  try {
    const body = await c.req.json<{ tenant_id?: string }>();
    tenantId = body.tenant_id;
  } catch {
    // No body or invalid JSON, proceed without tenant_id
  }

  const enableKey = tenantId
    ? `plugins:enabled:${pluginId}:tenant:${tenantId}`
    : `plugins:enabled:${pluginId}`;

  await kv.put(enableKey, 'true');

  logPluginConfigChange('enable', adminId, {
    pluginId,
    tenantId: tenantId ?? null,
  });

  return c.json({
    success: true,
    pluginId,
    tenantId: tenantId ?? null,
    enabled: true,
  });
}

/**
 * PUT /api/admin/plugins/:id/disable
 * Disable a plugin
 */
export async function disablePluginHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id');
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 404, 'Plugin not found');
  }

  let tenantId: string | undefined;
  try {
    const body = await c.req.json<{ tenant_id?: string }>();
    tenantId = body.tenant_id;
  } catch {
    // No body or invalid JSON, proceed without tenant_id
  }

  const enableKey = tenantId
    ? `plugins:enabled:${pluginId}:tenant:${tenantId}`
    : `plugins:enabled:${pluginId}`;

  await kv.put(enableKey, 'false');

  logPluginConfigChange('disable', adminId, {
    pluginId,
    tenantId: tenantId ?? null,
  });

  return c.json({
    success: true,
    pluginId,
    tenantId: tenantId ?? null,
    enabled: false,
  });
}

/**
 * GET /api/admin/plugins/:id/health
 * Get plugin health status (and trigger health check)
 */
export async function getPluginHealthHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id');
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 404, 'Plugin not found');
  }

  // Get last health check from KV
  let lastHealthCheck: PluginStatus['lastHealthCheck'];
  try {
    const healthData = await kv.get(`plugins:health:${pluginId}`);
    if (healthData) {
      lastHealthCheck = JSON.parse(healthData);
    }
  } catch {
    // Ignore
  }

  // Note: Actual health check execution would require loading the plugin
  // This endpoint returns cached health status
  // A background job or the plugin loader updates the health status

  return c.json({
    pluginId,
    health: lastHealthCheck ?? {
      status: 'unknown',
      timestamp: Date.now(),
      message: 'No health check data available',
    },
  });
}

/**
 * GET /api/admin/plugins/:id/schema
 * Get plugin configuration JSON Schema (for Admin UI)
 */
export async function getPluginSchemaHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id');
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.SERVER_ERROR,
      500,
      'Plugin storage not available'
    );
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  const entry = registry[pluginId];
  if (!entry) {
    return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 404, 'Plugin not found');
  }

  // Get schema from KV
  let configSchema: Record<string, unknown> | null = null;
  try {
    const schemaData = await kv.get(`plugins:schema:${pluginId}`);
    if (schemaData) {
      configSchema = JSON.parse(schemaData);
    }
  } catch {
    // Ignore
  }

  if (!configSchema) {
    return createRFCErrorResponse(
      c,
      RFC_ERROR_CODES.INVALID_REQUEST,
      404,
      'Schema not available for this plugin'
    );
  }

  return c.json({
    pluginId,
    version: entry.version,
    schema: configSchema,
    meta: entry.meta,
  });
}

// =============================================================================
// Plugin Registration (Internal API)
// =============================================================================

/**
 * Register a plugin in the registry
 * This is called by the plugin loader when a plugin is loaded
 */
export async function registerPlugin(
  kv: KVNamespace,
  plugin: {
    id: string;
    version: string;
    capabilities: string[];
    official?: boolean;
    meta?: PluginRegistryEntry['meta'];
  },
  schema?: Record<string, unknown>
): Promise<void> {
  const registry = await getPluginRegistry(kv);

  registry[plugin.id] = {
    id: plugin.id,
    version: plugin.version,
    capabilities: plugin.capabilities,
    official: plugin.official ?? false,
    meta: plugin.meta,
    registeredAt: Date.now(),
  };

  await kv.put('plugins:registry', JSON.stringify(registry));

  // Store schema separately
  if (schema) {
    await kv.put(`plugins:schema:${plugin.id}`, JSON.stringify(schema));
  }
}

/**
 * Update plugin health status
 * Called by plugin loader after health check
 */
export async function updatePluginHealth(
  kv: KVNamespace,
  pluginId: string,
  health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    message?: string;
  }
): Promise<void> {
  await kv.put(
    `plugins:health:${pluginId}`,
    JSON.stringify({
      ...health,
      timestamp: Date.now(),
    }),
    { expirationTtl: 3600 } // 1 hour TTL
  );
}
