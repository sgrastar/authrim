/**
 * Preparing the removal of a whole account is refused while a legal hold stands on it, in the
 * same write that moves the account to `deleting`: on SQLite (D1's engine) the batch either
 * writes everything or nothing, and elsewhere the transaction takes the hold authority row first.
 */
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, PreparedStatement } from '../../../db/adapter';
import { createLookupBlindIndex } from '../blind-index';
import {
  DIRECTORY_REMOVAL_ACCOUNT_HELD,
  insertPreparedAccountDirectoryRemovals,
  type AccountDirectoryRemovalPublication,
} from '../publication';

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
  close(): void;
}

const KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };
const NOW = 1_800_000_000;

function openDatabase(): Sqlite {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- node:sqlite is untyped here
  return new DatabaseSync(':memory:');
}

/** D1's batch: one transaction, rolled back only when a statement fails. */
function d1AdapterFor(database: Sqlite): DatabaseAdapter {
  const run = (statement: PreparedStatement): ExecuteResult => ({
    success: true,
    rowsAffected: Number(database.prepare(statement.sql).run(...(statement.params ?? [])).changes),
  });
  return {
    queryOne: async (sql: string, params: unknown[] = []) =>
      database.prepare(sql).get(...params) ?? null,
    batch: async (statements: PreparedStatement[]) => {
      database.exec('BEGIN');
      try {
        const results = statements.map(run);
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    getType: () => 'd1',
  } as unknown as DatabaseAdapter;
}

async function removal(accountId: string): Promise<AccountDirectoryRemovalPublication> {
  return {
    operationId: `remove:${accountId}`,
    tenantId: 'tenant-a',
    accountId,
    idempotencyKey: `remove:${accountId}`,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
    scope: 'account',
    indexes: [await createLookupBlindIndex('account_id', accountId, KEY)],
  };
}

describe('account removal prepare under a legal hold', () => {
  let database: Sqlite;

  beforeEach(() => {
    database = openDatabase();
    database.exec(`
      CREATE TABLE identity_accounts (tenant_id TEXT, id TEXT PRIMARY KEY, lifecycle_state TEXT,
        directory_publication_state TEXT, account_route_generation INTEGER, updated_at INTEGER,
        deleted_at INTEGER);
      CREATE TABLE account_legal_hold_states (tenant_id TEXT, account_id TEXT,
        active_hold_id TEXT, projection_state TEXT, updated_at INTEGER,
        PRIMARY KEY (tenant_id, account_id));
      CREATE TABLE legal_holds (id TEXT PRIMARY KEY, tenant_id TEXT, subject_type TEXT,
        subject_id TEXT, state TEXT);
      CREATE TABLE account_routing_outbox (outbox_id TEXT PRIMARY KEY, tenant_id TEXT,
        account_id TEXT, event_kind TEXT, route_generation INTEGER, route_schema_version INTEGER,
        hmac_key_generation INTEGER, payload_json TEXT, status TEXT, attempt_count INTEGER,
        created_at INTEGER, updated_at INTEGER);
      INSERT INTO identity_accounts VALUES
        ('tenant-a', 'account:free', 'active', 'active', 1, 1, NULL),
        ('tenant-a', 'account:held', 'active', 'active', 1, 1, NULL),
        ('tenant-a', 'account:projected', 'active', 'active', 1, 1, NULL);
      INSERT INTO account_legal_hold_states VALUES
        ('tenant-a', 'account:free', NULL, 'inactive', 1),
        ('tenant-a', 'account:held', 'hold-1', 'active', 1),
        ('tenant-a', 'account:projected', NULL, 'inactive', 1);
      INSERT INTO legal_holds VALUES
        ('hold-1', 'tenant-a', 'account', 'account:held', 'active'),
        ('hold-2', 'tenant-a', 'account', 'account:projected', 'active');
    `);
  });

  afterEach(() => database.close());

  const account = (id: string) =>
    database
      .prepare(
        'SELECT lifecycle_state, directory_publication_state FROM identity_accounts WHERE id = ?'
      )
      .get(id);
  const outboxRows = (id: string) =>
    database.prepare('SELECT status FROM account_routing_outbox WHERE account_id = ?').all(id);

  it('prepares an account with no hold, taking its hold authority row', async () => {
    await insertPreparedAccountDirectoryRemovals(
      d1AdapterFor(database),
      [await removal('account:free')],
      NOW
    );

    expect(account('account:free')).toEqual({
      lifecycle_state: 'deleting',
      directory_publication_state: 'disabled',
    });
    expect(outboxRows('account:free')).toEqual([{ status: 'prepared' }]);
    expect(
      database
        .prepare('SELECT updated_at FROM account_legal_hold_states WHERE account_id = ?')
        .get('account:free')
    ).toEqual({ updated_at: NOW * 1000 });
  });

  it('writes nothing while a hold stands, whether or not its projection caught up', async () => {
    for (const id of ['account:held', 'account:projected']) {
      await expect(
        insertPreparedAccountDirectoryRemovals(d1AdapterFor(database), [await removal(id)], NOW)
      ).rejects.toThrow(DIRECTORY_REMOVAL_ACCOUNT_HELD);
      expect(account(id)).toEqual({
        lifecycle_state: 'active',
        directory_publication_state: 'active',
      });
      expect(outboxRows(id)).toEqual([]);
    }
  });

  it('refuses an account with no hold authority row at all', async () => {
    database.exec(`DELETE FROM account_legal_hold_states WHERE account_id = 'account:free'`);

    await expect(
      insertPreparedAccountDirectoryRemovals(
        d1AdapterFor(database),
        [await removal('account:free')],
        NOW
      )
    ).rejects.toThrow(DIRECTORY_REMOVAL_ACCOUNT_HELD);
    expect(outboxRows('account:free')).toEqual([]);
  });
});

describe('account removal prepare in a transaction (PostgreSQL, Aurora DSQL)', () => {
  function transactional(results: ExecuteResult[]) {
    const executed: string[] = [];
    const tx = {
      execute: vi.fn(async (sql: string) => {
        executed.push(sql);
        return results[executed.length - 1] ?? { success: true, rowsAffected: 1 };
      }),
    };
    const adapter = {
      getType: () => 'postgres',
      batch: vi.fn(),
      transaction: vi.fn(async (fn: (context: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as DatabaseAdapter;
    return { adapter, executed };
  }

  it('takes the hold authority row first, then writes the removal', async () => {
    const { adapter, executed } = transactional([]);

    await insertPreparedAccountDirectoryRemovals(adapter, [await removal('account:free')], NOW);

    expect(executed).toHaveLength(3);
    expect(executed[0]).toContain('UPDATE account_legal_hold_states');
    expect(executed[1]).toContain('INSERT INTO account_routing_outbox');
    expect(executed[2]).toContain('UPDATE identity_accounts');
    expect(adapter.batch).not.toHaveBeenCalled();
  });

  it('stops at a hold before writing anything else', async () => {
    const { adapter, executed } = transactional([{ success: true, rowsAffected: 0 }]);

    await expect(
      insertPreparedAccountDirectoryRemovals(adapter, [await removal('account:held')], NOW)
    ).rejects.toThrow(DIRECTORY_REMOVAL_ACCOUNT_HELD);
    expect(executed).toHaveLength(1);
  });

  it('fails the transaction (rolling it back) when a later statement misses', async () => {
    const { adapter } = transactional([
      { success: true, rowsAffected: 1 },
      { success: true, rowsAffected: 1 },
      { success: true, rowsAffected: 0 },
    ]);

    await expect(
      insertPreparedAccountDirectoryRemovals(adapter, [await removal('account:free')], NOW)
    ).rejects.toThrow('directory_removal_account_prepare_failed');
  });
});
