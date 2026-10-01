/**
 * UI Configuration Manager
 *
 * Hybrid approach for managing UI configuration:
 * - Environment variables provide defaults (requires deploy to change)
 * - KV storage provides dynamic overrides (changes without deploy)
 *
 * Priority: KV > Environment variable > Default value
 *
 * Security Note:
 * UI_URL is admin-configured static value (not user input)
 * No open redirect vector - URL is set via env/KV by administrator
 *
 * Security Validation (Defense in Depth):
 * - Admin API validates baseUrl when setting via KV (strict, blocks invalid)
 * - Environment variable UI_URL is trusted but warned if suspicious
 * - See: ui-url-validator.ts for validation logic
 */

import type { Env } from '../types/env';
import { resolveEffectiveSettingsWithSources } from '../services/effective-settings';
import { buildIssuerUrl, type IssuerEnvLike } from './issuer';
import { getPrimaryTenantVanityDomain } from '../services/tenant-vanity-domain-resolver';
import {
  validateUIBaseUrl,
  parseAllowedOriginsEnv,
  type UIUrlValidationResult,
} from './ui-url-validator';
import { createLogger } from './logger';

const log = createLogger().module('UI_CONFIG');

/**
 * UI path configuration for various screens
 */
export interface UIPathConfig {
  /** Login page path */
  login: string;
  /** Consent page path */
  consent: string;
  /** Re-authentication page path */
  reauth: string;
  /** Error page path */
  error: string;
  /** Device flow verification page path */
  device: string;
  /** Device flow authorization page path */
  deviceAuthorize: string;
  /** Logout complete page path */
  logoutComplete: string;
  /** Logged out page path */
  loggedOut: string;
  /** Registration page path */
  register: string;
}

/**
 * UI configuration structure
 * Note: tenantMode is fixed to 'subdomain' - path/query modes are not supported
 */
export interface UIConfig {
  /** Base URL for the UI (e.g., https://login.example.com) */
  baseUrl: string;
  /** Path configuration for various screens */
  paths: UIPathConfig;
}

/**
 * Role-based UI path overrides
 */
export interface RoleBasedUIConfig {
  /** Role to path overrides mapping */
  rolePathOverrides: {
    [role: string]: Partial<UIPathConfig>;
  };
}

/**
 * Policy-based redirect rule condition
 */
export interface PolicyRedirectCondition {
  /** Field to evaluate */
  field: 'org_type' | 'user_type' | 'role' | 'plan' | 'email_domain_hash';
  /** Comparison operator */
  operator: 'eq' | 'ne' | 'in' | 'not_in' | 'contains';
  /** Value to compare against */
  value: string | string[];
}

/**
 * Policy-based redirect rule
 */
export interface PolicyRedirectRule {
  /** Conditions that must all be met */
  conditions: PolicyRedirectCondition[];
  /** Path to redirect to when conditions are met */
  redirectPath: string;
  /** Optional priority (higher = evaluated first) */
  priority?: number;
}

/**
 * UI routing configuration with RBAC/policy support
 */
export interface UIRoutingConfig {
  /** Role-based path overrides */
  rolePathOverrides?: RoleBasedUIConfig['rolePathOverrides'];
  /** Policy-based redirect rules */
  policyRedirects?: PolicyRedirectRule[];
}

/**
 * Full UI settings stored in KV
 */
export interface UISettings {
  /** Basic UI configuration */
  ui?: Partial<UIConfig>;
  /** Routing configuration */
  routing?: UIRoutingConfig;
}

/**
 * Default UI paths
 */
export const DEFAULT_UI_PATHS: UIPathConfig = {
  login: '/login',
  consent: '/consent',
  reauth: '/reauth',
  error: '/error',
  device: '/device',
  deviceAuthorize: '/device/authorize',
  logoutComplete: '/logout-complete',
  loggedOut: '/logged-out',
  register: '/signup',
};

/**
 * Configuration metadata for Admin UI
 */
export const UI_PATH_METADATA: Record<
  keyof UIPathConfig,
  {
    label: string;
    description: string;
  }
