/**
 * What the Settings API routes share: the settings manager (with its audit mirror), the failure
 * audit, the error body, and small readers of the saved documents.
 */
import type { Context } from 'hono';
import {
  ALL_CATEGORY_META,
  bumpAuthenticationMethodsCacheRevision,
  createAuditLogFromContext,
  createLogger,
  createSettingsManager,
  humanVerificationSelectionFromSettings,
  requireDedicatedAdminDatabaseAdapter,
  sanitizeObject,
  type AdminAuthContext,
  type CategoryName,
  type Env,
  type SettingScope,
  type SettingsManager,
  type SettingsPatchRequest,
} from '@authrim/ar-lib-core';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import type { IdentityMappingLevelHistoryVia } from '@authrim/ar-lib-core/services/identity-mapping-level-history';
import { BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS } from '../../human-verification-provider-projection';
import { markGlobalProviderDesiredRevision } from '../../provider-reprojection-jobs';

// Module-level logger for settings audit
export const log = createLogger().module('SETTINGS_AUDIT');
export const AUTHENTICATION_METHODS_TENANT_CACHE_CATEGORIES = new Set<CategoryName>([
  'authentication-methods',
  'account-lifecycle',
  'login-ui',
  'self-service',
  // federation.saml_enabled decides whether SAML sign-in is offered.
  'federation',
]);
export const AUTHENTICATION_METHODS_CLIENT_CACHE_CATEGORIES = new Set<CategoryName>(['login-ui']);
export const DEFAULT_HUMAN_VERIFICATION_PROVIDER = 'human-verification-cloudflare-turnstile';
export const HUMAN_VERIFICATION_SETTING_PREFIX = 'authentication-methods.human_verification.';

/**
 * Parse and sanitize PATCH request body
 */
export function parsePatchRequest(rawBody: unknown): SettingsPatchRequest {
  if (typeof rawBody !== 'object' || rawBody === null) {
    return { ifMatch: '' };
  }

  const body = rawBody as Record<string, unknown>;
  return {
    ifMatch: typeof body.ifMatch === 'string' ? body.ifMatch : '',
    set: body.set && typeof body.set === 'object' ? sanitizeObject(body.set) : undefined,
    clear: Array.isArray(body.clear)
      ? body.clear.filter((k): k is string => typeof k === 'string')
      : undefined,
    disable: Array.isArray(body.disable)
      ? body.disable.filter((k): k is string => typeof k === 'string')
      : undefined,
  };
}

/**
 * Get or create SettingsManager for the request
 */
export function getSettingsManager(
  env: Env,
  auditContext?: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>,
  /** Save through the canonical store (D1), with KV as the runtime projection. */
  canonicalSettings = false,
  /**
   * Refuse documents that cannot be read instead of reading them as empty: for views, which must
   * not show env or defaults as the values in effect. Writes leave it off, so a broken document
   * can still be replaced.
   */
  strictReads = false,
  /** Added to the audit record of every change the manager saves (the bulk apply's ID). */
  auditMetadata?: Record<string, unknown>,
  options: {
    /** Never create or change a document: for a preview, which must leave no trace. */
    readOnly?: boolean;
    /**
     * Keep the values out of the audit record and the log: they name the keys changed and what was
     * done to each (`bulk_operations` of `auditMetadata` says set or clear), not before and after.
     */
    omitAuditValues?: boolean;
    identityMappingHistory?: {
      via: IdentityMappingLevelHistoryVia;
      bulkId?: string;
      expectedLatestHistoryId?: string;
    };
  } = {}
): SettingsManager {
  const actor = auditContext?.get('adminAuth');
  const bulkId =
    options.identityMappingHistory?.bulkId ??
    (typeof auditMetadata?.bulk_id === 'string' ? auditMetadata.bulk_id : undefined);
  const canonicalAdapter = canonicalSettings
    ? requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
    : null;
  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS ?? null,
    strictReads,
    // Tenants created before settings were written to SETTINGS keep their creation-time copy.
    legacyKv: env.AUTHRIM_CONFIG ?? null,
    canonicalStore: canonicalAdapter
      ? new DatabaseSettingsCanonicalStore(canonicalAdapter, Date.now, {
          env,
          adapter: canonicalAdapter,
        })
      : null,
    cacheTTL: 5000, // 5 seconds (as per plan)
    readOnly: options.readOnly === true,
    ...(canonicalSettings && actor?.userId
      ? {
          identityMappingHistory: {
            actorId: actor.userId,
            actorType: actor.actorType ?? 'human',
            via: options.identityMappingHistory?.via ?? (bulkId ? 'bulk_apply' : 'settings'),
            ...(bulkId ? { bulkId } : {}),
            expectedLatestHistoryId: options.identityMappingHistory?.expectedLatestHistoryId,
          },
        }
      : {}),
    auditCallback: async (event) => {
      const changedKeys = Object.keys(event.diff);
      const operations = (auditMetadata?.bulk_operations ?? {}) as Record<string, unknown>;
      const results = Object.fromEntries(
        changedKeys.map((key) => [key, operations[key] === 'clear' ? 'cleared' : 'applied'])
      );
      log.info('Settings change', {
        action: event.event,
        scope: event.scope,
        scopeId: event.scopeId,
        category: event.category,
        actor: event.actor,
        ...(options.omitAuditValues
          ? { changed_keys: changedKeys, results }
          : { diff: event.diff }),
      });
      if (auditContext) {
        try {
          await createAuditLogFromContext(
            auditContext as unknown as Parameters<typeof createAuditLogFromContext>[0],
            `settings.${event.event}`,
            'settings',
            `${event.scope}:${event.scopeId}:${event.category}`,
            {
              scope: event.scope,
              scope_id: event.scopeId,
              category: event.category,
              actor: event.actor,
              ...(options.omitAuditValues
                ? { changed_keys: changedKeys, results }
                : { diff: sanitizeObject(event.diff) }),
              ...(auditMetadata ? sanitizeObject(auditMetadata) : {}),
            }
          );
        } catch {
          log.warn('Failed to mirror settings update audit', {
            category: event.category,
            scope: event.scope,
            scopeId: event.scopeId,
          });
        }
      }
    },
  });

  // Register all known categories
  for (const [, categoryMeta] of Object.entries(ALL_CATEGORY_META)) {
    manager.registerCategory(categoryMeta);
  }

  return manager;
}

