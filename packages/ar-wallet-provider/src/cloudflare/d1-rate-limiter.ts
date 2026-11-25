/** Fixed-window rate limiter on D1: one atomic upsert per request. */

import type { WalletProviderRateLimiter } from '@authrim/ar-lib-core';

interface Counter {
  count: number;
  window_start: number;
}

export function createD1RateLimiter(db: D1Database, now: () => number): WalletProviderRateLimiter {
  const verdict = (row: Counter | null, input: { windowSeconds: number; maxRequests: number }) => {
    const live = row !== null && row.window_start + input.windowSeconds > now();
    const count = live ? row.count : 0;
    return {
      allowed: count <= input.maxRequests,
      remaining: Math.max(0, input.maxRequests - count),
      resetAt: (live ? row.window_start : now()) + input.windowSeconds,
    };
  };

  return {
    async check(input) {
      const at = now();
      const row = await db
        .prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
           ON CONFLICT (key) DO UPDATE SET
             window_start = CASE WHEN window_start + ?3 <= ?2 THEN ?2 ELSE window_start END,
             count = CASE WHEN window_start + ?3 <= ?2 THEN 1 ELSE count + 1 END
           RETURNING count, window_start`
        )
        .bind(input.key, at, input.windowSeconds)
        .first<Counter>();
      return verdict(row, input);
    },
    async peek(input) {
      const row = await db
        .prepare('SELECT count, window_start FROM rate_limits WHERE key = ?1')
        .bind(input.key)
        .first<Counter>();
      return verdict(row, input);
    },
  };
}

/** Deletes counters whose window ended long ago (the longest window is one hour). */
export async function purgeRateLimits(db: D1Database, now: number): Promise<number> {
  const done = await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?1')
    .bind(now - 2 * 3600)
    .run();
  return done.meta.changes;
}