> = {
  login: {
    label: 'Login Page',
    description: 'Path to the login page',
  },
  consent: {
    label: 'Consent Page',
    description: 'Path to the OAuth consent page',
  },
  reauth: {
    label: 'Re-authentication Page',
    description: 'Path to the re-authentication page (prompt=login)',
  },
  error: {
    label: 'Error Page',
    description: 'Path to the error display page',
  },
  device: {
    label: 'Device Flow Page',
    description: 'Path to the device flow verification page',
  },
  deviceAuthorize: {
    label: 'Device Authorization Page',
    description: 'Path to the device flow authorization page',
  },
  logoutComplete: {
    label: 'Logout Complete Page',
    description: 'Path to display after logout completion',
  },
  loggedOut: {
    label: 'Logged Out Page',
    description: 'Path to display when user is logged out',
  },
  register: {
    label: 'Registration Page',
    description: 'Path to the user registration page',
  },
};

// Flag to track if UI_URL warning has been logged (avoid spam)
let uiUrlWarningLogged = false;

/** The UI paths a tenant can set through the Settings API, by path name. */
export const TENANT_UI_PATH_KEYS = {
  login: 'tenant.ui_login_path',
  consent: 'tenant.ui_consent_path',
  reauth: 'tenant.ui_reauth_path',
  error: 'tenant.ui_error_path',
} as const satisfies Partial<Record<keyof UIPathConfig, string>>;

const TENANT_UI_KEYS = ['tenant.ui_base_url', ...Object.values(TENANT_UI_PATH_KEYS)];

/**
 * A UI path that stays on the UI's host: it starts with one `/` (not `//` or `/\`, which a URL
 * resolves to another host) and has no whitespace, backslash, query or fragment.
 */
export function isValidUIPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^\/(?![/\\])[^\s\\?#]*$/.test(value);
}

type TenantUIEnv = Partial<IssuerEnvLike & Pick<Env, 'ISSUER_URL' | 'ALLOWED_ORIGINS'>>;

/**
 * Like validateTenantUIBaseUrl, and also the origin of the tenant's active primary custom domain
 * (its issuer when it has one). The domain is looked up only when the other origins do not
 * allow the URL; a lookup that fails allows nothing more.
 */
export async function validateTenantUIBaseUrlAsync(
  value: string,
  env: TenantUIEnv & Partial<Pick<Env, 'AUTHRIM_CONFIG' | 'DB'>>,
  tenantId: string
): Promise<UIUrlValidationResult> {
  const result = validateTenantUIBaseUrl(value, env, tenantId);
  if (result.valid || value.trim() === '' || value !== value.trim()) return result;
  let origin: string;
  try {
    origin = new URL(value).origin.toLowerCase();
  } catch {
    return result;
  }
  const primary = await getPrimaryTenantVanityDomain(env as Partial<Env>, tenantId).catch(
    () => null
  );
  if (!primary || origin !== `https://${primary.hostname}`.toLowerCase()) return result;
  return validateUIBaseUrl(value, env.ISSUER_URL, [
    ...parseAllowedOriginsEnv(env.ALLOWED_ORIGINS),
    origin,
  ]);
}

type UIConfigEnv = TenantUIEnv & Partial<Pick<Env, 'SETTINGS' | 'UI_URL' | 'AUTHRIM_CONFIG'>>;

/**
 * Whether a tenant's UI base URL is an allowed UI origin: the platform issuer's or the tenant's
 * own issuer origin, localhost, or one of ALLOWED_ORIGINS (as for the platform's UI).
 */
export function validateTenantUIBaseUrl(
  value: string,
  env: TenantUIEnv,
  tenantId: string
): UIUrlValidationResult {
  // Blank or padded values are not URLs (the shared validator treats blank as "not set").
  if (value.trim() === '' || value !== value.trim()) {
    return { valid: false, error: 'The UI base URL must not be blank or padded with spaces' };
  }
  const allowedOrigins = parseAllowedOriginsEnv(env.ALLOWED_ORIGINS);
  try {
    const tenantIssuer = buildIssuerUrl(env, tenantId);
    if (tenantIssuer) allowedOrigins.push(new URL(tenantIssuer).origin);
  } catch {
    // No issuer of its own (an id that cannot be a host name): the other origins only
  }
  return validateUIBaseUrl(value, env.ISSUER_URL, allowedOrigins);
}

/**
 * Get UI configuration
 * Priority: the tenant's Settings API values (`tenant.ui_*`) > KV (system_settings.ui) >
 * env.UI_URL > null
 *
 * Security: KV values are validated when set via Admin API. The tenant's values are validated
 * again here (they can also arrive through imports), and one that is not valid is skipped.
 * Environment variable UI_URL is trusted but warned if suspicious (defense in depth).
 *
 * @param env Environment bindings
 * @param tenantId The tenant whose sign-in UI is wanted (without one: the platform's)
 * @returns UI configuration or null if not configured
 */
