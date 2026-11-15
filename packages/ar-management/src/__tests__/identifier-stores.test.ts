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
  adminIdentifierStoreImportHandler,
  adminIdentifierStoresListHandler,
} from '../identifier-stores';

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
app.get('/stores', adminIdentifierStoresListHandler as never);
app.post('/stores/:name/import', adminIdentifierStoreImportHandler as never);
const post = (name: string, body: unknown) =>
  app.request(`/stores/${name}/import`, { method: 'POST', body: JSON.stringify(body) }, env);
const rows = () =>
  db
    .prepare('SELECT audience, account_id, identifier FROM mapped_identifier_values ORDER BY 1, 3')
    .all() as Array<{ audience: string; account_id: string; identifier: string }>;
const SP = 'https://sp.example.org';
const csv = (...lines: string[]) => ['audience,account,identifier', ...lines].join('\n');

describe('identifier store import', () => {
  it('binds each identifier to its account, and echoes nothing back', async () => {
    const response = await post('shibpid', {
      csv: csv(`${SP},user-jdoe,AAAA`, `"${SP}",user-asmith,BBBB`),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ store: 'shibpid', created: 2, replaced: 0, unchanged: 0 });
    expect(text).not.toMatch(/jdoe|AAAA/);
    expect(rows()).toEqual([
      { audience: SP, account_id: 'user-jdoe', identifier: 'AAAA' },
      { audience: SP, account_id: 'user-asmith', identifier: 'BBBB' },
    ]);
    expect(JSON.stringify(state.audit.mock.calls)).not.toMatch(/jdoe|AAAA/);
  });

  it('refuses a row for an account that does not exist, naming the line and never the value', async () => {
    const response = await post('s', {
      csv: csv(`${SP},user-jdoe,AAAA`, `${SP},user-nobody,BBBB`),
    });
    const body = await response.json<{ row_errors?: unknown }>();
    expect(response.status).toBe(400);
    expect(body.row_errors).toEqual([{ row: 3, column: 'account', code: 'unknown_account' }]);
    expect(JSON.stringify(body)).not.toMatch(/nobody|BBBB|AAAA/);
    // All or nothing: the good row is not written either.
    expect(rows()).toHaveLength(0);
  });

  it('refuses when the accounts cannot be checked, writing nothing', async () => {
    state.accountCheckFails = true;
    expect((await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) })).status).toBe(500);
    expect(rows()).toHaveLength(0);
  });

  it('refuses an account written as the canonical account: form or anything not an ID', async () => {
    for (const account of ['account:user-jdoe', 'a b', '']) {
      expect((await post('s', { csv: csv(`${SP},"${account}",AAAA`) })).status).toBe(400);
    }
    expect(rows()).toHaveLength(0);
  });

  it('leaves the same rows alone, and replaces another identifier only when asked', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    expect(await (await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) })).json()).toMatchObject({
      unchanged: 1,
    });
    expect((await post('s', { csv: csv(`${SP},user-jdoe,CCCC`) })).status).toBe(409);
    expect(rows()[0].identifier).toBe('AAAA');
    expect(
      await (await post('s', { csv: csv(`${SP},user-jdoe,CCCC`), replace: true })).json()
    ).toMatchObject({ replaced: 1 });
    expect(rows()[0].identifier).toBe('CCCC');
  });

  it('never gives one identifier to two accounts, in the file or against the store', async () => {
    const twice = await post('s', {
      csv: csv(`${SP},user-jdoe,AAAA`, `${SP},user-asmith,AAAA`),
    });
    expect(twice.status).toBe(400);
    expect((await twice.json<{ row_errors?: unknown }>()).row_errors).toEqual([
      { row: 3, column: 'identifier', code: 'identifier_of_another_account' },
    ]);
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    const taken = await post('s', { csv: csv(`${SP},user-asmith,AAAA`), replace: true });
    expect(taken.status).toBe(409);
    expect(rows()).toHaveLength(1);
    // The same identifier for another audience is someone else's business.
    expect((await post('s', { csv: csv(`https://other.example,user-asmith,AAAA`) })).status).toBe(
      200
    );
  });

  it("never releases one account's row for another: the row is keyed by account", async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    const row = db
      .prepare(
        `SELECT identifier FROM mapped_identifier_values
          WHERE tenant_id = ? AND store_name = ? AND audience = ? AND account_id = ?`
      )
      .get('tenant-a', 's', SP, 'user-asmith');
    expect(row).toBeUndefined();
  });

  it('writes nothing when any row is refused', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    const mixed = await post('s', { csv: csv(`${SP},user-third,DDDD`, `${SP},user-jdoe,EEEE`) });
    expect(mixed.status).toBe(409);
    expect(rows()).toHaveLength(1);
  });

  it('refuses a bad name, header, row or value', async () => {
    for (const [name, body] of [
      ['Bad Name', { csv: csv(`${SP},user-jdoe,b`) }],
      ['s', { csv: 'aud,acc,id\nx,y,z' }],
      // The old header.
      ['s', { csv: 'audience,source_value,identifier\nx,y,z' }],
      ['s', { csv: csv(`${SP},user-jdoe`) }],
      ['s', { csv: csv(`${SP},user-jdoe,`) }],
      ['s', { csv: csv(`${SP},user-jdoe,has space`) }],
      ['s', { csv: csv(`${SP},user-jdoe,b`, `${SP},user-jdoe,c`) }],
      ['s', { csv: csv('"unterminated,a,b') }],
      ['s', { csv: csv(`${SP},user-jdoe,b`), replace: 'yes' }],
    ] as const) {
      expect((await post(name, body)).status, JSON.stringify([name, body])).toBe(400);
    }
    expect(rows()).toHaveLength(0);
  });

  it('refuses control characters and surrounding whitespace in every cell', async () => {
    const cells: Array<[string, string, string]> = [
      // [audience, account, identifier]
      [`"${SP}\n"`, 'user-jdoe', 'AAAA'],
      [`${SP}\u0000`, 'user-jdoe', 'AAAA'],
      [`" ${SP}"`, 'user-jdoe', 'AAAA'],
      [`"${SP} "`, 'user-jdoe', 'AAAA'],
      [SP, '"user-jdoe\t"', 'AAAA'],
      [SP, '" user-jdoe"', 'AAAA'],
      [SP, 'user-jdoe', '"AA\u0007AA"'],
      [SP, 'user-jdoe', '" AAAA"'],
      [SP, 'user-jdoe', '"AAAA\u2028"'],
    ];
    for (const [audience, account, identifier] of cells) {
      const response = await post('s', { csv: csv(`${audience},${account},${identifier}`) });
      expect(response.status, JSON.stringify([audience, account, identifier])).toBe(400);
    }
    expect(rows()).toHaveLength(0);
  });

  it('refuses too long a cell', async () => {
    expect((await post('s', { csv: csv(`${SP},user-jdoe,${'a'.repeat(513)}`) })).status).toBe(400);
    expect((await post('s', { csv: csv(`${'a'.repeat(2049)},user-jdoe,AAAA`) })).status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('lists the stores with counts only', async () => {
    await post('shibpid', { csv: csv(`${SP},user-jdoe,AAAA`, `${SP},user-asmith,BBBB`) });
    const listed = await (await app.request('/stores', undefined, env)).json();
    expect(listed).toEqual({
      stores: [{ name: 'shibpid', count: 2, updatedAt: expect.any(Number) as number }],
    });
  });
});

describe('identifier values that were given to an account stay its own', () => {
  const retiredRows = () => db.prepare('SELECT * FROM retired_identifier_values').all();
  const codes = async (response: Response) =>
    (await response.json<{ row_errors?: Array<{ code: string }> }>()).row_errors?.map(
      (error) => error.code
    );

  it('refuses an identifier another account had before it was replaced', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    expect((await post('s', { csv: csv(`${SP},user-jdoe,BBBB`), replace: true })).status).toBe(200);
    // The old identifier is retired, as an HMAC only.
    expect(retiredRows()).toHaveLength(1);
    expect(JSON.stringify(retiredRows())).not.toContain('AAAA');
    const reuse = await post('s', { csv: csv(`${SP},user-asmith,AAAA`) });
    expect(reuse.status).toBe(400);
    expect(await codes(reuse)).toEqual(['value_retired']);
    expect(rows().map((row) => row.identifier)).toEqual(['BBBB']);
    // Another audience or store is another scope.
    expect((await post('s', { csv: csv(`https://other.example,user-asmith,AAAA`) })).status).toBe(
      200
    );
    expect((await post('t', { csv: csv(`${SP},user-asmith,AAAA`) })).status).toBe(200);
  });

  it('refuses an identifier of an erased account', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    const { eraseAccountIdentifierValues } = await import('../account-identifier-erasure');
    await eraseAccountIdentifierValues(env as never, { tenantId: 'tenant-a', userId: 'user-jdoe' });
    expect(rows()).toHaveLength(0);
    expect(JSON.stringify(retiredRows())).not.toMatch(/AAAA|jdoe/);
    const reuse = await post('s', { csv: csv(`${SP},user-asmith,AAAA`) });
    expect(await codes(reuse)).toEqual(['value_retired']);
    expect(rows()).toHaveLength(0);
  });

  it('takes the same identifier again as no change, and keeps it current', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    const again = await post('s', { csv: csv(`${SP},user-jdoe,AAAA`), replace: true });
    expect(await again.json()).toMatchObject({ unchanged: 1, replaced: 0 });
    expect(retiredRows()).toHaveLength(0);
  });

  it('removes what an import gave an account that was deleted during it', async () => {
    // The account exists at the check before the write, and is gone at the check after it.
    state.accountsAfterFirstCheck = new Set(['user-asmith']);
    const response = await post('s', {
      csv: csv(`${SP},user-jdoe,AAAA`, `${SP},user-asmith,BBBB`),
    });
    expect(response.status).toBe(400);
    const body = await response.json<{ row_errors: unknown[] }>();
    expect(body.row_errors).toEqual([{ row: 2, column: 'account', code: 'unknown_account' }]);
    expect(rows()).toEqual([{ audience: SP, account_id: 'user-asmith', identifier: 'BBBB' }]);
    // What was removed is retired, so it is not handed to anyone else.
    expect(retiredRows()).toHaveLength(1);
    state.accountsAfterFirstCheck = undefined;
    expect(await codes(await post('s', { csv: csv(`${SP},user-third,AAAA`) }))).toEqual([
      'value_retired',
    ]);
  });
});

