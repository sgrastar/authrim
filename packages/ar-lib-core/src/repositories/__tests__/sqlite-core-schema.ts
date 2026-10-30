import { DatabaseSync } from 'node:sqlite';
import {
  listMigrationSourceFiles,
  readMigrationSource,
} from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';

const MIGRATIONS = {
  control: new URL('../../../../../migrations/control/d1/', import.meta.url),
  core: new URL('../../../../../migrations/core/d1/', import.meta.url),
  pii: new URL('../../../../../migrations/pii/d1/', import.meta.url),
  admin: new URL('../../../../../migrations/admin/d1/', import.meta.url),
};

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

/** The executable D1 schema, so a statement naming a column the table lacks fails here. */
export function sqliteAdapter(
  plane: keyof typeof MIGRATIONS = 'core',
  through = Infinity
): {
  db: DatabaseSync;
  adapter: DatabaseAdapter;
} {
  const db = new DatabaseSync(':memory:');
  const migrations = MIGRATIONS[plane];
  const files = Number.isFinite(through)
    ? listMigrationSourceFiles(migrations).filter((name) => Number(name.split('_')[0]) <= through)
    : [`001_0_5_0_${plane}_baseline.sql`];
  for (const file of files) {
    db.exec(renderPortableMigrationSql(readMigrationSource(migrations, file), 'sqlite'));
  }
  const run = (statement: PreparedStatement) => {
    const changes = Number(db.prepare(statement.sql).run(...values(statement.params)).changes);
    return { success: true, rowsAffected: changes };
  };
  const adapter = {
    getType: () => 'd1' as const,
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
