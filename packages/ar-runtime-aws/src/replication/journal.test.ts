import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ReplicationJournal } from './journal';

const PLAN = 'a'.repeat(64);

function fakePool(options: { failUnlock?: boolean; hangUnlock?: boolean } = {}) {
  const events: string[] = [];
  const keys: Record<string, unknown> = {};
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_try_advisory_lock')) {
        events.push('lock');
        keys.lock = params?.[0];
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        events.push('unlock');
        keys.unlock = params?.[0];
        if (options.failUnlock) throw new Error('connection lost');
        if (options.hangUnlock) return new Promise<never>(() => undefined);
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (sql.startsWith('INSERT')) return { rows: [] };
      return {
        rows: [
          {
            pair_id: 'pair',
            plan_sha256: PLAN,
            revision: '1',
            value_json: '{"phase":"pending"}',
          },
        ],
      };
    }),
    release: vi.fn((destroy?: boolean) => {
      events.push(`release:${String(destroy)}`);
    }),
  });
  return { events, keys, client, pool: { connect: vi.fn(async () => client) } };
}

const input = (run: () => Promise<unknown>) => ({
  pairId: 'pair',
  operationId: 'op',
  planSha256: PLAN,
  initial: { phase: 'pending' },
  run,
});

describe('ReplicationJournal advisory lock', () => {
  it.each(['tenant', 'environment'] as const)(
    'gives the %s lock back before discarding the session, so an immediate retry is not busy',
    async (scope) => {
      const { pool, events, keys } = fakePool();
      const journal = new ReplicationJournal(pool as never, scope);
      await expect(
        journal.withOperation(
          input(async () => {
            throw new Error('response lost');
          })
        )
      ).rejects.toThrow('response lost');
      expect(events).toEqual(['lock', 'unlock', 'release:true']);
      const prefix =
        scope === 'environment' ? 'authrim:replication:environment:' : 'authrim:replication:';
      expect(keys.lock).toBe(`${prefix}pair`);
      expect(keys.unlock).toBe(keys.lock);
    }
  );

  it('keeps an error listener on the checked-out session so a dropped connection cannot crash the process', async () => {
    const { pool, client } = fakePool();
    const journal = new ReplicationJournal(pool as never);
    await journal.withOperation(
      input(async () => {
        expect(client.listenerCount('error')).toBeGreaterThan(0);
        expect(() => client.emit('error', new Error('terminated'))).not.toThrow();
        return 'done';
      })
    );
  });

  it('still discards the session when the unlock fails', async () => {
    const { pool, events } = fakePool({ failUnlock: true });
    const journal = new ReplicationJournal(pool as never);
    await expect(journal.withOperation(input(async () => 'done'))).resolves.toBe('done');
    expect(events).toEqual(['lock', 'unlock', 'release:true']);
  });

  it('does not wait forever for an unlock on a stuck session', async () => {
    vi.useFakeTimers();
    try {
      const { pool, events } = fakePool({ hangUnlock: true });
      const journal = new ReplicationJournal(pool as never);
      const result = journal.withOperation(input(async () => 'done'));
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toBe('done');
      expect(events).toEqual(['lock', 'unlock', 'release:true']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not unlock a lock it never acquired', async () => {
    const { pool, client, events } = fakePool();
    client.query.mockImplementationOnce(async () => ({ rows: [{ acquired: false }] }));
    const journal = new ReplicationJournal(pool as never);
    await expect(journal.withOperation(input(async () => 'x'))).rejects.toThrow(
      'replication_operation_busy'
    );
    expect(events).toEqual(['release:true']);
  });
});
