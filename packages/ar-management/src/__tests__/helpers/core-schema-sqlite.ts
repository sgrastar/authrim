import { readFileSync } from 'node:fs';
import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from '../test-sqlite';

const CORE_MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);

/**
 * A Core store with every executable D1 migration applied (so a statement naming a column a
 * table lacks, or a row a foreign key refuses, fails here as in D1), seeded with `tenantId`.
 * Separate stores stand in for separate D1 databases: the tenant metadata database and each
 * account database.
 */
export function openCoreStore(tenantId = 'tenant-a'): {
  db: SQLiteDatabase;
  adapter: DatabaseAdapter;
} {
  const db = new DatabaseSync(':memory:');
  for (const file of ['001_0_5_0_core_baseline.sql']) {
    db.exec(
      renderPortableMigrationSql(readFileSync(new URL(file, CORE_MIGRATIONS), 'utf8'), 'sqlite')
    );
  }
  db.prepare(
    `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(tenantId, `code-${tenantId}`, `key-${tenantId}`, `Tenant ${tenantId}`);
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const run = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run({ sql, params }),
    batch: async (statements: PreparedStatement[]) => {
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
    transaction: async () => {
      throw new Error('not used');
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0 }),
    getType: () => 'sqlite',
    close: async () => undefined,
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}
