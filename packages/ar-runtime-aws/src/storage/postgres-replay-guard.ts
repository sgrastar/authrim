import { createHash } from 'node:crypto';
import type { PostgresQueryClient } from './postgres-transient-state';
import type { RecordReplayInput, ReplayGuardStore } from './state-ports';

const TABLE = 'authrim_aws_replay_jtis';
const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;
const DB_NOW_MS = '(extract(epoch from clock_timestamp()) * 1000)::bigint';
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

function assertIdentity(tenantId: string, key: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) throw new Error('Invalid replay guard tenant');
  if (!key || key.length > 4096) throw new Error('Invalid replay guard key');
}

function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * One atomic PostgreSQL upsert per presentation: concurrent Lambda isolates insert the same
 * primary key, and only the first (or one replacing an expired row) returns it.
 */
export class PostgresReplayGuardStore implements ReplayGuardStore {
  constructor(private readonly db: PostgresQueryClient) {}

  async record(input: RecordReplayInput): Promise<'recorded' | 'replayed'> {
    assertIdentity(input.tenantId, input.key);
    if (
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < 1 ||
      input.ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error('Invalid replay guard TTL');
    }
    const ttlMs = input.ttlSeconds * 1000;
    // EXCLUDED.expires_at_ms - ttl is this statement's clock reading, so the expiry test and
    // the new expiry use one database time.
    const result = await this.db.query<{ key_hash: string }>(
      `/* aws-replay-guard:record */
       INSERT INTO ${TABLE} AS current (tenant_id, key_hash, expires_at_ms)
       VALUES ($1, $2, ${DB_NOW_MS} + $3::bigint)
       ON CONFLICT (tenant_id, key_hash) DO UPDATE
         SET expires_at_ms = EXCLUDED.expires_at_ms
         WHERE current.expires_at_ms <= EXCLUDED.expires_at_ms - $3::bigint
       RETURNING key_hash`,
      [input.tenantId, keyHash(input.key), ttlMs]
    );
    return result.rows.length === 1 ? 'recorded' : 'replayed';
  }

  async isRecorded(input: { tenantId: string; key: string }): Promise<boolean> {
    assertIdentity(input.tenantId, input.key);
    const result = await this.db.query<{ key_hash: string }>(
      `/* aws-replay-guard:is-recorded */
       SELECT key_hash FROM ${TABLE}
       WHERE tenant_id = $1 AND key_hash = $2 AND expires_at_ms > ${DB_NOW_MS}`,
      [input.tenantId, keyHash(input.key)]
    );
    return result.rows.length > 0;
  }

  async pruneExpired(limit = 1000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Invalid replay guard prune limit');
    }
    // The outer expiry test is re-evaluated on a row a concurrent record() has just reused
    // (READ COMMITTED rechecks updated rows), so a live record is never deleted.
    const result = await this.db.query<{ key_hash: string }>(
      `/* aws-replay-guard:prune */
       DELETE FROM ${TABLE}
       WHERE (tenant_id, key_hash) IN (
         SELECT tenant_id, key_hash FROM ${TABLE}
         WHERE expires_at_ms <= ${DB_NOW_MS}
         ORDER BY expires_at_ms LIMIT $1
       ) AND expires_at_ms <= ${DB_NOW_MS}
       RETURNING key_hash`,
      [limit]
    );
    return result.rowCount ?? result.rows.length;
  }
}
