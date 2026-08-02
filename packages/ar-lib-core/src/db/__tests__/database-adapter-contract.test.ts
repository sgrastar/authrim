import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../adapter';
import { D1Adapter } from '../adapters/d1-adapter';
import { MysqlAdapter } from '../adapters/mysql-adapter';
import { PostgresAdapter } from '../adapters/postgres-adapter';

async function exerciseDurableAdapterContract(adapter: DatabaseAdapter, expectedType: string) {
  expect(adapter.getType()).toBe(expectedType);

  await expect(
    adapter.queryOne<{ id: string }>('SELECT id FROM users_core WHERE tenant_id = ? AND id = ?', [
      'tenant-1',
      'user-1',
    ])
  ).resolves.toEqual({ id: 'user-1' });

  await expect(
    adapter.query<{ id: string }>('SELECT id FROM users_core WHERE tenant_id = ?', ['tenant-1'])
  ).resolves.toEqual([{ id: 'user-1' }]);

  await expect(
    adapter.execute('UPDATE users_core SET updated_at = ? WHERE tenant_id = ? AND id = ?', [
      1,
      'tenant-1',
      'user-1',
    ])
  ).resolves.toMatchObject({
    rowsAffected: 1,
    success: true,
  });

  await expect(
    adapter.transaction(async (tx) => {
      const user = await tx.queryOne<{ id: string }>(
        'SELECT id FROM users_core WHERE tenant_id = ? AND id = ?',
        ['tenant-1', 'user-1']
      );
      const update = await tx.execute(
        'UPDATE users_core SET updated_at = ? WHERE tenant_id = ? AND id = ?',
        [2, 'tenant-1', user?.id]
      );
      return { userId: user?.id, rowsAffected: update.rowsAffected };
    })
  ).resolves.toEqual({
    userId: 'user-1',
    rowsAffected: 1,
  });

  await expect(
    adapter.batch([
      {
        sql: 'INSERT INTO users_core (id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
        params: ['user-2', 'tenant-1', 1, 1],
      },
      {
        sql: 'DELETE FROM users_core WHERE tenant_id = ? AND id = ?',
        params: ['tenant-1', 'user-2'],
      },
    ])
  ).resolves.toEqual([
    expect.objectContaining({ rowsAffected: 1, success: true }),
    expect.objectContaining({ rowsAffected: 1, success: true }),
  ]);

  await expect(adapter.isHealthy()).resolves.toMatchObject({
    healthy: true,
    type: expectedType,
    partition: 'core',
  });

  await adapter.close();
}

function createD1Database(): D1Database {
  const preparedStatements: D1PreparedStatement[] = [];

  const createStatement = (sql: string): D1PreparedStatement => {
    const statement = {
      bind: vi.fn((..._params: unknown[]) => statement),
      first: vi.fn(async () => {
        if (sql === 'SELECT 1') {
          return { '1': 1 };
        }
        return { id: 'user-1' };
      }),
      all: vi.fn(async () => ({ results: [{ id: 'user-1' }], success: true, meta: {} })),
      run: vi.fn(async () => ({
        success: true,
        meta: { changes: 1, duration: 1, last_row_id: 1 },
      })),
    } as unknown as D1PreparedStatement;

    preparedStatements.push(statement);
    return statement;
  };

  const session = {
    prepare: vi.fn(createStatement),
    batch: vi.fn(async () => [
      { success: true, meta: { changes: 1, duration: 1, last_row_id: 1 }, results: [] },
      { success: true, meta: { changes: 1, duration: 1, last_row_id: 2 }, results: [] },
    ]),
    getBookmark: vi.fn(() => 'bookmark-1'),
  };
  return {
    prepare: vi.fn(createStatement),
    batch: session.batch,
    withSession: vi.fn(() => session),
  } as unknown as D1Database;
}

