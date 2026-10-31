import { createRequire } from 'node:module';

// This package pins Node 20 declarations, which predate the required runtime's node:sqlite.
export type SQLInputValue = null | number | bigint | string | Uint8Array;
export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SQLInputValue[]): unknown;
    all(...params: SQLInputValue[]): unknown[];
  };
  close(): void;
}
export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => DatabaseSync;
};
