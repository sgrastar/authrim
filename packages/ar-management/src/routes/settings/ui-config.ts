/**
 * UI Configuration Admin API
 *
 * GET    /api/admin/settings/ui-config  - Get UI settings
 * PUT    /api/admin/settings/ui-config  - Update UI settings
 * DELETE /api/admin/settings/ui-config  - Clear UI override
 *
 * GET    /api/admin/settings/ui-routing  - Get UI routing settings
 * PUT    /api/admin/settings/ui-routing  - Update UI routing settings
 * DELETE /api/admin/settings/ui-routing  - Clear UI routing override
 *
 * UI configuration for login, consent, and other authentication screens.
 * Includes RBAC/policy-based routing configuration.
 *
 * Settings stored in SETTINGS KV under "system_settings" key:
 * {
 *   "ui": {
 *     "baseUrl": "https://login.example.com",
 *     "paths": {
 *       "login": "/login",
 *       "consent": "/consent",
 *       ...
 *     }
 *   },
 *   "routing": {
 *     "rolePathOverrides": { ... },
 *     "policyRedirects": [ ... ]
 *   }
 * }
 *
 * Security:
 * - baseUrl requires HTTPS (except localhost)
 * - baseUrl must be same-origin as ISSUER_URL or in ALLOWED_ORIGINS
 * - All configuration changes are audit logged
 */

import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  getUIConfig,
  getUIConfigSource,
  getUIRoutingConfig,
  DEFAULT_UI_PATHS,
  UI_PATH_METADATA,
  type UIConfig,
  type UIPathConfig,
  type UIRoutingConfig,
  type PolicyRedirectRule,
  validateUIBaseUrl,
  parseAllowedOriginsEnv,
  logUIConfigChange,
  logUIConfigValidationFailure,
  buildIssuerUrl,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

/**
 * Get admin auth context from request
 */
function getAdminAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).get('adminAuth') as AdminAuthContext | null;
}

type SettingSource = 'kv' | 'env' | 'none';

interface SystemSettings {
  ui?: Partial<UIConfig>;
  routing?: UIRoutingConfig;
  [key: string]: unknown;
}

/**
 * GET /api/admin/settings/ui-config
 * Get current UI configuration
 */
export async function getUIConfigHandler(c: Context<{ Bindings: Env }>) {
  const config = await getUIConfig(c.env);
  const source = await getUIConfigSource(c.env);

  return c.json({
    config: config || { baseUrl: null, paths: DEFAULT_UI_PATHS },
    source,
    defaults: DEFAULT_UI_PATHS,
    metadata: UI_PATH_METADATA,
  });
}

/**
 * PUT /api/admin/settings/ui-config
 * Update UI configuration
 *
 * Security validations:
 * - baseUrl: HTTPS required (except localhost)
 * - baseUrl: Must be same-origin as ISSUER_URL or in ALLOWED_ORIGINS
 * - All changes are audit logged
 */
export async function updateUIConfigHandler(c: Context<{ Bindings: Env }>) {
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;

  const body = await c.req.json<{
    baseUrl?: string | null;
    paths?: Partial<UIPathConfig>;
  }>();

  // Get existing settings for audit logging
  let systemSettings: SystemSettings = {};
  let existingBaseUrl: string | null = null;
  try {
    const existingJson = await c.env.SETTINGS?.get('system_settings');
    if (existingJson) {
      systemSettings = JSON.parse(existingJson);
      existingBaseUrl = systemSettings.ui?.baseUrl ?? null;
    }
  } catch {
    // Start fresh
  }

  // Validate baseUrl if provided (allow null to clear)
  if (body.baseUrl !== undefined) {
    if (body.baseUrl !== null && body.baseUrl !== '') {
      // Security validation: HTTPS + Domain whitelist
      const allowedOrigins = parseAllowedOriginsEnv(c.env.ALLOWED_ORIGINS);
      const issuerUrl = buildIssuerUrl(c.env, getTenantIdFromContext(c));
      const validation = validateUIBaseUrl(body.baseUrl, issuerUrl, allowedOrigins);

      if (!validation.valid) {
        // Log the rejection for security audit
        logUIConfigValidationFailure(adminId, body.baseUrl, validation.error || 'Unknown error');

        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid baseUrl: ${validation.error}`,
          },
          400
        );
      }

      // Log the successful change
      logUIConfigChange('update', adminId, {
        field: 'baseUrl',
        oldValue: existingBaseUrl,
        newValue: body.baseUrl,
        validationResult: validation,
      });
    } else {
      // baseUrl is being cleared (null or empty string)
      logUIConfigChange('update', adminId, {
        field: 'baseUrl',
        oldValue: existingBaseUrl,
        newValue: null,
      });
    }
  }

  // Validate paths if provided
  if (body.paths) {
    for (const [key, value] of Object.entries(body.paths)) {
      if (typeof value !== 'string' || !value.startsWith('/')) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid path for ${key}: must be a string starting with /`,
          },
          400
        );
      }
    }

    // Log path changes
    logUIConfigChange('update', adminId, {
      field: 'paths',
      oldValue: JSON.stringify(systemSettings.ui?.paths ?? {}),
      newValue: JSON.stringify(body.paths),
    });
  }

  // Merge UI settings
  // Handle baseUrl: empty string or null means clear it (use undefined to omit)
  const newBaseUrl = body.baseUrl === '' || body.baseUrl === null ? undefined : body.baseUrl;
  systemSettings.ui = {
    ...systemSettings.ui,
    ...(newBaseUrl !== undefined ? { baseUrl: newBaseUrl } : {}),
    paths: { ...systemSettings.ui?.paths, ...body.paths } as UIPathConfig,
  };

  // If baseUrl is being cleared, remove it from the config
  if (body.baseUrl === '' || body.baseUrl === null) {
    delete (systemSettings.ui as Partial<UIConfig> & { baseUrl?: string }).baseUrl;
  }

  // Save to KV
  await c.env.SETTINGS?.put('system_settings', JSON.stringify(systemSettings));

  return c.json({
    success: true,
    config: systemSettings.ui,
  });
}

