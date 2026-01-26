import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getRefreshTokenShardConfig,
} from '@authrim/ar-lib-core';

/**
 * GET /api/admin/settings/code-shards
 * Get current shard count settings
 */
export async function getCodeShards(c: Context) {
  const kvValue = await c.env.AUTHRIM_CONFIG?.get('code_shards');
  const envValue = c.env.AUTHRIM_CODE_SHARDS;
  const current = kvValue || envValue || '4';

  return c.json({
    current: parseInt(current, 10),
    source: kvValue ? 'kv' : envValue ? 'env' : 'default',
    kv_value: kvValue || null,
    env_value: envValue || null,
  });
}

/**
 * PUT /api/admin/settings/code-shards
 * Dynamically change shard count (saved to KV)
 *
 * IMPORTANT: AuthCode and RefreshToken MUST have identical shard counts.
 * This is enforced at the API level to prevent data inconsistency.
 *
 * @param skip_sync_check - Set to true when updating both values together (e.g., from Scale UI)
 */
export async function updateCodeShards(c: Context<{ Bindings: Env }>) {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_KV_NOT_CONFIGURED);
  }

  const body = await c.req.json();
  const { shards, skip_sync_check } = body as { shards: number; skip_sync_check?: boolean };

  // Validation
  if (typeof shards !== 'number' || shards <= 0 || shards > 256) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // AuthCode/RefreshToken sync validation
  // Skip if explicitly requested (used when updating both values together from Scale UI)
  if (!skip_sync_check) {
    try {
      const refreshTokenConfig = await getRefreshTokenShardConfig(c.env, '__global__');
      if (refreshTokenConfig.currentShardCount !== shards) {
        return c.json(
          {
            error: 'validation_failed',
            error_description:
              `AuthCode and RefreshToken must have identical shard counts. ` +
              `Current RefreshToken: ${refreshTokenConfig.currentShardCount}, Requested AuthCode: ${shards}`,
            hint: 'Update both values together or use the Scale sliders',
            current_refresh_token_shards: refreshTokenConfig.currentShardCount,
            requested_code_shards: shards,
          },
          400
        );
      }
    } catch {
      // If RefreshToken config doesn't exist yet, allow the update
    }
  }

  // Save to KV
  await kv.put('code_shards', shards.toString());

  // Cache clear (will auto-refresh within 10 seconds)
  return c.json({
    success: true,
    shards,
    note: 'Cache will refresh within 10 seconds. Changes affect new sessions only.',
  });
}
