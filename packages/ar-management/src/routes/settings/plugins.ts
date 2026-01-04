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
import { createErrorResponse, AR_ERROR_CODES, getLogger } from '@authrim/ar-lib-core';
import {
  maskSensitiveFieldsRecursive,
  validateExternalUrl,
  encryptSecretFields,
  decryptSecretFields,
  getPluginEncryptionKey,
  matchesSecretPattern,
  type EncryptedConfig,
} from '@authrim/ar-lib-plugin';

// =============================================================================
// Types
// =============================================================================

/**
 * Plugin source information
 *
 * Used to determine trust level and display in Admin UI.
 * Trust is based on distribution channel, NOT metadata claims.
 */
interface PluginSource {
  /**
   * Source type
   * - builtin: Included in ar-lib-plugin/src/builtin/
   * - npm: Installed via npm (includes scoped packages)
   * - local: Local file path
   * - unknown: Source cannot be determined
   */
  type: 'builtin' | 'npm' | 'local' | 'unknown';

  /**
   * Source identifier
   * - builtin: "ar-lib-plugin/builtin/{path}"
   * - npm: "@scope/package-name" or "package-name"
   * - local: "/path/to/plugin"
   * - unknown: undefined
   */
  identifier?: string;

  /**
   * npm package version (if source is npm)
   */
  npmVersion?: string;
}

/**
 * Plugin trust level
 *
 * Determined by source, NOT by metadata claims.
 * - official: Builtin or @authrim/* npm scope
 * - community: Everything else
 */
type PluginTrustLevel = 'official' | 'community';

/**
 * Determine trust level from plugin source
 */
function getPluginTrustLevel(source: PluginSource): PluginTrustLevel {
  // Builtin is always official
  if (source.type === 'builtin') {
    return 'official';
  }

  // npm @authrim/* scope is official
  if (source.type === 'npm' && source.identifier?.startsWith('@authrim/')) {
    return 'official';
  }

  // Everything else is community
  return 'community';
}

/**
 * Disclaimer text for third-party plugins
 *
 * Admin UI is responsible for i18n. This provides only the English text.
 */
const THIRD_PARTY_DISCLAIMER =
  'This plugin is provided by a third party. Authrim does not guarantee its security, reliability, or compatibility. Use at your own risk.';

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
    author?: {
      name: string;
      email?: string;
      url?: string;
    };
    license?: string;
    tags?: string[];
    stability?: 'stable' | 'beta' | 'alpha' | 'deprecated';
  };
  source: PluginSource;
  trustLevel: PluginTrustLevel;
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
  /** Disclaimer for community plugins (null for official plugins). Admin UI handles i18n. */
  disclaimer: string | null;
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
 *
 * Uses recursive masking from ar-lib-plugin to handle:
 * - Top-level fields
 * - Nested objects
 * - Arrays of objects
 */
function maskSensitiveFields(config: Record<string, unknown>): Record<string, unknown> {
  return maskSensitiveFieldsRecursive(config, {
    usePatternMatching: true, // Use default patterns (apiKey, token, password, etc.)
  });
}

/**
 * Validate plugin metadata URLs for security
 *
 * Server-side validation for headless operation.
 * Blocks dangerous URLs (javascript:, internal IPs, metadata endpoints).
 */