/**
 * DELETE /api/admin/settings/ui-config
 * Clear UI configuration override (fall back to env)
 *
 * All changes are audit logged
 */
export async function deleteUIConfigHandler(c: Context<{ Bindings: Env }>) {
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;

  // Get existing settings
  let systemSettings: SystemSettings = {};
  let existingConfig: Partial<UIConfig> | undefined;
  try {
    const existingJson = await c.env.SETTINGS?.get('system_settings');
    if (existingJson) {
      systemSettings = JSON.parse(existingJson);
      existingConfig = systemSettings.ui;
    }
  } catch {
    // Ignore
  }

  // Log the deletion
  logUIConfigChange('delete', adminId, {
    field: 'ui',
    oldValue: JSON.stringify(existingConfig ?? {}),
    newValue: null,
  });

  // Remove UI settings
  delete systemSettings.ui;

  // Save back to KV
  await c.env.SETTINGS?.put('system_settings', JSON.stringify(systemSettings));

  return c.json({
    success: true,
    message: 'UI configuration cleared. Will fall back to environment variable.',
  });
}

/**
 * GET /api/admin/settings/ui-routing
 * Get current UI routing configuration
 */
export async function getUIRoutingHandler(c: Context<{ Bindings: Env }>) {
  const routing = await getUIRoutingConfig(c.env);

  return c.json({
    routing: routing || { rolePathOverrides: {}, policyRedirects: [] },
  });
}

/**
 * PUT /api/admin/settings/ui-routing
 * Update UI routing configuration
 *
 * All changes are audit logged
 */
export async function updateUIRoutingHandler(c: Context<{ Bindings: Env }>) {
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;

  const body = await c.req.json<{
    rolePathOverrides?: Record<string, Partial<UIPathConfig>>;
    policyRedirects?: PolicyRedirectRule[];
  }>();

  // Validate rolePathOverrides if provided
  if (body.rolePathOverrides) {
    for (const [role, paths] of Object.entries(body.rolePathOverrides)) {
      if (typeof role !== 'string' || role.length === 0) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Role name must be a non-empty string',
          },
          400
        );
      }
      for (const [key, value] of Object.entries(paths)) {
        if (typeof value !== 'string' || !value.startsWith('/')) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: `Invalid path for role ${role}.${key}: must be a string starting with /`,
            },
            400
          );
        }
      }
    }
  }

  // Validate policyRedirects if provided
  if (body.policyRedirects) {
    for (const [index, rule] of body.policyRedirects.entries()) {
      if (!Array.isArray(rule.conditions)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Policy redirect rule ${index}: conditions must be an array`,
          },
          400
        );
      }
      if (typeof rule.redirectPath !== 'string' || !rule.redirectPath.startsWith('/')) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Policy redirect rule ${index}: redirectPath must be a string starting with /`,
          },
          400
        );
      }
    }
  }

  // Get existing settings
  let systemSettings: SystemSettings = {};
  let existingRouting: UIRoutingConfig | undefined;
  try {
    const existingJson = await c.env.SETTINGS?.get('system_settings');
    if (existingJson) {
      systemSettings = JSON.parse(existingJson);
      existingRouting = systemSettings.routing;
    }
  } catch {
    // Start fresh
  }

  // Log the change
  logUIConfigChange('update', adminId, {
    field: 'routing',
    oldValue: JSON.stringify(existingRouting ?? {}),
    newValue: JSON.stringify(body),
  });

  // Merge routing settings
  systemSettings.routing = {
    ...systemSettings.routing,
    ...body,
  };

  // Save to KV
  await c.env.SETTINGS?.put('system_settings', JSON.stringify(systemSettings));

  return c.json({
    success: true,
    routing: systemSettings.routing,
  });
}

/**
 * DELETE /api/admin/settings/ui-routing
 * Clear UI routing configuration
 *
 * All changes are audit logged
 */
export async function deleteUIRoutingHandler(c: Context<{ Bindings: Env }>) {
  const adminAuth = getAdminAuth(c);
  const adminId = adminAuth?.userId ?? adminAuth?.authMethod;

  // Get existing settings
  let systemSettings: SystemSettings = {};
  let existingRouting: UIRoutingConfig | undefined;
  try {
    const existingJson = await c.env.SETTINGS?.get('system_settings');
    if (existingJson) {
      systemSettings = JSON.parse(existingJson);
      existingRouting = systemSettings.routing;
    }
  } catch {
    // Ignore
  }

  // Log the deletion
  logUIConfigChange('delete', adminId, {
    field: 'routing',
    oldValue: JSON.stringify(existingRouting ?? {}),
    newValue: null,
  });

  // Remove routing settings
  delete systemSettings.routing;

  // Save back to KV
  await c.env.SETTINGS?.put('system_settings', JSON.stringify(systemSettings));

  return c.json({
    success: true,
    message: 'UI routing configuration cleared.',
  });
}