describe('identifier store import: write-time checks, key, re-check', () => {
  const retiredRows = () => db.prepare('SELECT * FROM retired_identifier_values').all();

  it('rolls the whole batch back when another import replaced the row in between (409)', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,XXXX`) });
    // Between this import's read (XXXX) and its write, another import replaced it with YYYY.
    state.beforeBatch = () =>
      void db
        .prepare(
          `UPDATE mapped_identifier_values SET identifier = 'YYYY' WHERE account_id = 'user-jdoe'`
        )
        .run();
    const response = await post('s', { csv: csv(`${SP},user-jdoe,ZZZZ`), replace: true });
    expect(response.status).toBe(409);
    // Nothing of it was written: not the new identifier, and not a retired record for XXXX.
    expect(rows().map((row) => row.identifier)).toEqual(['YYYY']);
    expect(retiredRows()).toHaveLength(0);
  });

  it('refuses at write time an identifier retired since it was read', async () => {
    state.beforeBatch = () => {
      // Another import retired AAAA between this one's check and its write.
      const hmac = createHmac('sha256', 'test-key')
        .update(`stored\n${'s'}\n${SP}\nAAAA`)
        .digest('hex');
      db.prepare(
        `INSERT INTO retired_identifier_values VALUES ('tenant-a', 'stored', ?, ?, ?, ?, 1)`
      ).run(`s\n${SP}`, hmac, 'b'.repeat(64), state.keyId);
    };
    const response = await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    expect(response.status).toBe(409);
    expect(rows()).toHaveLength(0);
  });

  it('is refused, writing nothing, when the key is missing but values exist', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    // A restore brought the rows without the key manager's key.
    state.keyCreated = false;
    const response = await post('s', { csv: csv(`${SP},user-asmith,BBBB`) });
    expect(response.status).toBe(503);
    expect(rows()).toHaveLength(1);
    expect(state.keyCreated).toBe(false);
  });

  it('is refused when the retired records were made with another key', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    await post('s', { csv: csv(`${SP},user-jdoe,BBBB`), replace: true });
    expect(retiredRows()).toHaveLength(1);
    state.keyId = 'ffffffffffffffff';
    const response = await post('s', { csv: csv(`${SP},user-asmith,CCCC`) });
    expect(response.status).toBe(503);
    expect(rows().map((row) => row.identifier)).toEqual(['BBBB']);
  });

  it('keeps retired records with the id of the key that made them', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    await post('s', { csv: csv(`${SP},user-jdoe,BBBB`), replace: true });
    expect(retiredRows()).toEqual([expect.objectContaining({ key_id: '0123456789abcdef' })]);
  });

  it('still takes back an account deleted during the import when the audit log fails', async () => {
    state.accountsAfterFirstCheck = new Set(['user-asmith']);
    state.audit.mockRejectedValue(new Error('audit down'));
    const response = await post('s', {
      csv: csv(`${SP},user-jdoe,AAAA`, `${SP},user-asmith,BBBB`),
    });
    expect(response.status).toBe(500);
    // The re-check ran before the audit log: the deleted account's identifier is gone.
    expect(rows().map((row) => row.account_id)).toEqual(['user-asmith']);
  });

  it('takes back what it wrote and answers 503 when the re-check cannot be made', async () => {
    state.recheckFails = true;
    const response = await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    expect(response.status).toBe(503);
    expect(rows()).toHaveLength(0);
    // Taken back and retired from the account: the same account takes it again on a re-run.
    expect(retiredRows()).toHaveLength(1);
    state.recheckFails = false;
    expect((await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) })).status).toBe(200);
  });

  it('keeps a value retired by a failed re-check from every other account, and lets the old one come back', async () => {
    // Replace X→Y, the re-check fails (503): Y is taken back and retired, X is retired.
    await post('s', { csv: csv(`${SP},user-jdoe,XXXX`) });
    state.checks = 0;
    state.recheckFails = true;
    expect((await post('s', { csv: csv(`${SP},user-jdoe,YYYY`), replace: true })).status).toBe(503);
    state.recheckFails = false;
    expect(rows()).toHaveLength(0);
    // Another account cannot be given Y (it may have been issued).
    const other = await post('s', { csv: csv(`${SP},user-asmith,YYYY`) });
    expect(other.status).toBe(400);
    expect(rows()).toHaveLength(0);
    // The account's own old value, and the one it was given, are still its own.
    expect((await post('s', { csv: csv(`${SP},user-jdoe,XXXX`) })).status).toBe(200);
    expect(rows().map((row) => row.identifier)).toEqual(['XXXX']);
    expect((await post('s', { csv: csv(`${SP},user-jdoe,YYYY`), replace: true })).status).toBe(200);
  });

  it('lets an account take back an identifier it replaced, and nobody else', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`) });
    await post('s', { csv: csv(`${SP},user-jdoe,BBBB`), replace: true });
    expect((await post('s', { csv: csv(`${SP},user-asmith,AAAA`) })).status).toBe(400);
    expect((await post('s', { csv: csv(`${SP},user-jdoe,AAAA`), replace: true })).status).toBe(200);
    expect(rows().map((row) => row.identifier)).toEqual(['AAAA']);
  });

  it('erases an account while the value key is missing without making a key or retiring', async () => {
    await post('s', { csv: csv(`${SP},user-jdoe,AAAA`, `${SP},user-asmith,CCCC`) });
    await post('s', { csv: csv(`${SP},user-jdoe,BBBB`), replace: true });
    expect(retiredRows()).toHaveLength(1);
    // A restore brought the rows without the key manager's key.
    state.keyCreated = false;
    const { eraseAccountIdentifierValues } = await import('../account-identifier-erasure');
    await eraseAccountIdentifierValues(env as never, { tenantId: 'tenant-a', userId: 'user-jdoe' });
    // The rows are gone; no key was made, nothing new was retired, and the audit log says so.
    expect(rows().map((row) => row.account_id)).toEqual(['user-asmith']);
    expect(state.keyCreated).toBe(false);
    expect(retiredRows()).toHaveLength(1);
    expect(state.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'identifier_values.retirement_skipped',
        severity: 'warning',
      })
    );
    expect(JSON.stringify(state.audit.mock.calls)).not.toMatch(/AAAA|BBBB|CCCC/);
    // Imports are refused while the key is missing, and work again once the original is back.
    expect((await post('s', { csv: csv(`${SP},user-third,DDDD`) })).status).toBe(503);
    state.keyCreated = true;
    expect((await post('s', { csv: csv(`${SP},user-third,DDDD`) })).status).toBe(200);
  });
});
