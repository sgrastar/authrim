import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readRenderedMigrationSql } from '../../../../../test/helpers/migration-source.mjs';

/**
 * A D1-shaped adapter over node:sqlite for the `*.mutation.test.ts` files. Every statement that
 * reaches the database is recorded in `calls`, and `intercept` lets a test fail a statement or
 * answer it with a canned value (for responses the real database can never produce).
 */
export type SqlKind = 'first' | 'all' | 'run' | 'batch' | 'session';
export interface SqlCall {
  kind: SqlKind;
  sql: string;
  values: unknown[];
}
export interface D1Options {
  afterBatch?: () => void;
  /** Return `{ value }` to replace the answer; throw to fail the statement. */
  intercept?: (call: SqlCall) => { value: unknown } | undefined;
  /** Rewrites the real answer of a statement after it ran (the write has already happened). */
  rewrite?: (call: SqlCall, value: unknown) => unknown;
  /** Expose no `withSession`, as a D1 binding without the sessions API would. */
  withoutSession?: boolean;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
type SqlValue = string | number | null | Uint8Array;

export function openRunnerDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(
    readRenderedMigrationSql(
      resolve(REPO_ROOT, 'migrations/plugin-runner/d1'),
      '001_0_5_0_plugin_runner_baseline.sql'
    )
  );
  return database;
}

class Bound {
  constructor(
    readonly statement: StatementSync,
    readonly sql: string,
    readonly values: SqlValue[],
    private readonly adapter: Adapter
  ) {}

  async first<T>(): Promise<T | null> {
    const override = this.adapter.observe({ kind: 'first', sql: this.sql, values: this.values });
    if (override) return override.value as T | null;
    const real = (this.statement.get(...this.values) as T | undefined) ?? null;
    return this.adapter.rewritten(
      { kind: 'first', sql: this.sql, values: this.values },
      real
    ) as T | null;
  }

  async all<T>() {
    const override = this.adapter.observe({ kind: 'all', sql: this.sql, values: this.values });
    if (override) return override.value as { success: boolean; results: T[]; meta: object };
    const real = { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
    return this.adapter.rewritten(
      { kind: 'all', sql: this.sql, values: this.values },
      real
    ) as typeof real;
  }

  async run() {
    const override = this.adapter.observe({ kind: 'run', sql: this.sql, values: this.values });
    if (override) return override.value as { success: boolean; results: []; meta: object };
    const result = this.statement.run(...this.values);
    const real = { success: true, results: [], meta: { changes: Number(result.changes) } };
    return this.adapter.rewritten(
      { kind: 'run', sql: this.sql, values: this.values },
      real
    ) as typeof real;
  }
}

class Adapter {
  readonly calls: SqlCall[] = [];
  constructor(
    readonly database: DatabaseSync,
    readonly options: D1Options
  ) {}

  observe(call: SqlCall): { value: unknown } | undefined {
    this.calls.push(call);
    return this.options.intercept?.(call);
  }

  rewritten(call: SqlCall, value: unknown): unknown {
    return this.options.rewrite ? this.options.rewrite(call, value) : value;
  }

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    const bind = (...values: unknown[]) =>
      new Bound(
        statement,
        sql,
        values.map((value) => {
          if (typeof value === 'boolean') return value ? 1 : 0;
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            value === null ||
            value instanceof Uint8Array
          ) {
            return value;
          }
          throw new Error('unsupported_test_sqlite_value');
        }),
        this
      );
    return {
      bind,
      first: <T>() => bind().first<T>(),
      all: <T>() => bind().all<T>(),
      run: () => bind().run(),
    };
  }

  async batch(statements: Bound[]) {
    const override = this.observe({
      kind: 'batch',
      sql: statements.map((statement) => statement.sql).join('\n;\n'),
      values: statements.flatMap((statement) => statement.values),
    });
    if (override) return override.value as unknown[];
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      this.options.afterBatch?.();
      return this.rewritten(
        {
          kind: 'batch',
          sql: statements.map((statement) => statement.sql).join('\n;\n'),
          values: statements.flatMap((statement) => statement.values),
        },
        results
      ) as unknown[];
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function createD1(
  database: DatabaseSync,
  options: D1Options = {}
): { db: D1Database; calls: SqlCall[] } {
  const adapter = new Adapter(database, options);
  const db = {
    prepare: (sql: string) => adapter.prepare(sql),
    batch: (statements: Bound[]) => adapter.batch(statements),
    ...(options.withoutSession
      ? {}
      : {
          withSession: (constraint?: unknown) => {
            adapter.calls.push({ kind: 'session', sql: String(constraint), values: [] });
            return adapter;
          },
        }),
  } as unknown as D1Database;
  return { db, calls: adapter.calls };
}

/** Throws a value that is not an Error, as a misbehaving platform binding might. */
export function throwOpaque(value: unknown): never {
  throw value as Error;
}

/** The core database baseline, which holds the plugin hook outbox and notification intents. */
export function openCoreDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readRenderedMigrationSql(
      resolve(REPO_ROOT, 'migrations/core/d1'),
      '001_0_5_0_core_baseline.sql'
    )
  );
  return database;
}
