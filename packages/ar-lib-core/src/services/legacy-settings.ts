/**
 * Legacy settings stores, read as Settings API values.
 *
 * Before the Settings API, several settings were kept in platform-wide stores of their own
 * (AUTHRIM_CONFIG `oauth:config:*`, SETTINGS `system_settings`, and others), written by the
 * older `/api/admin/settings/*` endpoints. Those values still apply. This module reads them
 * under the Settings API keys, so settings resolution can place them below every Settings API
 * scope (tenant and client values win) and above environment variables and defaults, exactly
 * where the older code applied them.
 *
 * Only values an admin explicitly saved are returned; environment variables and defaults are
 * resolved by the Settings API itself, from the same variables.
 */

import { createLogger } from '../utils/logger';
import { readLegacyLogoutSettings } from '../utils/logout-settings';
import {
  SYSTEM_SETTINGS_FIELDS,
  systemSettingsFieldValues,
} from '../utils/system-settings-overrides';
import { getTenantSystemSettingsBase, parseSettingsDocument } from '../utils/tenant-settings';
import { ALL_CATEGORY_META } from '../types/settings/catalog';
import type { CategoryMeta } from '../utils/settings-manager';

const log = createLogger().module('LEGACY_SETTINGS');

export interface LegacySettingsEnv {
  AUTHRIM_CONFIG?: KVNamespace;
  SETTINGS?: KVNamespace;
}

type LegacyValue = { key: string; type: 'number' | 'boolean' };

/** AUTHRIM_CONFIG `oauth:config:<name>` (the older `/api/admin/settings/oauth-config`). */
const OAUTH_CONFIG: Record<string, LegacyValue> = {
  TOKEN_EXPIRY: { key: 'oauth.access_token_expiry', type: 'number' },
  REFRESH_TOKEN_EXPIRY: { key: 'oauth.refresh_token_expiry', type: 'number' },
  AUTH_CODE_TTL: { key: 'oauth.auth_code_ttl', type: 'number' },
  STATE_REQUIRED: { key: 'oauth.state_required', type: 'boolean' },
  USERINFO_REQUIRE_OPENID_SCOPE: { key: 'oauth.userinfo_require_openid', type: 'boolean' },
};

/** AUTHRIM_CONFIG error settings (the older `/api/admin/settings/error-*`), with their values. */
const ERROR_CONFIG: Record<string, { key: string; values: readonly string[] }> = {
  error_response_format: {
    key: 'oauth.error_response_format',
    values: ['oauth', 'problem_details'],
  },
  error_id_mode: { key: 'oauth.error_id_mode', values: ['all', '5xx', 'security_only', 'none'] },
};

/** Parse a stored value the way the older config manager did. */
function parseLegacyValue(raw: string, type: LegacyValue['type']): unknown {
  if (type === 'boolean') return raw.toLowerCase() === 'true' || raw === '1';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Read AUTHRIM_CONFIG values one by one. A value that cannot be read is skipped at runtime, as the
 * older code fell back to env or defaults; with `strict` (admin views) the failure propagates, so
 * a value that may be saved is never shown as unset.
 */
async function readConfigValues(
  kv: KVNamespace | undefined,
  names: string[],
  parse: (name: string, raw: string) => readonly [string, unknown] | null,
  context: LegacyReadContext
): Promise<Record<string, unknown>> {
  if (!kv) return {};
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const raw = await kv.get(name);
        return raw === null ? null : parse(name, raw);
      } catch (error) {
        log.warn('Legacy config value could not be read', { name });
        if (context.strict) throw error;
        context.failed = true;
        return null;
      }
    })
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

function readOAuthConfig(kv: KVNamespace | undefined, context: LegacyReadContext) {
  return readConfigValues(
    kv,
    Object.keys(OAUTH_CONFIG).map((name) => `oauth:config:${name}`),
    (name, raw) => {
      const target = OAUTH_CONFIG[name.slice('oauth:config:'.length)];
      const value = parseLegacyValue(raw, target.type);
      return value === undefined ? null : ([target.key, value] as const);
    },
    context
  );
}

function readErrorConfig(kv: KVNamespace | undefined, context: LegacyReadContext) {
  return readConfigValues(
    kv,
    Object.keys(ERROR_CONFIG),
    (name, raw) => {
      const target = ERROR_CONFIG[name];
      // The error middleware ignores a value it does not know.
      return target.values.includes(raw) ? ([target.key, raw] as const) : null;
    },
    context
  );
}

/**
 * The older `system_settings` document for a tenant (with its certification-profile overlay), or
 * the platform-wide one without a tenant; its fields in Settings API form for one category.
 * Throws when the document cannot be read or parsed.
 */
