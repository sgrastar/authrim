/**
 * Policy Service Configuration Admin API
 *
 * Manages dynamic configuration for the Policy Service (Check API).
 *
 * GET  /api/admin/settings/policy-flags        - Get all policy flags
 * PUT  /api/admin/settings/policy-flags/:name  - Update a specific flag
 * DELETE /api/admin/settings/policy-flags/:name - Clear a specific flag override
 *
 * Supported flags:
 * - CHECK_API_ENABLED (boolean): Enable/disable Check API
 * - CHECK_API_BATCH_SIZE_LIMIT (number, 1-1000): Maximum batch size
 *
 * @see CLAUDE.md: 設定項目・Feature Flagsの実装方針
 */

import type { Context } from 'hono';

/**
 * Policy flag metadata
 */
interface FlagMetadata {
  type: 'boolean' | 'number';
  description: string;
  default: boolean | number;
  min?: number;
  max?: number;
}

/**
 * Available policy flags
 */
const POLICY_FLAGS: Record<string, FlagMetadata> = {
  CHECK_API_ENABLED: {
    type: 'boolean',
    description: 'Enable or disable the Check API feature',
    default: false,
  },
  CHECK_API_BATCH_SIZE_LIMIT: {
    type: 'number',
    description: 'Maximum number of checks allowed in a single batch request',
    default: 100,
    min: 1,
    max: 1000,
  },
};

const POLICY_FLAG_NAMES = Object.keys(POLICY_FLAGS) as (keyof typeof POLICY_FLAGS)[];

/**
 * GET /api/admin/settings/policy-flags
 * Get all policy flag values with their sources
 */
export async function getPolicyFlags(c: Context) {
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
    const flags: Record<
      string,
      {
        value: string | null;
        source: 'kv' | 'default';
        default: boolean | number;
        metadata: FlagMetadata;
      }
    > = {};

    for (const name of POLICY_FLAG_NAMES) {
      const kvValue = await c.env.AUTHRIM_CONFIG.get(name);
      const metadata = POLICY_FLAGS[name];

      flags[name] = {
        value: kvValue,
        source: kvValue !== null ? 'kv' : 'default',
        default: metadata.default,
        metadata,
      };
    }

    return c.json({ flags });
  } catch (error) {
    console.error('[Policy Flags API] Error getting flags:', error);
    return c.json(
      {
        error: 'internal_error',
        error_description: 'Failed to get policy flags',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/policy-flags/:name
 * Update a specific policy flag value (stored in KV)
 *
 * Request body:
 * { "value": boolean | number }
 */
export async function updatePolicyFlag(c: Context) {
  const name = c.req.param('name');

  // Validate flag name
  if (!POLICY_FLAG_NAMES.includes(name as keyof typeof POLICY_FLAGS)) {
    return c.json(
      {
        error: 'invalid_flag',
        error_description: `Unknown flag name: ${name}. Valid flags: ${POLICY_FLAG_NAMES.join(', ')}`,
      },
      400
    );
  }

  const body = await c.req.json<{ value: boolean | number }>();
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

  const metadata = POLICY_FLAGS[name as keyof typeof POLICY_FLAGS];

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
      flag: name,
      value,
      note: 'Flag updated. Cache will refresh within 5 minutes.',
    });
  } catch (error) {
    console.error(`[Policy Flags API] Error updating ${name}:`, error);
    return c.json(
      {
        error: 'internal_error',
        error_description: `Failed to update flag: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/policy-flags/:name
 * Clear a specific policy flag override (revert to env/default)
 */
export async function clearPolicyFlag(c: Context) {
  const name = c.req.param('name');

  // Validate flag name
  if (!POLICY_FLAG_NAMES.includes(name as keyof typeof POLICY_FLAGS)) {
    return c.json(
      {
        error: 'invalid_flag',
        error_description: `Unknown flag name: ${name}. Valid flags: ${POLICY_FLAG_NAMES.join(', ')}`,
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
      flag: name,
      note: 'Flag override cleared. Will use env/default value. Cache will refresh within 5 minutes.',
    });
  } catch (error) {
    console.error(`[Policy Flags API] Error clearing ${name}:`, error);
    return c.json(
      {
        error: 'internal_error',
        error_description: `Failed to clear flag: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      500
    );
  }
}
