/**
 * An in-memory SQLite database with the deployed D1 core schema (the 0.5.0 baseline and the
 * migrations after it), and a minimal DatabaseAdapter over it, for tests that need real tables.
 */
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  listMigrationSourceFiles,
  readRenderedMigrationSql,
} from '../../../../test/helpers/migration-source.mjs';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

const CORE = new URL('../../../../migrations/core/d1/', import.meta.url);

export function coreSchemaDatabase(): { db: SQLiteDatabase; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  // The listing has the consolidated history first; later migrations start where it drops.
  const listed = listMigrationSourceFiles(CORE);
  const number = (name: string) => Number(name.split('_')[0]);
  const start = listed.findIndex((name, i) => i > 0 && number(name) < number(listed[i - 1]));
  const later = start < 0 ? [] : listed.slice(start).filter((name) => number(name) > 2);
  for (const file of ['001_0_5_0_core_baseline.sql', ...later])
    db.exec(renderPortableMigrationSql(readRenderedMigrationSql(CORE, file), 'sqlite'));
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const run = (sql: string, params?: unknown[]) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run(sql, params),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => run(statement.sql, statement.params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getType: () => 'd1',
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}
