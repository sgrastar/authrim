/**
 * Logging Configuration Settings API
 *
 * Allows dynamic configuration of logging via KV
 * without requiring redeployment.
 *
 * KV Keys:
 * - log_level: Global log level (debug/info/warn/error)
 * - log_format: Log format (json/pretty)
 * - log_hash_user_id: Whether to hash user IDs in logs (true/false)
 * - log_tenant_override:{tenantId}: Per-tenant log level override
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { LogLevel, LogFormat } from '@authrim/ar-lib-core';

// KV key constants
const KV_KEY_LOG_LEVEL = 'log_level';
const KV_KEY_LOG_FORMAT = 'log_format';
const KV_KEY_LOG_HASH_USER_ID = 'log_hash_user_id';
const KV_KEY_TENANT_OVERRIDE_PREFIX = 'log_tenant_override:';

// Valid values
const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const VALID_LOG_FORMATS: LogFormat[] = ['json', 'pretty'];

// Default values
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_LOG_FORMAT: LogFormat = 'json';
const DEFAULT_LOG_HASH_USER_ID = true;

/**
 * GET /api/admin/settings/logging
 * Get all logging configuration settings
 */
export async function getLoggingConfig(c: Context<{ Bindings: Env }>) {
  let level: string | null = null;
  let format: string | null = null;
  let hashUserId: string | null = null;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      [level, format, hashUserId] = await Promise.all([
        c.env.AUTHRIM_CONFIG.get(KV_KEY_LOG_LEVEL),
        c.env.AUTHRIM_CONFIG.get(KV_KEY_LOG_FORMAT),
        c.env.AUTHRIM_CONFIG.get(KV_KEY_LOG_HASH_USER_ID),
      ]);
    } catch {
      // KV read error - use defaults
    }
  }

  // Get environment variable overrides
  const envLevel = c.env.LOG_LEVEL as string | undefined;
  const envFormat = c.env.LOG_FORMAT as string | undefined;
  const envHashUserId = c.env.LOG_HASH_USER_ID as string | undefined;

  return c.json({
    level: {
      current: level ?? envLevel ?? DEFAULT_LOG_LEVEL,
      source: level ? 'kv' : envLevel ? 'env' : 'default',
      kv_value: level,
      env_value: envLevel,
      default: DEFAULT_LOG_LEVEL,
      valid_values: VALID_LOG_LEVELS,
      kv_key: KV_KEY_LOG_LEVEL,
      description: {
        debug: 'Verbose output for development (includes all logs)',
        info: 'Standard operation logs (default for production)',
        warn: 'Warnings and errors only',
        error: 'Errors only',
      },
    },
    format: {
      current: format ?? envFormat ?? DEFAULT_LOG_FORMAT,
      source: format ? 'kv' : envFormat ? 'env' : 'default',
      kv_value: format,
      env_value: envFormat,
      default: DEFAULT_LOG_FORMAT,
      valid_values: VALID_LOG_FORMATS,
      kv_key: KV_KEY_LOG_FORMAT,
      description: {
        json: 'Structured JSON logs (recommended for production)',
        pretty: 'Human-readable logs (recommended for development)',
      },
    },
    hash_user_id: {
      current:
        hashUserId !== null
          ? hashUserId === 'true'
          : envHashUserId === 'true' || DEFAULT_LOG_HASH_USER_ID,
      source: hashUserId !== null ? 'kv' : envHashUserId !== undefined ? 'env' : 'default',
      kv_value: hashUserId,
      env_value: envHashUserId,
      default: DEFAULT_LOG_HASH_USER_ID,
      kv_key: KV_KEY_LOG_HASH_USER_ID,
      description:
        'When enabled, user IDs are hashed using HMAC-SHA256 before logging (privacy protection)',
    },
    priority: 'KV > Environment Variables > Default Values',
    cache_ttl_seconds: 10,
    note: 'Changes take effect within 10 seconds (cache TTL)',
  });
}

/**
 * PUT /api/admin/settings/logging
 * Update logging configuration
 */
export async function updateLoggingConfig(c: Context<{ Bindings: Env }>) {
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

  const body = await c.req.json<{
    level?: string;
    format?: string;
    hash_user_id?: boolean;
  }>();

  const updates: { key: string; value: string }[] = [];
  const errors: string[] = [];

  // Validate and queue updates
  if (body.level !== undefined) {
    if (!VALID_LOG_LEVELS.includes(body.level as LogLevel)) {
      errors.push(`Invalid level. Valid levels: ${VALID_LOG_LEVELS.join(', ')}`);
    } else {
      updates.push({ key: KV_KEY_LOG_LEVEL, value: body.level });
    }
  }

  if (body.format !== undefined) {
    if (!VALID_LOG_FORMATS.includes(body.format as LogFormat)) {
      errors.push(`Invalid format. Valid formats: ${VALID_LOG_FORMATS.join(', ')}`);
    } else {
      updates.push({ key: KV_KEY_LOG_FORMAT, value: body.format });
    }
  }

  if (body.hash_user_id !== undefined) {
    updates.push({ key: KV_KEY_LOG_HASH_USER_ID, value: String(body.hash_user_id) });
  }

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  if (updates.length === 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'No valid fields to update. Provide level, format, or hash_user_id.',
      },
      400
    );
  }

  // Apply updates
  await Promise.all(updates.map(({ key, value }) => c.env.AUTHRIM_CONFIG!.put(key, value)));

  return c.json({
    success: true,
    updated: updates.reduce(
      (acc, { key, value }) => {
        acc[key] = value;
        return acc;
      },
      {} as Record<string, string>
    ),
    note: 'Changes will take effect within 10 seconds (cache TTL)',
  });
}

