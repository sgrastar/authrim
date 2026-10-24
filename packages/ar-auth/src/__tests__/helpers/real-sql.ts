/**
 * Real SQLite databases built from the migrations, behind the DatabaseAdapter interface, for tests
 * that keep the tenant metadata database and an account's own Core and PII databases apart.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/dist/migrations/sql-portability';

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export type RealSqlAdapter = DatabaseAdapter & { raw: SqliteDatabase };

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

/** A new in-memory database with every migration of the folder (`core`, `pii`) applied. */
export function migrate(folder: string): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  const directory = path.resolve(__dirname, '../../../../../migrations', folder, 'd1');
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(path.join(directory, file), 'utf8'), 'sqlite'));
  }
  return db;
}

/**
 * `maxBoundParameters` refuses a statement binding more values than that, as D1 does (100) where
 * SQLite would accept it.
 */
export function adapterOver(
  db: SqliteDatabase,
  options: { maxBoundParameters?: number } = {}
): RealSqlAdapter {
  const bind = (params: unknown[] = []) => {
    if (options.maxBoundParameters !== undefined && params.length > options.maxBoundParameters) {
      throw new Error('too many SQL variables');
    }
    return params.map((value) => (value === undefined ? null : value));
  };
  const adapter = {
    raw: db,
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      (db.prepare(sql).get(...bind(params)) as unknown) ?? null,
    execute: async (sql: string, params?: unknown[]) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...bind(params)).changes),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({
          success: true,
          rowsAffected: Number(db.prepare(statement.sql).run(...bind(statement.params)).changes),
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isHealthy: async () => true,
    getType: () => 'sqlite',
    close: async () => undefined,
  };
  return adapter as unknown as RealSqlAdapter;
}

export function count(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}
