import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  adapter: undefined as Record<string, unknown> | undefined,
  audit: vi.fn(async () => undefined),
  /** The accounts that exist in the tenant. */
  accounts: new Set<string>(),
  accountCheckFails: false,
  /** Whether the key manager has made its value key, and the id it reports. */
  keyCreated: false,
  recheckFails: false,
  keyId: '0123456789abcdef',
  /** Runs just before a batch, to interleave another writer. */
  beforeBatch: undefined as (() => void) | undefined,
  /** When set, the accounts that exist from the second check on (one deleted during the import). */
  accountsAfterFirstCheck: undefined as Set<string> | undefined,
  checks: 0,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuditLog: state.audit,
  getTenantIdFromContext: () => 'tenant-a',
  requireDedicatedAdminDatabaseAdapter: () => state.adapter,
}));
vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountExactSearchService: class {
    async findAdminContacts(input: { userIds: string[] }) {
      if (state.accountCheckFails) throw new Error('registry down');
      state.checks++;
      if (state.checks > 1 && state.recheckFails) throw new Error('registry down');
      const accounts =
        state.checks > 1 && state.accountsAfterFirstCheck
          ? state.accountsAfterFirstCheck
          : state.accounts;
      return new Map(input.userIds.filter((id) => accounts.has(id)).map((id) => [id, {}]));
    }
  },
}));

import {
  adminIdentifierSourceImportHandler,
  adminIdentifierSourcesListHandler,
} from '../identifier-sources';

/** The table as the migrations make it, in SQLite. */
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
/** The part of node:sqlite used here (this package has no Node types). */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const SQLITE_MODULE = 'node:sqlite';
const { DatabaseSync } = (await import(/* @vite-ignore */ SQLITE_MODULE)) as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
let db: SqliteDatabase;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(migrations);
  state.accounts = new Set(['user-jdoe', 'user-asmith', 'user-third']);
  state.accountCheckFails = false;
  state.accountsAfterFirstCheck = undefined;
  state.checks = 0;
  state.keyCreated = false;
  state.recheckFails = false;
  state.keyId = '0123456789abcdef';
  state.beforeBatch = undefined;
  state.audit.mockReset();
  state.audit.mockResolvedValue(undefined);
  state.adapter = {
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null,
    batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
      const hook = state.beforeBatch;
      state.beforeBatch = undefined;
      hook?.();
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params }) => db.prepare(sql).run(...params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  state.audit.mockClear();
});
afterEach(() => db.close());

/** A key manager's value HMAC: a keyed hash, so a retired value is never the plain value. */
const keyManager = {
  idFromName: (name: string) => name,
  get: () => ({
    identifierValueHmacsRpc: async (values: string[], options?: { create?: boolean }) => {
      if (!state.keyCreated) {
        if (options?.create !== true) throw new Error('identifier_value_key_missing');
        state.keyCreated = true;
      }
      return {
        keyId: state.keyId,
        hmacs: values.map((value) => createHmac('sha256', 'test-key').update(value).digest('hex')),
      };
    },
  }),
};
const env = { KEY_MANAGER: keyManager };

const app = new Hono();
app.get('/sources', adminIdentifierSourcesListHandler as never);
app.post('/sources/:name/import', adminIdentifierSourceImportHandler as never);
const post = (name: string, body: unknown) =>
  app.request(`/sources/${name}/import`, { method: 'POST', body: JSON.stringify(body) }, env);
const rows = () =>
  db.prepare('SELECT account_id, value FROM identifier_source_values ORDER BY 1').all() as Array<{
    account_id: string;
    value: string;
  }>;
const csv = (...lines: string[]) => ['account,value', ...lines].join('\n');

