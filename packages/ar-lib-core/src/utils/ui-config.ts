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
import {
  resolveEffectiveSettingsWithSources,
  resolvePlatformSettingsWithSources,
} from '../services/effective-settings';
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
  device: 'tenant.ui_device_path',
  deviceAuthorize: 'tenant.ui_device_authorize_path',
  logoutComplete: 'tenant.ui_logout_complete_path',
  loggedOut: 'tenant.ui_logged_out_path',
  register: 'tenant.ui_register_path',
} as const satisfies Record<keyof UIPathConfig, string>;

export const TENANT_UI_KEYS: readonly string[] = [
  'tenant.ui_base_url',
  ...Object.values(TENANT_UI_PATH_KEYS),
];

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
  tenantId: string,
  /** strict: a domain lookup that fails throws, instead of allowing nothing more. */
  options: { strict?: boolean } = {}
): Promise<UIUrlValidationResult> {
  const result = validateTenantUIBaseUrl(value, env, tenantId);
  if (result.valid || value.trim() === '' || value !== value.trim()) return result;
  let origin: string;
  try {
    origin = new URL(value).origin.toLowerCase();
  } catch {
    return result;
  }
  const lookup = getPrimaryTenantVanityDomain(env as Partial<Env>, tenantId, options);
  const primary = options.strict ? await lookup : await lookup.catch(() => null);
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
 * Priority: the tenant's Settings API values (`tenant.ui_*`) > the platform's > env.UI_URL > null
 *
 * Security: saved values are validated when set via Admin API, and again here (they can also
 * arrive through imports); one that is not valid is skipped.
 * Environment variable UI_URL is trusted but warned if suspicious (defense in depth).
 *
 * @param env Environment bindings
 * @param tenantId The tenant whose sign-in UI is wanted (without one: the platform's)
 * @returns UI configuration or null if not configured
 */
export async function getUIConfig(
  env: UIConfigEnv,
  tenantId?: string,
  options?: UIConfigReadOptions
): Promise<UIConfig | null> {
  return (await getTenantUIConfig(env, tenantId, options)).config;
}

/** How the UI configuration is read. */
export interface UIConfigReadOptions {
  /**
   * Let settings that cannot be read fail the read, instead of falling back as the login
   * redirects do: for admin views, which do not show a UI that may be configured as unset.
   */
  strict?: boolean;
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
  tenantId?: string,
  options: UIConfigReadOptions = {}
): Promise<TenantUIConfig> {
  const { config: platform, paths: platformPaths } = await applyPlatformUISettings(
    uiUrlConfig(env),
    env,
    options
  );
  const platformOnly = (): TenantUIConfig => ({
    config: platform,
    tenantBaseUrl: false,
    paths: platformPaths,
  });
  if (!tenantId) return platformOnly();
  let tenantValues: Record<string, unknown>;
  try {
    // The platform's values were applied above; only the tenant's own values are wanted here.
    const { values, sources } = await resolveEffectiveSettingsWithSources(env, 'tenant', {
      tenantId,
    });
    tenantValues = Object.fromEntries(
      TENANT_UI_KEYS.filter((key) => sources[key] === 'kv').map((key) => [key, values[key]])
    );
  } catch (error) {
    if (options.strict) throw error;
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
      ? await validateTenantUIBaseUrlAsync(tenantBase, env, tenantId, options)
      : undefined;
  return applyTenantUISettings(platform, tenantValues, env, tenantId, baseUrlCheck, platformPaths);
}

/**
 * The platform's UI configuration with the values set for the whole platform through the
 * Settings API (`tenant.ui_*` at the platform), which go before UI_URL: its base URL when it is
 * an allowed UI origin (as the Admin API requires), and its paths that stay on the UI's host.
 * Values that cannot be read leave UI_URL (unless `strict`).
 */
async function applyPlatformUISettings(
  platform: UIConfig | null,
  env: UIConfigEnv,
  options: UIConfigReadOptions = {}
): Promise<{ config: UIConfig | null; paths: UIPathConfig }> {
  const unchanged = { config: platform, paths: platform?.paths ?? DEFAULT_UI_PATHS };
  let values: Record<string, unknown>;
  try {
    const resolved = await resolvePlatformSettingsWithSources(env, 'tenant');
    values = Object.fromEntries(
      TENANT_UI_KEYS.filter((key) => resolved.sources[key] === 'kv').map((key) => [
        key,
        resolved.values[key],
      ])
    );
  } catch (error) {
    if (options.strict) throw error;
    log.warn('Platform UI settings could not be read; using UI_URL');
    return unchanged;
  }
  if (Object.keys(values).length === 0) return unchanged;
  let baseUrl = platform?.baseUrl;
  const base = values['tenant.ui_base_url'];
  if (typeof base === 'string' && base !== '') {
    const validation = validateUIBaseUrl(
      base,
      env.ISSUER_URL,
      parseAllowedOriginsEnv(env.ALLOWED_ORIGINS)
    );
    if (validation.valid) baseUrl = normalizeUrl(base);
    else log.warn('Platform UI base URL is not an allowed UI origin; ignoring it');
  }
  const paths: UIPathConfig = { ...(platform?.paths ?? DEFAULT_UI_PATHS) };
  for (const [name, key] of Object.entries(TENANT_UI_PATH_KEYS) as Array<
    [keyof typeof TENANT_UI_PATH_KEYS, string]
  >) {
    const path = values[key];
    if (path === undefined) continue;
    if (isValidUIPath(path)) paths[name] = path;
    else log.warn('Platform UI path is not valid; using the default path', { key });
  }
  // Paths alone do not give the platform a UI when none is configured.
  return { config: baseUrl ? { baseUrl, paths } : null, paths };
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
  baseUrlCheck?: UIUrlValidationResult,
  /** The platform's paths, also when it has no UI configured. */
  platformPaths: UIPathConfig = platform?.paths ?? DEFAULT_UI_PATHS
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
  const paths: UIPathConfig = { ...platformPaths };
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

/** The platform's UI configuration before the Settings API values: UI_URL with the default paths. */
function uiUrlConfig(
  env: Partial<Pick<Env, 'UI_URL' | 'ISSUER_URL' | 'ALLOWED_ORIGINS'>>
): UIConfig | null {
  // UI_URL is trusted, but warned about when it does not look like an allowed UI origin.
  if (env.UI_URL) {
    if (!uiUrlWarningLogged) {
      const validation = validateUIBaseUrl(
        env.UI_URL,
        env.ISSUER_URL,
        parseAllowedOriginsEnv(env.ALLOWED_ORIGINS)
      );
      if (!validation.valid) {
        log.warn('UI_URL environment variable may be misconfigured - this is a warning only', {
          error: validation.error,
          url: env.UI_URL,
        });
        uiUrlWarningLogged = true;
      }
    }
    return { baseUrl: normalizeUrl(env.UI_URL), paths: DEFAULT_UI_PATHS };
  }
  return null;
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
