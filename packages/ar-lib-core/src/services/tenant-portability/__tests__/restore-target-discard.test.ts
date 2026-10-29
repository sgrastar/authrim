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

it('blocks consent authority before partially deleting any ordinary restored data', async () => {
  db.exec(`CREATE TABLE user_consent_records(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);
    INSERT INTO user_consent_records VALUES('record','a');
    CREATE TABLE statement_consent_key_states(tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,statement_id TEXT NOT NULL,PRIMARY KEY(tenant_id,user_id,statement_id)) WITHOUT ROWID;
    INSERT INTO statement_consent_key_states VALUES('a','u','s');`);
  const schema = await Promise.all(
    ['user_consent_records', 'statement_consent_key_states'].map((table) =>
      readBackupSqliteSchema(adapter(), table)
    )
  );
  const records = dataset('user_consent_records', ['id', 'tenant_id'], 'users');
  const keys = dataset(
    'statement_consent_key_states',
    ['tenant_id', 'user_id', 'statement_id'],
    'users'
  );
  const datasets: TenantDiscardDataset[] = [
    { ...records, id: 'core.user_consent_records' },
    {
      ...keys,
      id: 'core.statement_consent_key_states',
      capture: { ...keys.capture, primaryKey: ['tenant_id', 'user_id', 'statement_id'] },
    },
  ];
  const discard = planTenantDiscard({ family: 'core', schema, datasets, identity });
  expect(
    await runTenantDiscardPage({
      database: adapter(),
      plan: discard,
      authorize: async () => {},
      signal,
    })
  ).toEqual({
    done: false,
    blocked: { table: 'statement_consent_key_states', reason: 'restricted' },
  });
  expect(db.prepare('SELECT count(*) AS n FROM user_consent_records').get()).toEqual({ n: 1 });
});

it('keeps immutable Guest denials while discarding ordinary restored lifecycle rows', async () => {
  db.exec(`CREATE TABLE guest_account_lifecycle(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,phase TEXT NOT NULL);
    INSERT INTO guest_account_lifecycle VALUES ('active','a','active'),('finalized','a','registered'),('pending','a','deleting'),('gone','a','deleted'),('foreign','b','active');
    CREATE TRIGGER keep_guest_denial BEFORE DELETE ON guest_account_lifecycle WHEN OLD.phase IN ('deleting','deleted') BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TABLE guest_core_mutation_epoch(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO guest_core_mutation_epoch VALUES(1,7);`);
  const schema = await Promise.all(
    ['guest_account_lifecycle', 'guest_core_mutation_epoch'].map((name) =>
      readBackupSqliteSchema(adapter(), name)
    )
  );
  const lifecycle = {
    ...dataset('guest_account_lifecycle', ['id', 'tenant_id', 'phase'], 'users'),
    id: 'core.guest_account_lifecycle',
  };
  const discard = planTenantDiscard({ family: 'core', schema, datasets: [lifecycle], identity });
  await expect(
    runTenantDiscardPage({ database: adapter(), plan: discard, authorize: async () => {}, signal })
  ).resolves.toEqual({ done: true });
  expect(db.prepare('SELECT id FROM guest_account_lifecycle ORDER BY id').all()).toEqual([
    { id: 'foreign' },
    { id: 'gone' },
    { id: 'pending' },
  ]);
  expect(await hasTenantDiscardRemaining(adapter(), discard)).toBe(false);
  expect(db.prepare('SELECT revision FROM guest_core_mutation_epoch').get()).toEqual({
    revision: 7,
  });
});

it('retains terminal PII markers on cancel without attempting a forbidden DELETE', async () => {
  db.exec(`CREATE TABLE guest_pii_erasure_markers(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,state TEXT NOT NULL);
    INSERT INTO guest_pii_erasure_markers VALUES ('deny','a','deleted');
    CREATE TRIGGER keep_guest_marker BEFORE DELETE ON guest_pii_erasure_markers BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TABLE guest_pii_mutation_epoch(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO guest_pii_mutation_epoch VALUES(1,3);
    CREATE TABLE users_pii(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);
    INSERT INTO users_pii VALUES ('live','a');`);
  const schema = await Promise.all(
    ['guest_pii_erasure_markers', 'guest_pii_mutation_epoch', 'users_pii'].map((name) =>
      readBackupSqliteSchema(adapter(), name)
    )
  );
  const datasets = ['guest_pii_erasure_markers', 'users_pii'].map((table) => ({
    ...dataset(
      table,
      table === 'users_pii' ? ['id', 'tenant_id'] : ['id', 'tenant_id', 'state'],
      'users'
    ),
    id: `pii.${table}`,
  }));
  const discard = planTenantDiscard({ family: 'pii', schema, datasets, identity });
  expect(discard.tables.map((value) => value.table)).toEqual(['users_pii']);
  await expect(
    runTenantDiscardPage({ database: adapter(), plan: discard, authorize: async () => {}, signal })
  ).resolves.toEqual({ done: true });
  expect(db.prepare('SELECT * FROM guest_pii_erasure_markers').all()).toEqual([
    { id: 'deny', tenant_id: 'a', state: 'deleted' },
  ]);
  expect(await hasTenantDiscardRemaining(adapter(), discard)).toBe(false);
});

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
  const queryOne = database.queryOne.bind(database);
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
