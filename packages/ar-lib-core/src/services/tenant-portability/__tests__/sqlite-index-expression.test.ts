import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { inspectBackupSchema } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { assessSnapshotTable } from '../sqlite-schema-assessment';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  sqliteSnapshotPageQuery,
} from '../sqlite-snapshot';
import { snapshotUniqueTermSql } from '../sqlite-index-expression';

it.each(['INSERT OR REPLACE', 'UPDATE OR REPLACE'])(
  'retains COALESCE conflicts for %s with recursive delete triggers disabled',
  (operation) => {
    const sql = `CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,subject_id TEXT,value TEXT);
    CREATE UNIQUE INDEX subject_key ON items(tenant_id,COALESCE(subject_id,''));`;
    const result = assessSnapshotTable(inspectBackupSchema([sql]).tables[0]);
    expect(result.concerns).toEqual([]);
    const schema = result.schema;
    if (!schema) throw new Error('missing_schema');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(sql + SQLITE_SNAPSHOT_SCHEMA);
      db.exec(`PRAGMA recursive_triggers=OFF;
      INSERT INTO items VALUES ('old','a',NULL,'original'),('other','b',NULL,'private'),('move','a','separate','before-move');`);
      db.exec(sqliteSnapshotTriggers(schema, 'json'));
      db.exec(
        "INSERT INTO tenant_backup_snapshots (id,tenant_id,state) VALUES ('s','a','capturing')"
      );
      if (operation === 'INSERT OR REPLACE')
        db.exec("INSERT OR REPLACE INTO items VALUES ('replacement','a','','new')");
      else db.exec("UPDATE OR REPLACE items SET subject_id='',value='new' WHERE id='move'");
      const records = db
        .prepare(sqliteSnapshotPageQuery(schema, 'json'))
        .all('s', 'a', '', 100)
        .map((row) => JSON.parse(row.row_json as string));
      expect(records).toHaveLength(2);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: ['text', 'old'],
            subject_id: ['null', null],
            value: ['text', 'original'],
          }),
          expect.objectContaining({ id: ['text', 'move'], value: ['text', 'before-move'] }),
        ])
      );
      expect(db.prepare("SELECT value FROM items WHERE tenant_id='b'").get()?.value).toBe(
        'private'
      );
    } finally {
      db.close();
    }
  }
);

it('handles a partial JSON index without evaluating malformed non-indexed JSON', () => {
  const sql = `CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,kind TEXT,config TEXT);
    CREATE UNIQUE INDEX entity_key ON items(tenant_id,json_extract(config,'$.entityId'))
      WHERE kind='saml' AND json_valid(config) AND json_type(config,'$.entityId')='text';`;
  const schema = assessSnapshotTable(inspectBackupSchema([sql]).tables[0]).schema;
  if (!schema) throw new Error('missing_schema');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql + SQLITE_SNAPSHOT_SCHEMA);
    db.exec(
      `INSERT INTO items VALUES ('old','a','saml','{"entityId":"urn:example"}'),('unindexed','a','other','invalid-json'),('other','b','saml','{"entityId":"urn:example"}');`
    );
    db.exec(sqliteSnapshotTriggers(schema, 'json'));
    db.exec(
      "INSERT INTO tenant_backup_snapshots (id,tenant_id,state) VALUES ('s','a','capturing')"
    );
    db.exec(`INSERT OR REPLACE INTO items VALUES ('new','a','saml','{"entityId":"urn:example"}');
      UPDATE items SET config='still-invalid' WHERE id='unindexed';`);
    const records = db
      .prepare(sqliteSnapshotPageQuery(schema, 'json'))
      .all('s', 'a', '', 100)
      .map((row) => JSON.parse(row.row_json as string));
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ['text', 'old'] }),
        expect.objectContaining({ id: ['text', 'unindexed'], config: ['text', 'invalid-json'] }),
      ])
    );
  } finally {
    db.close();
  }
});

it.each([
  'lower(subject_id)',
  "coalesce(subject_id,'fallback')",
  "json_extract(subject_id,'$[0]')",
  'subject_id COLLATE NOCASE',
])('refuses unsupported index semantics: %s', (expression) => {
  const table = inspectBackupSchema([
    `CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT,subject_id TEXT);
      CREATE UNIQUE INDEX unsupported_key ON items(${expression});`,
  ]).tables[0];
  expect(assessSnapshotTable(table).schema).toBeNull();
});
it('rejects untrusted paths or unknown columns at rendering time', () => {
  expect(() =>
    snapshotUniqueTermSql(
      { kind: 'json_extract', column: 'config', path: "$.x'); SELECT 1;--" },
      'NEW',
      ['config']
    )
  ).toThrow('snapshot_invalid_unique_expression');
  expect(() =>
    snapshotUniqueTermSql({ kind: 'coalesce_empty', column: 'unknown' }, 'NEW', ['config'])
  ).toThrow('snapshot_invalid_unique_expression');
});
