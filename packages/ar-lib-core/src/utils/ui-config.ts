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
 */

import type { Env } from '../types/env';

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
  register: '/register',
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

/**
 * Get UI configuration
 * Priority: KV (system_settings.ui) > env.UI_URL > null
 *
 * @param env Environment bindings
 * @returns UI configuration or null if not configured
 */
export async function getUIConfig(
  env: Partial<Pick<Env, 'SETTINGS' | 'UI_URL'>>
): Promise<UIConfig | null> {
  // 1. Try KV first
  if (env.SETTINGS) {
    try {
      const settings = await env.SETTINGS.get('system_settings');
      if (settings) {
        const parsed = JSON.parse(settings) as { ui?: Partial<UIConfig> };
        if (parsed.ui?.baseUrl) {
          return {
            baseUrl: normalizeUrl(parsed.ui.baseUrl),
            paths: { ...DEFAULT_UI_PATHS, ...parsed.ui.paths },
          };
        }
      }
    } catch {
      // Fall through to environment variable
    }
  }

  // 2. Try environment variable
  if (env.UI_URL) {
    return {
      baseUrl: normalizeUrl(env.UI_URL),
      paths: DEFAULT_UI_PATHS,
    };
  }

  // 3. Not configured
  return null;
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
