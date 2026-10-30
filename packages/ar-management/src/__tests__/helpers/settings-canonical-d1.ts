import { readRenderedMigrationSql } from '../../../../../test/helpers/migration-source.mjs';
/**
 * An in-memory DB_ADMIN with the settings canonical tables (tenant, client and platform
 * documents), for tests of code that saves settings.
 */

import { DatabaseSync, type SQLiteDatabase } from '../test-sqlite';

type StatementSync = ReturnType<SQLiteDatabase['prepare']>;

type SqlValue = string | number | null | Uint8Array;

const MIGRATIONS = ['001_0_5_0_admin_baseline.sql'];

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}
  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }
  runSync<T>() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [] as T[],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number('lastInsertRowid' in result ? result.lastInsertRowid : 0),
      },
    };
  }
  async run<T>() {
    return this.runSync<T>();
  }
}

export function createSettingsCanonicalD1(): D1Database {
  const database = new DatabaseSync(':memory:');
  for (const file of MIGRATIONS) {
    database.exec(
      readRenderedMigrationSql(
        new URL(`../../../../../migrations/admin/d1/`, import.meta.url),
        `${file}`
      )
    );
  }
  const prepare = (sql: string) => {
    const statement = database.prepare(sql);
    const bind = (...values: unknown[]) => new BoundStatement(statement, values as SqlValue[]);
    return { bind, first: () => bind().first(), all: () => bind().all(), run: () => bind().run() };
  };
  const session = { prepare, getBookmark: () => 'bookmark' };
  return {
    ...session,
    withSession: () => session,
    batch: async (statements: BoundStatement[]) => {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(statement.runSync());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    dump: async () => new ArrayBuffer(0),
    exec: async (sql: string) => {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
