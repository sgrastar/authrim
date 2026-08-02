/**
 * Plugin Management Admin API
 *
 * GET    /api/admin/plugins                  - List all registered plugins
 * GET    /api/admin/plugins/:id              - Get plugin details
 * GET    /api/admin/plugins/:id/config       - Get plugin configuration
 * PUT    /api/admin/plugins/:id/config       - Update plugin configuration
 * PUT    /api/admin/plugins/:id/enable       - Enable plugin
 * PUT    /api/admin/plugins/:id/disable      - Disable plugin
 * POST   /api/admin/plugins/:id/uninstall    - Disable and clean up managed resources
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
import type {
  Env,
  AdminAuthContext,
  ApprovedDynamicPlugin,
  ControlPluginResourceSelection,
} from '@authrim/ar-lib-core';
import {
  PLATFORM_NOTIFICATION_NAMESPACE,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  createLogger,
  produceNotificationDelivery,
  getTenantEmailSettings,
  putTenantEmailSettings,
  invalidatePluginRuntimeCaches,
  bumpAuthenticationMethodsCacheRevision,
} from '@authrim/ar-lib-core';
import {
  maskSensitiveFieldsRecursive,
  validateExternalUrl,
  encryptSecretFields,
  decryptSecretFields,
  getPluginEncryptionKey,
  matchesSecretPattern,
  type EncryptedConfig,
  // Builtin plugin registration
  registerBuiltinPlugins,
  needsBuiltinRegistration,
  cloudflareEmailPlugin,
  resendEmailPlugin,
  cloudflareTurnstilePlugin,
  hcaptchaPlugin,
  googleReCaptchaPlugin,
} from '@authrim/ar-lib-plugin';
import { resolveBuiltinPluginBootstrapConfig } from '@authrim/ar-lib-plugin/core';
import {
  disableTenantBuiltinNotificationProvider,
  deriveTenantNotificationProviderInstallationId,
  projectTenantNotificationProviderCredential,
  removeTenantNotificationProviderFromOrder,
} from '../../notification-provider-projection';
import {
  BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS,
  disableTenantHumanVerificationProvider,
  projectTenantHumanVerificationProvider,
} from '../../human-verification-provider-projection';
import { writeAdminAuditLog } from '../../admin-shared';
import {
  listProviderReprojectionStatus,
  markGlobalProviderDesiredRevision,
} from '../../provider-reprojection-jobs';
import {
  configureDynamicPluginWithControl,
  DynamicPluginResourcesPendingError,
  getDynamicPluginResourcePreparation,
  getDynamicPluginResourcePreparationForDisable,
  getDynamicPluginResourceProvisioning,
  requestDynamicPluginResourceCleanup,
  stageDynamicPluginActivation,
} from '../../plugin-dynamic-worker-control';
import {
  cancelDynamicPluginResourceFinalization,
  enqueueDynamicPluginResourceFinalization,
} from '../../plugin-resource-finalization';

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
  backendKind?: 'dynamic_worker';
  capabilityManifestDigest?: string;
  activeVersionDigest?: string;
  credentialSlots?: Array<{ configKey: string; required: boolean }>;
  resources?: ApprovedDynamicPlugin['resources'];
}

interface PluginStatus {
  pluginId: string;
  enabled: boolean;
  configSource: 'kv' | 'env' | 'default';
  configured: boolean;
  missingRequiredFields: string[];
  provisioning?: {
    operationId: string;
    state: 'pending' | 'blocked';
    kind: 'provisioning' | 'cleanup';
  };
  hasTenantOverride?: boolean;
  loadedAt?: number;
  lastHealthCheck?: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: number;
    message?: string;
  };
}

function parsePluginEnableBody(input: unknown): {
  tenantId: string | undefined;
  resourceSelections: ControlPluginResourceSelection[];
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_enable_input_invalid');
  }
  const value = input as Record<string, unknown>;
  if (!Object.keys(value).every((key) => ['tenant_id', 'resource_selections'].includes(key))) {
    throw new Error('plugin_enable_input_invalid');
  }
  const tenantId = value.tenant_id;
  if (tenantId !== undefined && (typeof tenantId !== 'string' || tenantId.length > 256)) {
    throw new Error('plugin_enable_input_invalid');
  }
  if (value.resource_selections !== undefined && !Array.isArray(value.resource_selections)) {
    throw new Error('plugin_enable_input_invalid');
  }
  const logicalIds = new Set<string>();
  const resourceSelections = (value.resource_selections ?? []).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('plugin_enable_input_invalid');
    }
    const selection = entry as Record<string, unknown>;
    if (
      Object.keys(selection).sort().join(',') !==
        'logical_resource_id,mode,provider_name,provider_resource_id' ||
      typeof selection.logical_resource_id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(selection.logical_resource_id) ||
      selection.mode !== 'existing' ||
      typeof selection.provider_resource_id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(selection.provider_resource_id) ||
      typeof selection.provider_name !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(selection.provider_name) ||
      logicalIds.has(selection.logical_resource_id)
    ) {
      throw new Error('plugin_enable_input_invalid');
    }
    logicalIds.add(selection.logical_resource_id);
    return {
      logicalResourceId: selection.logical_resource_id,
      mode: 'existing' as const,
      providerResourceId: selection.provider_resource_id,
      providerName: selection.provider_name,
    };
  });
  if (resourceSelections.length > 16) throw new Error('plugin_enable_input_invalid');
  return { tenantId, resourceSelections };
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

export interface ResolvedPluginConfigState {
  config: Record<string, unknown>;
  source: 'kv' | 'env' | 'default';
  configured: boolean;
  missingRequiredFields: string[];
  schema?: Record<string, unknown>;
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

type PluginTenantScope = 'tenant' | 'platform';

const PLUGIN_TENANT_SCOPE_KEY = 'pluginTenantScope';
const AUTHENTICATION_METHODS_PLUGIN_PREFIXES = ['human-verification-'];
const BUILTIN_NOTIFICATION_PROVIDER_IDS = new Set([cloudflareEmailPlugin.id, resendEmailPlugin.id]);

function notificationProviderNamespace(tenantId: string | undefined): string {
  return tenantId ?? PLATFORM_NOTIFICATION_NAMESPACE;
}

export async function platformPluginScopeMiddleware(
  c: Context<{ Bindings: Env }>,
  next: () => Promise<void>
): Promise<void> {
  (c as any).set(PLUGIN_TENANT_SCOPE_KEY, 'platform');
  await next();
}

function getPluginTenantScope(c: Context<{ Bindings: Env }>): PluginTenantScope {
  return ((c as any).get(PLUGIN_TENANT_SCOPE_KEY) as PluginTenantScope | undefined) ?? 'tenant';
}

function pluginAffectsAuthenticationMethods(pluginId: string): boolean {
  return AUTHENTICATION_METHODS_PLUGIN_PREFIXES.some((prefix) => pluginId.startsWith(prefix));
}

async function invalidateAuthenticationMethodsCacheForPluginChange(
  c: Context<{ Bindings: Env }>,
  pluginId: string,
  tenantId: string | undefined,
  reason: string
): Promise<void> {
  if (!pluginAffectsAuthenticationMethods(pluginId)) {
    return;
  }
  const log = getLogger(c).module('PluginAdminAPI');
  try {
    await bumpAuthenticationMethodsCacheRevision(c.env, tenantId ?? null);
  } catch (error) {
    log.warn('Failed to bump authentication methods cache revision', {
      pluginId,
      tenantId: tenantId ?? 'global',
      reason,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

function getContextTenantId(c: Context<{ Bindings: Env }>): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const tenantId = ((c as any).get('tenantId') as string | null | undefined)?.trim();
    return tenantId || undefined;
  } catch {
    return undefined;
  }
}

function getRequestTenantId(
  c: Context<{ Bindings: Env }>,
  explicitTenantId?: string
): string | undefined {
  if (getPluginTenantScope(c) === 'tenant') {
    const tenantId = getContextTenantId(c);
    if (!tenantId) {
      throw new Error('Plugin tenant-scope routes require tenant context');
    }
    return tenantId;
  }

  const candidates = [explicitTenantId, c.req.query('tenant_id'), c.req.header('X-Tenant-Id')];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
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
  action: 'update' | 'enable' | 'disable' | 'rollout_batch',
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
async function getPluginRegistry(
  kv: KVNamespace,
  env?: Env
): Promise<Record<string, PluginRegistryEntry>> {
  let registry: Record<string, PluginRegistryEntry> = {};
  try {
    const data = await kv.get('plugins:registry');
    if (data) {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        registry = parsed as Record<string, PluginRegistryEntry>;
      }
    }
  } catch {
    // Ignore parse errors
  }
  if (!env?.PLUGIN_RUNNER || typeof env.PLUGIN_RUNNER.listApprovedDynamicPlugins !== 'function') {
    return registry;
  }
  let dynamicPlugins: ApprovedDynamicPlugin[];
  try {
    dynamicPlugins = await env.PLUGIN_RUNNER.listApprovedDynamicPlugins();
  } catch {
    return registry;
  }
  for (const plugin of dynamicPlugins) {
    if (registry[plugin.pluginId]) continue;
    registry[plugin.pluginId] = {
      id: plugin.pluginId,
      version: plugin.activeVersionDigest.slice(0, 12),
      capabilities: plugin.capabilities,
      official: false,
      meta: {
        name: plugin.pluginId,
        description: 'Operator-approved custom Dynamic Worker plugin.',
        category: 'integration',
        stability: 'beta',
      },
      source: {
        type: 'local',
        identifier: `approved-manifest:${plugin.capabilityManifestDigest}`,
      },
      trustLevel: 'community',
      registeredAt: plugin.updatedAt * 1_000,
      backendKind: 'dynamic_worker',
      capabilityManifestDigest: plugin.capabilityManifestDigest,
      activeVersionDigest: plugin.activeVersionDigest,
      credentialSlots: plugin.credentials,
      resources: plugin.resources,
    };
  }
  return registry;
}

function dynamicConfigSchema(entry: PluginRegistryEntry): Record<string, unknown> | undefined {
  if (entry.backendKind !== 'dynamic_worker') return undefined;
  const slots = entry.credentialSlots ?? [];
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      slots.map((slot) => [
        slot.configKey,
        {
          type: 'string',
          minLength: 1,
          maxLength: 8192,
          description:
            'Secret credential. Existing values are never returned; re-enter to replace.',
        },
      ])
    ),
    required: slots.filter((slot) => slot.required).map((slot) => slot.configKey),
  };
}

function pluginRunner(env: Env): NonNullable<Env['PLUGIN_RUNNER']> {
  if (!env.PLUGIN_RUNNER) throw new Error('dynamic_plugin_runner_unavailable');
  return env.PLUGIN_RUNNER;
}

async function dynamicRolloutOperationId(
  pluginId: string,
  idempotencyKey: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(['authrim-dynamic-plugin-rollout-v1', pluginId, idempotencyKey])
    )
  );
  const encoded = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `plugin-rollout-v1-${encoded}`;
}

/**
 * POST /api/admin/platform/plugins/:id/rollout
 * Process one bounded batch of an explicit custom Dynamic Worker rollout.
 */
export async function rolloutDynamicPluginBatchHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id')!;
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'A valid Idempotency-Key header is required',
      },
      400
    );
  }
  let batchSize: number;
  try {
    const body = await c.req.json<{ batch_size?: unknown }>();
    batchSize = Number(body.batch_size);
  } catch {
    batchSize = Number.NaN;
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 25) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'batch_size must be an integer from 1 through 25',
      },
      400
    );
  }
  const adminAuth = getAdminAuth(c);
  if (adminAuth?.actorType && adminAuth.actorType !== 'human') {
    return c.json(
      { error: 'forbidden', error_description: 'A human system administrator is required' },
      403
    );
  }
  try {
    const operationId = await dynamicRolloutOperationId(pluginId, idempotencyKey);
    const auditId = await writeAdminAuditLog(c, {
      action: 'plugin.dynamic_worker.rollout_batch.requested',
      resourceType: 'dynamic_worker_plugin',
      resourceId: pluginId,
      result: 'success',
      after: {
        operation_id: operationId,
        requested_batch_size: batchSize,
      },
      metadata: { execution: 'plugin_runner_service_binding' },
    });
    if (!auditId) {
      return c.json(
        { error: 'temporarily_unavailable', error_description: 'Plugin rollout audit unavailable' },
        503
      );
    }
    const result = await pluginRunner(c.env).rolloutDynamicPluginBatch({
      operationId,
      pluginId,
      batchSize,
    });
    getLogger(c)
      .module('PluginAdminAPI')
      .info(
        'Dynamic plugin rollout batch processed',
        buildPluginAuditLog('rollout_batch', adminAuth?.userId ?? adminAuth?.authMethod, {
          pluginId,
          operationId: result.operationId,
          targetVersionDigest: result.targetVersionDigest,
          state: result.state,
          processedThisBatch: result.processedThisBatch,
          succeededCount: result.succeededCount,
          blockedCount: result.blockedCount,
          failedCount: result.failedCount,
          hasMore: result.hasMore,
          lastErrorCode: result.lastErrorCode,
        })
      );
    return c.json({ ...result, auditId });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (
      code === 'plugin_dynamic_rollout_in_progress' ||
      code === 'plugin_dynamic_rollout_idempotency_conflict' ||
      code === 'plugin_dynamic_rollout_target_changed'
    ) {
      return c.json(
        {
          error: 'conflict',
          error_description:
            'The plugin rollout is already running or the operation does not match',
        },
        409
      );
    }
    if (
      code === 'plugin_dynamic_rollout_batch_input_invalid' ||
      code === 'plugin_dynamic_rollout_version_unavailable'
    ) {
      return c.json(
        { error: 'invalid_request', error_description: 'The plugin rollout is not available' },
        400
      );
    }
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The plugin rollout could not proceed',
      },
      503
    );
  }
}