export async function getUIConfig(env: UIConfigEnv, tenantId?: string): Promise<UIConfig | null> {
  return (await getTenantUIConfig(env, tenantId)).config;
}

/** The UI configuration for a tenant (see getTenantUIConfig). */
export interface TenantUIConfig {
  /** The UI to redirect to, or null when none is configured. */
  config: UIConfig | null;
  /**
   * Whether the base URL is the tenant's own (`tenant.ui_base_url`): an explicit choice that
   * callers put before a UI host they would otherwise pick themselves.
   */
  tenantBaseUrl: boolean;
  /** The UI paths, with the tenant's, also when no base URL is configured. */
  paths: UIPathConfig;
}

/** Like getUIConfig, with whether the base URL is the tenant's and the paths on their own. */
export async function getTenantUIConfig(
  env: UIConfigEnv,
  tenantId?: string
): Promise<TenantUIConfig> {
  let document: unknown = null;
  if (env.SETTINGS) {
    try {
      const settings = await env.SETTINGS.get('system_settings');
      document = settings ? JSON.parse(settings) : null;
    } catch {
      // Fall through to environment variable
    }
  }
  const platform = resolveUIConfig(document, env).config;
  const platformOnly = (): TenantUIConfig => ({
    config: platform,
    tenantBaseUrl: false,
    paths: platform?.paths ?? DEFAULT_UI_PATHS,
  });
  if (!tenantId) return platformOnly();
  let tenantValues: Record<string, unknown>;
  try {
    const { values, sources } = await resolveEffectiveSettingsWithSources(env, 'tenant', {
      tenantId,
      keys: TENANT_UI_KEYS,
      // The older store was read above; only the tenant's own values are wanted here.
      legacy: {},
    });
    tenantValues = Object.fromEntries(
      TENANT_UI_KEYS.filter((key) => sources[key] === 'kv').map((key) => [key, values[key]])
    );
  } catch {
    // As before tenants could set these: the platform's UI.
    log.warn('Tenant UI settings could not be read; using the platform UI settings', {
      tenantId,
    });
    return platformOnly();
  }
  // A base URL on the tenant's custom domain needs a lookup: made only for a value the other
  // origins do not allow.
  const tenantBase = tenantValues['tenant.ui_base_url'];
  const baseUrlCheck =
    typeof tenantBase === 'string' && tenantBase !== ''
      ? await validateTenantUIBaseUrlAsync(tenantBase, env, tenantId)
      : undefined;
  return applyTenantUISettings(platform, tenantValues, env, tenantId, baseUrlCheck);
}

/**
 * The platform's UI configuration with the values a tenant set: its base URL when it is an
 * allowed UI origin (as the Admin API requires), and its paths that stay on the UI's host.
 * Paths alone do not give a tenant a UI when none is configured.
 */
export function applyTenantUISettings(
  platform: UIConfig | null,
  tenantValues: Record<string, unknown>,
  env: TenantUIEnv,
  tenantId: string,
  /** The base URL's check, when made beforehand (such as with the custom domain lookup). */
  baseUrlCheck?: UIUrlValidationResult
): TenantUIConfig {
  let baseUrl = platform?.baseUrl;
  let fromTenant = false;
  const tenantBase = tenantValues['tenant.ui_base_url'];
  if (typeof tenantBase === 'string' && tenantBase !== '') {
    const validation = baseUrlCheck ?? validateTenantUIBaseUrl(tenantBase, env, tenantId);
    if (validation.valid) {
      baseUrl = normalizeUrl(tenantBase);
      fromTenant = true;
    } else {
      log.warn('Tenant UI base URL is not an allowed UI origin; using the platform UI', {
        tenantId,
        error: validation.error,
      });
    }
  }
  const paths: UIPathConfig = { ...(platform?.paths ?? DEFAULT_UI_PATHS) };
  for (const [name, key] of Object.entries(TENANT_UI_PATH_KEYS) as Array<
    [keyof typeof TENANT_UI_PATH_KEYS, string]
  >) {
    const path = tenantValues[key];
    if (path === undefined) continue;
    if (isValidUIPath(path)) paths[name] = path;
    else log.warn('Tenant UI path is not valid; using the platform path', { tenantId, key });
  }
  return {
    config: baseUrl ? { baseUrl, paths } : null,
    tenantBaseUrl: fromTenant,
    paths,
  };
}

/**
 * The UI configuration from a `system_settings` document (as read; null when none) and env:
 * the document's `ui` (already validated when set via Admin API) when it has a base URL, else
 * UI_URL with the default paths, else none. Admin views pass the document they read once, so
 * the configuration and its source come from the same read.
 */