async function readSystemSettings(
  env: LegacySettingsEnv,
  category: string,
  tenantId: string | undefined
): Promise<Record<string, unknown>> {
  const kv = env.SETTINGS;
  if (!kv) return {};
  try {
    const readGlobal = async () => parseSettingsDocument(await kv.get('system_settings'));
    if (!tenantId) return systemSettingsFieldValues(await readGlobal(), category);
    const values = systemSettingsFieldValues(
      await getTenantSystemSettingsBase(kv, tenantId, { failOnError: true }),
      category
    );
    // Platform-only settings (such as conformance mode) are read by runtime from the global
    // document alone, never from a tenant's certification profile.
    const settings =
      (ALL_CATEGORY_META as Record<string, CategoryMeta | undefined>)[category]?.settings ?? {};
    const platformOnly = Object.keys(settings).filter(
      (key) => settings[key].scopes?.includes('tenant') === false
    );
    if (platformOnly.length === 0) return values;
    const global = systemSettingsFieldValues(await readGlobal(), category);
    for (const key of platformOnly) {
      if (key in global) values[key] = global[key];
      else delete values[key];
    }
    return values;
  } catch (error) {
    // Runtime refuses security-relevant requests when this document cannot be read, so it must
    // not read as "nothing saved" (which would show env or defaults as the effective values).
    log.warn('Legacy system settings could not be read', { category });
    throw error;
  }
}

/** The UI paths with Settings API keys, by `system_settings.ui.paths` name. */
const UI_PATH_KEYS: Record<string, string> = {
  login: 'tenant.ui_login_path',
  consent: 'tenant.ui_consent_path',
  reauth: 'tenant.ui_reauth_path',
  error: 'tenant.ui_error_path',
};

/**
 * The platform's `system_settings.ui` (the older ui-config API), as the login redirects use it:
 * its base URL, and its paths only together with that base URL (with UI_URL alone, the default
 * paths apply). Throws when the document cannot be read (admin views then answer 503).
 */
async function readUiSettings(
  env: LegacySettingsEnv,
  context: LegacyReadContext
): Promise<Record<string, unknown>> {
  if (!env.SETTINGS) return {};
  let document: Record<string, unknown> | null;
  try {
    document = parseSettingsDocument(await env.SETTINGS.get('system_settings'));
  } catch (error) {
    log.warn('Legacy UI settings could not be read');
    if (context.strict) throw error;
    context.failed = true;
    return {};
  }
  const ui = document?.ui as { baseUrl?: unknown; paths?: Record<string, unknown> } | undefined;
  if (typeof ui?.baseUrl !== 'string' || ui.baseUrl === '') return {};
  const values: Record<string, unknown> = { 'tenant.ui_base_url': ui.baseUrl.replace(/\/$/, '') };
  for (const [name, key] of Object.entries(UI_PATH_KEYS)) {
    const path = ui.paths?.[name];
    if (typeof path === 'string') values[key] = path;
  }
  return values;
}

/** SETTINGS keys of the older policy flags, and their Settings API keys. */
export const POLICY_FLAG_KEYS: Record<string, string> = {
  'policy:flags:ENABLE_ABAC': 'feature.enable_abac',
  'policy:flags:ENABLE_REBAC': 'feature.enable_rebac',
  'policy:flags:ENABLE_POLICY_LOGGING': 'feature.enable_policy_logging',
  'policy:flags:ENABLE_VERIFIED_ATTRIBUTES': 'feature.enable_verified_attributes',
  'policy:flags:ENABLE_CUSTOM_RULES': 'feature.enable_custom_rules',
  'policy:flags:ENABLE_SD_JWT': 'feature.enable_sd_jwt',
  'policy:flags:ENABLE_POLICY_EMBEDDING': 'feature.enable_policy_embedding',
};

/** SETTINGS keys of the older token embedding limits, and their Settings API keys. */
const EMBEDDING_LIMIT_KEYS: Record<string, string> = {
  'config:max_embedded_permissions': 'limits.max_embedded_permissions',
  'config:max_resource_permissions': 'limits.max_resource_permissions',
  'config:max_custom_claims': 'limits.max_custom_claims',
};

/** The profiles with Settings API keys, and the window each has when nothing is saved. */
export const RATE_LIMIT_SETTING_PROFILES = ['strict', 'moderate', 'lenient'] as const;
const RATE_LIMIT_DEFAULT_WINDOW_SECONDS = 60;

/** The AUTHRIM_CONFIG keys of the profiles with Settings API keys. */
export const RATE_LIMIT_LEGACY_KEYS: readonly string[] = RATE_LIMIT_SETTING_PROFILES.flatMap(
  (profile) => [`rate_limit_${profile}_max_requests`, `rate_limit_${profile}_window_seconds`]
);

