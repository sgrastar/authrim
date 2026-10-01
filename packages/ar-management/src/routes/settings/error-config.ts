/**
 * Error Configuration Settings API
 *
 * Allows dynamic configuration of error handling via KV
 * without requiring redeployment.
 *
 * KV Keys:
 * - error_locale: Error message locale (en/ja)
 * - error_response_format: Response format (oauth/problem_details)
 * - error_id_mode: Error ID generation mode (all/5xx/security_only/none)
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import {
  getTenantIdFromContext,
  resolveEffectiveSettingsWithSources,
  type Env,
} from '@authrim/ar-lib-core';
import type { ErrorLocale, ErrorIdMode, ErrorResponseFormat } from '@authrim/ar-lib-core';
import { SettingsUnavailableError, settingsUnavailableResponse } from './settings-unavailable';

// KV key constants
const KV_KEY_LOCALE = 'error_locale';
const KV_KEY_RESPONSE_FORMAT = 'error_response_format';
const KV_KEY_ERROR_ID_MODE = 'error_id_mode';

// Valid values
const VALID_LOCALES: ErrorLocale[] = ['en', 'ja'];
const VALID_RESPONSE_FORMATS: ErrorResponseFormat[] = ['oauth', 'problem_details'];
const VALID_ERROR_ID_MODES: ErrorIdMode[] = ['all', '5xx', 'security_only', 'none'];

// Default values
const DEFAULT_LOCALE: ErrorLocale = 'en';
const DEFAULT_RESPONSE_FORMAT: ErrorResponseFormat = 'oauth';
// What deployed workers use when nothing is set (the error middleware's production default).
const DEFAULT_ERROR_ID_MODE: ErrorIdMode = 'security_only';

type DisplaySource = 'kv' | 'env' | 'default';

/**
 * The response format and error ID mode the request's tenant gets, as the error middleware
 * resolves them: its Settings API values, else the values saved here, else env, else defaults.
 * Throws SettingsUnavailableError (503) when they cannot be read: while they cannot, runtime
 * falls back to its defaults, so no stored value is the one in effect.
 */
async function effectiveErrorSettings(c: Context<{ Bindings: Env }>): Promise<{
  format: { value: string | null; source: DisplaySource };
  mode: { value: string | null; source: DisplaySource };
}> {
  const shown = (value: unknown, source: string | undefined, allowed: readonly string[]) =>
    source && source !== 'default' && typeof value === 'string' && allowed.includes(value)
      ? { value, source: (source === 'env' ? 'env' : 'kv') as DisplaySource }
      : { value: null, source: 'default' as DisplaySource };
  try {
    const { values, sources } = await resolveEffectiveSettingsWithSources(c.env, 'oauth', {
      tenantId: getTenantIdFromContext(c),
      freshLegacy: true,
      // The stores the error middleware reads for these settings, and no others.
      keys: ['oauth.error_response_format', 'oauth.error_id_mode'],
    });
    return {
      format: shown(
        values['oauth.error_response_format'],
        sources['oauth.error_response_format'],
        VALID_RESPONSE_FORMATS
      ),
      mode: shown(
        values['oauth.error_id_mode'],
        sources['oauth.error_id_mode'],
        VALID_ERROR_ID_MODES
      ),
    };
  } catch (error) {
    throw new SettingsUnavailableError(error);
  }
}

/**
 * GET /api/admin/settings/error-config
 * Get all error configuration settings
 */
