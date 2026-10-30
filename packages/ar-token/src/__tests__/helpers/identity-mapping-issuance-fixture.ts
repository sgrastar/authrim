import { readRenderedMigrationSql } from '../../../../../test/helpers/migration-source.mjs';

import { createRequire } from 'node:module';
import type { DatabaseAdapter, TransactionContext } from '@authrim/ar-lib-core';
import type { IdentityMappingFailureRow } from '@authrim/ar-lib-core/services/identity-mapping-failures';

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

/** Protocol-local dedicated Admin database; no production test exports are required. */
export function issuanceFailureDatabase() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['001_0_5_0_admin_baseline.sql']) {
    db.exec(
      readRenderedMigrationSql(
        new URL(`../../../../../migrations/admin/d1/`, import.meta.url),
        `${file}`
      )
    );
  }
  const values = (params: unknown[] = []) => params.map((value) => value ?? null);
  const adapter: DatabaseAdapter = {
    query: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...values(params)) as T[],
    queryOne: async <T>(sql: string, params?: unknown[]) =>
      (db.prepare(sql).get(...values(params)) as T) ?? null,
    execute: async (sql, params) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
    }),
    transaction: <T>(fn: (tx: TransactionContext) => Promise<T>) => fn(adapter),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const result = statements.map(({ sql, params }) => ({
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
        }));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'sqlite' }),
    getType: () => 'sqlite',
    close: async () => {},
  };
  return {
    db,
    adapter,
    rows: () =>
      db
        .prepare('SELECT * FROM identity_mapping_failures ORDER BY tenant_id,client_id,code')
        .all() as IdentityMappingFailureRow[],
  };
}