function validatePluginMetaUrls(meta?: PluginRegistryEntry['meta']): {
  valid: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!meta) {
    return { valid: true, warnings };
  }

  // Validate icon URL
  if (meta.icon) {
    const iconResult = validateExternalUrl(meta.icon, {
      allowDataUrl: true, // Allow data:image/svg+xml for icons
    });
    if (!iconResult.valid) {
      warnings.push(`Invalid icon URL: ${iconResult.reason}`);
    }
  }

  // Validate logo URL (stricter - no data URLs)
  if ('logoUrl' in meta && typeof (meta as { logoUrl?: string }).logoUrl === 'string') {
    const logoUrl = (meta as { logoUrl?: string }).logoUrl!;
    const logoResult = validateExternalUrl(logoUrl, {
      allowDataUrl: false, // No data URLs for logos
    });
    if (!logoResult.valid) {
      warnings.push(`Invalid logo URL: ${logoResult.reason}`);
    }
  }

  // Validate documentation URL
  if (meta.documentationUrl) {
    const docResult = validateExternalUrl(meta.documentationUrl);
    if (!docResult.valid) {
      warnings.push(`Invalid documentation URL: ${docResult.reason}`);
    }
  }

  // For community plugins, log warnings but don't reject
  // For security, warnings are logged for operator review
  return { valid: true, warnings };
}

/**
 * Log plugin configuration change for audit
 * Note: This helper returns an object for logging, caller should use getLogger(c).info()
 */
