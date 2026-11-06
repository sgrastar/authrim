import { describe, expect, it } from 'vitest';
import { PostgresReplayGuardStore } from '../postgres-replay-guard';
import type { PostgresQueryClient } from '../postgres-transient-state';

/** Applies each statement's condition and write together, as PostgreSQL's upsert does. */
class FakePostgres implements PostgresQueryClient {
  readonly rows = new Map<string, number>();
  readonly statements: { sql: string; values: unknown[] }[] = [];
  nowMs = 1_800_000_000_000;

  async query<T>(sql: string, values: unknown[] = []) {
    this.statements.push({ sql, values });
    const [tenantId, keyHash, third] = values as [string, string, number];
    const id = `${tenantId}\u0000${keyHash}`;
    if (sql.includes('aws-replay-guard:record')) {
      const current = this.rows.get(id);
      if (current !== undefined && current > this.nowMs) return { rows: [] as T[], rowCount: 0 };
      this.rows.set(id, this.nowMs + third);
      return { rows: [{ key_hash: keyHash }] as T[], rowCount: 1 };
    }
    if (sql.includes('aws-replay-guard:is-recorded')) {
      const live = (this.rows.get(id) ?? 0) > this.nowMs;
      return { rows: (live ? [{ key_hash: keyHash }] : []) as T[], rowCount: live ? 1 : 0 };
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

const input = { tenantId: 'tenant-a', key: 'dpop:["client","jti"]', ttlSeconds: 60 };

describe('PostgresReplayGuardStore', () => {
  it('records a key once until it expires, in one upsert keyed by a hash', async () => {
    const db = new FakePostgres();
    const store = new PostgresReplayGuardStore(db);

    expect(await store.isRecorded(input)).toBe(false);
    expect(await store.record(input)).toBe('recorded');
    expect(await store.isRecorded(input)).toBe(true);
    expect(await store.record(input)).toBe('replayed');
    expect(await store.record({ ...input, tenantId: 'tenant-b' })).toBe('recorded');

    db.nowMs += 60_000;
    expect(await store.isRecorded(input)).toBe(false);
    expect(await store.record(input)).toBe('recorded');

    const record = db.statements.find(({ sql }) => sql.includes('aws-replay-guard:record'));
    expect(record?.sql).toContain('ON CONFLICT (tenant_id, key_hash) DO UPDATE');
    expect(record?.sql).toContain('WHERE current.expires_at_ms <=');
    expect(record?.values).toEqual(['tenant-a', expect.stringMatching(/^[0-9a-f]{64}$/u), 60_000]);
    expect(JSON.stringify(db.statements)).not.toContain('client');
  });

  it('rejects invalid input before touching the database', async () => {
    const db = new FakePostgres();
    const store = new PostgresReplayGuardStore(db);

    await expect(store.record({ ...input, tenantId: 'Tenant A' })).rejects.toThrow();
    await expect(store.record({ ...input, key: '' })).rejects.toThrow();
    await expect(store.record({ ...input, ttlSeconds: 0 })).rejects.toThrow();
    await expect(store.record({ ...input, ttlSeconds: 1.5 })).rejects.toThrow();
    await expect(
      store.isRecorded({ tenantId: 'tenant-a', key: 'x'.repeat(4097) })
    ).rejects.toThrow();
    expect(db.statements).toHaveLength(0);
  });
});
