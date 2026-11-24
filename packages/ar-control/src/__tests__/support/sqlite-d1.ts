import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { renderPortableMigrationSql } from '@authrim/ar-lib-core/control-plane';

type SqliteValue = string | number | null | Uint8Array;

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    return this.executeRun();
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  first<T>(): Promise<T | null> {
    return new BoundStatement(this.statement, []).first<T>();
  }

  all<T>() {
    return new BoundStatement(this.statement, []).all<T>();
  }

  run() {
    return new BoundStatement(this.statement, []).run();
  }

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

/** A D1 facade over node:sqlite, sufficient for the repository queries under test. */
export function d1Over(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: unknown[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
          return statement.executeRun();
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

/** An in-memory control database at the current baseline schema, without foreign key enforcement. */
export function controlDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  database.exec(
    renderPortableMigrationSql(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_5_0_control_baseline.sql'),
        'utf8'
      ),
      'sqlite'
    )
  );
  database.exec('PRAGMA foreign_keys = OFF');
  return database;
}

/** Removes the consistency triggers so query tests can seed rows without a full provisioning history. */
export function dropTriggers(database: DatabaseSync): void {
  const triggers = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as { name: string }[];
  for (const { name } of triggers) database.exec(`DROP TRIGGER "${name}"`);
}
