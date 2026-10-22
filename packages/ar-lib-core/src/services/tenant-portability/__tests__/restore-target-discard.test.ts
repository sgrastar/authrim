import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  hasTenantDiscardRemaining,
  planTenantDiscard,
  runTenantDiscardPage,
  type TenantDiscardDataset,
} from '../restore-target-discard';
import { readBackupSqliteSchema, readBackupSqliteSchemaDefinitions } from '../sqlite-schema-reader';

let db: DatabaseSync;
const signal = new AbortController().signal;
const identity = { tenantId: 'a', tenantKey: 'key-a' };

function adapter() {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
}

function dataset(
  table: string,
  columns: string[],
  kind: TenantDiscardDataset['kind'] = 'settings',
  deferredColumns: string[] = []
): TenantDiscardDataset {
  return {
    id: `admin.${table}`,
    kind,
    capture: { table, columns, primaryKey: ['id'], uniqueKeys: [], tenantColumn: 'tenant_id' },
    referenceOnly: false,
    deferredColumns,
  };
}

async function plan(datasets: TenantDiscardDataset[]) {
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")
    .all() as { name: string }[];
  const schema = await Promise.all(
    tables.map(({ name }) => readBackupSqliteSchema(adapter(), name))
  );
  return planTenantDiscard({ family: 'admin', schema, datasets, identity });
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
});
afterEach(() => db.close());

it('clears self references, deletes children first and leaves other tenants alone', async () => {
  db.exec(`
    CREATE TABLE groups(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_id TEXT REFERENCES groups(id));
    CREATE TABLE members(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES groups(id));
    INSERT INTO groups VALUES ('g1','a',NULL),('g2','a','g1'),('g3','a','g2'),('gb','b',NULL);
    INSERT INTO members VALUES ('m1','a','g3'),('mb','b','gb');
  `);
  const discard = await plan([
    dataset('groups', ['id', 'tenant_id', 'parent_id']),
    dataset('members', ['id', 'tenant_id', 'group_id']),
  ]);
  expect(discard.tables.map(({ table }) => table)).toEqual(['members', 'groups']);
  expect(discard.tables[1].detachColumns).toEqual(['parent_id']);
  for (let i = 0; i < 5; i++) {
    const page = await runTenantDiscardPage({
      database: adapter(),
      plan: discard,
      authorize: async () => {},
      signal,
      statements: 1,
    });
    if (page.done) break;
    expect(page).not.toHaveProperty('blocked');
  }
  expect(await hasTenantDiscardRemaining(adapter(), discard)).toBe(false);
  expect(db.prepare('SELECT id FROM groups UNION ALL SELECT id FROM members').all()).toEqual([
    { id: 'gb' },
    { id: 'mb' },
  ]);
});

it('keeps a row a cascade would take from another tenant and reports it', async () => {
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    INSERT INTO users VALUES ('u1','a'),('u2','a');
    INSERT INTO sessions VALUES ('s-own','a','u2'),('s-foreign','b','u1');
  `);
  const discard = await plan([dataset('users', ['id', 'tenant_id'])]);
  const result = await runTenantDiscardPage({
    database: adapter(),
    plan: discard,
    authorize: async () => {},
    signal,
  });
  expect(result).toEqual({
    done: false,
    blocked: { table: 'users', reason: 'foreign_reference' },
  });
  // u2 and its own session went; u1 stays for the foreign session.
  expect(db.prepare('SELECT id FROM users').all()).toEqual([{ id: 'u1' }]);
  expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's-foreign' }]);
});

it('follows a cascade through a deleted child to a foreign grandchild', async () => {
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    CREATE TABLE tokens(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE uses(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE SET NULL);
    INSERT INTO users VALUES ('u1','a');
    INSERT INTO tokens VALUES ('t1','a','u1');
    INSERT INTO uses VALUES ('x1','b','t1');
  `);
  const discard = await plan([dataset('users', ['id', 'tenant_id'])]);
  const result = await runTenantDiscardPage({
    database: adapter(),
    plan: discard,
    authorize: async () => {},
    signal,
  });
  expect(result).toMatchObject({ blocked: { table: 'users', reason: 'foreign_reference' } });
  expect(db.prepare('SELECT token_id FROM uses').get()).toEqual({ token_id: 't1' });
});

it('stops on a kept row that restricts the delete', async () => {
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    CREATE TABLE history(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id));
    INSERT INTO users VALUES ('u1','a');
    INSERT INTO history VALUES ('h1','a','u1');
  `);
  const discard = await plan([
    dataset('users', ['id', 'tenant_id']),
    dataset('history', ['id', 'tenant_id', 'user_id'], 'history'),
  ]);
  expect(discard.tables.map(({ table }) => table)).toEqual(['users']);
  expect(
    await runTenantDiscardPage({
      database: adapter(),
      plan: discard,
      authorize: async () => {},
      signal,
    })
  ).toEqual({ done: false, blocked: { table: 'users', reason: 'restricted' } });
  expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
});

it('is not blocked when an earlier cleanup lease deletes the same rows meanwhile', async () => {
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    INSERT INTO users VALUES ('u1','a'),('u2','a');
  `);
  const discard = await plan([dataset('users', ['id', 'tenant_id'])]);
  const database = adapter();
  const queryOne = database.queryOne;
  let raced = false;
  database.queryOne = async (sql, params) => {
    // The stale worker's delete lands right after this worker found rows to delete.
    if (!raced && sql.includes('count(*)')) {
      raced = true;
      db.exec('DELETE FROM users');
    }
    return queryOne(sql, params);
  };
  expect(
    await runTenantDiscardPage({ database, plan: discard, authorize: async () => {}, signal })
  ).toEqual({ done: true });
});

it('checks the cleanup lease before every write and stops when it is lost', async () => {
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    INSERT INTO users VALUES ('u1','a');
  `);
  const discard = await plan([dataset('users', ['id', 'tenant_id'])]);
  await expect(
    runTenantDiscardPage({
      database: adapter(),
      plan: discard,
      authorize: async () => {
        throw new Error('backup_import_discard_fenced');
      },
      signal,
    })
  ).rejects.toThrow('backup_import_discard_fenced');
  expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
});

it('writes nothing once DDL changed the schema the plan was made against', async () => {
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    INSERT INTO users VALUES ('u1','a');
  `);
  const discard = await plan([dataset('users', ['id', 'tenant_id'])]);
  db.exec(`
    CREATE TABLE grants(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT);
    INSERT INTO grants VALUES ('g-b','b','u1');
  `);
  const { definitions } = await readBackupSqliteSchemaDefinitions(adapter(), signal);
  // Same length, other action: deleting u1 would now cascade into tenant b's grant.
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE grants_next(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    INSERT INTO grants_next SELECT * FROM grants;
    DROP TABLE grants;
    ALTER TABLE grants_next RENAME TO grants;
    PRAGMA foreign_keys = ON;
  `);
  expect(
    await runTenantDiscardPage({
      database: adapter(),
      plan: discard,
      authorize: async () => {},
      signal,
      schemaDefinitions: definitions,
    })
  ).toEqual({ done: false });
  expect(db.prepare('SELECT id FROM grants').all()).toEqual([{ id: 'g-b' }]);
  expect(db.prepare('SELECT id FROM users').all()).toEqual([{ id: 'u1' }]);
});
