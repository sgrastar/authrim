import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  DEFAULT_SESSION_SHARD_COUNT,
} from '@authrim/ar-lib-core';

/**
 * KV key for session shard count configuration.
 * Matches the key used in ar-lib-core/utils/tenant-context.ts
 */
const SESSION_SHARDS_KV_KEY = 'session_shards';

function parseShardCount(value: string | undefined | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 256 ? parsed : null;
}

/**
 * GET /api/admin/settings/session-shards
 * Get current session shard count settings
 *
 * Returns:
 * - current: Active shard count (based on priority: KV > env > default)
 * - source: Where the current value comes from ('kv' | 'env' | 'default')
 * - kv_value: Value stored in KV (null if not set)
 * - env_value: Value from environment variable (null if not set)
 * - default_value: Default shard count
 */
export async function getSessionShards(c: Context<{ Bindings: Env }>) {
  const kvValue = await c.env.AUTHRIM_CONFIG?.get(SESSION_SHARDS_KV_KEY);
  const envValue = c.env.AUTHRIM_SESSION_SHARDS;
  const parsedKvValue = parseShardCount(kvValue);
  const parsedEnvValue = parseShardCount(envValue);
  const current = parsedKvValue ?? parsedEnvValue ?? DEFAULT_SESSION_SHARD_COUNT;

  return c.json({
    current,
    source: parsedKvValue !== null ? 'kv' : parsedEnvValue !== null ? 'env' : 'default',
    kv_value: parsedKvValue,
    env_value: parsedEnvValue,
    default_value: DEFAULT_SESSION_SHARD_COUNT,
  });
}

/**
 * PUT /api/admin/settings/session-shards
 * Dynamically change session shard count (saved to KV)
 *
 * Note: Changing shard count affects routing of new sessions.
 * Existing sessions will continue to work as they use embedded routing info.
 *
 * Request body:
 * - shards: number (1-256)
 *
 * Returns:
 * - success: boolean
 * - shards: Updated shard count
 * - note: Information about the change
 */
export async function updateSessionShards(c: Context<{ Bindings: Env }>) {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_KV_NOT_CONFIGURED);
  }

  const { shards } = await c.req.json();

  // Validation (1-256 range)
  if (typeof shards !== 'number' || !Number.isInteger(shards) || shards < 1 || shards > 256) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Save to KV
  await kv.put(SESSION_SHARDS_KV_KEY, shards.toString());

  return c.json({
    success: true,
    shards,
    note: 'Session shard count updated. Changes affect new sessions only.',
  });
}
