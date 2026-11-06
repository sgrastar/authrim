/**
 * Test helper: a node:sqlite database with the real status_lists / issued_credentials DDL (0.5.0
 * baseline + the Token Status List migration) behind the DatabaseAdapter surface the status code
 * uses. `batch` is a real transaction: a thrown statement rolls the whole batch back.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { DatabaseAdapter, ExecuteResult, PreparedStatement } from '../../db/adapter';

function findWorkspaceRoot(start: string): string {
  let current = start;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error('workspace_root_not_found');
}

const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));

function readSql(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

/** `CREATE TABLE <name> (...);` out of the baseline */
function tableDdl(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE ${table} (`);
  if (start < 0) throw new Error(`table_not_found:${table}`);
  return sql.slice(start, sql.indexOf('\n);', start) + 3);
}

export interface StatusTestDb {
  sqlite: DatabaseSync;
  adapter: DatabaseAdapter;
  /** Statements seen by `batch`, in order (for failure injection and assertions) */
  batches: PreparedStatement[][];
  /** Runs before each batch is executed; may throw to simulate a failing or racing batch */
  beforeBatch?: (statements: PreparedStatement[]) => void;
}

export function createStatusTestDb(): StatusTestDb {
  const sqlite = new DatabaseSync(':memory:');
  const baseline = readSql('migrations/core/d1/001_0_5_0_core_baseline.sql');
  sqlite.exec(tableDdl(baseline, 'status_lists'));
  sqlite.exec(tableDdl(baseline, 'issued_credentials'));
  sqlite.exec(readSql('migrations/core/d1/003_credential_status_list_formats.sql'));

  const bind = (values: unknown[] = []): SQLInputValue[] =>
    values.map((value) => {
      if (value === undefined) return null;
      if (value === null || typeof value === 'string' || typeof value === 'number') return value;
      throw new Error('unsupported_test_sql_value');
    });

  const run = (sql: string, values?: unknown[]): ExecuteResult => {
    const result = sqlite.prepare(sql).run(...bind(values));
    return { rowsAffected: Number(result.changes), success: true };
  };

  const db: StatusTestDb = { sqlite, batches: [], adapter: undefined as never };
  db.adapter = {
    async query<T>(sql: string, values?: unknown[]) {
      return sqlite.prepare(sql).all(...bind(values)) as T[];
    },
    async queryOne<T>(sql: string, values?: unknown[]) {
      return (sqlite.prepare(sql).get(...bind(values)) ?? null) as T | null;
    },
    async execute(sql: string, values?: unknown[]) {
      return run(sql, values);
    },
    async batch(statements: PreparedStatement[]) {
      db.batches.push(statements);
      db.beforeBatch?.(statements);
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => run(statement.sql, statement.params));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return db;
}
