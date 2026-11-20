import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PostgresReplayGuardStore } from './postgres-replay-guard';
import type { PostgresQueryClient } from './postgres-transient-state';

function makeDb(rows: unknown[] = [{ key_hash: 'x' }], rowCount: number | null = rows.length) {
  const query = vi.fn(async () => ({ rows, rowCount }));
  return { db: { query } as unknown as PostgresQueryClient, query };
}

describe('PostgresReplayGuardStore (mutation hardening)', () => {
  const base = { tenantId: 'tenant-a', key: 'k', ttlSeconds: 60 };

  it('rejects invalid tenant ids with the exact message and never queries', async () => {
    const { db, query } = makeDb();
    const store = new PostgresReplayGuardStore(db);
    await expect(store.record({ ...base, tenantId: 'Bad_Tenant' })).rejects.toThrow(
      'Invalid replay guard tenant'
    );
    await expect(store.isRecorded({ tenantId: '-a', key: 'k' })).rejects.toThrow(
      'Invalid replay guard tenant'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects empty and over-long keys, accepting exactly 4096 characters', async () => {
    const { db, query } = makeDb();
    const store = new PostgresReplayGuardStore(db);
    await expect(store.record({ ...base, key: '' })).rejects.toThrow('Invalid replay guard key');
    await expect(store.record({ ...base, key: 'a'.repeat(4097) })).rejects.toThrow(
      'Invalid replay guard key'
    );
    expect(query).not.toHaveBeenCalled();
    await expect(store.record({ ...base, key: 'a'.repeat(4096) })).resolves.toBe('recorded');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid TTLs with the exact message and accepts the boundaries', async () => {
    const { db, query } = makeDb();
    const store = new PostgresReplayGuardStore(db);
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN, 30 * 24 * 60 * 60 + 1]) {
      await expect(store.record({ ...base, ttlSeconds })).rejects.toThrow(
        'Invalid replay guard TTL'
      );
    }
    expect(query).not.toHaveBeenCalled();
    await store.record({ ...base, ttlSeconds: 1 });
    await store.record({ ...base, ttlSeconds: 30 * 24 * 60 * 60 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('passes tenant, sha256 key hash and ttl in milliseconds as parameters', async () => {
    const { db, query } = makeDb();
    await new PostgresReplayGuardStore(db).record({ ...base, key: 'abc', ttlSeconds: 3 });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('aws-replay-guard:record');
    expect(values).toEqual(['tenant-a', createHash('sha256').update('abc').digest('hex'), 3000]);
  });

  it('maps row count 1 to recorded and anything else to replayed', async () => {
    expect(await new PostgresReplayGuardStore(makeDb([]).db).record(base)).toBe('replayed');
    expect(
      await new PostgresReplayGuardStore(makeDb([{ key_hash: 'a' }, { key_hash: 'b' }]).db).record(
        base
      )
    ).toBe('replayed');
  });

  it('isRecorded reflects whether any live row exists', async () => {
    expect(await new PostgresReplayGuardStore(makeDb([]).db).isRecorded(base)).toBe(false);
    const { db, query } = makeDb([{ key_hash: 'a' }]);
    expect(await new PostgresReplayGuardStore(db).isRecorded(base)).toBe(true);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('aws-replay-guard:is-recorded');
    expect(values).toEqual(['tenant-a', createHash('sha256').update('k').digest('hex')]);
  });

  it('pruneExpired validates the limit (1..10000) with the exact message', async () => {
    const { db, query } = makeDb([], 0);
    const store = new PostgresReplayGuardStore(db);
    for (const limit of [0, -1, 10_001, 1.5, Number.NaN]) {
      await expect(store.pruneExpired(limit)).rejects.toThrow('Invalid replay guard prune limit');
    }
    expect(query).not.toHaveBeenCalled();
    await store.pruneExpired(1);
    await store.pruneExpired(10_000);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('pruneExpired defaults to 1000 and prefers rowCount over rows length', async () => {
    const { db, query } = makeDb([{ key_hash: 'a' }], 5);
    const store = new PostgresReplayGuardStore(db);
    expect(await store.pruneExpired()).toBe(5);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('aws-replay-guard:prune');
    expect(values).toEqual([1000]);
    expect(
      await new PostgresReplayGuardStore(makeDb([{ key_hash: 'a' }], null).db).pruneExpired()
    ).toBe(1);
  });
});
