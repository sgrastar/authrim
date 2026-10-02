/**
 * The older settings stores, read as Settings API values for the one-time import.
 *
 * Before the Settings API, several settings were kept in stores of their own (AUTHRIM_CONFIG
 * `oauth:config:*`, SETTINGS `system_settings`, a tenant's certification profile, and others),
 * written by the older `/api/admin/settings/*` endpoints. Runtime no longer reads them: the import
 * (`legacy-settings-import.ts`) copies what they hold into the Settings API. This module reads
 * them under the Settings API keys, as runtime used to read them. Only values an admin explicitly
 * saved are returned; a store that cannot be read fails the read.
 */

import { createLogger } from '../utils/logger';
import {
  RATE_LIMIT_PROFILE_SETTING_NAMES,
  rateLimitProfileKeys,
  type RateLimitProfileName,
} from '../types/settings/rate-limit';
import {
  LOGOUT_CONFIG_SETTING_KEYS,
  LOGOUT_WEBHOOK_SETTING_KEYS,
  readLegacyLogoutSettings,
  readLegacyLogoutWebhookSettings,
} from '../utils/logout-settings';
import {
  LEGACY_UNSET,
  SYSTEM_SETTINGS_FIELDS,
  systemSettingsFieldSections,
  systemSettingsFieldValues,
} from '../utils/system-settings-fields';
import { parseSettingsDocument } from '../utils/tenant-settings';
import { NO_JIT_PROVIDER } from '../types/settings/external-idp';
import { CHECK_API_AUDIT_DEFAULTS } from '../types/settings/check-api-audit';
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
  STATE_EXPIRY: { key: 'oauth.state_expiry', type: 'number' },
  NONCE_EXPIRY: { key: 'oauth.nonce_expiry', type: 'number' },
  MAX_CODES_PER_USER: { key: 'oauth.max_codes_per_user', type: 'number' },
};

/** AUTHRIM_CONFIG error settings (the older `/api/admin/settings/error-*`), with their values. */
const ERROR_CONFIG: Record<string, { key: string; values: readonly string[] }> = {
  error_response_format: {
    key: 'oauth.error_response_format',
    values: ['oauth', 'problem_details'],
  },
  error_id_mode: { key: 'oauth.error_id_mode', values: ['all', '5xx', 'security_only', 'none'] },
  error_locale: { key: 'oauth.error_locale', values: ['en', 'ja'] },
};

/** Parse a stored value the way the older config manager did. */
function parseLegacyValue(raw: string, type: LegacyValue['type']): unknown {
  if (type === 'boolean') return raw.toLowerCase() === 'true' || raw === '1';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Read older config values one by one. One that cannot be read fails the read. */
async function readConfigValues(
  kv: KVNamespace | undefined,
  names: string[],
  parse: (name: string, raw: string) => readonly [string, unknown] | null
): Promise<Record<string, unknown>> {
  if (!kv) return {};
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const raw = await kv.get(name);
        return raw === null ? null : parse(name, raw);
      } catch (error) {
        log.warn('Legacy config value could not be read', { name });
        throw error;
      }
    })
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

function readOAuthConfig(kv: KVNamespace | undefined) {
  return readConfigValues(
    kv,
    Object.keys(OAUTH_CONFIG).map((name) => `oauth:config:${name}`),
    (name, raw) => {
      const target = OAUTH_CONFIG[name.slice('oauth:config:'.length)];
      const value = parseLegacyValue(raw, target.type);
      return value === undefined ? null : ([target.key, value] as const);
    }
  );
}

function readErrorConfig(kv: KVNamespace | undefined) {
  return readConfigValues(kv, Object.keys(ERROR_CONFIG), (name, raw) => {
    const target = ERROR_CONFIG[name];
    // The error middleware ignores a value it does not know.
    return target.values.includes(raw) ? ([target.key, raw] as const) : null;
  });
}

/**
 * The fields of one category from the older `system_settings` documents, in Settings API form:
 * the global document with a tenant's certification-profile overlay (null without one) on top.
 * The keys whose values come from the overlay are added to `tenantKeys`: every field of a
 * section the overlay replaces, one it leaves out as `LEGACY_UNSET` (runtime reads the section
 * without it, so only env and the default apply). Platform-only settings (such as conformance
 * mode) come from the global document alone, never from a tenant's profile.
 */
