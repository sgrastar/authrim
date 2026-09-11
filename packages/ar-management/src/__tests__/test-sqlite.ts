import { createRequire } from 'node:module';
export type SQLInputValue = null | number | bigint | string | Uint8Array;
export interface SQLiteDatabase {
  function(name: string, callback: (...args: SQLInputValue[]) => SQLInputValue): void;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SQLInputValue[]): { changes: number | bigint };
    get(...params: SQLInputValue[]): unknown;
    all(...params: SQLInputValue[]): unknown[];
  };
  close(): void;
}
export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SQLiteDatabase;
};