describe('identifier source import', () => {
  it('binds each value to its account, and echoes nothing back, in the response or the audit log', async () => {
    const response = await post('staff', { csv: csv('user-jdoe,E-1001', '"user-asmith",E-1002') });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ source: 'staff', created: 2, replaced: 0, unchanged: 0 });
    expect(text).not.toMatch(/E-100/);
    expect(rows()).toEqual([
      { account_id: 'user-asmith', value: 'E-1002' },
      { account_id: 'user-jdoe', value: 'E-1001' },
    ]);
    expect(JSON.stringify(state.audit.mock.calls)).not.toMatch(/E-100|jdoe/);
    expect(state.audit.mock.calls).toHaveLength(1);
  });

  it('refuses an account that does not exist as a row error, writing nothing', async () => {
    const response = await post('staff', { csv: csv('user-jdoe,E-1', 'user-nobody,E-2') });
    const body = await response.json<{ row_errors?: unknown }>();
    expect(response.status).toBe(400);
    expect(body.row_errors).toEqual([{ row: 3, column: 'account', code: 'unknown_account' }]);
    expect(JSON.stringify(body)).not.toMatch(/nobody|E-/);
    expect(rows()).toHaveLength(0);
  });

  it('refuses a second value for an account, and one value for two accounts, in the file', async () => {
    const two = await post('staff', { csv: csv('user-jdoe,E-1', 'user-jdoe,E-2') });
    expect((await two.json<{ row_errors?: unknown }>()).row_errors).toEqual([
      { row: 3, column: 'value', code: 'another_value_for_account' },
    ]);
    const shared = await post('staff', { csv: csv('user-jdoe,E-1', 'user-asmith,E-1') });
    expect((await shared.json<{ row_errors?: unknown }>()).row_errors).toEqual([
      { row: 3, column: 'value', code: 'value_of_another_account' },
    ]);
    expect(rows()).toHaveLength(0);
  });

  it('leaves the same rows alone, and replaces another value only when asked', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    expect(await (await post('staff', { csv: csv('user-jdoe,E-1') })).json()).toMatchObject({
      unchanged: 1,
    });
    expect((await post('staff', { csv: csv('user-jdoe,E-9') })).status).toBe(409);
    expect(rows()[0].value).toBe('E-1');
    expect(
      await (await post('staff', { csv: csv('user-jdoe,E-9'), replace: true })).json()
    ).toMatchObject({ replaced: 1 });
    expect(rows()[0].value).toBe('E-9');
  });

  it('never gives a value another account holds, with or without replace', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    for (const replace of [false, true]) {
      expect((await post('staff', { csv: csv('user-asmith,E-1'), replace })).status).toBe(409);
    }
    expect(rows()).toEqual([{ account_id: 'user-jdoe', value: 'E-1' }]);
    // Another source is another namespace.
    expect((await post('other', { csv: csv('user-asmith,E-1') })).status).toBe(200);
  });

  it('refuses a bad name, header, row or value', async () => {
    for (const [name, body] of [
      ['Bad Name', { csv: csv('user-jdoe,E-1') }],
      ['s', { csv: 'acc,val\nx,y' }],
      ['s', { csv: 'audience,account,identifier\nx,y,z' }],
      ['s', { csv: csv('user-jdoe') }],
      ['s', { csv: csv('user-jdoe,') }],
      ['s', { csv: csv('"unterminated,a') }],
      ['s', { csv: csv('user-jdoe,E-1'), replace: 'yes' }],
      ['s', { csv: csv(`user-jdoe,${'a'.repeat(513)}`) }],
    ] as const) {
      expect((await post(name, body)).status, JSON.stringify([name, body])).toBe(400);
    }
    expect(rows()).toHaveLength(0);
  });

  it('refuses control characters and surrounding whitespace in every cell', async () => {
    for (const line of [
      '"user-jdoe\n",E-1',
      'user-jdoe,"E-\u00001"',
      'user-jdoe,"E-1\r"',
      'user-jdoe," E-1"',
      'user-jdoe,"E-1 "',
      '" user-jdoe",E-1',
      'user-jdoe,"E-1\u2028"',
      'user-jdoe,"E-\u009f1"',
    ]) {
      expect((await post('staff', { csv: csv(line) })).status, line).toBe(400);
    }
    expect(rows()).toHaveLength(0);
  });

  it('keeps a value as the text it is: no typing, no parsing', async () => {
    await post('staff', { csv: csv('user-jdoe,007', 'user-asmith,1e3') });
    expect(
      rows()
        .map((row) => row.value)
        .sort()
    ).toEqual(['007', '1e3']);
  });

  it('lists the sources with counts only', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1', 'user-asmith,E-2') });
    const text = await (await app.request('/sources', undefined, env)).text();
    expect(JSON.parse(text)).toEqual({
      sources: [{ name: 'staff', count: 2, updatedAt: expect.any(Number) as number }],
    });
    expect(text).not.toMatch(/E-/);
  });
});