function systemSettingsDocumentValues(
  global: Record<string, unknown> | null,
  tenant: Record<string, unknown> | null,
  category: string,
  tenantKeys: Set<string>
): Record<string, unknown> {
  if (!tenant) return systemSettingsFieldValues(global, category);
  const values = systemSettingsFieldValues({ ...(global ?? {}), ...tenant }, category);
  for (const field of SYSTEM_SETTINGS_FIELDS) {
    if (
      field.category !== category ||
      !systemSettingsFieldSections(field).some((section) => section in tenant)
    ) {
      continue;
    }
    tenantKeys.add(field.key);
    if (!(field.key in values)) values[field.key] = LEGACY_UNSET;
  }
  const settings =
    (ALL_CATEGORY_META as Record<string, CategoryMeta | undefined>)[category]?.settings ?? {};
  const platformOnly = Object.keys(settings).filter(
    (key) => settings[key].scopes?.includes('tenant') === false
  );
  if (platformOnly.length === 0) return values;
  const globalValues = systemSettingsFieldValues(global, category);
  for (const key of platformOnly) {
    tenantKeys.delete(key);
    if (key in globalValues) values[key] = globalValues[key];
    else delete values[key];
  }
  return values;
}

/**
 * The platform-wide `system_settings` document's fields in Settings API form for one category.
 * Throws when the document cannot be read or parsed.
 */
async function readSystemSettings(
  env: LegacySettingsEnv,
  category: string
): Promise<Record<string, unknown>> {
  if (!env.SETTINGS) return {};
  return systemSettingsFieldValues(
    parseSettingsDocument(await env.SETTINGS.get('system_settings')),
    category
  );
}

/** The UI paths with Settings API keys, by `system_settings.ui.paths` name. */
const UI_PATH_KEYS: Record<string, string> = {
  login: 'tenant.ui_login_path',
  consent: 'tenant.ui_consent_path',
  reauth: 'tenant.ui_reauth_path',
  error: 'tenant.ui_error_path',
  device: 'tenant.ui_device_path',
  deviceAuthorize: 'tenant.ui_device_authorize_path',
  logoutComplete: 'tenant.ui_logout_complete_path',
  loggedOut: 'tenant.ui_logged_out_path',
  register: 'tenant.ui_register_path',
};

/**
 * The platform's `system_settings.ui` (the older ui-config API), as the login redirects use it:
 * its base URL, and its paths only together with that base URL (with UI_URL alone, the default
 * paths apply). Throws when the document cannot be read (admin views then answer 503).
 */
async function readUiSettings(env: LegacySettingsEnv): Promise<Record<string, unknown>> {
  const document = await readSystemSettingsDocument(env, 'UI');
  const ui = document?.ui as { baseUrl?: unknown; paths?: Record<string, unknown> } | undefined;
  if (typeof ui?.baseUrl !== 'string' || ui.baseUrl === '') return {};
  const values: Record<string, unknown> = { 'tenant.ui_base_url': ui.baseUrl.replace(/\/$/, '') };
  for (const [name, key] of Object.entries(UI_PATH_KEYS)) {
    const path = ui.paths?.[name];
    if (typeof path === 'string') values[key] = path;
  }
  return values;
}

/** The global `system_settings` document (null when none); throws when it cannot be read. */
async function readSystemSettingsDocument(
  env: LegacySettingsEnv,
  what: string
): Promise<Record<string, unknown> | null> {
  if (!env.SETTINGS) return null;
  try {
    return parseSettingsDocument(await env.SETTINGS.get('system_settings'));
  } catch (error) {
    log.warn(`Legacy ${what} settings could not be read`);
    throw error;
  }
}

function sectionOf(
  document: Record<string, unknown> | null,
  name: string
): Record<string, unknown> {
  const section = document?.[name];
  return section && typeof section === 'object' && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : {};
}