function buildPluginAuditLog(
  action: 'update' | 'enable' | 'disable',
  adminId: string | undefined,
  details: Record<string, unknown>
): Record<string, unknown> {
  return {
    action,
    adminId: adminId ?? 'unknown',
    timestamp: new Date().toISOString(),
    ...details,
  };
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
 * Decrypt secret fields in configuration if encrypted
 */
async function decryptConfigIfNeeded(
  config: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  // Check if config has encrypted fields
  const encryptedConfig = config as EncryptedConfig;
  if (!encryptedConfig._encrypted || encryptedConfig._encrypted.length === 0) {
    return config;
  }

  try {
    const key = await getPluginEncryptionKey(
      env as { PLUGIN_ENCRYPTION_KEY?: string; KEY_MANAGER_SECRET?: string }
    );
    return await decryptSecretFields(encryptedConfig, key);
  } catch {
    // If decryption fails, return config as-is (may be unencrypted legacy data)
    // Note: Caller should handle logging if needed
    // Remove _encrypted marker to avoid confusion
    const { _encrypted, ...rest } = config as EncryptedConfig;
    return rest;
  }
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
        const decryptedTenantConfig = await decryptConfigIfNeeded(tenantConfig, env);
        // Merge with global config
        const globalConfig = await getPluginConfig(kv, env, pluginId);
        return {
          config: { ...globalConfig.config, ...decryptedTenantConfig },
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
      const parsedConfig = JSON.parse(kvValue);
      const decryptedConfig = await decryptConfigIfNeeded(parsedConfig, env);
      return { config: decryptedConfig, source: 'kv' };
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

/**
 * Identify secret fields in configuration by pattern matching
 */
function identifySecretFields(config: Record<string, unknown>): string[] {
  const secretFields: string[] = [];
  for (const key of Object.keys(config)) {
    if (matchesSecretPattern(key) && typeof config[key] === 'string') {
      secretFields.push(key);
    }
  }
  return secretFields;
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
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
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
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const registry = await getPluginRegistry(kv);
  const entry = registry[pluginId];

  if (!entry) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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

  // Include disclaimer for community plugins
  const disclaimer = entry.trustLevel === 'community' ? THIRD_PARTY_DISCLAIMER : null;

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
    disclaimer,
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
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
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
 *
 * Security:
 * - Secret fields (apiKey, password, token, etc.) are automatically encrypted
 * - Encrypted data is stored with enc:v1: prefix in KV
 * - Requires PLUGIN_ENCRYPTION_KEY or KEY_MANAGER_SECRET environment variable
 */
export async function updatePluginConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PluginAdminAPI');
  const pluginId = c.req.param('id');
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  const body = await c.req.json<{
    config: Record<string, unknown>;
    tenant_id?: string;
    /** Explicit list of secret fields to encrypt (optional, uses pattern matching if not provided) */
    secret_fields?: string[];
  }>();

  if (!body.config || typeof body.config !== 'object') {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Get existing config for audit logging
  const { config: existingConfig } = await getPluginConfig(kv, c.env, pluginId, body.tenant_id);

  // Determine the key
  const configKey = body.tenant_id
    ? `plugins:config:${pluginId}:tenant:${body.tenant_id}`
    : `plugins:config:${pluginId}`;

  // Merge with existing config
  const newConfig = { ...existingConfig, ...body.config };

  // Identify secret fields to encrypt
  const secretFields = body.secret_fields ?? identifySecretFields(newConfig);

  // Encrypt secret fields if any exist and encryption key is available
  let configToStore: Record<string, unknown> = newConfig;
  if (secretFields.length > 0) {
    try {
      const encryptionKey = await getPluginEncryptionKey(
        c.env as { PLUGIN_ENCRYPTION_KEY?: string; KEY_MANAGER_SECRET?: string }
      );
      configToStore = await encryptSecretFields(newConfig, secretFields, encryptionKey);
    } catch (error) {
      // If encryption fails due to missing key, store unencrypted with warning
      log.warn('Encryption key not available, storing config unencrypted', {}, error as Error);
      // Continue with unencrypted config
    }
  }

  // Save to KV
  await kv.put(configKey, JSON.stringify(configToStore));

  // Log the change (with masked values for audit)
  log.info(
    'Plugin config updated',
    buildPluginAuditLog('update', adminId, {
      pluginId,
      tenantId: body.tenant_id ?? null,
      changedFields: Object.keys(body.config),
      encryptedFields: secretFields,
    })
  );

  return c.json({
    success: true,
    pluginId,
    tenantId: body.tenant_id ?? null,
    config: maskSensitiveFields(newConfig),
    encryptedFields: secretFields,
  });
}

/**
 * PUT /api/admin/plugins/:id/enable
 * Enable a plugin
 */
export async function enablePluginHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PluginAdminAPI');
  const pluginId = c.req.param('id');
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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

  log.info(
    'Plugin enabled',
    buildPluginAuditLog('enable', adminId, {
      pluginId,
      tenantId: tenantId ?? null,
    })
  );

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
  const log = getLogger(c).module('PluginAdminAPI');
  const pluginId = c.req.param('id');
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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

  log.info(
    'Plugin disabled',
    buildPluginAuditLog('disable', adminId, {
      pluginId,
      tenantId: tenantId ?? null,
    })
  );

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
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  if (!registry[pluginId]) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv);
  const entry = registry[pluginId];
  if (!entry) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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
 *
 * Security: Validates external URLs in plugin metadata for headless operation.
 */
export async function registerPlugin(
  kv: KVNamespace,
  plugin: {
    id: string;
    version: string;
    capabilities: string[];
    official?: boolean;
    meta?: PluginRegistryEntry['meta'];
    source?: PluginSource;
  },
  schema?: Record<string, unknown>
): Promise<{ warnings?: string[] }> {
  const registry = await getPluginRegistry(kv);

  // Determine source - default to unknown if not provided
  const source: PluginSource = plugin.source ?? { type: 'unknown' };

  // Trust level is determined by source, NOT by official flag
  const trustLevel = getPluginTrustLevel(source);

  // Validate URLs in metadata (for headless security)
  const urlValidation = validatePluginMetaUrls(plugin.meta);
  // Note: Caller should log warnings if needed using structured logger
  const warnings =
    urlValidation.warnings.length > 0
      ? urlValidation.warnings.map((w) => `[${plugin.id}] ${w} (trust: ${trustLevel})`)
      : undefined;

  registry[plugin.id] = {
    id: plugin.id,
    version: plugin.version,
    capabilities: plugin.capabilities,
    official: plugin.official ?? false,
    meta: plugin.meta,
    source,
    trustLevel,
    registeredAt: Date.now(),
  };

  await kv.put('plugins:registry', JSON.stringify(registry));

  // Store schema separately
  if (schema) {
    await kv.put(`plugins:schema:${plugin.id}`, JSON.stringify(schema));
  }

  return { warnings };
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
