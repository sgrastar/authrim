import { describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '@authrim/ar-lib-core/db/adapter';
import {
  AuroraDsqlAdapter,
  DsqlOperationError,
  type DsqlClient,
  type DsqlQueryResult,
} from './adapter';

const config = {
  hostname: 'abcdefghijklmnopqrstuv1234.dsql.ap-northeast-1.on.aws',
  region: 'ap-northeast-1',
  user: 'authrim_probe',
};
const empty: DsqlQueryResult = { rows: [], rowCount: 0 };

function sqlFailure(code: string, message = 'private failure') {
  return Object.assign(new Error(message), { code });
}

function client() {
  return {
    query: vi
      .fn<(sql: string, params?: unknown[]) => Promise<DsqlQueryResult>>()
      .mockResolvedValue(empty),
    release: vi.fn<(destroy?: boolean) => void>(),
  } satisfies DsqlClient;
}

function fixture(clients: DsqlClient[]) {
  const pool = {
    connect: vi.fn(async () => {
      const next = clients.shift();
      if (!next) throw new Error('unexpected_connection');
      return next;
    }),
    end: vi.fn(async () => undefined),
  };
  const sleep = vi.fn(async (_ms: number) => undefined);
  const adapter = new AuroraDsqlAdapter(config, {
    poolFactory: () => pool,
    sleep,
    random: () => 0.5,
  });
  return { pool, adapter, sleep };
}

describe('experimental DSQL adapter', () => {
  it('stays distinct from the PostgreSQL serving capability', () => {
    const { adapter } = fixture([]);
    expect(adapter.getType()).toBe('aurora-dsql');
    expect(adapter).not.toHaveProperty('statementConsentAtomicCapability');
  });

  it('converts SQL parameters and reports affected rows', async () => {
    const connection = client();
    connection.query.mockResolvedValue({ rows: [{ id: 'tenant-a' }], rowCount: 1 });
    const { adapter } = fixture([connection]);
    await expect(
      adapter.execute('UPDATE users SET enabled = ? WHERE tenant_id = ?', [false, 'a'])
    ).resolves.toMatchObject({ rowsAffected: 1, success: true });
    expect(connection.query).toHaveBeenCalledWith(
      'UPDATE users SET enabled = $1 WHERE tenant_id = $2',
      [false, 'a']
    );
    expect(connection.release).toHaveBeenCalledWith(false);
  });

  it('keeps parallel transactions and ordinary queries on distinct leases', async () => {
    const first = client();
    const second = client();
    const ordinary = client();
    const { adapter } = fixture([first, second, ordinary]);
    let unlock!: () => void;
    const barrier = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let firstStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const transaction = adapter.transaction(async (tx) => {
      await tx.execute('UPDATE users SET enabled = ? WHERE tenant_id = ?', [true, 'first']);
      firstStarted();
      await barrier;
    });
    await entered;
    await adapter.transaction(async (tx) => {
      await tx.execute('UPDATE users SET enabled = ? WHERE tenant_id = ?', [false, 'second']);
    });
    await adapter.query('SELECT $1 AS tenant', ['ordinary']);
    unlock();
    await transaction;
    expect(first.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      'UPDATE users SET enabled = $1 WHERE tenant_id = $2',
      'COMMIT',
    ]);
    expect(second.query.mock.calls[1]?.[1]).toEqual([false, 'second']);
    expect(ordinary.query.mock.calls).toEqual([['SELECT $1 AS tenant', ['ordinary']]]);
    for (const connection of [first, second, ordinary])
      expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back failures and prevents use of an expired transaction lease', async () => {
    const connection = client();
    const { adapter } = fixture([connection]);
    let retained: TransactionContext | undefined;
    await expect(
      adapter.transaction(async (tx) => {
        retained = tx;
        throw new Error('private error');
      })
    ).rejects.toThrow('aurora_dsql_operation_failed');
    if (!retained) throw new Error('transaction_was_not_entered');
    await expect(retained.query('SELECT 1')).rejects.toThrow('aurora_dsql_operation_failed');
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      'ROLLBACK',
    ]);
    expect(connection.release).toHaveBeenCalledWith(true);
  });

  it('never retries the normal transaction callback', async () => {
    const connection = client();
    connection.query.mockRejectedValueOnce({ code: '40001', message: 'secret conflict' });
    const { adapter, pool, sleep } = fixture([connection]);
    await expect(adapter.transaction(async () => undefined)).rejects.toMatchObject({
      code: '40001',
    });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledWith(true);
  });

  it('retries only a confirmed conflict with explicit opt-in and a fresh connection', async () => {
    const first = client();
    const second = client();
    first.query.mockImplementation(async (sql) => {
      if (sql.startsWith('UPDATE')) throw sqlFailure('40001', 'tenant secret');
      return empty;
    });
    const { adapter, sleep } = fixture([first, second]);
    const callback = vi.fn(async (tx: TransactionContext) => {
      await tx.execute('UPDATE counters SET value = value + 1 WHERE tenant_id = $1', ['a']);
      return 'committed';
    });
    await expect(adapter.retryableTransaction(callback)).resolves.toBe('committed');
    expect(callback).toHaveBeenCalledTimes(2);
    expect(first.query).toHaveBeenCalledWith('ROLLBACK');
    expect(second.query).toHaveBeenCalledWith('COMMIT', undefined);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('does not retry a callback error masquerading as a database conflict', async () => {
    const connection = client();
    const { adapter, pool } = fixture([connection]);
    await expect(
      adapter.retryableTransaction(async () => {
        throw sqlFailure('40001', 'application failure');
      })
    ).rejects.toMatchObject({ message: 'aurora_dsql_operation_failed', code: undefined });
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['ECONNRESET', '08006', '57014'])(
    'does not retry unknown commit outcome %s',
    async (code) => {
      const connection = client();
      connection.query.mockImplementation(async (sql) => {
        if (sql === 'COMMIT') throw sqlFailure(code, 'password=secret');
        return empty;
      });
      const { adapter, pool, sleep } = fixture([connection]);
      const callback = vi.fn(async (tx: TransactionContext) => {
        await tx.execute('UPDATE counters SET value = value + 1');
      });
      await expect(adapter.retryableTransaction(callback)).rejects.toBeInstanceOf(
        DsqlOperationError
      );
      expect(callback).toHaveBeenCalledTimes(1);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  );

  it('does not commit after a callback catches a failed statement', async () => {
    const connection = client();
    connection.query.mockImplementation(async (sql) => {
      if (sql.startsWith('INSERT')) throw sqlFailure('23505', 'private duplicate');
      return empty;
    });
    const { adapter } = fixture([connection]);
    await expect(
      adapter.transaction(async (tx) => {
        await tx.execute('INSERT INTO users VALUES ($1)', ['a']).catch(() => undefined);
      })
    ).rejects.toMatchObject({ code: '23505' });
    expect(connection.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(connection.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('caps conflict retry attempts', async () => {
    const connections = [client(), client()];
    for (const connection of connections)
      connection.query.mockImplementation(async (sql) => {
        if (sql === 'COMMIT') throw sqlFailure('40001');
        return empty;
      });
    const { adapter, pool } = fixture(connections);
    await expect(
      adapter.retryableTransaction(async () => undefined, { maxAttempts: 2 })
    ).rejects.toMatchObject({ code: '40001' });
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('does not retry a conflict when rollback also fails', async () => {
    const connection = client();
    connection.query.mockImplementation(async (sql) => {
      if (sql === 'COMMIT') throw sqlFailure('40001');
      if (sql === 'ROLLBACK') throw sqlFailure('08006');
      return empty;
    });
    const { adapter, pool } = fixture([connection]);
    await expect(adapter.retryableTransaction(async () => undefined)).rejects.toMatchObject({
      code: undefined,
    });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledWith(true);
  });

  it('waits for started SQL and closes the callback lease before commit', async () => {
    const connection = client();
    let finishWrite!: (value: DsqlQueryResult) => void;
    const write = new Promise<DsqlQueryResult>((resolve) => {
      finishWrite = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    connection.query.mockImplementation(async (sql) => {
      if (sql.startsWith('UPDATE')) {
        signalStarted();
        return write;
      }
      return empty;
    });
    const { adapter } = fixture([connection]);
    let retained: TransactionContext | undefined;
    const transaction = adapter.transaction(async (tx) => {
      retained = tx;
      void tx.execute('UPDATE counters SET value = value + 1');
    });
    await started;
    await Promise.resolve();
    expect(connection.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    if (!retained) throw new Error('transaction_was_not_entered');
    await expect(retained.query('SELECT 1')).rejects.toThrow('aurora_dsql_operation_failed');
    finishWrite(empty);
    await transaction;
    expect(connection.query).toHaveBeenCalledWith('COMMIT', undefined);
  });

  it('redacts server messages, detail, query and causes from errors and health checks', async () => {
    const first = client();
    const second = client();
    const secret = {
      code: '28P01',
      message: 'secret-token',
      detail: 'private tenant',
      query: 'secret sql',
    };
    first.query.mockRejectedValue(secret);
    second.query.mockRejectedValue(secret);
    const { adapter } = fixture([first, second]);
    const error = await adapter.query('SELECT $1', ['secret']).catch((failure: Error) => failure);
    expect(error).toMatchObject({
      name: 'DsqlOperationError',
      message: 'aurora_dsql_operation_failed',
      code: '28P01',
    });
    expect(JSON.stringify(error)).not.toMatch(/secret|private/u);
    expect(error).not.toHaveProperty('cause');
    await expect(adapter.isHealthy()).resolves.toMatchObject({
      healthy: false,
      error: 'aurora_dsql_unavailable',
    });
  });

  it('closes once and rejects future queries without acquiring a connection', async () => {
    const { adapter, pool } = fixture([]);
    await adapter.close();
    await adapter.close();
    await expect(adapter.query('SELECT 1')).rejects.toThrow('aurora_dsql_operation_failed');
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