describe('source values that were given to an account stay its own', () => {
  const retiredRows = () => db.prepare('SELECT * FROM retired_identifier_values').all();
  const codes = async (response: Response) =>
    (await response.json<{ row_errors?: Array<{ code: string }> }>()).row_errors?.map(
      (error) => error.code
    );

  it('refuses a value another account had before it was replaced', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    expect((await post('staff', { csv: csv('user-jdoe,E-2'), replace: true })).status).toBe(200);
    expect(retiredRows()).toHaveLength(1);
    expect(JSON.stringify(retiredRows())).not.toContain('E-1');
    const reuse = await post('staff', { csv: csv('user-asmith,E-1') });
    expect(reuse.status).toBe(400);
    expect(await codes(reuse)).toEqual(['value_retired']);
    expect(rows()).toEqual([{ account_id: 'user-jdoe', value: 'E-2' }]);
    // Another source is another scope.
    expect((await post('other', { csv: csv('user-asmith,E-1') })).status).toBe(200);
  });

  it('refuses a value of an erased account', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    const { eraseAccountIdentifierValues } = await import('../account-identifier-erasure');
    await eraseAccountIdentifierValues(env as never, { tenantId: 'tenant-a', userId: 'user-jdoe' });
    expect(rows()).toHaveLength(0);
    expect(JSON.stringify(retiredRows())).not.toMatch(/E-1|jdoe/);
    expect(await codes(await post('staff', { csv: csv('user-asmith,E-1') }))).toEqual([
      'value_retired',
    ]);
  });

  it('takes the same value again as no change, and retires nothing', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    const again = await post('staff', { csv: csv('user-jdoe,E-1'), replace: true });
    expect(await again.json()).toMatchObject({ unchanged: 1, replaced: 0 });
    expect(retiredRows()).toHaveLength(0);
  });

  it('removes what an import gave an account that was deleted during it', async () => {
    state.accountsAfterFirstCheck = new Set(['user-asmith']);
    const response = await post('staff', { csv: csv('user-jdoe,E-1', 'user-asmith,E-2') });
    expect(response.status).toBe(400);
    const body = await response.json<{ row_errors: unknown[] }>();
    expect(body.row_errors).toEqual([{ row: 2, column: 'account', code: 'unknown_account' }]);
    expect(rows()).toEqual([{ account_id: 'user-asmith', value: 'E-2' }]);
    expect(retiredRows()).toHaveLength(1);
    state.accountsAfterFirstCheck = undefined;
    expect(await codes(await post('staff', { csv: csv('user-third,E-1') }))).toEqual([
      'value_retired',
    ]);
  });
});

