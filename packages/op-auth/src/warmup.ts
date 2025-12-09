import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  getSessionShardCount,
  buildSessionShardInstanceName,
  getShardCount,
  buildAuthCodeShardInstanceName,
} from '@authrim/shared';

/**
 * Warmup handler for pre-heating Durable Objects to eliminate cold start latency.
 *
 * This endpoint triggers lightweight requests to all DO shards, bringing them from
 * "cold" (evicted from memory) to "warm" (in-memory and ready to serve requests).
 *
 * Cold DO hit adds 1-3 seconds latency per request. With 24 shards × 4 DO types = 96 instances,
 * warming them before load tests significantly improves response times.
 *
 * Usage:
 * - Call this endpoint before load testing or after deployment
 * - Can be automated via external health checks or scheduled workers
 *
 * @endpoint GET /_internal/warmup
 * @auth Requires ADMIN_API_SECRET header
 */
export async function warmupHandler(c: Context<{ Bindings: Env }>) {
  // Validate internal API secret
  const secret = c.req.header('X-Admin-Secret') || c.req.query('secret');
  if (secret !== c.env.ADMIN_API_SECRET) {
    return c.json({ error: 'unauthorized', message: 'Invalid or missing admin secret' }, 401);
  }

  const startTime = Date.now();
  const results: {
    sessionStores: { count: number; warmed: number; failed: number };
    authCodeStores: { count: number; warmed: number; failed: number };
    keyManager: { warmed: boolean; error?: string };
    totalTime: number;
  } = {
    sessionStores: { count: 0, warmed: 0, failed: 0 },
    authCodeStores: { count: 0, warmed: 0, failed: 0 },
    keyManager: { warmed: false },
    totalTime: 0,
  };

  try {
    // Get shard counts
    const sessionShardCount = await getSessionShardCount(c.env);
    const authCodeShardCount = await getShardCount(c.env);

    results.sessionStores.count = sessionShardCount;
    results.authCodeStores.count = authCodeShardCount;

    const warmupPromises: Promise<void>[] = [];

    // Warmup SessionStore shards
    for (let i = 0; i < sessionShardCount; i++) {
      const instanceName = buildSessionShardInstanceName(i);
      warmupPromises.push(
        (async () => {
          try {
            const stub = c.env.SESSION_STORE.get(c.env.SESSION_STORE.idFromName(instanceName));
            // Use /status endpoint - lightweight health check that warms the DO
            const response = await stub.fetch('https://session-store/status');
            if (response.ok) {
              results.sessionStores.warmed++;
            } else {
              results.sessionStores.failed++;
            }
          } catch {
            results.sessionStores.failed++;
          }
        })()
      );
    }

    // Warmup AuthCodeStore shards
    for (let i = 0; i < authCodeShardCount; i++) {
      const instanceName = buildAuthCodeShardInstanceName(i);
      warmupPromises.push(
        (async () => {
          try {
            const stub = c.env.AUTH_CODE_STORE.get(c.env.AUTH_CODE_STORE.idFromName(instanceName));
            // Use /status endpoint - lightweight health check that warms the DO
            const response = await stub.fetch('https://auth-code-store/status');
            if (response.ok) {
              results.authCodeStores.warmed++;
            } else {
              results.authCodeStores.failed++;
            }
          } catch {
            results.authCodeStores.failed++;
          }
        })()
      );
    }

    // Warmup KeyManager (single instance)
    warmupPromises.push(
      (async () => {
        try {
          const stub = c.env.KEY_MANAGER.get(c.env.KEY_MANAGER.idFromName('default-v3'));
          // Use /jwks endpoint - returns public keys, warms the DO
          const response = await stub.fetch('https://key-manager/jwks');
          results.keyManager.warmed = response.ok;
          if (!response.ok) {
            results.keyManager.error = `Status: ${response.status}`;
          }
        } catch (e) {
          results.keyManager.warmed = false;
          results.keyManager.error = e instanceof Error ? e.message : 'Unknown error';
        }
      })()
    );

    // Execute all warmup requests in parallel
    await Promise.all(warmupPromises);

    results.totalTime = Date.now() - startTime;

    return c.json({
      status: 'ok',
      message: 'Warmup completed',
      results,
    });
  } catch (e) {
    results.totalTime = Date.now() - startTime;

    return c.json(
      {
        status: 'error',
        message: e instanceof Error ? e.message : 'Warmup failed',
        results,
      },
      500
    );
  }
}
