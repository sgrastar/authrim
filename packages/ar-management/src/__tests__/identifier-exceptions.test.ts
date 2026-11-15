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
  checks: 0,
  /** The accounts check made after the write fails (the first, before it, does not). */
  recheckFails: false,
  /** When set, the accounts that exist from the second check on (one deleted during the import). */
  accountsAfterFirstCheck: undefined as Set<string> | undefined,
  /** The imported salts the key manager holds. */
  salts: new Set<string>(),
  /** Runs just before a batch, to make it fail. */
  failBatch: false,
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
  adminIdentifierExceptionsImportHandler,
  adminIdentifierExceptionsListHandler,
} from '../identifier-exceptions';
import { eraseAccountIdentifierValues } from '../account-identifier-erasure';
import { createIdentifierExceptionReader } from '@authrim/ar-lib-core';

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
  state.accounts = new Set(['user-jdoe', 'user-asmith']);
  state.accountCheckFails = false;
  state.accountsAfterFirstCheck = undefined;
  state.checks = 0;
  state.recheckFails = false;
  state.salts = new Set(['old-idp', 'other-salt']);
  state.failBatch = false;
  state.audit.mockReset();
  state.audit.mockResolvedValue(undefined);
  state.adapter = {
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null,
    batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params }, index) => {
          if (state.failBatch && index === statements.length - 1) throw new Error('D1 failure');
          return db.prepare(sql).run(...params);
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
});
afterEach(() => db.close());

const keyManager = {
  idFromName: (name: string) => name,
  get: () => ({
    getExistingSecretRpc: async (ref: string) =>
      state.salts.has(ref.replace('identifier-salt:import:', ''))
        ? { active: { value: btoa('salt-bytes') } }
        : null,
    identifierValueHmacsRpc: async () => {
      throw new Error('identifier_value_key_missing');
    },
  }),
};
const env = { KEY_MANAGER: keyManager };

const app = new Hono();
app.get('/exceptions', adminIdentifierExceptionsListHandler as never);
app.post('/exceptions/:name/import', adminIdentifierExceptionsImportHandler as never);
const post = (name: string, body: unknown) =>
  app.request(`/exceptions/${name}/import`, { method: 'POST', body: JSON.stringify(body) }, env);
const csv = (...lines: string[]) => ['account,audience,action,salt', ...lines].join('\n');
const table = () =>
  db
    .prepare(
      'SELECT list_name, account_id, audience, action, salt_name FROM mapped_identifier_exceptions ORDER BY 1, 2, 3'
    )
    .all() as Array<{
    list_name: string;
    account_id: string;
    audience: string;
    action: string;
    salt_name: string | null;
  }>;
const errorsOf = async (response: Response) =>
  (await response.json<{ row_errors?: Array<{ row: number; column: string; code: string }> }>())
    .row_errors ?? [];

