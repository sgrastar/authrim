import { createRequire } from 'node:module';

export type SQLInputValue = null | number | bigint | string | Uint8Array;
export interface SQLiteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    all(...params: SQLInputValue[]): unknown[];
    get(...params: SQLInputValue[]): unknown;
    run(...params: SQLInputValue[]): { changes: number | bigint };
  };
}

// `node:sqlite` has no type declaration here, so it is loaded through `require`.
export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SQLiteDatabase;
};
