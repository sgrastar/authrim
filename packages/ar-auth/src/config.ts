import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getSessionShardCount,
  getShardCount,
  timingSafeEqual,
  createErrorResponse,
  AR_ERROR_CODES,
} from '@authrim/ar-lib-core';

/**
 * Config endpoint for debugging shard configuration.
 *
 * Returns the current shard configuration as seen by this Worker,
 * including values from KV, environment variables, and defaults.
 *
 * This helps diagnose configuration mismatches between:
 * - KV stored values
 * - Environment variables (wrangler.toml)
 * - Default values
 *
 * @endpoint GET /_internal/config
 * @auth Requires ADMIN_API_SECRET header
 */
export async function configHandler(c: Context<{ Bindings: Env }>) {
  // Validate internal API secret
  const secret = c.req.header('X-Admin-Secret') || c.req.query('secret');
  // Use timing-safe comparison to prevent timing attacks
  if (!secret || !c.env.ADMIN_API_SECRET || !timingSafeEqual(secret, c.env.ADMIN_API_SECRET)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  try {
    // Get resolved shard counts (after KV → ENV → Default resolution)
    const codeShards = await getShardCount(c.env);
    const sessionShards = await getSessionShardCount(c.env);

    // Get raw KV values (if KV is bound)
    let kvCodeShards: string | null = null;
    let kvSessionShards: string | null = null;

    if (c.env.AUTHRIM_CONFIG) {
      kvCodeShards = await c.env.AUTHRIM_CONFIG.get('code_shards');
      kvSessionShards = await c.env.AUTHRIM_CONFIG.get('session_shards');
    }

    return c.json({
      status: 'ok',
      shards: {
        code: {
          resolved: codeShards,
          kv: kvCodeShards,
          env: c.env.AUTHRIM_CODE_SHARDS || null,
          default: 4,
        },
        session: {
          resolved: sessionShards,
          kv: kvSessionShards,
          env: c.env.AUTHRIM_SESSION_SHARDS || null,
          default: 4,
        },
      },
      bindings: {
        AUTHRIM_CONFIG: !!c.env.AUTHRIM_CONFIG,
        SESSION_STORE: !!c.env.SESSION_STORE,
        AUTH_CODE_STORE: !!c.env.AUTH_CODE_STORE,
        KEY_MANAGER: !!c.env.KEY_MANAGER,
      },
      meta: {
        codeVersion: c.env.CODE_VERSION_UUID?.substring(0, 8) || 'not-set',
        deployTime: c.env.DEPLOY_TIME_UTC || 'not-set',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (e) {
    return c.json(
      {
        status: 'error',
        message: e instanceof Error ? e.message : 'Failed to retrieve config',
      },
      500
    );
  }
}