export function resolveUIConfig(
  document: unknown,
  env: Partial<Pick<Env, 'UI_URL' | 'ISSUER_URL' | 'ALLOWED_ORIGINS'>>
): { config: UIConfig | null; source: 'kv' | 'env' | 'none' } {
  // 1. The saved document
  const ui =
    document && typeof document === 'object'
      ? (document as { ui?: Partial<UIConfig> }).ui
      : undefined;
  // A base URL that is not a non-empty string is unusable: as before, UI_URL or none applies.
  if (typeof ui?.baseUrl === 'string' && ui.baseUrl !== '') {
    return {
      config: { baseUrl: normalizeUrl(ui.baseUrl), paths: { ...DEFAULT_UI_PATHS, ...ui.paths } },
      source: 'kv',
    };
  }

  // 2. Try environment variable (trusted but validate for defense in depth)
  if (env.UI_URL) {
    // Defense in depth: warn if UI_URL doesn't pass validation
    // This helps catch misconfigurations during development/staging
    if (!uiUrlWarningLogged) {
      const allowedOrigins = parseAllowedOriginsEnv(env.ALLOWED_ORIGINS);
      const validation = validateUIBaseUrl(env.UI_URL, env.ISSUER_URL, allowedOrigins);
      if (!validation.valid) {
        log.warn('UI_URL environment variable may be misconfigured - this is a warning only', {
          error: validation.error,
          url: env.UI_URL,
        });
        uiUrlWarningLogged = true;
      }
    }

    return {
      config: { baseUrl: normalizeUrl(env.UI_URL), paths: DEFAULT_UI_PATHS },
      source: 'env',
    };
  }

  // 3. Not configured
  return { config: null, source: 'none' };
}

/**
 * Get UI routing configuration for RBAC/policy support
 *
 * @param env Environment bindings
 * @returns UI routing configuration
 */
