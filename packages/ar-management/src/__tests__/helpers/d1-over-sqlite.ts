import type { SQLiteDatabase, SQLInputValue } from '../test-sqlite';

/**
 * A D1 binding over a SQLite database, for tests that must go through the real `D1Adapter`: its
 * retry and its wrapping of a database error (`D1OperationError`, with the original in `cause`)
 * are what the code under test meets in production, and a plain adapter over SQLite does not
 * have them. A unique-constraint failure is thrown as D1 words it.
 */
class Statement {
  constructor(
    private readonly db: SQLiteDatabase,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = []
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(
      this.db,
      this.sql,
      values.map((value) => (value ?? null) as SQLInputValue)
    );
  }

  private wrap<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      throw new Error(`D1_ERROR: ${(error as Error).message}`, { cause: error });
    }
  }

  async first<T>(): Promise<T | null> {
    return this.wrap(
      () => (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null
    );
  }

  async all<T>() {
    return this.wrap(() => ({
      success: true,
      results: this.db.prepare(this.sql).all(...this.values) as T[],
      meta: {},
    }));
  }

  async run() {
    return this.wrap(() => {
      const result = this.db.prepare(this.sql).run(...this.values);
      return {
        success: true,
        results: [],
        meta: { changes: Number(result.changes), last_row_id: 0 },
      };
    });
  }
}

export function d1OverSqlite(db: SQLiteDatabase): D1Database {
  return {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
