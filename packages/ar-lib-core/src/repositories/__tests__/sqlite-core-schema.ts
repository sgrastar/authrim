import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

/** The executable D1 schema, so a statement naming a column the table lacks fails here. */
export function sqliteAdapter(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, MIGRATIONS), 'utf8'), 'sqlite'));
  }
  const run = (statement: PreparedStatement) => {
    const changes = Number(db.prepare(statement.sql).run(...values(statement.params)).changes);
    return { success: true, rowsAffected: changes };
  };
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      return run({ sql, params });
    },
    async batch(statements: PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map(run);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}