/**
 * DELETE /api/admin/settings/logging
 * Reset all logging configuration to defaults
 */
export async function resetLoggingConfig(c: Context<{ Bindings: Env }>) {
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

  await Promise.all([
    c.env.AUTHRIM_CONFIG.delete(KV_KEY_LOG_LEVEL),
    c.env.AUTHRIM_CONFIG.delete(KV_KEY_LOG_FORMAT),
    c.env.AUTHRIM_CONFIG.delete(KV_KEY_LOG_HASH_USER_ID),
  ]);

  return c.json({
    success: true,
    reset_to_defaults: {
      level: DEFAULT_LOG_LEVEL,
      format: DEFAULT_LOG_FORMAT,
      hash_user_id: DEFAULT_LOG_HASH_USER_ID,
    },
    note: 'Logging configuration reset to defaults. Environment variables will take precedence if set.',
  });
}

// ============================================
// Per-Tenant Log Level Override
// ============================================

/**
 * GET /api/admin/settings/logging/tenant/:tenantId
 * Get logging configuration for a specific tenant
 */
export async function getTenantLoggingConfig(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  let globalLevel: string | null = null;
  let tenantLevel: string | null = null;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      [globalLevel, tenantLevel] = await Promise.all([
        c.env.AUTHRIM_CONFIG.get(KV_KEY_LOG_LEVEL),
        c.env.AUTHRIM_CONFIG.get(`${KV_KEY_TENANT_OVERRIDE_PREFIX}${tenantId}`),
      ]);
    } catch {
      // KV read error
    }
  }

  const envLevel = c.env.LOG_LEVEL as string | undefined;
  const effectiveGlobalLevel = globalLevel ?? envLevel ?? DEFAULT_LOG_LEVEL;

  return c.json({
    tenant_id: tenantId,
    level: {
      current: tenantLevel ?? effectiveGlobalLevel,
      source: tenantLevel
        ? 'tenant_override'
        : globalLevel
          ? 'global_kv'
          : envLevel
            ? 'env'
            : 'default',
      tenant_override: tenantLevel,
      global_level: effectiveGlobalLevel,
      valid_values: VALID_LOG_LEVELS,
      kv_key: `${KV_KEY_TENANT_OVERRIDE_PREFIX}${tenantId}`,
    },
    note: 'Tenant-specific log level overrides the global setting',
  });
}

/**
 * PUT /api/admin/settings/logging/tenant/:tenantId
 * Update logging configuration for a specific tenant
 */
export async function updateTenantLoggingConfig(c: Context<{ Bindings: Env }>) {
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

  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  const body = await c.req.json<{ level: string }>();
  const { level } = body;

  if (!level) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'level is required',
      },
      400
    );
  }

  if (!VALID_LOG_LEVELS.includes(level as LogLevel)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid level. Valid levels: ${VALID_LOG_LEVELS.join(', ')}`,
      },
      400
    );
  }

  const kvKey = `${KV_KEY_TENANT_OVERRIDE_PREFIX}${tenantId}`;
  await c.env.AUTHRIM_CONFIG.put(kvKey, level);

  return c.json({
    success: true,
    tenant_id: tenantId,
    level,
    kv_key: kvKey,
    note: 'Tenant log level override applied. Changes will take effect within 10 seconds.',
  });
}

/**
 * DELETE /api/admin/settings/logging/tenant/:tenantId
 * Remove tenant-specific logging override
 */
export async function resetTenantLoggingConfig(c: Context<{ Bindings: Env }>) {
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

  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  const kvKey = `${KV_KEY_TENANT_OVERRIDE_PREFIX}${tenantId}`;
  await c.env.AUTHRIM_CONFIG.delete(kvKey);

  return c.json({
    success: true,
    tenant_id: tenantId,
    note: 'Tenant log level override removed. Tenant will now use global log level.',
  });
}

/**
 * GET /api/admin/settings/logging/tenants
 * List all tenant-specific logging overrides
 */
export async function listTenantLoggingOverrides(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json({
      overrides: [],
      note: 'AUTHRIM_CONFIG KV namespace is not configured',
    });
  }

  try {
    // List all keys with the tenant override prefix
    const list = await c.env.AUTHRIM_CONFIG.list({ prefix: KV_KEY_TENANT_OVERRIDE_PREFIX });

    const overrides = await Promise.all(
      list.keys.map(async (key) => {
        const tenantId = key.name.replace(KV_KEY_TENANT_OVERRIDE_PREFIX, '');
        const level = await c.env.AUTHRIM_CONFIG!.get(key.name);
        return {
          tenant_id: tenantId,
          level: level ?? 'unknown',
        };
      })
    );

    return c.json({
      overrides,
      count: overrides.length,
    });
  } catch {
    return c.json({
      overrides: [],
      error: 'Failed to list tenant overrides',
    });
  }
}
