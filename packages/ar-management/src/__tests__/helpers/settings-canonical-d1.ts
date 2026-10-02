/**
 * An in-memory DB_ADMIN with the settings canonical tables (tenant, client and platform
 * documents), for tests of code that saves settings.
 */
import { readFileSync } from 'node:fs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

type SqlValue = string | number | null | Uint8Array;

const MIGRATIONS = [
  '028_tenant_settings_documents.sql',
  '038_tenant_settings_reconciled_at.sql',
  '039_platform_settings_documents.sql',
  '040_settings_legacy_import_state.sql',
];

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
  async run<T>() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [] as T[],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

export function createSettingsCanonicalD1(): D1Database {
  const database = new DatabaseSync(':memory:');
  for (const file of MIGRATIONS) {
    database.exec(
      readFileSync(new URL(`../../../../../migrations/admin/d1/${file}`, import.meta.url), 'utf8')
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
    batch: async (statements: BoundStatement[]) => Promise.all(statements.map((s) => s.run())),
    dump: async () => new ArrayBuffer(0),
    exec: async (sql: string) => {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