async function getDynamicPluginStatus(env: Env, tenantId: string, pluginId: string) {
  return pluginRunner(env).getDynamicPluginInstallationStatus({ tenantId, pluginId });
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

  // Default: disabled. Plugins must be explicitly enabled after configuration.
  return false;
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
      env as { PLUGIN_ENCRYPTION_KEY?: string; PLUGIN_ENCRYPTION_SALT?: string }
    );
    return await decryptSecretFields(encryptedConfig, key);
  } catch {
    const encryptedFields = new Set(encryptedConfig._encrypted);
    return Object.fromEntries(
      Object.entries(config).filter(
        ([field]) => field !== '_encrypted' && !encryptedFields.has(field)
      )
    );
  }
}

async function getPluginSchema(
  kv: KVNamespace,
  pluginId: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const schemaData = await kv.get(`plugins:schema:${pluginId}`);
    if (!schemaData) {
      return undefined;
    }

    const parsed = JSON.parse(schemaData);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function hasConfiguredValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function getMissingRequiredFields(
  schema: Record<string, unknown> | undefined,
  config: Record<string, unknown>
): string[] {
  const required = schema?.required;
  if (!Array.isArray(required)) {
    return [];
  }

  return required.filter(
    (field): field is string =>
      typeof field === 'string' && !hasConfiguredValue(config[field as keyof typeof config])
  );
}

function getGenericPluginEnvConfig(env: Env, pluginId: string): Record<string, unknown> {
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

function getBuiltinBootstrapConfig(env: Env, pluginId: string): Record<string, unknown> {
  return resolveBuiltinPluginBootstrapConfig(env, pluginId);
}

function isMaskedSecretReplacement(value: unknown): value is string {
  return typeof value === 'string' && value.includes('****');
}

function mergeConfigPreservingSecrets(
  existingConfig: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...existingConfig };

  for (const [key, value] of Object.entries(patch)) {
    if (
      matchesSecretPattern(key) &&
      isMaskedSecretReplacement(value) &&
      typeof existingConfig[key] === 'string'
    ) {
      merged[key] = existingConfig[key];
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

/**
 * Get plugin configuration
 */
export async function getPluginConfig(
  kv: KVNamespace,
  env: Env,
  pluginId: string,
  tenantId?: string
): Promise<{ config: Record<string, unknown>; source: 'kv' | 'env' | 'default' }> {
  let hasKvConfig = false;
  let globalConfig: Record<string, unknown> = {};
  let tenantConfig: Record<string, unknown> = {};

  const envConfig = {
    ...getGenericPluginEnvConfig(env, pluginId),
    ...getBuiltinBootstrapConfig(env, pluginId),
  };

  const readKvConfig = async (key: string): Promise<Record<string, unknown> | null> => {
    const rawValue = await kv.get(key);
    if (!rawValue) {
      return null;
    }

    try {
      const parsedConfig = JSON.parse(rawValue);
      const decryptedConfig = await decryptConfigIfNeeded(parsedConfig, env);
      return decryptedConfig;
    } catch {
      return null;
    }
  };

  const resolvedGlobalConfig = await readKvConfig(`plugins:config:${pluginId}`);
  if (resolvedGlobalConfig) {
    globalConfig = resolvedGlobalConfig;
    hasKvConfig = true;
  }

  // Check tenant-specific first
  if (tenantId) {
    const resolvedTenantConfig = await readKvConfig(
      `plugins:config:${pluginId}:tenant:${tenantId}`
    );
    if (resolvedTenantConfig) {
      tenantConfig = resolvedTenantConfig;
      hasKvConfig = true;
    }
  }

  const mergedConfig = {
    ...envConfig,
    ...globalConfig,
    ...tenantConfig,
  };

  if (hasKvConfig) {
    return { config: mergedConfig, source: 'kv' };
  }

  if (Object.keys(envConfig).length > 0) {
    return { config: mergedConfig, source: 'env' };
  }

  return { config: {}, source: 'default' };
}

export async function getResolvedPluginConfigState(
  kv: KVNamespace,
  env: Env,
  pluginId: string,
  tenantId?: string
): Promise<ResolvedPluginConfigState> {
  const [{ config, source }, schema] = await Promise.all([
    getPluginConfig(kv, env, pluginId, tenantId),
    getPluginSchema(kv, pluginId),
  ]);
  const missingRequiredFields = getMissingRequiredFields(schema, config);

  return {
    config,
    source,
    configured: missingRequiredFields.length === 0,
    missingRequiredFields,
    schema,
  };
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

function getBuiltinEmailPluginById(pluginId: string) {
  switch (pluginId) {
    case cloudflareEmailPlugin.id:
      return cloudflareEmailPlugin;
    case resendEmailPlugin.id:
      return resendEmailPlugin;
    default:
      return null;
  }
}

function getBuiltinHumanVerificationPluginById(pluginId: string) {
  switch (pluginId) {
    case cloudflareTurnstilePlugin.id:
      return cloudflareTurnstilePlugin;
    case hcaptchaPlugin.id:
      return hcaptchaPlugin;
    case googleReCaptchaPlugin.id:
      return googleReCaptchaPlugin;
    default:
      return null;
  }
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
  const tenantId = getRequestTenantId(c);

  // Lazy initialization: Ensure builtin plugins are registered
  // This runs once per Worker isolate and is a no-op if already registered
  await ensureBuiltinPluginsRegistered(kv);

  const registry = await getPluginRegistry(kv, c.env);
  const plugins: Array<PluginRegistryEntry & PluginStatus> = [];

  for (const [pluginId, entry] of Object.entries(registry)) {
    const [dynamicStatus, provisioning] =
      entry.backendKind === 'dynamic_worker' && tenantId
        ? await Promise.all([
            getDynamicPluginStatus(c.env, tenantId, pluginId),
            getDynamicPluginResourceProvisioning(c.env, { tenantId, pluginId }),
          ])
        : [null, null];
    const enabled = dynamicStatus
      ? dynamicStatus.state === 'enabled'
      : entry.backendKind === 'dynamic_worker'
        ? false
        : await isPluginEnabled(kv, pluginId, tenantId);
    const resolved = dynamicStatus
      ? {
          source: 'default' as const,
          configured: dynamicStatus.missingRequiredFields.length === 0,
          missingRequiredFields: dynamicStatus.missingRequiredFields,
        }
      : entry.backendKind === 'dynamic_worker'
        ? {
            source: 'default' as const,
            configured: false,
            missingRequiredFields: (entry.credentialSlots ?? [])
              .filter((slot) => slot.required)
              .map((slot) => slot.configKey),
          }
        : await getResolvedPluginConfigState(kv, c.env, pluginId, tenantId);

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
      configSource: resolved.source,
      configured: resolved.configured,
      missingRequiredFields: resolved.missingRequiredFields,
      ...(provisioning ? { provisioning } : {}),
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
  const pluginId = c.req.param('id')!;
  const kv = getPluginKV(c.env);
  const tenantId = getRequestTenantId(c);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const registry = await getPluginRegistry(kv, c.env);
  const entry = registry[pluginId];

  if (!entry) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  const [dynamicStatus, provisioning] =
    entry.backendKind === 'dynamic_worker' && tenantId
      ? await Promise.all([
          getDynamicPluginStatus(c.env, tenantId, pluginId),
          getDynamicPluginResourceProvisioning(c.env, { tenantId, pluginId }),
        ])
      : [null, null];
  const resolved = dynamicStatus
    ? {
        config: {},
        source: 'default' as const,
        configured: dynamicStatus.missingRequiredFields.length === 0,
        missingRequiredFields: dynamicStatus.missingRequiredFields,
        schema: dynamicConfigSchema(entry),
      }
    : await getResolvedPluginConfigState(kv, c.env, pluginId, tenantId);
  const enabled = dynamicStatus
    ? dynamicStatus.state === 'enabled'
    : await isPluginEnabled(kv, pluginId, tenantId);
  const hasTenantOverride =
    !dynamicStatus && tenantId
      ? (await kv.get(`plugins:config:${pluginId}:tenant:${tenantId}`)) !== null
      : false;

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
      configSource: resolved.source,
      configured: resolved.configured,
      missingRequiredFields: resolved.missingRequiredFields,
      ...(provisioning ? { provisioning } : {}),
      hasTenantOverride,
      lastHealthCheck,
    },
    config: maskSensitiveFields(resolved.config),
    configSchema: resolved.schema,
    disclaimer,
  };

  return c.json(response);
}

/**
 * GET /api/admin/plugins/:id/config
 * Get plugin configuration (with masked sensitive fields)
 */
export async function getPluginConfigHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id')!;
  const tenantId = getRequestTenantId(c);
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const registry = await getPluginRegistry(kv, c.env);
  const entry = registry[pluginId];
  if (entry?.backendKind === 'dynamic_worker') {
    if (!tenantId) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    const status = await getDynamicPluginStatus(c.env, tenantId, pluginId);
    return c.json({
      pluginId,
      tenantId,
      config: {},
      source: 'default',
      configured: status.missingRequiredFields.length === 0,
      missingRequiredFields: status.missingRequiredFields,
      configuredFields: status.configuredKeys,
      hasTenantOverride: false,
    });
  }

  const { config, source, configured, missingRequiredFields } = await getResolvedPluginConfigState(
    kv,
    c.env,
    pluginId,
    tenantId
  );
  const hasTenantOverride = tenantId
    ? (await kv.get(`plugins:config:${pluginId}:tenant:${tenantId}`)) !== null
    : false;

  return c.json({
    pluginId,
    tenantId: tenantId ?? null,
    config: maskSensitiveFields(config),
    source,
    configured,
    missingRequiredFields,
    hasTenantOverride,
  });
}

/**
 * DELETE /api/admin/plugins/:id/config
 * Remove the current tenant override and return to inherited configuration.
 */
export async function resetPluginConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PluginAdminAPI');
  const pluginId = c.req.param('id')!;
  const tenantId = getRequestTenantId(c);
  const kv = getPluginKV(c.env);

  if (!kv || !tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  const registry = await getPluginRegistry(kv, c.env);
  const entry = registry[pluginId];
  if (!entry) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  if (entry.backendKind === 'dynamic_worker') {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'dynamic plugin credential reset' },
    });
  }

  const overrideKey = `plugins:config:${pluginId}:tenant:${tenantId}`;
  if ((await kv.get(overrideKey)) !== null) {
    await kv.delete(overrideKey);
    if (
      BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId) ||
      BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId)
    ) {
      await markGlobalProviderDesiredRevision(c.env, pluginId);
    }
  }

  invalidatePluginRuntimeCaches(c.env, { tenantId, pluginId });
  await invalidateAuthenticationMethodsCacheForPluginChange(c, pluginId, tenantId, 'plugin:reset');
  const { config, source, configured, missingRequiredFields } = await getResolvedPluginConfigState(
    kv,
    c.env,
    pluginId,
    tenantId
  );
  log.info('Plugin tenant config reset to inherited state', {
    pluginId,
    tenantId,
    adminId: getAdminAuth(c)?.userId ?? getAdminAuth(c)?.authMethod,
  });
  return c.json({
    pluginId,
    tenantId,
    config: maskSensitiveFields(config),
    source,
    configured,
    missingRequiredFields,
    hasTenantOverride: false,
  });
}

