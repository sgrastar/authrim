import { createHash } from 'node:crypto';
import type { PostgresQueryClient } from './postgres-transient-state';

export interface CheckRateLimitInput {
  tenantId?: string;
  key: string;
  windowSeconds: number;
  maxRequests: number;
}

const TABLE = 'authrim_aws_rate_limit_counters';
const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;
const DB_NOW_S = 'floor(extract(epoch from clock_timestamp()))::bigint';

function assertPositiveInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${name}`);
  }
}

function safeInteger(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid rate limit counter');
  }
  return parsed;
}

/** One atomic PostgreSQL upsert per request; Lambda isolates never hold the counter. */
export class PostgresRateLimitStore {
  constructor(private readonly db: PostgresQueryClient) {}

  async check(
    input: CheckRateLimitInput
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    if (input.tenantId !== undefined && !TENANT_ID_PATTERN.test(input.tenantId)) {
      throw new Error('Invalid rate limit tenant');
    }
    if (!input.key || input.key.length > 4096) throw new Error('Invalid rate limit key');
    assertPositiveInteger(input.windowSeconds, 'rate limit window', 86_400);
    assertPositiveInteger(input.maxRequests, 'rate limit maximum', 1_000_000);

    const scopeKind = input.tenantId === undefined ? 'global' : 'tenant';
    const scopeId = input.tenantId ?? 'global';
    const keyHash = createHash('sha256').update(input.key).digest('hex');
    const result = await this.db.query<{
      request_count: string | number;
      reset_at_s: string | number;
    }>(
      `/* aws-rate-limit:check */
       WITH at AS (SELECT ${DB_NOW_S} AS now_s)
       INSERT INTO ${TABLE} AS current
         (scope_kind, scope_id, key_hash, request_count, reset_at_s)
       SELECT $1, $2, $3, 1, at.now_s + $4::bigint FROM at
       ON CONFLICT (scope_kind, scope_id, key_hash) DO UPDATE
         SET request_count = CASE
               WHEN current.reset_at_s <= EXCLUDED.reset_at_s - $4::bigint THEN 1
               ELSE LEAST(current.request_count + 1, $5::bigint + 1)
             END,
             reset_at_s = CASE
               WHEN current.reset_at_s <= EXCLUDED.reset_at_s - $4::bigint
                 THEN EXCLUDED.reset_at_s
               ELSE current.reset_at_s
             END
       RETURNING request_count, reset_at_s`,
      [scopeKind, scopeId, keyHash, input.windowSeconds, input.maxRequests]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Rate limit state unavailable');
    const count = safeInteger(row.request_count);
    const resetAt = safeInteger(row.reset_at_s);
    return {
      allowed: count <= input.maxRequests,
      remaining: Math.max(0, input.maxRequests - count),
      resetAt,
    };
  }

  async pruneExpired(limit = 1000): Promise<number> {
    assertPositiveInteger(limit, 'rate limit prune limit', 10_000);
    const result = await this.db.query<{ key_hash: string }>(
      `/* aws-rate-limit:prune */
       DELETE FROM ${TABLE}
       WHERE ctid IN (
         SELECT ctid FROM ${TABLE}
         WHERE reset_at_s <= ${DB_NOW_S}
         ORDER BY reset_at_s LIMIT $1
       ) RETURNING key_hash`,
      [limit]
    );
    return result.rowCount ?? result.rows.length;
  }
}