export async function getErrorConfig(c: Context<{ Bindings: Env }>) {
  let locale: string | null = null;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      locale = await c.env.AUTHRIM_CONFIG.get(KV_KEY_LOCALE);
    } catch {
      // KV read error - use defaults
    }
  }
  let effective: Awaited<ReturnType<typeof effectiveErrorSettings>>;
  try {
    effective = await effectiveErrorSettings(c);
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    throw error;
  }
  const { format: responseFormat, mode: errorIdMode } = effective;

  return c.json({
    locale: {
      current: locale ?? DEFAULT_LOCALE,
      source: locale ? 'kv' : 'default',
      default: DEFAULT_LOCALE,
      valid_values: VALID_LOCALES,
      kv_key: KV_KEY_LOCALE,
    },
    response_format: {
      current: responseFormat.value ?? DEFAULT_RESPONSE_FORMAT,
      source: responseFormat.source,
      default: DEFAULT_RESPONSE_FORMAT,
      valid_values: VALID_RESPONSE_FORMATS,
      kv_key: KV_KEY_RESPONSE_FORMAT,
      note: 'OIDC core endpoints (/authorize, /token, /userinfo, etc.) always use OAuth format regardless of this setting',
    },
    error_id_mode: {
      current: errorIdMode.value ?? DEFAULT_ERROR_ID_MODE,
      source: errorIdMode.source,
      default: DEFAULT_ERROR_ID_MODE,
      valid_values: VALID_ERROR_ID_MODES,
      kv_key: KV_KEY_ERROR_ID_MODE,
      description: {
        all: 'Generate error_id for all errors',
        '5xx': 'Generate error_id only for 5xx errors',
        security_only: 'Generate error_id only for security-tracked errors (default)',
        none: 'Never generate error_id',
      },
    },
    cache_ttl_seconds: 60,
    note: 'Changes take effect within a minute (cache TTL). Response format and error ID mode set per tenant through the Settings API take precedence over the values here.',
  });
}

// ============================================
// Locale Settings
// ============================================

/**
 * GET /api/admin/settings/error-locale
 * Get current error message locale
 */
export async function getErrorLocale(c: Context<{ Bindings: Env }>) {
  let locale: string | null = null;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      locale = await c.env.AUTHRIM_CONFIG.get(KV_KEY_LOCALE);
    } catch {
      // KV read error - use default
    }
  }

  return c.json({
    locale: locale ?? DEFAULT_LOCALE,
    source: locale ? 'kv' : 'default',
    default: DEFAULT_LOCALE,
    available_locales: VALID_LOCALES,
    kv_key: KV_KEY_LOCALE,
  });
}

/**
 * PUT /api/admin/settings/error-locale
 * Update error message locale
 */
export async function updateErrorLocale(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<{ locale: string }>();
  const { locale } = body;

  if (!locale) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'locale is required',
      },
      400
    );
  }

  if (!VALID_LOCALES.includes(locale as ErrorLocale)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid locale. Valid locales: ${VALID_LOCALES.join(', ')}`,
      },
      400
    );
  }

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_LOCALE, locale);

  return c.json({
    success: true,
    locale,
    kv_key: KV_KEY_LOCALE,
    note: 'Changes will take effect within 10 seconds (cache TTL)',
  });
}

/**
 * DELETE /api/admin/settings/error-locale
 * Reset locale to default
 */
export async function resetErrorLocale(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  await c.env.AUTHRIM_CONFIG.delete(KV_KEY_LOCALE);

  return c.json({
    success: true,
    reset_to_default: DEFAULT_LOCALE,
    note: 'Locale reset to default. Changes will take effect within 10 seconds.',
  });
}

// ============================================
// Response Format Settings
// ============================================

/**
 * GET /api/admin/settings/error-response-format
 * Get current error response format
 */
export async function getErrorResponseFormat(c: Context<{ Bindings: Env }>) {
  let effective: Awaited<ReturnType<typeof effectiveErrorSettings>>;
  try {
    effective = await effectiveErrorSettings(c);
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    throw error;
  }
  const { format } = effective;

  return c.json({
    response_format: format.value ?? DEFAULT_RESPONSE_FORMAT,
    source: format.source,
    default: DEFAULT_RESPONSE_FORMAT,
    valid_values: VALID_RESPONSE_FORMATS,
    kv_key: KV_KEY_RESPONSE_FORMAT,
    oidc_core_endpoints: ['/authorize', '/token', '/userinfo', '/introspect', '/revoke'],
    note: 'OIDC core endpoints always use OAuth format. This setting affects non-OIDC endpoints only.',
  });
}

/**
 * PUT /api/admin/settings/error-response-format
 * Update error response format
 */
export async function updateErrorResponseFormat(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<{ format: string }>();
  const { format } = body;

  if (!format) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'format is required',
      },
      400
    );
  }

  if (!VALID_RESPONSE_FORMATS.includes(format as ErrorResponseFormat)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid format. Valid formats: ${VALID_RESPONSE_FORMATS.join(', ')}`,
      },
      400
    );
  }

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_RESPONSE_FORMAT, format);

  return c.json({
    success: true,
    response_format: format,
    kv_key: KV_KEY_RESPONSE_FORMAT,
    note:
      format === 'problem_details'
        ? 'Non-OIDC endpoints will now return RFC 9457 Problem Details format. OIDC core endpoints remain OAuth format.'
        : 'All endpoints will use OAuth error format.',
  });
}