/**
 * PUT /api/admin/plugins/:id/config
 * Update plugin configuration
 *
 * Security:
 * - Secret fields (apiKey, password, token, etc.) are automatically encrypted
 * - Encrypted data is stored with enc:v1: prefix in KV
 * - Requires PLUGIN_ENCRYPTION_KEY environment variable
 */
export async function updatePluginConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PluginAdminAPI');
  const pluginId = c.req.param('id')!;
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv, c.env);
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
  const tenantId = getRequestTenantId(c, body.tenant_id);
  const entry = registry[pluginId];
  if (entry.backendKind === 'dynamic_worker') {
    if (!tenantId || Array.isArray(body.config)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const credentials = Object.fromEntries(
      Object.entries(body.config).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string' && entry[1].length > 0;
      })
    );
    if (Object.keys(credentials).length !== Object.keys(body.config).length) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'plugin credentials' },
      });
    }
    const status = await getDynamicPluginStatus(c.env, tenantId, pluginId);
    await pluginRunner(c.env).replaceDynamicPluginCredentials({
      operationId: `dynamic-plugin-credentials-${crypto.randomUUID()}`,
      tenantId,
      pluginId,
      expectedConfigVersion: status.configVersion,
      credentials,
    });
    const changedFields = Object.keys(credentials);
    log.info(
      'Dynamic plugin credentials updated',
      buildPluginAuditLog('update', adminId, { pluginId, tenantId, changedFields })
    );
    return c.json({
      success: true,
      pluginId,
      tenantId,
      config: {},
      encryptedFields: changedFields,
    });
  }
  const { config: existingConfig } = await getPluginConfig(kv, c.env, pluginId, tenantId);

  // Determine the key
  const configKey = tenantId
    ? `plugins:config:${pluginId}:tenant:${tenantId}`
    : `plugins:config:${pluginId}`;

  // Merge with existing config
  const newConfig = mergeConfigPreservingSecrets(existingConfig, body.config);
  const builtinEmailPlugin = getBuiltinEmailPluginById(pluginId);
  if (builtinEmailPlugin && !builtinEmailPlugin.configSchema.safeParse(newConfig).success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'plugin configuration' },
    });
  }
  const builtinHumanVerificationPlugin = getBuiltinHumanVerificationPluginById(pluginId);
  if (
    builtinHumanVerificationPlugin &&
    !builtinHumanVerificationPlugin.configSchema.safeParse(newConfig).success
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'plugin configuration' },
    });
  }
  if (
    BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId) &&
    newConfig.failurePolicy === 'fail_open'
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'failurePolicy' },
    });
  }

  // Identify secret fields to encrypt
  const secretFields = body.secret_fields ?? identifySecretFields(newConfig);

  // Encrypt secret fields. Plugin secrets must never be stored unencrypted.
  let configToStore: Record<string, unknown> = newConfig;
  if (secretFields.length > 0) {
    try {
      const encryptionKey = await getPluginEncryptionKey(
        c.env as { PLUGIN_ENCRYPTION_KEY?: string; PLUGIN_ENCRYPTION_SALT?: string }
      );
      configToStore = await encryptSecretFields(newConfig, secretFields, encryptionKey);
    } catch (error) {
      log.error(
        'Plugin encryption key not available; refusing to store plugin secrets',
        {},
        error as Error
      );
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }
  }

  // Save to KV
  await kv.put(configKey, JSON.stringify(configToStore));
  if (
    !tenantId &&
    (BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId) ||
      BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId))
  ) {
    await markGlobalProviderDesiredRevision(c.env, pluginId);
  }
  if (BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId)) {
    const enabled = await isPluginEnabled(kv, pluginId, tenantId);
    if (enabled) {
      await projectTenantNotificationProviderCredential(c.env, {
        tenantId: notificationProviderNamespace(tenantId),
        channel: 'email',
        pluginId,
        config: newConfig,
      });
    }
  }
  if (tenantId && BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId)) {
    const enabled = await isPluginEnabled(kv, pluginId, tenantId);
    if (enabled) {
      await projectTenantHumanVerificationProvider(c.env, {
        tenantId,
        pluginId,
        config: newConfig,
      });
    }
  }
  invalidatePluginRuntimeCaches(c.env, tenantId ? { tenantId, pluginId } : { pluginId });
  await invalidateAuthenticationMethodsCacheForPluginChange(c, pluginId, tenantId, 'plugin:config');

  // Log the change (with masked values for audit)
  log.info(
    'Plugin config updated',
    buildPluginAuditLog('update', adminId, {
      pluginId,
      tenantId: tenantId ?? null,
      changedFields: Object.keys(body.config),
      encryptedFields: secretFields,
    })
  );

  return c.json({
    success: true,
    pluginId,
    tenantId: tenantId ?? null,
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
  const pluginId = c.req.param('id')!;
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv, c.env);
  if (!registry[pluginId]) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  let enableInput: ReturnType<typeof parsePluginEnableBody>;
  try {
    enableInput = parsePluginEnableBody(await c.req.json<unknown>());
  } catch {
    const contentLength = Number(c.req.header('Content-Length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    enableInput = { tenantId: undefined, resourceSelections: [] };
  }
  const tenantId = getRequestTenantId(c, enableInput.tenantId);

  const entry = registry[pluginId];
  if (entry.backendKind === 'dynamic_worker') {
    if (!tenantId) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    let installation;
    try {
      ({ installation } = await configureDynamicPluginWithControl(c.env, {
        tenantId,
        pluginId,
        enabled: true,
        ...(enableInput.resourceSelections.length > 0
          ? { resourceSelections: enableInput.resourceSelections }
          : {}),
      }));
    } catch (error) {
      if (!(error instanceof DynamicPluginResourcesPendingError)) throw error;
      log.info(
        'Dynamic plugin resource provisioning requested',
        buildPluginAuditLog('enable', adminId, {
          pluginId,
          tenantId,
          operationId: error.preparation.operationId,
          provisioningState: error.preparation.readiness,
          resourceCount: error.preparation.resources.length,
        })
      );
      if (!error.preparation.operationId) throw new Error('dynamic_plugin_control_plan_mismatch');
      await stageDynamicPluginActivation(c.env, {
        tenantId,
        pluginId,
        activationRequestId: error.preparation.operationId,
      });
      await enqueueDynamicPluginResourceFinalization(kv, {
        operationId: error.preparation.operationId,
        tenantId,
        pluginId,
      });
      return c.json(
        {
          success: true,
          pluginId,
          tenantId,
          enabled: false,
          configSource: 'default',
          configured: true,
          missingRequiredFields: [],
          provisioning: {
            operationId: error.preparation.operationId,
            state: error.preparation.readiness,
            kind: 'provisioning',
          },
        },
        202
      );
    }
    log.info(
      'Dynamic plugin enabled',
      buildPluginAuditLog('enable', adminId, {
        pluginId,
        tenantId,
        pinnedVersionDigest: installation.pinnedVersionDigest,
        resourceSelectionCount: enableInput.resourceSelections.length,
      })
    );
    return c.json({
      success: true,
      pluginId,
      tenantId,
      enabled: true,
      configSource: 'default',
      configured: true,
      missingRequiredFields: [],
    });
  }
  if (enableInput.resourceSelections.length > 0) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  const { config, configured, missingRequiredFields } = await getResolvedPluginConfigState(
    kv,
    c.env,
    pluginId,
    tenantId
  );
  if (!configured) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'plugin configuration' },
      extensions: {
        plugin_id: pluginId,
        missing_required_fields: missingRequiredFields,
      },
    });
  }

  if (BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId)) {
    await projectTenantNotificationProviderCredential(c.env, {
      tenantId: notificationProviderNamespace(tenantId),
      channel: 'email',
      pluginId,
      config,
    });
  }
  if (tenantId && BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId)) {
    await projectTenantHumanVerificationProvider(c.env, {
      tenantId,
      pluginId,
      config,
    });
  }

  const enableKey = tenantId
    ? `plugins:enabled:${pluginId}:tenant:${tenantId}`
    : `plugins:enabled:${pluginId}`;

  await kv.put(enableKey, 'true');
  if (
    !tenantId &&
    (BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId) ||
      BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId))
  ) {
    await markGlobalProviderDesiredRevision(c.env, pluginId);
  }
  invalidatePluginRuntimeCaches(c.env, tenantId ? { tenantId, pluginId } : { pluginId });
  await invalidateAuthenticationMethodsCacheForPluginChange(c, pluginId, tenantId, 'plugin:enable');

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
  const pluginId = c.req.param('id')!;
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv, c.env);
  if (!registry[pluginId]) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  let tenantId: string | undefined;
  try {
    const body = await c.req.json<{ tenant_id?: string }>();
    tenantId = getRequestTenantId(c, body.tenant_id);
  } catch {
    tenantId = getRequestTenantId(c);
  }

  const entry = registry[pluginId];
  if (entry.backendKind === 'dynamic_worker') {
    if (!tenantId) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    const preparation = await getDynamicPluginResourcePreparationForDisable(c.env, {
      tenantId,
      pluginId,
    });
    await configureDynamicPluginWithControl(c.env, {
      tenantId,
      pluginId,
      enabled: false,
    });
    if (preparation) {
      await cancelDynamicPluginResourceFinalization(kv, {
        operationId: preparation.operationId,
        tenantId,
        pluginId,
      });
    }
    log.info(
      'Dynamic plugin disabled',
      buildPluginAuditLog('disable', adminId, { pluginId, tenantId })
    );
    return c.json({
      success: true,
      pluginId,
      tenantId,
      enabled: false,
      configSource: 'default',
      configured: true,
      missingRequiredFields: [],
    });
  }

  const enableKey = tenantId
    ? `plugins:enabled:${pluginId}:tenant:${tenantId}`
    : `plugins:enabled:${pluginId}`;

  if (BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId)) {
    const namespace = notificationProviderNamespace(tenantId);
    await disableTenantBuiltinNotificationProvider(c.env, {
      tenantId: namespace,
      channel: 'email',
      pluginId,
    });

    await removeTenantNotificationProviderFromOrder(c.env, {
      tenantId: namespace,
      channel: 'email',
      pluginId,
    });

    if (tenantId) {
      const currentSettings = await getTenantEmailSettings(c.env, tenantId);
      const providerIds = currentSettings.providerOrder.filter(
        (providerId) => providerId !== pluginId
      );
      await putTenantEmailSettings(c.env, tenantId, {
        strategy: 'priority_failover',
        providerOrder: providerIds,
      });
    }
  }
  if (tenantId && BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId)) {
    await disableTenantHumanVerificationProvider(c.env, { tenantId, pluginId });
  }
  await kv.put(enableKey, 'false');
  if (
    !tenantId &&
    (BUILTIN_NOTIFICATION_PROVIDER_IDS.has(pluginId) ||
      BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId))
  ) {
    await markGlobalProviderDesiredRevision(c.env, pluginId);
  }
  invalidatePluginRuntimeCaches(c.env, tenantId ? { tenantId, pluginId } : { pluginId });
  await invalidateAuthenticationMethodsCacheForPluginChange(
    c,
    pluginId,
    tenantId,
    'plugin:disable'
  );

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
 * POST /api/admin/plugins/:id/uninstall
 * Disable a dynamic plugin and start the fenced 30-minute resource cleanup workflow.
 */
