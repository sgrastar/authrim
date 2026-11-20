import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PostgresQueryClient } from './postgres-transient-state';
import { PostgresRateLimitStore } from './postgres-rate-limit';

function makeDb(rows: unknown[], rowCount: number | null = rows.length) {
  const query = vi.fn(async () => ({ rows, rowCount }));
  return { db: { query } as unknown as PostgresQueryClient, query };
}
const row = (request_count: string | number, reset_at_s: string | number) => [
  { request_count, reset_at_s },
];
const base = { key: 'k', windowSeconds: 60, maxRequests: 5 };

describe('PostgresRateLimitStore (mutation hardening)', () => {
  it('rejects invalid tenants, keys and bounds with exact messages', async () => {
    const { db, query } = makeDb(row(1, 100));
    const store = new PostgresRateLimitStore(db);
    await expect(store.check({ ...base, tenantId: 'Bad' })).rejects.toThrow(
      'Invalid rate limit tenant'
    );
    await expect(store.check({ ...base, key: '' })).rejects.toThrow('Invalid rate limit key');
    await expect(store.check({ ...base, key: 'a'.repeat(4097) })).rejects.toThrow(
      'Invalid rate limit key'
    );
    for (const windowSeconds of [0, -1, 86_401, 1.5]) {
      await expect(store.check({ ...base, windowSeconds })).rejects.toThrow(
        'Invalid rate limit window'
      );
    }
    for (const maxRequests of [0, -1, 1_000_001, 1.5]) {
      await expect(store.check({ ...base, maxRequests })).rejects.toThrow(
        'Invalid rate limit maximum'
      );
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts the exact boundaries (1 and the maximum)', async () => {
    const { db, query } = makeDb(row(1, 100));
    const store = new PostgresRateLimitStore(db);
    await store.check({ ...base, key: 'a'.repeat(4096), windowSeconds: 1, maxRequests: 1 });
    await store.check({ ...base, windowSeconds: 86_400, maxRequests: 1_000_000 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('uses the global scope without a tenant and the tenant scope with one', async () => {
    const { db, query } = makeDb(row(1, 100));
    const store = new PostgresRateLimitStore(db);
    const hash = createHash('sha256').update('k').digest('hex');
    await store.check(base);
    await store.check({ ...base, tenantId: 'tenant-a' });
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[0][0]).toContain('aws-rate-limit:check');
    expect(calls[0][1]).toEqual(['global', 'global', hash, 60, 5]);
    expect(calls[1][1]).toEqual(['tenant', 'tenant-a', hash, 60, 5]);
  });

  it('fails when the statement returns no row', async () => {
    const store = new PostgresRateLimitStore(makeDb([]).db);
    await expect(store.check(base)).rejects.toThrow('Rate limit state unavailable');
  });

  it('computes allowed/remaining/resetAt from the counter, including string values', async () => {
    expect(await new PostgresRateLimitStore(makeDb(row('5', '200')).db).check(base)).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 200,
    });
    expect(await new PostgresRateLimitStore(makeDb(row(6, 200)).db).check(base)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 200,
    });
    expect(await new PostgresRateLimitStore(makeDb(row(2, 200)).db).check(base)).toEqual({
      allowed: true,
      remaining: 3,
      resetAt: 200,
    });
  });

  it('accepts a zero counter/reset but rejects negative, fractional or non-numeric ones', async () => {
    expect(await new PostgresRateLimitStore(makeDb(row(0, 0)).db).check(base)).toEqual({
      allowed: true,
      remaining: 5,
      resetAt: 0,
    });
    for (const bad of [-1, 1.5, 'abc']) {
      await expect(new PostgresRateLimitStore(makeDb(row(bad, 1)).db).check(base)).rejects.toThrow(
        'Invalid rate limit counter'
      );
      await expect(new PostgresRateLimitStore(makeDb(row(1, bad)).db).check(base)).rejects.toThrow(
        'Invalid rate limit counter'
      );
    }
  });

  it('pruneExpired validates 1..10000 with the exact message and defaults to 1000', async () => {
    const { db, query } = makeDb([{ key_hash: 'a' }], 4);
    const store = new PostgresRateLimitStore(db);
    for (const limit of [0, -1, 10_001, 1.5]) {
      await expect(store.pruneExpired(limit)).rejects.toThrow('Invalid rate limit prune limit');
    }
    expect(query).not.toHaveBeenCalled();
    await store.pruneExpired(1);
    await store.pruneExpired(10_000);
    expect(await store.pruneExpired()).toBe(4);
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[2][0]).toContain('aws-rate-limit:prune');
    expect(calls[2][1]).toEqual([1000]);
  });

  it('pruneExpired falls back to rows length when rowCount is null', async () => {
    const store = new PostgresRateLimitStore(
      makeDb([{ key_hash: 'a' }, { key_hash: 'b' }], null).db
    );
    expect(await store.pruneExpired()).toBe(2);
  });
});