const AUTHENTICATION_METHOD_USAGES = ['login', 'signup', 'reauth', 'account_link'] as const;

/**
 * `system_settings.advanced.passkeyEnabled` / `magicLinkEnabled`: what every tenant without its
 * own switches for passkeys and email codes used. Only values that differ from the Settings API
 * defaults (passkeys on, email codes off) are read; the methods are set per tenant, so the import
 * reports them for an administrator to set again.
 */
async function readAuthenticationMethodDefaults(
  env: LegacySettingsEnv
): Promise<Record<string, unknown>> {
  const advanced = sectionOf(
    await readSystemSettingsDocument(env, 'authentication method'),
    'advanced'
  );
  const values: Record<string, unknown> = {};
  for (const usage of AUTHENTICATION_METHOD_USAGES) {
    if (advanced.passkeyEnabled === false) {
      values[`authentication-methods.passkey.${usage}_enabled`] = false;
    }
    if (advanced.magicLinkEnabled === true) {
      values[`authentication-methods.email_otp.${usage}_enabled`] = true;
    }
  }
  return values;
}

/**
 * `system_settings.loginUI` and the site name and logo of `general`: the sign-in page of every
 * tenant while nothing else set one. Login UI is set per tenant, so the import reports them for an
 * administrator to set again.
 */
async function readLoginUiDefaults(env: LegacySettingsEnv): Promise<Record<string, unknown>> {
  const document = await readSystemSettingsDocument(env, 'Login UI');
  const loginUi = sectionOf(document, 'loginUI');
  const general = sectionOf(document, 'general');
  const values: Record<string, unknown> = {};
  if (loginUi.theme) values['login-ui.theme'] = loginUi.theme;
  if (loginUi.variant) values['login-ui.variant'] = loginUi.variant;
  if (loginUi.supportedLocales) values['login-ui.supported_locales'] = loginUi.supportedLocales;
  if (general.siteName) values['login-ui.brand_name'] = general.siteName;
  if (general.logoUrl) values['login-ui.logo_url'] = general.logoUrl;
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
  // The token-embedding API's switches, read by token issuance from SETTINGS.
  'policy:flags:ENABLE_CUSTOM_CLAIMS': 'feature.enable_custom_claims',
  'policy:flags:ENABLE_ID_LEVEL_PERMISSIONS': 'feature.enable_id_level_permissions',
};

/**
 * AUTHRIM_CONFIG keys the custom claim schemas read (no older API wrote them; the same flag name
 * in SETTINGS is the token claim rules' switch), and their Settings API keys.
 */
const CUSTOM_CLAIM_SCHEMA_KEYS: Record<string, string> = {
  'policy:flags:ENABLE_CUSTOM_CLAIMS': 'feature.enable_custom_claim_schemas',
  'policy:flags:ENABLE_CUSTOM_CLAIMS_INTROSPECTION':
    'feature.enable_custom_claim_schemas_introspection',
  'policy:flags:CUSTOM_CLAIMS_MAX_PER_TOKEN': 'limits.custom_claim_schemas_max_per_target',
};

/** The older custom claim schema values, read as the resolver read them. */
function readCustomClaimSchemaConfig(
  kv: KVNamespace | undefined,
  category: 'feature-flags' | 'limits'
) {
  const names = Object.keys(CUSTOM_CLAIM_SCHEMA_KEYS).filter(
    (name) => CUSTOM_CLAIM_SCHEMA_KEYS[name].startsWith('limits.') === (category === 'limits')
  );
  return readConfigValues(kv, names, (name, raw) => {
    const key = CUSTOM_CLAIM_SCHEMA_KEYS[name];
    if (category === 'feature-flags') {
      return [key, raw.toLowerCase() === 'true' || raw === '1'] as const;
    }
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? ([key, value] as const) : null;
  });
}

/** SETTINGS keys of the older token embedding limits, and their Settings API keys. */
const EMBEDDING_LIMIT_KEYS: Record<string, string> = {
  'config:max_embedded_permissions': 'limits.max_embedded_permissions',
  'config:max_resource_permissions': 'limits.max_resource_permissions',
  'config:max_custom_claims': 'limits.max_custom_claims',
};