describe('durable database adapter contract', () => {
  it('keeps D1 compatible with the shared durable adapter contract', async () => {
    await exerciseDurableAdapterContract(
      new D1Adapter({
        db: createD1Database(),
        partition: 'core',
      }),
      'd1'
    );
  });

  it('distinguishes an empty D1 queryOne result from retry exhaustion', async () => {
    const emptyStatement = {
      bind: vi.fn(),
      first: vi.fn(async () => null),
    } as unknown as D1PreparedStatement;
    const emptyDb = {
      prepare: vi.fn(() => emptyStatement),
      withSession: vi.fn(() => ({ prepare: vi.fn(() => emptyStatement) })),
    } as unknown as D1Database;
    const emptyAdapter = new D1Adapter({
      db: emptyDb,
      partition: 'core',
      retryConfig: { maxRetries: 0 },
    });

    await expect(emptyAdapter.queryOne('SELECT id FROM users_core')).resolves.toBeNull();

    const failedStatement = {
      bind: vi.fn(),
      first: vi.fn(async () => {
        throw new Error('simulated_database_unavailable');
      }),
    } as unknown as D1PreparedStatement;
    const failedDb = {
      prepare: vi.fn(() => failedStatement),
      withSession: vi.fn(() => ({ prepare: vi.fn(() => failedStatement) })),
    } as unknown as D1Database;
    const failedAdapter = new D1Adapter({
      db: failedDb,
      partition: 'core',
      retryConfig: { maxRetries: 0 },
    });

    await expect(failedAdapter.queryOne('SELECT id FROM users_core')).rejects.toThrow(
      'D1Adapter.queryOne failed after retries exhausted'
    );
  });

  it('maps D1 query consistency classes to Sessions API constraints', async () => {
    const db = createD1Database();
    const adapter = new D1Adapter({ db, partition: 'core' });

    await adapter.queryOne('SELECT 1');
    await adapter.query('SELECT 1', [], { consistencyClass: 'replica_eligible' });
    await adapter.queryOne('SELECT 1', [], {
      consistencyClass: 'read_after_write',
      bookmark: 'bookmark-previous',
    });

    expect(db.withSession).toHaveBeenNthCalledWith(1, 'first-primary');
    expect(db.withSession).toHaveBeenNthCalledWith(2, 'first-unconstrained');
    expect(db.withSession).toHaveBeenNthCalledWith(3, 'bookmark-previous');
    await expect(
      adapter.queryOne('SELECT 1', [], { consistencyClass: 'read_after_write' })
    ).rejects.toThrow('d1_read_after_write_bookmark_required');
  });

  it('allows primary compatibility reads but fails closed for replica use without Sessions API', async () => {
    const statement = {
      first: vi.fn(async () => ({ id: 'row-1' })),
      all: vi.fn(async () => ({ results: [{ id: 'row-1' }], success: true })),
    } as unknown as D1PreparedStatement;
    const adapter = new D1Adapter({
      db: {
        prepare: vi.fn(() => statement),
        batch: vi.fn(),
      } as unknown as D1Database,
      partition: 'core',
    });

    await expect(adapter.queryOne('SELECT 1')).resolves.toEqual({ id: 'row-1' });
    await expect(
      adapter.queryOne('SELECT 1', [], { consistencyClass: 'replica_eligible' })
    ).rejects.toThrow('d1_sessions_api_required');
  });

  it('keeps Postgres compatible with the shared durable adapter contract', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT 1' || sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('SELECT')) {
        return { rows: [{ id: 'user-1' }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });

    await exerciseDurableAdapterContract(
      new PostgresAdapter({
        connectionString: 'postgres://user:pass@example.com:5432/authrim',
        partition: 'core',
        clientFactory: async () => ({
          query,
          end: async () => undefined,
        }),
      }),
      'postgres'
    );
  });

  it('keeps MySQL compatible with the shared durable adapter contract', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT 1') {
        return { rows: [{ '1': 1 }] };
      }

      return { rows: [{ id: 'user-1' }] };
    });
    const execute = vi.fn(async () => ({ rows: [], affectedRows: 1, insertId: 1 }));

    await exerciseDurableAdapterContract(
      new MysqlAdapter({
        connectionString: 'mysql://user:pass@example.com:3306/authrim',
        partition: 'core',
        clientFactory: async () => ({
          query,
          execute,
          beginTransaction: async () => undefined,
          commit: async () => undefined,
          rollback: async () => undefined,
          end: async () => undefined,
        }),
      }),
      'mysql'
    );
  });
});