export async function uninstallPluginHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PluginAdminAPI');
  const pluginId = c.req.param('id');
  if (!pluginId) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  const adminAuth = getAdminAuth(c);
  const adminId = String(adminAuth?.userId ?? adminAuth?.authMethod ?? 'admin-session');
  const kv = getPluginKV(c.env);
  if (!kv) return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);

  const registry = await getPluginRegistry(kv, c.env);
  const entry = registry[pluginId];
  if (!entry) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  if (entry.backendKind !== 'dynamic_worker') {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json<unknown>();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  if (
    Object.keys(body).sort().join(',') !== 'confirmation,idempotency_key,tenant_id' ||
    body.confirmation !== 'UNINSTALL' ||
    typeof body.idempotency_key !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(body.idempotency_key)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  const tenantId = getRequestTenantId(
    c,
    typeof body.tenant_id === 'string' ? body.tenant_id : undefined
  );
  if (!tenantId) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);

  const preparation = await getDynamicPluginResourcePreparationForDisable(c.env, {
    tenantId,
    pluginId,
  });
  await configureDynamicPluginWithControl(c.env, { tenantId, pluginId, enabled: false });
  if (preparation) {
    await cancelDynamicPluginResourceFinalization(kv, {
      operationId: preparation.operationId,
      tenantId,
      pluginId,
    });
  }
  const cleanup = await requestDynamicPluginResourceCleanup(c.env, {
    tenantId,
    pluginId,
    reason: 'uninstall',
    requestedById: adminId,
    idempotencyKey: body.idempotency_key,
  });
  log.info(
    'Dynamic plugin uninstall requested',
    buildPluginAuditLog('disable', adminId, {
      pluginId,
      tenantId,
      cleanupOperationId: cleanup?.operationId ?? null,
      cleanupState: cleanup?.state ?? 'not_required',
    })
  );
  return c.json(
    {
      success: true,
      pluginId,
      tenantId,
      enabled: false,
      cleanup,
    },
    cleanup ? 202 : 200
  );
}