/** A saved rate limit value as the rate limiter reads it: a positive integer, else unset. */
export function positiveRateLimitValue(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/** AUTHRIM_CONFIG keys of the older per-profile rate limits, by their Settings API keys. */
const RATE_LIMIT_LEGACY_KEYS: Record<string, string> = Object.fromEntries(
  (Object.keys(RATE_LIMIT_PROFILE_SETTING_NAMES) as RateLimitProfileName[]).flatMap((profile) => {
    const keys = rateLimitProfileKeys(profile);
    return [
      [keys.legacyMaxRequests, keys.maxRequests],
      [keys.legacyWindowSeconds, keys.windowSeconds],
    ];
  })
);

/** AUTHRIM_CONFIG per-profile rate limits (the older `/api/admin/settings/rate-limits/:profile`). */
function readRateLimitConfig(kv: KVNamespace | undefined) {
  return readConfigValues(kv, Object.keys(RATE_LIMIT_LEGACY_KEYS), (name, raw) => {
    const value = positiveRateLimitValue(raw);
    return value === undefined ? null : ([RATE_LIMIT_LEGACY_KEYS[name], value] as const);
  });
}

/** The on/off fields of the older JIT document the bridge tested for truth, by Settings API key. */
const JIT_SWITCHES: Record<string, string> = {
  require_verified_email: 'external_idp.jit_require_verified_email',
  join_all_matching_orgs: 'external_idp.jit_join_all_matching_orgs',
  allow_user_without_org: 'external_idp.jit_allow_user_without_org',
  allow_unverified_domain_mappings: 'external_idp.jit_allow_unverified_domain_mappings',
};

/** Every Settings API key the older JIT document holds. */
export const JIT_PROVISIONING_SETTING_KEYS: readonly string[] = [
  'external_idp.jit_provisioning_enabled',
  ...Object.values(JIT_SWITCHES),
  'external_idp.jit_default_role_id',
  'external_idp.jit_allowed_provider_ids',
];

/**
 * The Settings API values of a saved `jit_provisioning_config` document (raw, as read; null when
 * none is saved), as the bridge read them: it used the document as it is, not over the defaults,
 * so a field it leaves out counts as off (none for the role and the providers). `enabled` is false
 * unless it is `true`. A document that is not a JSON object turns JIT off and leaves the rest to
 * the defaults, as the bridge did.
 */
export function legacyJitProvisioningValues(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  let document: Record<string, unknown> | null = null;
  try {
    document = parseSettingsDocument(raw);
  } catch {
    // Saved but not a JSON object: JIT stays off.
  }
  const values: Record<string, unknown> = {
    'external_idp.jit_provisioning_enabled': document?.enabled === true,
  };
  if (!document) return values;
  for (const [field, key] of Object.entries(JIT_SWITCHES)) {
    values[key] = Boolean(document[field]);
  }
  const role = document.default_role_id;
  values['external_idp.jit_default_role_id'] = typeof role === 'string' ? role : '';
  // Provider IDs (UUIDs) as a comma-separated list, refusing at least what the bridge refused.
  // It refused every provider not in a non-empty list (`allowed_provider_ids.length > 0`):
  // - an array: matched entry by entry, exactly, so only entries that can name a provider as
  //   they are carry over (no surrounding space, no comma);
  // - a string: matched as a substring; as a list it allows no more;
  // - anything else with a length above 0 made the check fail, so no account was created.
  // A list that would be left with none refused every provider: NO_JIT_PROVIDER keeps it so,
  // whatever turns JIT on. Without a length above 0, every provider was allowed.
  const providers = document.allowed_provider_ids;
  const refusesSome =
    providers !== null &&
    providers !== undefined &&
    Number((providers as { length?: unknown }).length) > 0;
  let allowed = '';
  if (refusesSome) {
    const ids = Array.isArray(providers)
      ? providers.filter(
          (id): id is string =>
            typeof id === 'string' && id !== '' && id === id.trim() && !id.includes(',')
        )
      : typeof providers === 'string'
        ? providers
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [];
    allowed = ids.length > 0 ? ids.join(',') : NO_JIT_PROVIDER;
  }
  values['external_idp.jit_allowed_provider_ids'] = allowed;
  return values;
}

async function readJitProvisioningSettings(
  env: LegacySettingsEnv
): Promise<Record<string, unknown>> {
  if (!env.SETTINGS) return {};
  let raw: string | null;
  try {
    raw = await env.SETTINGS.get('jit_provisioning_config');
  } catch (error) {
    log.warn('Legacy JIT provisioning settings could not be read');
    throw error;
  }
  return legacyJitProvisioningValues(raw);
}

/** SETTINGS `settings:logout` (the older `/api/admin/settings/logout`). */
async function readLogoutSettings(env: LegacySettingsEnv): Promise<Record<string, unknown>> {
  try {
    return await readLegacyLogoutSettings(env.SETTINGS);
  } catch (error) {
    // As the logout handler did, runtime falls back to the environment and defaults.
    log.warn('Legacy logout settings could not be read');
    throw error;
  }
}

/** SETTINGS `settings:logout_webhook` (the older `/api/admin/settings/logout-webhook`). */
async function readLogoutWebhookSettings(env: LegacySettingsEnv): Promise<Record<string, unknown>> {
  try {
    return await readLegacyLogoutWebhookSettings(env.SETTINGS);
  } catch (error) {
    // As the logout handler did, runtime falls back to the defaults.
    log.warn('Legacy logout webhook settings could not be read');
    throw error;
  }
}

/** One older Check API audit value, as the Check API read it (see READERS). */
function checkApiAuditValue(name: string, raw: string): readonly [string, unknown] | null {
  switch (name) {
    case 'CHECK_API_AUDIT_ENABLED':
      return ['audit.check_api_enabled', raw === 'true'];
    case 'CHECK_API_AUDIT_MODE':
      return ['waitUntil', 'sync', 'queue'].includes(raw) ? ['audit.check_api_mode', raw] : null;
    case 'CHECK_API_AUDIT_LOG_ALLOW':
      return ['always', 'sample', 'never'].includes(raw)
        ? ['audit.check_api_log_allow', raw]
        : null;
    case 'CHECK_API_AUDIT_SAMPLE_RATE': {
      const rate = parseFloat(raw);
      return [
        'audit.check_api_sample_rate',
        !isNaN(rate) && rate >= 0 && rate <= 1
          ? rate
          : CHECK_API_AUDIT_DEFAULTS['audit.check_api_sample_rate'],
      ];
    }
    case 'CHECK_API_AUDIT_RETENTION_DAYS': {
      const days = parseInt(raw, 10);
      return [
        'audit.check_api_retention_days',
        !isNaN(days) && days > 0
          ? days
          : CHECK_API_AUDIT_DEFAULTS['audit.check_api_retention_days'],
      ];
    }
    default:
      return null;
  }
}

/** One older store behind a category, and the Settings API keys it can hold. */
interface LegacySource {
  /** Names the store in import reports. */
  id: string;
  keys: readonly string[];
  read: (env: LegacySettingsEnv) => Promise<Record<string, unknown>>;
}

function systemSettingsSource(category: string): LegacySource {
  return {
    id: `SETTINGS system_settings (${category})`,
    keys: SYSTEM_SETTINGS_FIELDS.filter((field) => field.category === category).map(
      (field) => field.key
    ),
    read: (env) => readSystemSettings(env, category),
  };
}

const READERS: Record<string, LegacySource[]> = {
  oauth: [
    systemSettingsSource('oauth'),
    {
      id: 'AUTHRIM_CONFIG oauth:config:*',
      keys: Object.values(OAUTH_CONFIG).map((target) => target.key),
      read: (env) => readOAuthConfig(env.AUTHRIM_CONFIG),
    },
    {
      id: 'AUTHRIM_CONFIG error_*',
      keys: Object.values(ERROR_CONFIG).map((target) => target.key),
      read: (env) => readErrorConfig(env.AUTHRIM_CONFIG),
    },
  ],
  security: [systemSettingsSource('security')],
  discovery: [systemSettingsSource('discovery')],
  tokens: [systemSettingsSource('tokens')],
  'feature-flags': [
    systemSettingsSource('feature-flags'),
    {
      // AUTHRIM_CONFIG CHECK_API_ENABLED (the older policy flags API wrote it there; no deployment
      // binds the policy service's own POLICY_FLAGS_KV), read as the Check API read it: saved, it
      // is on only as 'true'.
      id: 'AUTHRIM_CONFIG CHECK_API_ENABLED',
      keys: ['feature.enable_check_api'],
      read: (env) =>
        readConfigValues(
          env.AUTHRIM_CONFIG,
          ['CHECK_API_ENABLED'],
          (_name, raw) => ['feature.enable_check_api', raw === 'true'] as const
        ),
    },
    {
      id: 'AUTHRIM_CONFIG policy:flags:ENABLE_CUSTOM_CLAIMS*',
      keys: [
        'feature.enable_custom_claim_schemas',
        'feature.enable_custom_claim_schemas_introspection',
      ],
      read: (env) => readCustomClaimSchemaConfig(env.AUTHRIM_CONFIG, 'feature-flags'),
    },
    {
      // SETTINGS policy:flags:* (the older admin settings / policy flags / token-embedding APIs
      // write them), read as the policy code reads them: 'true' or '1' is on, anything else off.
      id: 'SETTINGS policy:flags:*',
      keys: Object.values(POLICY_FLAG_KEYS),
      read: (env) =>
        readConfigValues(
          env.SETTINGS,
          Object.keys(POLICY_FLAG_KEYS),
          (name, raw) =>
            [POLICY_FLAG_KEYS[name], raw.toLowerCase() === 'true' || raw === '1'] as const
        ),
    },
  ],
  'check-api-audit': [
    {
      // AUTHRIM_CONFIG CHECK_API_AUDIT_* (the older /api/admin/settings/check-api-audit), read as
      // the Check API read them: a saved switch is on only as 'true'; a mode or allow policy it
      // did not know left env to decide; a sample rate or retention it could not use kept the
      // default (not env).
      id: 'AUTHRIM_CONFIG CHECK_API_AUDIT_*',
      keys: [
        'audit.check_api_enabled',
        'audit.check_api_mode',
        'audit.check_api_log_allow',
        'audit.check_api_sample_rate',
        'audit.check_api_retention_days',
      ],
      read: (env) =>
        readConfigValues(
          env.AUTHRIM_CONFIG,
          [
            'CHECK_API_AUDIT_ENABLED',
            'CHECK_API_AUDIT_MODE',
            'CHECK_API_AUDIT_LOG_ALLOW',
            'CHECK_API_AUDIT_SAMPLE_RATE',
            'CHECK_API_AUDIT_RETENTION_DAYS',
          ],
          checkApiAuditValue
        ),
    },
  ],
  'authentication-methods': [
    {
      id: 'SETTINGS system_settings.advanced',
      keys: AUTHENTICATION_METHOD_USAGES.flatMap((usage) => [
        `authentication-methods.passkey.${usage}_enabled`,
        `authentication-methods.email_otp.${usage}_enabled`,
      ]),
      read: (env) => readAuthenticationMethodDefaults(env),
    },
  ],
  'login-ui': [
    {
      id: 'SETTINGS system_settings.loginUI',
      keys: [
        'login-ui.theme',
        'login-ui.variant',
        'login-ui.supported_locales',
        'login-ui.brand_name',
        'login-ui.logo_url',
      ],
      read: (env) => readLoginUiDefaults(env),
    },
  ],
  tenant: [
    {
      id: 'SETTINGS system_settings.ui',
      keys: ['tenant.ui_base_url', ...Object.values(UI_PATH_KEYS)],
      read: (env) => readUiSettings(env),
    },
  ],
  limits: [
    systemSettingsSource('limits'),
    {
      // AUTHRIM_CONFIG CHECK_API_BATCH_SIZE_LIMIT (as CHECK_API_ENABLED), read as the Check API
      // read it: a whole number in 1..1000, else unset.
      id: 'AUTHRIM_CONFIG CHECK_API_BATCH_SIZE_LIMIT',
      keys: ['limits.check_api_batch_size'],
      read: (env) =>
        readConfigValues(env.AUTHRIM_CONFIG, ['CHECK_API_BATCH_SIZE_LIMIT'], (_name, raw) => {
          const value = parseInt(raw, 10);
          return Number.isNaN(value) || value < 1 || value > 1000
            ? null
            : (['limits.check_api_batch_size', value] as const);
        }),
    },
    {
      id: 'AUTHRIM_CONFIG policy:flags:CUSTOM_CLAIMS_MAX_PER_TOKEN',
      keys: ['limits.custom_claim_schemas_max_per_target'],
      read: (env) => readCustomClaimSchemaConfig(env.AUTHRIM_CONFIG, 'limits'),
    },
    {
      // SETTINGS config:max_* (the older token-embedding API), read as token issuance reads them.
      id: 'SETTINGS config:max_*',
      keys: Object.values(EMBEDDING_LIMIT_KEYS),
      read: (env) =>
        readConfigValues(env.SETTINGS, Object.keys(EMBEDDING_LIMIT_KEYS), (name, raw) => {
          const value = positiveRateLimitValue(raw);
          return value === undefined ? null : ([EMBEDDING_LIMIT_KEYS[name], value] as const);
        }),
    },
  ],
  'external-idp': [
    {
      id: 'SETTINGS jit_provisioning_config',
      keys: JIT_PROVISIONING_SETTING_KEYS,
      read: (env) => readJitProvisioningSettings(env),
    },
  ],
  'rate-limit': [
    {
      id: 'AUTHRIM_CONFIG rate_limit_*',
      keys: Object.values(RATE_LIMIT_LEGACY_KEYS),
      read: (env) => readRateLimitConfig(env.AUTHRIM_CONFIG),
    },
  ],
  session: [
    {
      id: 'SETTINGS settings:logout',
      keys: LOGOUT_CONFIG_SETTING_KEYS,
      read: (env) => readLogoutSettings(env),
    },
    {
      id: 'SETTINGS settings:logout_webhook',
      keys: LOGOUT_WEBHOOK_SETTING_KEYS,
      read: (env) => readLogoutWebhookSettings(env),
    },
  ],
};

/** An older store, by the Settings API category its values belong to (for the one-time import). */
export interface LegacyStoreSource {
  id: string;
  category: string;
  keys: readonly string[];
}

/** Every older store the Settings API reads values from. */
export const LEGACY_STORE_SOURCES: readonly LegacyStoreSource[] = Object.entries(READERS).flatMap(
  ([category, sources]) => sources.map(({ id, keys }) => ({ id, category, keys }))
);

function sourceById(id: string): LegacySource {
  for (const sources of Object.values(READERS)) {
    const source = sources.find((candidate) => candidate.id === id);
    if (source) return source;
  }
  throw new Error(`Unknown legacy settings store: ${id}`);
}

/**
 * The platform-wide values one older store holds, as runtime reads them. Throws when the store
 * cannot be read, so a store that may hold values is never taken for an empty one.
 */
export async function readLegacyStore(
  env: LegacySettingsEnv,
  id: string
): Promise<Record<string, unknown>> {
  return sourceById(id).read(env);
}

/** The categories whose settings a tenant's certification profile can hold. */
export const TENANT_PROFILE_CATEGORIES: readonly string[] = [
  ...new Set(SYSTEM_SETTINGS_FIELDS.map((field) => field.category)),
];

/**
 * The values a tenant's certification profile (its older `system_settings` overlay, as stored)
 * sets for one category, over the global document, as runtime reads them; a field a replaced
 * section leaves out is `LEGACY_UNSET` (only env and the default apply to it).
 */
export function tenantProfileValues(
  global: Record<string, unknown> | null,
  profile: Record<string, unknown>,
  category: string
): Record<string, unknown> {
  const tenantKeys = new Set<string>();
  const values = systemSettingsDocumentValues(global, profile, category, tenantKeys);
  return Object.fromEntries(Object.entries(values).filter(([key]) => tenantKeys.has(key)));
}
