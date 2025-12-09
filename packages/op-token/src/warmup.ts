/**
 * Durable Object Warmup Handler
 *
 * Pre-warms AuthCodeShard DOs before load testing to avoid cold start latency spikes.
 * This endpoint is protected by Admin API authentication and placed under /internal/*
 * to prevent accidental hits from bots/crawlers.
 *
 * Usage:
 *   GET /internal/warmup?type=auth-code&batch_size=32
 *   POST /internal/warmup?action=reload-config&batch_size=32  (reload config on all shards)
 *   Authorization: Bearer {ADMIN_API_SECRET}
 */

import { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { getShardCount, buildAuthCodeShardInstanceName } from '@authrim/shared';

/**
 * Result of a warmup operation
 */
interface WarmupResult {
  warmed_up: {
    auth_code_shards: number;
    refresh_token_shards: number;
  };
  duration_ms: number;
  batch_details: Array<{
    batch: number;
    count: number;
    duration_ms: number;
  }>;
  dry_run?: boolean;
  config_reload?: {
    shards_updated: number;
    sample_config?: {
      previous: { ttl: number; maxCodesPerUser: number };
      current: { ttl: number; maxCodesPerUser: number };
    };
  };
}

/**
 * Handle GET/POST /internal/warmup requests
 *
 * @param c - Hono context
 * @returns JSON response with warmup results
 */
export async function handleWarmup(c: Context<{ Bindings: Env }>): Promise<Response> {
  // 1. Admin authentication check
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized', message: 'Missing Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== c.env.ADMIN_API_SECRET) {
    return c.json({ error: 'unauthorized', message: 'Invalid admin secret' }, 401);
  }

  // 2. Parse query parameters
  const type = c.req.query('type') || 'auth-code';
  const action = c.req.query('action') || 'warmup'; // 'warmup' or 'reload-config'
  const batchSize = Math.min(Math.max(parseInt(c.req.query('batch_size') || '32', 10), 1), 64);
  const dryRun = c.req.query('dry_run') === 'true';

  const startTime = Date.now();
  const result: WarmupResult = {
    warmed_up: { auth_code_shards: 0, refresh_token_shards: 0 },
    duration_ms: 0,
    batch_details: [],
  };

  // 3. Handle reload-config action
  if (action === 'reload-config') {
    const shardCount = await getShardCount(c.env);
    let shardsUpdated = 0;
    let sampleConfig:
      | {
          previous: { ttl: number; maxCodesPerUser: number };
          current: { ttl: number; maxCodesPerUser: number };
        }
      | undefined = undefined;

    for (let i = 0; i < shardCount; i += batchSize) {
      const batchStart = Date.now();
      const batchEnd = Math.min(i + batchSize, shardCount);
      const promises: Promise<void>[] = [];

      for (let j = i; j < batchEnd; j++) {
        const instanceName = buildAuthCodeShardInstanceName(j);
        const doId = c.env.AUTH_CODE_STORE.idFromName(instanceName);
        const doStub = c.env.AUTH_CODE_STORE.get(doId);
        // Use RPC to reload config
        promises.push(
          doStub
            .reloadConfigRpc()
            .then((result) => {
              if (!sampleConfig && result.config?.previous && result.config?.current) {
                sampleConfig = {
                  previous: result.config.previous,
                  current: result.config.current,
                };
              }
              shardsUpdated++;
            })
            .catch((error) => {
              console.error(`Failed to reload config for shard ${j}:`, error);
            })
        );
      }

      await Promise.all(promises);

      const batchDuration = Date.now() - batchStart;
      result.batch_details.push({
        batch: Math.floor(i / batchSize) + 1,
        count: batchEnd - i,
        duration_ms: batchDuration,
      });
    }

    result.config_reload = {
      shards_updated: shardsUpdated,
      sample_config: sampleConfig,
    };
    result.duration_ms = Date.now() - startTime;

    console.log(
      `[CONFIG-RELOAD] Completed: ${shardsUpdated}/${shardCount} shards updated in ${result.duration_ms}ms`
    );

    return c.json(result);
  }

  // 4. Warm up AuthCodeShard DOs (default action)
  if (type === 'auth-code' || type === 'all') {
    const shardCount = await getShardCount(c.env);

    if (dryRun) {
      result.warmed_up.auth_code_shards = shardCount;
      result.dry_run = true;
    } else {
      // Process in batches to avoid overwhelming Cloudflare
      for (let i = 0; i < shardCount; i += batchSize) {
        const batchStart = Date.now();
        const batchEnd = Math.min(i + batchSize, shardCount);
        const promises: Promise<void>[] = [];

        for (let j = i; j < batchEnd; j++) {
          const instanceName = buildAuthCodeShardInstanceName(j);
          const doId = c.env.AUTH_CODE_STORE.idFromName(instanceName);
          const doStub = c.env.AUTH_CODE_STORE.get(doId);
          // Use RPC status call to trigger DO initialization
          promises.push(doStub.getStatusRpc().then(() => {}));
        }

        // Wait for all DOs in this batch to respond
        await Promise.all(promises);

        const batchDuration = Date.now() - batchStart;
        result.batch_details.push({
          batch: Math.floor(i / batchSize) + 1,
          count: batchEnd - i,
          duration_ms: batchDuration,
        });
        result.warmed_up.auth_code_shards += batchEnd - i;
      }
    }
  }

  // Note: RefreshTokenRotator warmup would require knowing client_id + generation + shard
  // which is dynamic. For now, only AuthCodeShard warmup is supported.

  result.duration_ms = Date.now() - startTime;

  console.log(
    `[WARMUP] Completed: ${result.warmed_up.auth_code_shards} auth-code shards in ${result.duration_ms}ms`
  );

  return c.json(result);
}