describe('identifier source import: write-time checks, key, re-check', () => {
  const retiredRows = () => db.prepare('SELECT * FROM retired_identifier_values').all();

  it('rolls the whole batch back when another import replaced the value in between (409)', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    // Between this import's read (E-1) and its write, another import replaced it with E-2: if
    // this one went on, E-2 (possibly in use) would never be retired.
    state.beforeBatch = () =>
      void db
        .prepare(`UPDATE identifier_source_values SET value = 'E-2' WHERE account_id = 'user-jdoe'`)
        .run();
    const response = await post('staff', { csv: csv('user-jdoe,E-3'), replace: true });
    expect(response.status).toBe(409);
    expect(rows()).toEqual([{ account_id: 'user-jdoe', value: 'E-2' }]);
    expect(retiredRows()).toHaveLength(0);
  });

  it('refuses at write time a value retired since it was read', async () => {
    state.beforeBatch = () => {
      const hmac = createHmac('sha256', 'test-key').update('source\nstaff\nE-1').digest('hex');
      db.prepare(
        `INSERT INTO retired_identifier_values VALUES ('tenant-a', 'source', 'staff', ?, ?, ?, 1)`
      ).run(hmac, 'b'.repeat(64), state.keyId);
    };
    expect((await post('staff', { csv: csv('user-jdoe,E-1') })).status).toBe(409);
    expect(rows()).toHaveLength(0);
  });

  it('is refused, writing nothing, when the key is missing but values exist', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    state.keyCreated = false;
    expect((await post('staff', { csv: csv('user-asmith,E-2') })).status).toBe(503);
    expect(rows()).toHaveLength(1);
    expect(state.keyCreated).toBe(false);
  });

  it('is refused when the retired records were made with another key', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    await post('staff', { csv: csv('user-jdoe,E-2'), replace: true });
    state.keyId = 'ffffffffffffffff';
    expect((await post('staff', { csv: csv('user-asmith,E-3') })).status).toBe(503);
    expect(rows()).toEqual([{ account_id: 'user-jdoe', value: 'E-2' }]);
  });

  it('still takes back an account deleted during the import when the audit log fails', async () => {
    state.accountsAfterFirstCheck = new Set(['user-asmith']);
    state.audit.mockRejectedValue(new Error('audit down'));
    const response = await post('staff', { csv: csv('user-jdoe,E-1', 'user-asmith,E-2') });
    expect(response.status).toBe(500);
    expect(rows()).toEqual([{ account_id: 'user-asmith', value: 'E-2' }]);
  });

  it('takes back what it wrote and answers 503 when the re-check cannot be made', async () => {
    state.recheckFails = true;
    expect((await post('staff', { csv: csv('user-jdoe,E-1') })).status).toBe(503);
    expect(rows()).toHaveLength(0);
    // Taken back and retired from the account: the same account takes it again on a re-run.
    expect(retiredRows()).toHaveLength(1);
    state.recheckFails = false;
    expect((await post('staff', { csv: csv('user-jdoe,E-1') })).status).toBe(200);
  });

  it('keeps a value retired by a failed re-check from every other account, and lets the old one come back', async () => {
    await post('staff', { csv: csv('user-jdoe,X-1') });
    state.checks = 0;
    state.recheckFails = true;
    expect((await post('staff', { csv: csv('user-jdoe,Y-1'), replace: true })).status).toBe(503);
    state.recheckFails = false;
    expect(rows()).toHaveLength(0);
    // Another account cannot be given Y-1; the account takes X-1 back, then Y-1.
    expect((await post('staff', { csv: csv('user-asmith,Y-1') })).status).toBe(400);
    expect(rows()).toHaveLength(0);
    expect((await post('staff', { csv: csv('user-jdoe,X-1') })).status).toBe(200);
    expect((await post('staff', { csv: csv('user-jdoe,Y-1'), replace: true })).status).toBe(200);
  });

  it('lets an account take back a value it replaced, and nobody else', async () => {
    await post('staff', { csv: csv('user-jdoe,E-1') });
    await post('staff', { csv: csv('user-jdoe,E-2'), replace: true });
    expect((await post('staff', { csv: csv('user-asmith,E-1') })).status).toBe(400);
    expect((await post('staff', { csv: csv('user-jdoe,E-1'), replace: true })).status).toBe(200);
    expect(rows()).toEqual([{ account_id: 'user-jdoe', value: 'E-1' }]);
  });
});
