/**
 * Durable Object SQLite storage backed by Node's built-in SQLite, so state-machine tests run the
 * real SQL (constraints, `RETURNING`, `ON CONFLICT`) instead of a hand-written imitation.
 */
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';

type Param = string | number | null | Uint8Array | undefined;

export interface SqliteTestState {
  db: DatabaseSync;
  state: DurableObjectState;
  /** Resolves when the object's constructor-time initialisation has finished (or rejects). */
  ready: () => Promise<unknown>;
  setAlarm: ReturnType<typeof vi.fn>;
}

export function createSqliteState(
  db: DatabaseSync = new DatabaseSync(':memory:')
): SqliteTestState {
  const sql = {
    exec(query: string, ...params: Param[]) {
      const bound = params.map((value) => (value === undefined ? null : value));
      const returnsRows = /^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query);
      if (bound.length === 0 && !returnsRows) {
        // Multi-statement scripts (schema, migrations) have no parameters.
        db.exec(query);
        return cursor([], 0);
      }
      const statement = db.prepare(query);
      if (returnsRows) {
        const rows = statement.all(...bound) as Record<string, unknown>[];
        return cursor(rows, rows.length);
      }
      return cursor([], Number(statement.run(...bound).changes));
    },
  };
  const pending: Promise<unknown>[] = [];
  const setAlarm = vi.fn().mockResolvedValue(undefined);
  const storage = {
    sql,
    transactionSync: <T>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getAlarm: vi.fn().mockResolvedValue(null),
    setAlarm,
  };
  const state = {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      const promise = fn();
      pending.push(promise);
      return promise;
    },
  } as unknown as DurableObjectState;
  return { db, state, ready: () => Promise.all(pending), setAlarm };
}

function cursor(rows: Record<string, unknown>[], rowsWritten: number) {
  return {
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error('Expected one row');
      return rows[0];
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}