export async function getUIRoutingConfig(
  env: Partial<Pick<Env, 'SETTINGS'>>
): Promise<UIRoutingConfig | null> {
  if (!env.SETTINGS) {
    return null;
  }

  try {
    const settings = await env.SETTINGS.get('system_settings');
    if (settings) {
      const parsed = JSON.parse(settings) as { routing?: UIRoutingConfig };
      return parsed.routing || null;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Get configuration source for debugging
 *
 * @param env Environment bindings
 * @returns Source of the configuration
 */
export async function getUIConfigSource(
  env: Partial<Pick<Env, 'SETTINGS' | 'UI_URL'>>
): Promise<'kv' | 'env' | 'none'> {
  // Check KV first
  if (env.SETTINGS) {
    try {
      const settings = await env.SETTINGS.get('system_settings');
      if (settings) {
        const parsed = JSON.parse(settings) as { ui?: Partial<UIConfig> };
        if (parsed.ui?.baseUrl) {
          return 'kv';
        }
      }
    } catch {
      // Fall through
    }
  }

  // Check environment variable
  if (env.UI_URL) {
    return 'env';
  }

  return 'none';
}

/**
 * Normalize URL by removing trailing slash
 */
function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Build a UI URL for a specific page
 *
 * @param config UI configuration
 * @param path Path key (e.g., 'login', 'consent')
 * @param params Query parameters to add
 * @param tenantHint Optional tenant hint for branding (UX only, not security)
 * @returns Full URL string
 */
export function buildUIUrl(
  config: UIConfig,
  path: keyof UIPathConfig,
  params?: Record<string, string>,
  tenantHint?: string
): string {
  const url = new URL(config.paths[path], config.baseUrl);

  // Add query parameters
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  // Add tenant_hint for UI branding (UX only, not for security decisions)
  if (tenantHint) {
    url.searchParams.set('tenant_hint', tenantHint);
  }

  return url.toString();
}

/**
 * Get path override for a specific role
 *
 * @param routingConfig UI routing configuration
 * @param roles User's roles
 * @param pathKey Path key to look up
 * @returns Overridden path or undefined if no override
 */
export function getRoleBasedPath(
  routingConfig: UIRoutingConfig | null,
  roles: string[],
  pathKey: keyof UIPathConfig
): string | undefined {
  if (!routingConfig?.rolePathOverrides) {
    return undefined;
  }

  // Check roles in order (first match wins)
  for (const role of roles) {
    const override = routingConfig.rolePathOverrides[role];
    if (override && override[pathKey]) {
      return override[pathKey];
    }
  }

  return undefined;
}

/**
 * Evaluate policy redirect rules
 *
 * @param routingConfig UI routing configuration
 * @param context Context for policy evaluation
 * @returns Redirect path if a rule matches, or undefined
 */
export function evaluatePolicyRedirect(
  routingConfig: UIRoutingConfig | null,
  context: {
    org_type?: string;
    user_type?: string;
    roles?: string[];
    plan?: string;
    email_domain_hash?: string;
  }
): string | undefined {
  if (!routingConfig?.policyRedirects || routingConfig.policyRedirects.length === 0) {
    return undefined;
  }

  // Sort by priority (descending)
  const sortedRules = [...routingConfig.policyRedirects].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
  );

  for (const rule of sortedRules) {
    if (evaluateConditions(rule.conditions, context)) {
      return rule.redirectPath;
    }
  }

  return undefined;
}

/**
 * Evaluate all conditions for a rule
 */
function evaluateConditions(
  conditions: PolicyRedirectCondition[],
  context: {
    org_type?: string;
    user_type?: string;
    roles?: string[];
    plan?: string;
    email_domain_hash?: string;
  }
): boolean {
  return conditions.every((condition) => evaluateCondition(condition, context));
}

/**
 * Evaluate a single condition
 */
function evaluateCondition(
  condition: PolicyRedirectCondition,
  context: {
    org_type?: string;
    user_type?: string;
    roles?: string[];
    plan?: string;
    email_domain_hash?: string;
  }
): boolean {
  let contextValue: string | string[] | undefined;

  switch (condition.field) {
    case 'org_type':
      contextValue = context.org_type;
      break;
    case 'user_type':
      contextValue = context.user_type;
      break;
    case 'role':
      contextValue = context.roles;
      break;
    case 'plan':
      contextValue = context.plan;
      break;
    case 'email_domain_hash':
      contextValue = context.email_domain_hash;
      break;
    default:
      return false;
  }

  if (contextValue === undefined) {
    return false;
  }

  const conditionValue = condition.value;

  switch (condition.operator) {
    case 'eq':
      if (Array.isArray(contextValue)) {
        return contextValue.includes(conditionValue as string);
      }
      return contextValue === conditionValue;

    case 'ne':
      if (Array.isArray(contextValue)) {
        return !contextValue.includes(conditionValue as string);
      }
      return contextValue !== conditionValue;

    case 'in':
      if (!Array.isArray(conditionValue)) {
        return false;
      }
      if (Array.isArray(contextValue)) {
        return contextValue.some((v) => conditionValue.includes(v));
      }
      return conditionValue.includes(contextValue);

    case 'not_in':
      if (!Array.isArray(conditionValue)) {
        return false;
      }
      if (Array.isArray(contextValue)) {
        return !contextValue.some((v) => conditionValue.includes(v));
      }
      return !conditionValue.includes(contextValue);

    case 'contains':
      if (Array.isArray(contextValue)) {
        return contextValue.some((v) => v.includes(conditionValue as string));
      }
      return contextValue.includes(conditionValue as string);

    default:
      return false;
  }
}

/**
 * Build UI URL with role/policy overrides applied
 *
 * @param env Environment bindings
 * @param pathKey Path key (e.g., 'login', 'consent')
 * @param params Query parameters
 * @param context Context for role/policy evaluation
 * @param tenantHint Optional tenant hint
 * @returns Full URL string or null if UI not configured
 */
export async function buildUIUrlWithOverrides(
  env: Partial<Pick<Env, 'SETTINGS' | 'UI_URL'>>,
  pathKey: keyof UIPathConfig,
  params?: Record<string, string>,
  context?: {
    roles?: string[];
    org_type?: string;
    user_type?: string;
    plan?: string;
    email_domain_hash?: string;
  },
  tenantHint?: string
): Promise<string | null> {
  const config = await getUIConfig(env);
  if (!config) {
    return null;
  }

  const routingConfig = await getUIRoutingConfig(env);

  // Check for role-based path override
  let finalPath = config.paths[pathKey];
  if (context?.roles && routingConfig) {
    const roleOverride = getRoleBasedPath(routingConfig, context.roles, pathKey);
    if (roleOverride) {
      finalPath = roleOverride;
    }
  }

  // Build URL with the (possibly overridden) path
  const url = new URL(finalPath, config.baseUrl);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  if (tenantHint) {
    url.searchParams.set('tenant_hint', tenantHint);
  }

  return url.toString();
}