describe('identifier exception import', () => {
  it('writes the rows of a list, with `*` for any account and recipient, and echoes no account', async () => {
    const response = await post('list-a', {
      csv: csv(
        'user-jdoe,app.example,salt,old-idp',
        'user-asmith,*,block,',
        '*,https://sp.example.org/shibboleth,salt,other-salt'
      ),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ list: 'list-a', rows: 3, salts: 2, blocks: 1 });
    expect(table()).toEqual([
      {
        list_name: 'list-a',
        account_id: '*',
        audience: 'https://sp.example.org/shibboleth',
        action: 'salt',
        salt_name: 'other-salt',
      },
      {
        list_name: 'list-a',
        account_id: 'user-asmith',
        audience: '*',
        action: 'block',
        salt_name: null,
      },
      {
        list_name: 'list-a',
        account_id: 'user-jdoe',
        audience: 'app.example',
        action: 'salt',
        salt_name: 'old-idp',
      },
    ]);
    // The audit log holds counts only.
    expect(JSON.stringify(state.audit.mock.calls)).not.toContain('user-jdoe');
    expect(JSON.stringify(state.audit.mock.calls)).not.toContain('old-idp');
  });

  it('replaces the whole list, and leaves another list alone', async () => {
    await post('list-a', {
      csv: csv('user-jdoe,app.example,block,', 'user-asmith,app.example,block,'),
    });
    await post('list-b', { csv: csv('user-jdoe,app.example,block,') });
    const response = await post('list-a', { csv: csv('*,*,block,') });
    expect(response.status).toBe(200);
    expect(table().filter((row) => row.list_name === 'list-a')).toEqual([
      { list_name: 'list-a', account_id: '*', audience: '*', action: 'block', salt_name: null },
    ]);
    expect(table().filter((row) => row.list_name === 'list-b')).toHaveLength(1);
  });

  it.each([
    ['an unknown account', 'user-nobody,app.example,block,', 'account', 'unknown_account'],
    ['an invalid action', 'user-jdoe,app.example,allow,', 'action', 'invalid_action'],
    ['a salt action without a salt', 'user-jdoe,app.example,salt,', 'salt', 'required'],
    ['a block with a salt', 'user-jdoe,app.example,block,old-idp', 'salt', 'not_allowed'],
    ['a salt that was not imported', 'user-jdoe,app.example,salt,nowhere', 'salt', 'unknown_salt'],
    ['a bad salt name', 'user-jdoe,app.example,salt,Bad Name', 'salt', 'invalid_salt_name'],
    ['a missing audience', 'user-jdoe,,block,', 'audience', 'required'],
  ])(
    'refuses %s as a row error, writing nothing and keeping the list',
    async (_name, line, column, code) => {
      await post('list-a', { csv: csv('user-asmith,app.example,block,') });
      const before = table();
      const response = await post('list-a', { csv: csv('user-jdoe,other.example,block,', line) });
      expect(response.status).toBe(400);
      expect(await errorsOf(response)).toContainEqual({ row: 3, column, code });
      expect(table()).toEqual(before);
    }
  );

  it('refuses two entries for an account and a recipient, and a bad name, header or row', async () => {
    const dup = await post('list-a', {
      csv: csv('user-jdoe,app.example,block,', 'user-jdoe,app.example,salt,old-idp'),
    });
    expect(await errorsOf(dup)).toContainEqual({ row: 3, column: 'row', code: 'duplicate' });
    expect((await post('Bad_Name', { csv: csv('*,*,block,') })).status).toBe(400);
    expect((await post('list-a', { csv: 'account,value\nuser-jdoe,x' })).status).toBe(400);
    const short = await post('list-a', { csv: csv('user-jdoe,app.example,block') });
    expect(await errorsOf(short)).toContainEqual({ row: 2, column: 'row', code: 'field_count' });
    expect(table()).toEqual([]);
  });

  it('replaces atomically: a failing write leaves the old list as it was (409)', async () => {
    await post('list-a', { csv: csv('user-asmith,app.example,block,') });
    const before = table();
    state.failBatch = true;
    const response = await post('list-a', {
      csv: csv('user-jdoe,app.example,block,', '*,*,block,'),
    });
    expect(response.status).toBe(409);
    expect(table()).toEqual(before);
  });

  it('removes the rows of an account deleted during the import and says so', async () => {
    state.accountsAfterFirstCheck = new Set(['user-asmith']);
    const response = await post('list-a', {
      csv: csv('user-jdoe,app.example,block,', 'user-asmith,app.example,block,', '*,*,block,'),
    });
    expect(response.status).toBe(400);
    expect(await errorsOf(response)).toContainEqual({
      row: 2,
      column: 'account',
      code: 'unknown_account',
    });
    expect(table().map((row) => row.account_id)).toEqual(['*', 'user-asmith']);
  });

  it('writes the audit of a replace even when the accounts cannot be checked again afterwards (503)', async () => {
    state.recheckFails = true;
    const response = await post('list-a', { csv: csv('user-jdoe,app.example,block,') });
    expect(response.status).toBe(503);
    // The list was replaced and stays as written, and the change is on record, with counts only.
    expect(table()).toHaveLength(1);
    expect(state.audit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.audit.mock.calls)).toContain('identifier_exceptions.imported');
    expect(JSON.stringify(state.audit.mock.calls)).not.toContain('user-jdoe');
  });

  it('keeps every row, blocks of live accounts included, when the accounts cannot be checked again (503)', async () => {
    state.accountsAfterFirstCheck = new Set(['user-jdoe']);
    state.recheckFails = true;
    const response = await post('list-a', {
      csv: csv('user-jdoe,app.example,block,', 'user-asmith,app.example,block,', '*,*,block,'),
    });
    expect(response.status).toBe(503);
    // Nothing is dropped: a block must not fail open.
    expect(table().map((row) => row.account_id)).toEqual(['*', 'user-asmith', 'user-jdoe']);
  });

  it('removes the rows of a deleted account at the start of the next import, even one that is then refused', async () => {
    state.accountsAfterFirstCheck = new Set(['user-jdoe']);
    state.recheckFails = true;
    await post('list-a', {
      csv: csv('user-jdoe,app.example,block,', 'user-asmith,app.example,block,', '*,*,block,'),
    });
    expect(table().map((row) => row.account_id)).toContain('user-asmith');

    // The account is gone now; the retry still names it.
    state.accounts = new Set(['user-jdoe']);
    state.accountsAfterFirstCheck = undefined;
    state.recheckFails = false;
    state.checks = 0;
    const retry = await post('list-a', { csv: csv('user-asmith,app.example,block,') });

    expect(retry.status).toBe(400);
    expect(await errorsOf(retry)).toContainEqual({
      row: 2,
      column: 'account',
      code: 'unknown_account',
    });
    // The refused import changed nothing of the list, but the deleted account's rows are gone.
    expect(table().map((row) => row.account_id)).toEqual(['*', 'user-jdoe']);
  });

  it('answers 503 and changes nothing when the accounts of the list cannot be checked at the start', async () => {
    await post('list-a', { csv: csv('user-jdoe,app.example,block,', '*,*,block,') });
    const before = table();
    state.accountCheckFails = true;
    const response = await post('list-a', { csv: csv('user-asmith,app.example,block,') });
    expect(response.status).toBe(503);
    expect(table()).toEqual(before);
  });

  it('empties a list with a header-only CSV, atomically and audited; the other imports still refuse one', async () => {
    await post('list-a', { csv: csv('user-jdoe,app.example,block,', '*,*,block,') });
    await post('list-b', { csv: csv('user-asmith,app.example,block,') });
    state.audit.mockClear();

    const response = await post('list-a', { csv: 'account,audience,action,salt\n' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ list: 'list-a', rows: 0, salts: 0, blocks: 0 });
    expect(table().map((row) => row.list_name)).toEqual(['list-b']);
    expect(state.audit).toHaveBeenCalledTimes(1);
    // A failing empty replace leaves the list as it was.
    state.failBatch = true;
    const failed = await post('list-b', { csv: 'account,audience,action,salt' });
    state.failBatch = false;
    expect(failed.status).toBe(409);
    expect(table().map((row) => row.list_name)).toEqual(['list-b']);
  });

  it('still removes the rows of an account deleted during the import when the audit log fails', async () => {
    state.accountsAfterFirstCheck = new Set(['user-asmith']);
    state.audit.mockRejectedValue(new Error('audit down'));
    const response = await post('list-a', {
      csv: csv('user-jdoe,app.example,block,', 'user-asmith,app.example,block,'),
    });
    // The failure is raised, after the clean-up.
    expect(response.status).toBe(500);
    expect(table().map((row) => row.account_id)).toEqual(['user-asmith']);
  });

  it('lists the lists with counts only', async () => {
    await post('list-a', { csv: csv('user-jdoe,app.example,block,', '*,*,block,') });
    await post('list-b', { csv: csv('user-asmith,app.example,block,') });
    const response = await app.request('/exceptions', { method: 'GET' }, env);
    const body = await response.json<{ lists: Array<{ name: string; count: number }> }>();
    expect(body.lists.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: 'list-a', count: 2 },
      { name: 'list-b', count: 1 },
    ]);
    expect(JSON.stringify(body)).not.toContain('user-jdoe');
  });
});