export async function recordSettingsAuditFailure(
  c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>,
  input: {
    category: CategoryName;
    scope: SettingScope;
    reason: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const scopeId =
    'id' in input.scope && typeof input.scope.id === 'string' ? input.scope.id : 'platform';
  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'settings.patch.failure',
      'settings',
      `${input.scope.type}:${scopeId}:${input.category}`,
      {
        scope: input.scope.type,
        scope_id: scopeId,
        category: input.category,
        result: 'failure',
        reason: input.reason,
        ...(input.metadata ? sanitizeObject(input.metadata) : {}),
      },
      'warning'
    );
  } catch {
    log.warn('Failed to mirror settings failure audit', {
      category: input.category,
      scope: input.scope.type,
      reason: input.reason,
    });
  }
}

/** Persistent record of the external plugins a turn-off of `plugin.enabled` switched off. */
export async function recordExternalPluginShutdownAudit(
  c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>,
  input: {
    scope: SettingScope;
    stopped: readonly string[];
    outcome: 'success' | 'failure';
    /** The plugin whose switch-off failed; null when none is to blame (the listing failed). */
    failedPluginId: string | null;
  }
): Promise<void> {
  const scopeId =
    'id' in input.scope && typeof input.scope.id === 'string' ? input.scope.id : 'platform';
  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'settings.plugin.external_shutdown',
      'settings',
      `${input.scope.type}:${scopeId}:plugin`,
      {
        scope: input.scope.type,
        scope_id: scopeId,
        category: 'plugin',
        result: input.outcome,
        stopped_plugin_ids: [...input.stopped],
        ...(input.failedPluginId === null ? {} : { failed_plugin_id: input.failedPluginId }),
      },
      input.outcome === 'success' ? 'info' : 'warning'
    );
  } catch {
    log.warn('Failed to mirror the external plugin shutdown audit', {
      scope: input.scope.type,
      stoppedCount: input.stopped.length,
    });
  }
}

/**
 * Error response helper
 */
export function errorResponse(
  c: {
    json: (data: unknown, status: number) => Response;
  },
  error: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
) {
  return c.json({ error, message, ...details }, status);
}

export function settingsKVKey(category: string, scope: SettingScope): string {
  if (scope.type === 'platform') {
    return `settings:platform:${category}`;
  }
  if (scope.type === 'client') {
    return `settings:client:${scope.tenantId}:${scope.id}:${category}`;
  }
  return `settings:${scope.type}:${scope.id}:${category}`;
}

export async function invalidateAuthenticationMethodsCacheRevision(
  c: { env: Env },
  tenantId: string | null,
  reason: string
): Promise<void> {
  try {
    await bumpAuthenticationMethodsCacheRevision(c.env, tenantId);
  } catch (error) {
    log.warn('Failed to bump authentication methods cache revision', {
      tenantId: tenantId ?? 'global',
      reason,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

export async function readScopedSettingsRecord(
  env: Env,
  category: string,
  scope: SettingScope
): Promise<Record<string, unknown>> {
  try {
    const raw = await env.SETTINGS?.get(settingsKVKey(category, scope));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function selectedHumanVerificationProvider(settings: Record<string, unknown>): string {
  // The selection the API and the servers use (trimmed, blank means the default).
  const { pluginId } = humanVerificationSelectionFromSettings(settings);
  return BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(pluginId)
    ? pluginId
    : DEFAULT_HUMAN_VERIFICATION_PROVIDER;
}

export async function scheduleInheritedHumanVerificationProjection(
  env: Env,
  tenantId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Promise<void> {
  if (!env.SETTINGS) return;
  const providers = new Set([
    selectedHumanVerificationProvider(before),
    selectedHumanVerificationProvider(after),
  ]);
  for (const pluginId of providers) {
    const override = await env.SETTINGS.get(`plugins:config:${pluginId}:tenant:${tenantId}`);
    if (override === null) {
      await markGlobalProviderDesiredRevision(env, pluginId);
    }
  }
}

export async function ensureTenantAccountPageEnabled(
  manager: SettingsManager,
  tenantId: string,
  actor: string
): Promise<void> {
  const scope: SettingScope = { type: 'tenant', id: tenantId };
  const current = await manager.getAll('self-service', scope);
  if (current.values['self-service.account_page_enabled'] === true) {
    return;
  }
  await manager.patch(
    'self-service',
    scope,
    {
      ifMatch: current.version,
      set: {
        'self-service.account_page_enabled': true,
        'self-service.account_page_path':
          typeof current.values['self-service.account_page_path'] === 'string'
            ? current.values['self-service.account_page_path']
            : '/account',
      },
    },
    actor
  );
}