/**
 * DELETE /api/admin/settings/error-response-format
 * Reset response format to default
 */
export async function resetErrorResponseFormat(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  await c.env.AUTHRIM_CONFIG.delete(KV_KEY_RESPONSE_FORMAT);

  return c.json({
    success: true,
    reset_to_default: DEFAULT_RESPONSE_FORMAT,
    note: 'Response format reset to default. Changes will take effect within a minute.',
  });
}

// ============================================
// Error ID Mode Settings
// ============================================

/**
 * GET /api/admin/settings/error-id-mode
 * Get current error ID generation mode
 */
export async function getErrorIdMode(c: Context<{ Bindings: Env }>) {
  let effective: Awaited<ReturnType<typeof effectiveErrorSettings>>;
  try {
    effective = await effectiveErrorSettings(c);
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    throw error;
  }
  const { mode } = effective;

  return c.json({
    error_id_mode: mode.value ?? DEFAULT_ERROR_ID_MODE,
    source: mode.source,
    default: DEFAULT_ERROR_ID_MODE,
    valid_values: VALID_ERROR_ID_MODES,
    kv_key: KV_KEY_ERROR_ID_MODE,
    description: {
      all: 'Generate error_id for all errors - useful for debugging',
      '5xx': 'Generate error_id only for server errors (5xx)',
      security_only:
        'Generate error_id only for security-tracked errors (invalid_client, invalid_grant, etc.) - default',
      none: 'Never generate error_id - minimal response size',
    },
    security_tracked_errors: [
      'invalid_client',
      'invalid_grant',
      'unauthorized_client',
      'access_denied',
      'client/authentication-failed',
      'user/invalid-credentials',
      'user/locked',
      'token/reuse-detected',
      'rate-limit/exceeded',
      'policy/invalid-api-key',
      'admin/authentication-required',
    ],
  });
}

/**
 * PUT /api/admin/settings/error-id-mode
 * Update error ID generation mode
 */
export async function updateErrorIdMode(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<{ mode: string }>();
  const { mode } = body;

  if (!mode) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'mode is required',
      },
      400
    );
  }

  if (!VALID_ERROR_ID_MODES.includes(mode as ErrorIdMode)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid mode. Valid modes: ${VALID_ERROR_ID_MODES.join(', ')}`,
      },
      400
    );
  }

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ERROR_ID_MODE, mode);

  const modeDescriptions: Record<ErrorIdMode, string> = {
    all: 'All errors will now include error_id for debugging.',
    '5xx': 'Only server errors (5xx) will include error_id.',
    security_only: 'Only security-tracked errors will include error_id.',
    none: 'No errors will include error_id.',
  };

  return c.json({
    success: true,
    error_id_mode: mode,
    kv_key: KV_KEY_ERROR_ID_MODE,
    note: modeDescriptions[mode as ErrorIdMode],
  });
}

/**
 * DELETE /api/admin/settings/error-id-mode
 * Reset error ID mode to default
 */
export async function resetErrorIdMode(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  await c.env.AUTHRIM_CONFIG.delete(KV_KEY_ERROR_ID_MODE);

  return c.json({
    success: true,
    reset_to_default: DEFAULT_ERROR_ID_MODE,
    note: 'Error ID mode reset to default. Changes will take effect within a minute.',
  });
}
