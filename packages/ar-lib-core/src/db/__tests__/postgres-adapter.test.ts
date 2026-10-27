import { describe, expect, it, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres-adapter';
import type { TransactionContext } from '../adapter';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

describe('PostgresAdapter', () => {
  it('converts question-mark placeholders to postgres placeholders', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 1 }], rowCount: 1 });
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://user:pass@example.com:5432/authrim',
      clientFactory: async () => ({
        query,
        end: async () => undefined,
      }),
    });

    const result = await adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM event_log WHERE tenant_id = ? AND event_type = ?',
      ['tenant-1', 'auth.login']
    );

    expect(result?.count).toBe(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT COUNT(*) as count FROM event_log WHERE tenant_id = $1 AND event_type = $2',
      ['tenant-1', 'auth.login']
    );
  });

  it('wraps batch operations in a transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://user:pass@example.com:5432/authrim',
      clientFactory: async () => ({
        query,
        end: async () => undefined,
      }),
    });

    await adapter.batch([
      { sql: 'INSERT INTO event_log (id, tenant_id) VALUES (?, ?)', params: ['evt-1', 'tenant-1'] },
      { sql: 'DELETE FROM event_log WHERE id = ?', params: ['evt-1'] },
    ]);

    expect(query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(query.mock.calls[1]?.[0]).toBe('INSERT INTO event_log (id, tenant_id) VALUES ($1, $2)');
    expect(query.mock.calls[2]?.[0]).toBe('DELETE FROM event_log WHERE id = $1');
    expect(query.mock.calls[3]?.[0]).toBe('COMMIT');
  });

  it('keeps concurrent transactions and ordinary reads and writes outside an active transaction', async () => {
    const entered = signal();
    const proceed = signal();
    const calls: string[] = [];
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://synthetic',
      clientFactory: () => ({
        async query(sql) {
          calls.push(sql);
          return { rows: [], rowCount: 1 };
        },
        async end() {},
      }),
    });
    const first = adapter.transaction(async (tx) => {
      await tx.execute('INSERT hold');
      entered.resolve();
      await proceed.promise;
      await tx.execute('INSERT event');
    });
    await entered.promise;
    const second = adapter.transaction((tx) => tx.execute('DELETE account'));
    const write = adapter.execute('INSERT ordinary');
    const health = adapter.isHealthy();
    await Promise.resolve();
    expect(calls).toEqual(['BEGIN', 'INSERT hold']);
    proceed.resolve();
    await Promise.all([first, second, write, health]);
    expect(calls).toEqual([
      'BEGIN',
      'INSERT hold',
      'INSERT event',
      'COMMIT',
      'BEGIN',
      'DELETE account',
      'COMMIT',
      'INSERT ordinary',
      'SELECT 1',
    ]);
  });

  it('rolls back failed evidence before admitting a queued operation on the connection', async () => {
    const entered = signal();
    const proceed = signal();
    const calls: string[] = [];
    let connections = 0;
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://synthetic',
      clientFactory: () => {
        const id = ++connections;
        return {
          async query(sql: string) {
            calls.push(`${id}:${sql}`);
            if (sql === 'INSERT event') throw new Error('synthetic_evidence_failure');
            return { rows: [], rowCount: 1 };
          },
          async end() {
            calls.push(`${id}:end`);
          },
        };
      },
    });
    const first = adapter.transaction(async (tx) => {
      await tx.execute('INSERT hold');
      entered.resolve();
      await proceed.promise;
      await tx.execute('INSERT event');
    });
    const rejected = expect(first).rejects.toThrow('synthetic_evidence_failure');
    await entered.promise;
    const second = adapter.transaction((tx) => tx.execute('DELETE account'));
    proceed.resolve();
    await Promise.all([rejected, second]);
    expect(calls).toEqual([
      '1:BEGIN',
      '1:INSERT hold',
      '1:INSERT event',
      '1:ROLLBACK',
      '1:BEGIN',
      '1:DELETE account',
      '1:COMMIT',
    ]);
  });

  it.each(['BEGIN', 'COMMIT'])(
    'discards an uncertain %s without replaying the callback',
    async (stage) => {
      const calls: string[] = [];
      const callback = vi.fn(async (tx: TransactionContext) => tx.execute('INSERT hold'));
      const adapter = new PostgresAdapter({
        connectionString: 'postgres://synthetic',
        clientFactory: () => ({
          async query(sql) {
            calls.push(sql);
            if (sql === stage) throw new Error('synthetic_lost_acknowledgement');
            if (sql === 'ROLLBACK') throw new Error('synthetic_rollback_failure');
            return { rows: [], rowCount: 1 };
          },
          async end() {
            calls.push('end');
          },
        }),
      });
      await expect(adapter.transaction(callback)).rejects.toThrow('synthetic_lost_acknowledgement');
      expect(callback).toHaveBeenCalledTimes(stage === 'BEGIN' ? 0 : 1);
      expect(calls.at(-2)).toBe('ROLLBACK');
      expect(calls.at(-1)).toBe('end');
      expect(calls.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    }
  );

  it('rejects escaped transaction contexts after the callback releases its lease', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://synthetic',
      clientFactory: () => ({ query, async end() {} }),
    });
    let saved: TransactionContext | undefined;
    await adapter.transaction(async (tx) => {
      saved = tx;
    });
    await expect(saved?.execute('INSERT late')).rejects.toThrow(
      'postgres_transaction_context_closed'
    );
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(['BEGIN', 'COMMIT']);
  });

  it('does not commit a swallowed database failure or an unfinished statement', async () => {
    const entered = signal();
    const proceed = signal();
    const calls: string[] = [];
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://synthetic',
      clientFactory: () => ({
        async query(sql) {
          calls.push(sql);
          if (sql === 'INSERT event') {
            entered.resolve();
            await proceed.promise;
            throw new Error('synthetic_event_failure');
          }
          return { rows: [], rowCount: 1 };
        },
        async end() {},
      }),
    });
    const operation = adapter.transaction(async (tx) => {
      void tx.execute('INSERT event').catch(() => undefined);
    });
    const rejected = expect(operation).rejects.toThrow('synthetic_event_failure');
    await entered.promise;
    expect(calls).toEqual(['BEGIN', 'INSERT event']);
    proceed.resolve();
    await rejected;
    expect(calls).toEqual(['BEGIN', 'INSERT event', 'ROLLBACK']);
  });

  it('waits for an active transaction before closing its connection', async () => {
    const entered = signal();
    const proceed = signal();
    const calls: string[] = [];
    const adapter = new PostgresAdapter({
      connectionString: 'postgres://synthetic',
      clientFactory: () => ({
        async query(sql) {
          calls.push(sql);
          return { rows: [], rowCount: 1 };
        },
        async end() {
          calls.push('end');
        },
      }),
    });
    const operation = adapter.transaction(async () => {
      entered.resolve();
      await proceed.promise;
    });
    await entered.promise;
    const close = adapter.close();
    await Promise.resolve();
    expect(calls).toEqual(['BEGIN']);
    proceed.resolve();
    await Promise.all([operation, close]);
    expect(calls).toEqual(['BEGIN', 'COMMIT', 'end']);
  });
});
