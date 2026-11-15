import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ adapter: undefined as Record<string, unknown> | undefined }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: () => state.adapter,
}));

import { eraseAccountIdentifierValues } from '../account-identifier-erasure';

const migrations = [
  '017_mapped_identifier_values.sql',
  '019_mapped_identifier_values_account_binding.sql',
  '020_identifier_source_values.sql',
  '022_mapped_identifier_exceptions.sql',
]
  .map((file) =>
    readFileSync(resolve(__dirname, `../../../../migrations/admin/d1/${file}`), 'utf8')
  )
  .join('\n');
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const env = {
  KEY_MANAGER: {
    idFromName: (name: string) => name,
    get: () => ({
      identifierValueHmacsRpc: async (values: string[]) => ({
        keyId: '0123456789abcdef',
        hmacs: values.map((value) => createHmac('sha256', 'test-key').update(value).digest('hex')),
      }),
    }),
  },
} as never;
const SQLITE_MODULE = 'node:sqlite';
const { DatabaseSync } = (await import(/* @vite-ignore */ SQLITE_MODULE)) as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
let db: SqliteDatabase;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(migrations);
  state.adapter = {
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    batch: async (statements: Array<{ sql: string; params: unknown[] }>) =>
      statements.map(({ sql, params }) => {
        db.prepare(sql).run(...params);
        return { success: true };
      }),
  };
  for (const [tenant, account] of [
    ['tenant-a', 'user-1'],
    ['tenant-a', 'user-2'],
    ['tenant-b', 'user-1'],
  ]) {
    db.prepare(`INSERT INTO mapped_identifier_values VALUES (?, 'store', 'aud', ?, ?, 1, 1)`).run(
      tenant,
      account,
      `id-${tenant}-${account}`
    );
    db.prepare(`INSERT INTO identifier_source_values VALUES (?, 'src', ?, ?, 1, 1)`).run(
      tenant,
      account,
      `v-${tenant}-${account}`
    );
  }
});
afterEach(() => db.close());

const remaining = (table: string) =>
  db.prepare(`SELECT tenant_id, account_id FROM ${table} ORDER BY 1, 2`).all();

describe('erasing an account with its identifier material', () => {
  it("erases the account's stored identifiers and identifier-source values, and only those", async () => {
    await eraseAccountIdentifierValues(env, { tenantId: 'tenant-a', userId: 'user-1' });
    const expected = [
      { tenant_id: 'tenant-a', account_id: 'user-2' },
      { tenant_id: 'tenant-b', account_id: 'user-1' },
    ];
    expect(remaining('mapped_identifier_values')).toEqual(expected);
    expect(remaining('identifier_source_values')).toEqual(expected);
    // Moved to retired records, as HMACs only: no value, no account.
    const retired = db.prepare('SELECT * FROM retired_identifier_values ORDER BY kind').all();
    expect(retired).toHaveLength(2);
    expect(JSON.stringify(retired)).not.toMatch(/id-tenant|v-tenant|user-1/);
    expect(retired.map((row) => (row as { kind: string }).kind)).toEqual(['source', 'stored']);
  });

  it('is idempotent, and retires each value once', async () => {
    const run = () => eraseAccountIdentifierValues(env, { tenantId: 'tenant-a', userId: 'user-1' });
    await run();
    await run();
    expect(remaining('identifier_source_values')).toHaveLength(2);
    expect(db.prepare('SELECT * FROM retired_identifier_values').all()).toHaveLength(2);
  });

  it('fails when a statement fails, so the deletion is not reported done', async () => {
    state.adapter = {
      query: async (sql: string) =>
        sql.includes('mapped_identifier_values')
          ? [{ store_name: 's', audience: 'a', identifier: 'x' }]
          : [],
      batch: async () => [{ success: false }],
    };
    await expect(
      eraseAccountIdentifierValues(env, { tenantId: 'tenant-a', userId: 'user-1' })
    ).rejects.toThrow('account_identifier_erasure_failed');
  });
});