/** A saved rate limit value as the rate limiter reads it: a positive integer, else unset. */
export function positiveRateLimitValue(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/**
 * The Settings API values of the older per-profile values (raw, as read, by AUTHRIM_CONFIG key):
 * each profile's limit, and `rate_limit.window_ms` only when the three profiles end up with the
 * same window (otherwise each keeps its own and there is no single value).
 */
export function legacyRateLimitValues(
  raw: Record<string, string | null | undefined>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const windows: number[] = [];
  let anyWindowSaved = false;
  for (const profile of RATE_LIMIT_SETTING_PROFILES) {
    const max = positiveRateLimitValue(raw[`rate_limit_${profile}_max_requests`]);
    if (max !== undefined) values[`rate_limit.${profile}`] = max;
    const window = positiveRateLimitValue(raw[`rate_limit_${profile}_window_seconds`]);
    if (window !== undefined) anyWindowSaved = true;
    windows.push(window ?? RATE_LIMIT_DEFAULT_WINDOW_SECONDS);
  }
  if (anyWindowSaved && windows.every((window) => window === windows[0])) {
    values['rate_limit.window_ms'] = windows[0] * 1000;
  }
  return values;
}

/** AUTHRIM_CONFIG per-profile rate limits (the older `/api/admin/settings/rate-limit/:profile`). */
async function readRateLimitConfig(
  kv: KVNamespace | undefined,
  context: LegacyReadContext
): Promise<Record<string, unknown>> {
  const saved = await readConfigValues(
    kv,
    [...RATE_LIMIT_LEGACY_KEYS],
    (name, raw) => [name, raw] as const,
    context
  );
  return legacyRateLimitValues(saved as Record<string, string>);
}

/**
 * The Settings API value of a saved `jit_provisioning_config` document (raw, as read; null when
 * none is saved): its `enabled`, false when that is not `true` or the document is not a JSON
 * object, since the bridge then refuses JIT.
 */
export function legacyJitProvisioningValues(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  let document: Record<string, unknown> | null = null;
  try {
    document = parseSettingsDocument(raw);
  } catch {
    // Saved but not a JSON object: JIT stays off.
  }
  return { 'external_idp.jit_provisioning_enabled': document?.enabled === true };
}

async function readJitProvisioningSettings(
  env: LegacySettingsEnv,
  context: LegacyReadContext
): Promise<Record<string, unknown>> {
  if (!env.SETTINGS) return {};
  let raw: string | null;
  try {
    raw = await env.SETTINGS.get('jit_provisioning_config');
  } catch (error) {
    log.warn('Legacy JIT provisioning settings could not be read');
    if (context.strict) throw error;
    context.failed = true;
    return {};
  }
  return legacyJitProvisioningValues(raw);
}

/** SETTINGS `settings:logout` (the older `/api/admin/settings/logout`). */
async function readLogoutSettings(
  env: LegacySettingsEnv,
  context: LegacyReadContext
): Promise<Record<string, unknown>> {
  try {
    return await readLegacyLogoutSettings(env.SETTINGS);
  } catch (error) {
    // As the logout handler did, runtime falls back to the environment and defaults.
    log.warn('Legacy logout settings could not be read');
    if (context.strict) throw error;
    context.failed = true;
    return {};
  }
}

interface LegacyReadContext {
  tenantId: string | undefined;
  /** Let a store that cannot be read fail the read, instead of skipping its values. */
  strict: boolean;
  /** Set when a store was skipped: the result is then not cached. */
  failed: boolean;
}

/** One older store behind a category, and the Settings API keys it can hold. */
interface LegacySource {
  keys: readonly string[];
  read: (env: LegacySettingsEnv, context: LegacyReadContext) => Promise<Record<string, unknown>>;
}

function systemSettingsSource(category: string): LegacySource {
  return {
    keys: SYSTEM_SETTINGS_FIELDS.filter((field) => field.category === category).map(
      (field) => field.key
    ),
    read: (env, { tenantId }) => readSystemSettings(env, category, tenantId),
  };
}

const READERS: Record<string, LegacySource[]> = {
  oauth: [
    systemSettingsSource('oauth'),
    {
      keys: Object.values(OAUTH_CONFIG).map((target) => target.key),
      read: (env, context) => readOAuthConfig(env.AUTHRIM_CONFIG, context),
    },
    {
      keys: Object.values(ERROR_CONFIG).map((target) => target.key),
      read: (env, context) => readErrorConfig(env.AUTHRIM_CONFIG, context),
    },
  ],
  security: [systemSettingsSource('security')],
  tokens: [systemSettingsSource('tokens')],
  'feature-flags': [
    systemSettingsSource('feature-flags'),
    {
      // SETTINGS policy:flags:* (the older admin settings / policy flags / token-embedding APIs
      // write them), read as the policy code reads them: 'true' or '1' is on, anything else off.
      keys: Object.values(POLICY_FLAG_KEYS),
      read: (env, context) =>
        readConfigValues(
          env.SETTINGS,
          Object.keys(POLICY_FLAG_KEYS),
          (name, raw) =>
            [POLICY_FLAG_KEYS[name], raw.toLowerCase() === 'true' || raw === '1'] as const,
          context
        ),
    },
  ],
  tenant: [
    {
      keys: ['tenant.ui_base_url', ...Object.values(UI_PATH_KEYS)],
      read: (env, context) => readUiSettings(env, context),
    },
  ],
  limits: [
    {
      // SETTINGS config:max_* (the older token-embedding API), read as token issuance reads them.
      keys: Object.values(EMBEDDING_LIMIT_KEYS),
      read: (env, context) =>
        readConfigValues(
          env.SETTINGS,
          Object.keys(EMBEDDING_LIMIT_KEYS),
          (name, raw) => {
            const value = positiveRateLimitValue(raw);
            return value === undefined ? null : ([EMBEDDING_LIMIT_KEYS[name], value] as const);
          },
          context
        ),
    },
  ],
  'external-idp': [
    {
      keys: ['external_idp.jit_provisioning_enabled'],
      read: (env, context) => readJitProvisioningSettings(env, context),
    },
  ],
  'rate-limit': [
    {
      keys: [
        ...RATE_LIMIT_SETTING_PROFILES.map((profile) => `rate_limit.${profile}`),
        'rate_limit.window_ms',
      ],
      read: (env, context) => readRateLimitConfig(env.AUTHRIM_CONFIG, context),
    },
  ],
  session: [
    {
      keys: [
        'session.backchannel_logout_token_exp',
        'session.backchannel_request_timeout_ms',
        'session.backchannel_retry_max_attempts',
        'session.backchannel_retry_initial_delay_ms',
        'session.backchannel_retry_max_delay_ms',
        'session.backchannel_retry_backoff_multiplier',
        'session.backchannel_on_failure',
      ],
      read: (env, context) => readLogoutSettings(env, context),
    },
  ],
};

const CACHE_TTL_MS = 60_000;
const cache = new WeakMap<object, Map<string, { values: Record<string, unknown>; at: number }>>();

export interface LegacySettingsReadOptions {
  tenantId?: string;
  /** Read without the per-isolate cache (admin views show what was just saved). */
  fresh?: boolean;
  /**
   * Let a read failure of any older store propagate instead of skipping its values: for admin
   * views (a value that may be saved must not show as unset) and for runtime callers that keep
   * their own fallback. Defaults to `fresh`.
   */
  strict?: boolean;
  /** Only the stores that can hold these keys (default: every store of the category). */
  keys?: readonly string[];
}

/**
 * The values saved in the older stores for one Settings API category, keyed by setting key.
 * Cached per worker isolate for a minute (as the older config manager cached them) unless
 * `fresh` is set.
 */
export async function readLegacySettings(
  env: LegacySettingsEnv,
  category: string,
  options: LegacySettingsReadOptions = {}
): Promise<Record<string, unknown>> {
  const sources = (READERS[category] ?? []).filter(
    (source) => !options.keys || source.keys.some((key) => options.keys!.includes(key))
  );
  if (sources.length === 0) return {};
  const context: LegacyReadContext = {
    tenantId: options.tenantId,
    strict: options.strict ?? options.fresh === true,
    failed: false,
  };
  const read = async () => {
    const parts = await Promise.all(sources.map((source) => source.read(env, context)));
    return Object.assign({}, ...parts) as Record<string, unknown>;
  };
  // Admin reads show what was just saved; runtime reads use the cache.
  if (options.fresh) return read();
  const binding = (env.AUTHRIM_CONFIG ?? env.SETTINGS ?? env) as object;
  let byCategory = cache.get(binding);
  if (!byCategory) {
    byCategory = new Map();
    cache.set(binding, byCategory);
  }
  const cacheKey = `${category}:${options.tenantId ?? ''}:${options.keys?.join(',') ?? '*'}`;
  const cached = byCategory.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;
  const values = await read();
  // A result with a skipped store is not what is saved: read again next time.
  if (!context.failed) byCategory.set(cacheKey, { values, at: Date.now() });
  return values;
}

/** Categories with settings kept in an older store. */
export function hasLegacySettings(category: string): boolean {
  return category in READERS;
}