describe('the reader runs against the real table', () => {
  const reader = () => createIdentifierExceptionReader(state.adapter as never, 'tenant-a');
  const put = (account: string, audience: string, action: 'salt' | 'block', salt: string | null) =>
    db
      .prepare(
        `INSERT INTO mapped_identifier_exceptions
           (tenant_id, list_name, account_id, audience, action, salt_name, created_at)
         VALUES ('tenant-a', 'list-a', ?, ?, ?, ?, 1)`
      )
      .run(account, audience, action, salt);

  it('does not fall through to the `*` account when the account has an entry for another recipient only', async () => {
    put('user-jdoe', 'other.example', 'block', null);
    put('*', 'app.example', 'salt', 'old-idp');
    // The account has its own entries, none for this recipient: the default, not the `*` salt.
    await expect(reader()('list-a', 'user-jdoe', 'app.example')).resolves.toEqual({
      action: 'default',
    });
    // An account without entries of its own reads the `*` ones.
    await expect(reader()('list-a', 'user-asmith', 'app.example')).resolves.toEqual({
      action: 'salt',
      saltName: 'old-idp',
    });
    // The account's own entry for the recipient.
    await expect(reader()('list-a', 'user-jdoe', 'other.example')).resolves.toEqual({
      action: 'block',
    });
  });

  it('reads another list and tenant as nothing', async () => {
    put('*', '*', 'block', null);
    await expect(
      createIdentifierExceptionReader(state.adapter as never, 'tenant-b')(
        'list-a',
        'user-jdoe',
        'x'
      )
    ).resolves.toEqual({ action: 'default' });
    await expect(reader()('list-other', 'user-jdoe', 'x')).resolves.toEqual({ action: 'default' });
  });
});

describe('exceptions are erased with the account', () => {
  it('removes the account’s rows, in every list, and keeps the `*` and other accounts’ rows', async () => {
    await post('list-a', {
      csv: csv(
        'user-jdoe,app.example,block,',
        'user-jdoe,*,salt,old-idp',
        'user-asmith,*,block,',
        '*,*,block,'
      ),
    });
    await post('list-b', { csv: csv('user-jdoe,app.example,block,') });

    await eraseAccountIdentifierValues(env as never, { tenantId: 'tenant-a', userId: 'user-jdoe' });

    expect(table().map((row) => `${row.list_name}:${row.account_id}`)).toEqual([
      'list-a:*',
      'list-a:user-asmith',
    ]);
    // Idempotent.
    await eraseAccountIdentifierValues(env as never, { tenantId: 'tenant-a', userId: 'user-jdoe' });
    expect(table()).toHaveLength(2);
  });
});
