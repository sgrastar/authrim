/**
 * Check API Audit Settings Admin API
 *
 * Manages dynamic configuration for Check API audit logging.
 *
 * GET    /api/admin/settings/check-api-audit          - Get all audit settings
 * PUT    /api/admin/settings/check-api-audit/:name    - Update a specific setting
 * DELETE /api/admin/settings/check-api-audit/:name    - Clear a specific setting override
 *
 * Supported settings:
 * - CHECK_API_AUDIT_ENABLED (boolean): Enable/disable audit logging
 * - CHECK_API_AUDIT_MODE (string): waitUntil | sync | queue
 * - CHECK_API_AUDIT_LOG_ALLOW (string): always | sample | never
 * - CHECK_API_AUDIT_SAMPLE_RATE (number, 0-1): Sample rate for allow events
 * - CHECK_API_AUDIT_RETENTION_DAYS (number, 1-3650): Retention period in days
 *
 * @see CLAUDE.md: Settings and Feature Flags implementation policy
 */

import type { Context } from 'hono';
import { getLogger } from '@authrim/ar-lib-core';

/**
 * Audit setting metadata
 */
interface SettingMetadata {
  type: 'boolean' | 'number' | 'string';
  description: string;
  default: boolean | number | string;
  min?: number;
  max?: number;
  enum?: string[];
}

/**
 * Available audit settings
 */
const AUDIT_SETTINGS: Record<string, SettingMetadata> = {
  CHECK_API_AUDIT_ENABLED: {
    type: 'boolean',
    description: 'Enable or disable Check API audit logging',
    default: false,
  },
  CHECK_API_AUDIT_MODE: {
    type: 'string',
    description:
      'Audit log recording mode: waitUntil (non-blocking), sync (guaranteed), queue (high-scale)',
    default: 'waitUntil',
    enum: ['waitUntil', 'sync', 'queue'],
  },
  CHECK_API_AUDIT_LOG_ALLOW: {
    type: 'string',
    description: 'How to log allowed permission checks: always, sample, never',
    default: 'sample',
    enum: ['always', 'sample', 'never'],
  },
  CHECK_API_AUDIT_SAMPLE_RATE: {
    type: 'number',
    description: 'Sample rate for allow events (0.0-1.0, e.g., 0.01 = 1%)',
    default: 0.01,
    min: 0,
    max: 1,
  },
  CHECK_API_AUDIT_RETENTION_DAYS: {
    type: 'number',
    description: 'Number of days to retain audit logs',
    default: 90,
    min: 1,
    max: 3650,
  },
};

const AUDIT_SETTING_NAMES = Object.keys(AUDIT_SETTINGS) as (keyof typeof AUDIT_SETTINGS)[];

/**
 * GET /api/admin/settings/check-api-audit
 * Get all audit setting values with their sources
 */
export async function getCheckApiAuditSettings(c: Context) {
  const log = getLogger(c).module('CheckApiAuditAPI');
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  try {
    const settings: Record<
      string,
      {
        value: string | null;
        source: 'kv' | 'default';
        default: boolean | number | string;
        metadata: SettingMetadata;
      }
    > = {};

    for (const name of AUDIT_SETTING_NAMES) {
      const kvValue = await c.env.AUTHRIM_CONFIG.get(name);
      const metadata = AUDIT_SETTINGS[name];

      settings[name] = {
        value: kvValue,
        source: kvValue !== null ? 'kv' : 'default',
        default: metadata.default,
        metadata,
      };
    }

    return c.json({ settings });
  } catch (error) {
    log.error('Error getting audit settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get audit settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/check-api-audit/:name
 * Update a specific audit setting value (stored in KV)
 *
 * Request body:
 * { "value": boolean | number | string }
 */
export async function updateCheckApiAuditSetting(c: Context) {
  const log = getLogger(c).module('CheckApiAuditAPI');
  const name = c.req.param('name')!;

  // Validate setting name
  if (!AUDIT_SETTING_NAMES.includes(name as keyof typeof AUDIT_SETTINGS)) {
    return c.json(
      {
        error: 'invalid_setting',
        error_description: `Unknown setting name: ${name}. Valid settings: ${AUDIT_SETTING_NAMES.join(', ')}`,
      },
      400
    );
  }

  const body = await c.req.json<{ value: boolean | number | string }>();
  const { value } = body;

  if (value === undefined) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Request body must contain "value" field',
      },
      400
    );
  }

  const metadata = AUDIT_SETTINGS[name as keyof typeof AUDIT_SETTINGS];

  // Type validation
  if (metadata.type === 'boolean') {
    if (typeof value !== 'boolean') {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be a boolean`,
        },
        400
      );
    }
  } else if (metadata.type === 'number') {
    if (typeof value !== 'number' || isNaN(value)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be a number`,
        },
        400
      );
    }

    if (name === 'CHECK_API_AUDIT_RETENTION_DAYS' && !Number.isInteger(value)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be an integer`,
        },
        400
      );
    }

    // Range validation
    if (metadata.min !== undefined && value < metadata.min) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be >= ${metadata.min}`,
        },
        400
      );
    }
    if (metadata.max !== undefined && value > metadata.max) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be <= ${metadata.max}`,
        },
        400
      );
    }
  } else if (metadata.type === 'string') {
    if (typeof value !== 'string') {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be a string`,
        },
        400
      );
    }

    // Enum validation
    if (metadata.enum && !metadata.enum.includes(value)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be one of: ${metadata.enum.join(', ')}`,
        },
        400
      );
    }
  }

  // Check if KV is available
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  try {
    // Store as string in KV
    await c.env.AUTHRIM_CONFIG.put(name, String(value));

    return c.json({
      success: true,
      setting: name,
      value,
      note: 'Setting updated. Cache will refresh within 5 minutes.',
    });
  } catch (error) {
    log.error('Error updating audit setting', { settingName: name }, error as Error);
    // SECURITY: Do not expose internal error details
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update setting',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/check-api-audit/:name
 * Clear a specific audit setting override (revert to env/default)
 */
export async function clearCheckApiAuditSetting(c: Context) {
  const log = getLogger(c).module('CheckApiAuditAPI');
  const name = c.req.param('name')!;

  // Validate setting name
  if (!AUDIT_SETTING_NAMES.includes(name as keyof typeof AUDIT_SETTINGS)) {
    return c.json(
      {
        error: 'invalid_setting',
        error_description: `Unknown setting name: ${name}. Valid settings: ${AUDIT_SETTING_NAMES.join(', ')}`,
      },
      400
    );
  }

  // Check if KV is available
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  try {
    await c.env.AUTHRIM_CONFIG.delete(name);

    return c.json({
      success: true,
      setting: name,
      note: 'Setting override cleared. Will use env/default value. Cache will refresh within 5 minutes.',
    });
  } catch (error) {
    log.error('Error clearing audit setting', { settingName: name }, error as Error);
    // SECURITY: Do not expose internal error details
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to clear setting',
      },
      500
    );
  }
}
