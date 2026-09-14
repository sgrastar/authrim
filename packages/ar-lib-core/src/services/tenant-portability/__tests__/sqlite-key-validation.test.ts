import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { sqliteSnapshotStartStatement } from '../sqlite-capture-plan';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  sqliteSnapshotPageQuery,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';
import { inspectBackupSchema } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { assessSnapshotTable } from '../../../../../../scripts/tenant-backup/snapshot-applicability';

const schema: SnapshotTableSchema = {
  table: 'items',
  columns: ['id', 'tenant_id', 'value'],
  primaryKey: ['id'],
  uniqueKeys: [],
  tenantColumn: 'tenant_id',
};

describe('DB-enforced snapshot identities', () => {
  it.each(['id TEXT PRIMARY KEY', 'id INTEGER PRIMARY KEY NOT NULL', 'id TEXT NOT NULL UNIQUE'])(
    'refuses an unsupported key definition even when current rows are valid: %s',
    (key) => {
      const ddl = `CREATE TABLE items (${key}, tenant_id TEXT NOT NULL, value TEXT)`;
      const metadata = inspectBackupSchema([ddl]).tables[0];
      expect(assessSnapshotTable(metadata).schema).toBeNull();
      const db = new DatabaseSync(':memory:');
      try {
        db.exec(`${ddl}; ${SQLITE_SNAPSHOT_SCHEMA} ${sqliteSnapshotTriggers(schema)}`);
        db.exec("INSERT INTO items VALUES ('1','a','valid')");
        const start = sqliteSnapshotStartStatement([schema], 's', 'a');
        expect(db.prepare(start.sql).run(...start.params).changes).toBe(0);
        expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_snapshots').get()).toEqual({
          n: 0,
        });
      } finally {
        db.close();
      }
    }
  );

  it('requires every actual composite key component, with its exact position', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        `CREATE TABLE items (id TEXT NOT NULL, tenant_id TEXT NOT NULL, value TEXT, PRIMARY KEY(tenant_id,id)); ${SQLITE_SNAPSHOT_SCHEMA} ${sqliteSnapshotTriggers(schema)}`
      );
      const start = sqliteSnapshotStartStatement([schema], 's', 'a');
      expect(db.prepare(start.sql).run(...start.params).changes).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keeps NULL impossible before, during and after capture for every tenant', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, value TEXT);
        ${SQLITE_SNAPSHOT_SCHEMA} ${sqliteSnapshotTriggers(schema)}
        INSERT INTO items VALUES ('valid','a','before');`);
      const rejectNull = () => {
        for (const tenant of ['a', 'b'])
          expect(() => db.exec(`INSERT INTO items VALUES (NULL,'${tenant}','bad')`)).toThrow(
            /NOT NULL|snapshot_invalid_row_identity/
          );
        expect(() => db.exec("UPDATE items SET id=NULL WHERE id='valid'")).toThrow(
          /NOT NULL|snapshot_invalid_row_identity/
        );
      };
      rejectNull();
      const start = sqliteSnapshotStartStatement([schema], 's', 'a');
      expect(db.prepare(start.sql).run(...start.params).changes).toBe(1);
      rejectNull();
      // DB constraints are permanent; the capture guard additionally prevents
      // conflict-handling modes from journaling an invalid attempted identity.
      expect(() => db.exec("INSERT OR IGNORE INTO items VALUES (NULL,'a','bad')")).toThrow(
        'snapshot_invalid_row_identity'
      );
      expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').get()).toEqual({
        n: 0,
      });
      db.exec("UPDATE items SET value='after' WHERE id='valid'");
      const rows = db.prepare(sqliteSnapshotPageQuery(schema)).all('s', 'a', '', 100);
      expect(rows.map((row) => JSON.parse(String(row.row_json)).value[1])).toEqual(['before']);
      db.exec("UPDATE tenant_backup_snapshots SET state='sealed'");
      rejectNull();
    } finally {
      db.close();
    }
  });
});
