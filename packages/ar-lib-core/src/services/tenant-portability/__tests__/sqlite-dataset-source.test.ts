import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { readSqliteSnapshotDataset, readNextSqliteSnapshotChunk } from '../sqlite-dataset-source';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';
import { TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES } from '../bundle-codec';
const schema: SnapshotTableSchema = {
  table: 'accounts',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'id', 'value', 'amount', 'blob'],
  primaryKey: ['tenant_id', 'id'],
  uniqueKeys: [],
};
let db: DatabaseSync;
let database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE accounts(tenant_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT,amount INTEGER,blob BLOB,PRIMARY KEY(tenant_id,id));${SQLITE_SNAPSHOT_SCHEMA}${sqliteSnapshotTriggers(schema)}`
  );
  database = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
  };
});
afterEach(() => db.close());
function source(tenantId = 'a') {
  return readSqliteSnapshotDataset({
    database,
    schema,
    snapshotId: 'snapshot',
    tenantId,
    signal: new AbortController().signal,
  });
}
async function text(source: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let value = '';
  for await (const chunk of source) {
    expect(chunk.length).toBeLessThanOrEqual(TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES);
    value += decoder.decode(chunk, { stream: true });
  }
  return value + decoder.decode();
}
it('keeps the start boundary through updates and deletion between pages', async () => {
  for (let i = 0; i < 105; i++)
    db.prepare("INSERT INTO accounts VALUES (?,?,?,9007199254740993,X'00ff')").run(
      'a',
      String(i).padStart(3, '0'),
      'before'
    );
  db.exec(
    "INSERT INTO accounts VALUES ('b','000','other',0,NULL); INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('snapshot','a','capturing');"
  );
  const generator = source();
  const first = await generator.next();
  expect(first.done).toBe(false);
  db.exec(
    "UPDATE accounts SET value='after' WHERE tenant_id='a'; DELETE FROM accounts WHERE tenant_id='a' AND id='104'; INSERT INTO accounts VALUES ('a','new','new',0,NULL);"
  );
  const rows = (new TextDecoder().decode(first.value) + (await text(generator)))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(rows).toHaveLength(105);
  for (const row of rows) {
    expect(row.tenant_id).toEqual(['text', 'a']);
    expect(row.value).toEqual(['text', 'before']);
    expect(row.amount).toEqual(['integer', '9007199254740993']);
    expect(row.blob).toEqual(['blob', '00FF']);
  }
});
it('continues byte-limited pages and splits multibyte rows across codec chunks', async () => {
  const value = '界'.repeat(1024 * 1024);
  for (let i = 0; i < 3; i++)
    db.prepare('INSERT INTO accounts VALUES (?,?,?,0,NULL)').run('a', String(i), value);
  db.exec(
    "INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('snapshot','a','capturing')"
  );
  const rows = (await text(source()))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.id[1])).toEqual(['0', '1', '2']);
  expect(rows.every((row) => row.value[1] === value)).toBe(true);
});
it('does not mistake absent or invalidated snapshots for successful empty datasets', async () => {
  await expect(text(source())).rejects.toThrow('backup_snapshot_unavailable');
  db.exec(
    "INSERT INTO accounts VALUES ('a','0','value',0,NULL); INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('snapshot','a','capturing')"
  );
  await expect(text(source('b'))).rejects.toThrow('backup_snapshot_unavailable');
  const query = database.query;
  database.query = async <T>(sql: string, params?: unknown[]) => {
    const rows = await query<T>(sql, params);
    db.exec("UPDATE tenant_backup_snapshots SET state='invalid'");
    return rows;
  };
  await expect(text(source())).rejects.toThrow('backup_snapshot_unavailable');
});
it('stops on cancellation before reading storage', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    text(
      readSqliteSnapshotDataset({
        database,
        schema,
        snapshotId: 'snapshot',
        tenantId: 'a',
        signal: controller.signal,
      })
    )
  ).rejects.toThrow();
});
it('streams expanded rows larger than the page budget without returning the full JSON to the Worker', async () => {
  const value = '\u0001'.repeat(2 * 1024 * 1024);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,0,NULL)').run('a', '0', value);
  db.exec(
    "INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('snapshot','a','capturing')"
  );
  const query = database.query;
  const queryOne = database.queryOne;
  let fragments = 0;
  database.query = async <T>(sql: string, params?: unknown[]) => {
    const rows = await query<T>(sql, params);
    for (const row of rows as { row_json?: unknown; row_type: string }[]) {
      expect(row.row_json).toBeUndefined();
      expect(row.row_type).toBe('blob');
    }
    return rows;
  };
  database.queryOne = async <T>(sql: string, params?: unknown[]) => {
    const result = await queryOne<T>(sql, params);
    if (sql.includes('AS fragment')) {
      fragments++;
      expect((result as { fragment: string }).fragment.length).toBeLessThanOrEqual(512 * 1024);
    }
    return result;
  };
  const rows = (await text(source()))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(rows).toHaveLength(1);
  expect(rows[0].value).toEqual(['text', value]);
  expect(fragments).toBeGreaterThan(8);
});

it('reads legacy JSON preimages alongside new binary live rows', async () => {
  db.exec(
    "INSERT INTO accounts VALUES ('a','0','before',0,NULL),('a','1','live',0,NULL); INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('snapshot','a','capturing');"
  );
  const legacy = {
    tenant_id: ['text', 'a'],
    id: ['text', '0'],
    value: ['text', 'before'],
    amount: ['integer', '0'],
    blob: ['null', null],
  };
  db.prepare(
    'INSERT INTO tenant_backup_preimages(snapshot_id,source_table,record_key,present,row_json) VALUES (?,?,?,?,?)'
  ).run(
    'snapshot',
    'accounts',
    JSON.stringify([
      ['text', 'a'],
      ['text', '0'],
    ]),
    1,
    JSON.stringify(legacy)
  );
  db.exec("UPDATE accounts SET value='after' WHERE id='0'");
  const rows = (await text(source()))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(rows.map((row) => row.value)).toEqual([
    ['text', 'before'],
    ['text', 'live'],
  ]);
});

it('reopens after every chunk including inside a Unicode row and preserves the original data', async () => {
  const value = '界'.repeat(200000);
  db.prepare("INSERT INTO accounts VALUES ('a','0',?,0,NULL)").run(value);
  db.exec(
    "INSERT INTO accounts VALUES ('a','1','second',0,NULL); INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('snapshot','a','capturing')"
  );
  const input = {
    database,
    schema,
    snapshotId: 'snapshot',
    tenantId: 'a',
    signal: new AbortController().signal,
  };
  let cursor: string | null = null;
  const bytes: Uint8Array[] = [];
  for (let step = 0; step < 20; step++) {
    const next = await readNextSqliteSnapshotChunk(input, cursor);
    if (!next) break;
    const retry = await readNextSqliteSnapshotChunk(input, cursor);
    expect(retry).toEqual(next);
    bytes.push(next.bytes);
    cursor = next.nextCursor;
    if (step === 0)
      db.exec(
        "UPDATE accounts SET value='changed'; DELETE FROM accounts WHERE id='1'; INSERT INTO accounts VALUES ('a','new','new',0,NULL)"
      );
  }
  expect(bytes.length).toBeGreaterThan(2);
  async function* collected() {
    yield* bytes;
  }
  const rows = (await text(collected()))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(rows.map((row) => row.value[1])).toEqual([value, 'second']);
});
it('rejects a cursor past the current row instead of silently ending the dataset', async () => {
  db.exec(
    "INSERT INTO accounts VALUES ('a','0','value',0,NULL); INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('snapshot','a','capturing')"
  );
  const input = {
    database,
    schema,
    snapshotId: 'snapshot',
    tenantId: 'a',
    signal: new AbortController().signal,
  };
  for (const cursor of ['null', '{}', '{"after":"","chunk":-1}', '{"after":"","chunk":999}'])
    await expect(readNextSqliteSnapshotChunk(input, cursor)).rejects.toThrow('invalid_cursor');
});

it('streams only the installed logical partition from live rows and preimages', async () => {
  const partitioned: SnapshotTableSchema = {
    table: 'permissions',
    tenantColumn: 'tenant_id',
    columns: ['id', 'tenant_id', 'subject_type', 'value'],
    primaryKey: ['id'],
    uniqueKeys: [],
    rowPartition: { column: 'subject_type', values: ['user', 'role', 'org'] },
  };
  db.exec(`CREATE TABLE permissions(
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      value TEXT NOT NULL
    );
    ${sqliteSnapshotTriggers(partitioned)}
    INSERT INTO permissions VALUES
      ('u','a','user','user-before'),
      ('r','a','role','role-before'),
      ('o','a','org','org-before');
    INSERT INTO tenant_backup_snapshots(id,tenant_id,state)
      VALUES ('partition-snapshot','a','capturing');
    UPDATE permissions SET value='changed' WHERE id IN ('u','r');`);
  const read = (partitions: string[]) =>
    text(
      readSqliteSnapshotDataset({
        database,
        schema: partitioned,
        snapshotId: 'partition-snapshot',
        tenantId: 'a',
        partitions,
        signal: new AbortController().signal,
      })
    );
  const settings = (await read(['role', 'org']))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  const users = (await read(['user']))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(settings.map((row) => row.value[1]).sort()).toEqual(['org-before', 'role-before']);
  expect(users.map((row) => row.value[1])).toEqual(['user-before']);
});
