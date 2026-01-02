import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES } from '@authrim/ar-lib-core';

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
 */
export async function updateCodeShards(c: Context<{ Bindings: Env }>) {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_KV_NOT_CONFIGURED);
  }

  const { shards } = await c.req.json();

  // Validation
  if (typeof shards !== 'number' || shards <= 0 || shards > 256) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Save to KV
  await kv.put('code_shards', shards.toString());

  // Cache clear (will auto-refresh within 10 seconds)
  return c.json({
    success: true,
    shards,
    note: 'Cache will refresh within 10 seconds',
  });
}
