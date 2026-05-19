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

  return {
    prepare: vi.fn(createStatement),
    batch: vi.fn(async () => [
      { success: true, meta: { changes: 1, duration: 1, last_row_id: 1 }, results: [] },
      { success: true, meta: { changes: 1, duration: 1, last_row_id: 2 }, results: [] },
    ]),
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
