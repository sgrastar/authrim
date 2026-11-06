// Minimal typing of Node's built-in SQLite for the Durable Object state-machine tests
// (this package does not depend on @types/node).
declare module 'node:sqlite' {
  type SqlValue = string | number | bigint | null | Uint8Array;

  export class StatementSync {
    all(...params: SqlValue[]): Record<string, unknown>[];
    get(...params: SqlValue[]): Record<string, unknown> | undefined;
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