/**
 * POST /api/admin/plugins/:id/test-email
 * Send a test email using the selected plugin's current configuration.
 */
export async function sendPluginTestEmailHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id')!;
  const kv = getPluginKV(c.env);
  const logger = getLogger(c).module('PluginAdminAPI');

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const registry = await getPluginRegistry(kv, c.env);
  const entry = registry[pluginId];
  if (!entry) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  if (!entry.capabilities.includes('notifier.email')) {
    return c.json(
      {
        error: 'invalid_plugin',
        error_description: 'Test email is only supported for email notifier plugins',
      },
      400
    );
  }

  const plugin = getBuiltinEmailPluginById(pluginId);
  if (!plugin) {
    return c.json(
      {
        error: 'unsupported_plugin',
        error_description: 'Test email is currently supported for builtin email plugins only',
      },
      400
    );
  }

  const body = await c.req
    .json<{
      to?: string;
      tenant_id?: string;
    }>()
    .catch(() => null);

  const to = body?.to?.trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return c.json(
      {
        error: 'invalid_email',
        error_description: 'A valid recipient email address is required',
      },
      400
    );
  }

  const tenantId = getRequestTenantId(c, body?.tenant_id);
  const enabled = await isPluginEnabled(kv, pluginId, tenantId);
  if (!enabled) {
    return c.json(
      {
        error: 'plugin_disabled',
        error_description: 'Enable this plugin before sending a test email',
      },
      400
    );
  }

  const { config: existingConfig } = await getPluginConfig(kv, c.env, pluginId, tenantId);
  const effectiveConfig = existingConfig;

  try {
    plugin.configSchema.parse(effectiveConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Plugin configuration is invalid';
    return c.json(
      {
        error: 'invalid_config',
        error_description: message,
      },
      400
    );
  }

  try {
    const namespace = notificationProviderNamespace(tenantId);
    const installationId = await deriveTenantNotificationProviderInstallationId(c.env, {
      tenantId: namespace,
      pluginId,
      channel: 'email',
    });
    const deliveryId = crypto.randomUUID();
    const delivery = await produceNotificationDelivery(c.env, {
      owner: tenantId ? { owner: 'tenant', tenantId } : { owner: 'platform' },
      intentId: `admin-test-email:${deliveryId}`,
      outboxId: `notification:${deliveryId}`,
      notificationKind: 'admin.test-email',
      idempotencyKey: `admin-test-email:${deliveryId}`,
      expiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
      requiredInstallationId: installationId,
      payload: {
        channel: 'email',
        to,
        ...(typeof effectiveConfig.defaultFrom === 'string'
          ? { from: effectiveConfig.defaultFrom }
          : {}),
        subject: 'Authrim test email',
        body: `<p>This is a test email from Authrim.</p><p>Provider: ${entry.meta?.name ?? pluginId}</p>`,
        metadata: {
          textBody: `This is a test email from Authrim.\nProvider: ${entry.meta?.name ?? pluginId}`,
        },
      },
    });

    if (delivery.delivery === 'permanent_failure') {
      return c.json(
        {
          error: 'test_email_failed',
          error_description: 'The plugin could not send the test email',
          retryable: false,
        },
        502
      );
    }

    return c.json(
      {
        success: true,
        pluginId,
        tenantId: tenantId ?? null,
        to,
        messageId: delivery.reference.intentId,
        deliveryState: delivery.delivery,
      },
      delivery.delivery === 'pending' ? 202 : 200
    );
  } catch (error) {
    logger.warn('Plugin test email failed', {
      pluginId,
      tenantId,
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return c.json(
      {
        error: 'test_email_failed',
        error_description: 'Failed to send test email',
      },
      502
    );
  }
}

export async function getProviderReprojectionStatusHandler(c: Context<{ Bindings: Env }>) {
  try {
    return c.json({ jobs: await listProviderReprojectionStatus(c.env) });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/plugins/:id/health
 * Get plugin health status (and trigger health check)
 */
export async function getPluginHealthHandler(c: Context<{ Bindings: Env }>) {
  const pluginId = c.req.param('id')!;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv, c.env);
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
  const pluginId = c.req.param('id')!;
  const kv = getPluginKV(c.env);

  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify plugin exists
  const registry = await getPluginRegistry(kv, c.env);
  const entry = registry[pluginId];
  if (!entry) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }

  // Get schema from KV
  let configSchema: Record<string, unknown> | null = dynamicConfigSchema(entry) ?? null;
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

// =============================================================================
// Builtin Plugin Auto-Registration
// =============================================================================

/** Cache for registration check to avoid repeated KV reads within a request */
let builtinRegistrationChecked = false;

/**
 * Ensure builtin plugins are registered in KV
 *
 * This function should be called at startup or lazily on first plugin list request.
 * It registers all builtin plugins (from ar-lib-plugin/builtin/) to the KV registry
 * so they appear in Admin UI.
 *
 * Features:
 * - Idempotent: Only registers if missing or version changed
 * - Lightweight: Checks needsBuiltinRegistration() first to minimize KV reads
 * - Caches result to avoid repeated checks within the same isolate
 *
 * @param kv - KV namespace (SETTINGS)
 * @returns Registration result with counts and any errors
 */
export async function ensureBuiltinPluginsRegistered(
  kv: KVNamespace
): Promise<{ registered: number; skipped: number; errors: string[] } | null> {
  // Skip if already checked in this isolate
  if (builtinRegistrationChecked) {
    return null;
  }

  const log = createLogger().module('PluginRegistry');

  try {
    // Quick check if registration is needed
    const needsRegistration = await needsBuiltinRegistration(kv);
    if (!needsRegistration) {
      builtinRegistrationChecked = true;
      log.debug('Builtin plugins already registered, skipping');
      return null;
    }

    // Register builtin plugins
    const result = await registerBuiltinPlugins(kv, {
      force: false,
      log: (message, data) => {
        log.debug(message, data ?? {});
      },
    });

    builtinRegistrationChecked = true;

    if (result.registered > 0) {
      log.info('Builtin plugins registered', {
        registered: result.registered,
        skipped: result.skipped,
        errors: result.errors.length,
      });
    }

    if (result.errors.length > 0) {
      log.warn('Some builtin plugins failed to register', { errors: result.errors });
    }

    return result;
  } catch (error) {
    log.error('Failed to register builtin plugins', {}, error as Error);
    // Don't cache failure - allow retry on next request
    return { registered: 0, skipped: 0, errors: [(error as Error).message] };
  }
}
