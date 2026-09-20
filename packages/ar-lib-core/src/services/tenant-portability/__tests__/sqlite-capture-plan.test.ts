import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { sqliteCapturePlan, sqliteSnapshotStartStatement } from '../sqlite-capture-plan';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  type SnapshotTableSchema,
  type ParentSnapshotTableSchema,
} from '../sqlite-snapshot';

const parent: SnapshotTableSchema = {
  table: 'parents',
  tenantColumn: 'tenant_id',
  columns: ['id', 'tenant_id'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const child: ParentSnapshotTableSchema = {
  table: 'children',
  columns: ['id', 'parent_id'],
  primaryKey: ['id'],
  uniqueKeys: [],
  parent: { schema: parent, childColumns: ['parent_id'] },
};

describe('SQLite capture dependency plan', () => {
  it('checks the last chunk too when a large capture plan spans multiple bindings', () => {
    const schemas = Array.from({ length: 60 }, (_, index) => ({
      ...parent,
      table: `items_${index}`,
    }));
    const plan = sqliteCapturePlan(schemas);
    const start = sqliteSnapshotStartStatement(schemas, 'many', 'tenant');
    expect(start.params.length).toBeGreaterThan(3);
    expect(start.params.slice(2).every((value) => Buffer.byteLength(value) <= 256 * 1024)).toBe(
      true
    );
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(SQLITE_SNAPSHOT_SCHEMA);
      for (const schema of schemas)
        db.exec(
          `CREATE TABLE "${schema.table}" (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL)`
        );
      for (const trigger of plan.triggers.slice(0, -1)) db.exec(trigger.sql);
      expect(db.prepare(start.sql).run(...start.params).changes).toBe(0);
      db.exec(plan.triggers[plan.triggers.length - 1].sql);
      const incompleteParams = [...start.params];
      const firstChunk = JSON.parse(incompleteParams[2]) as Array<Record<string, unknown>>;
      delete firstChunk[0].primaryKey;
      incompleteParams[2] = JSON.stringify(firstChunk);
      expect(db.prepare(start.sql).run(...incompleteParams).changes).toBe(0);
      expect(start.sql.length).toBeLessThan(100_000);
      expect(db.prepare(start.sql).run(...start.params).changes).toBe(1);
    } finally {
      db.close();
    }
  });
  it('includes the parent even when only the child was selected', () => {
    const plan = sqliteCapturePlan([child, parent, child]);
    expect(plan.schemas.map((schema) => schema.table)).toEqual(['parents', 'children']);
    expect(plan.triggers.length).toBe(6);
  });
  it('rejects conflicting definitions instead of choosing one silently', () => {
    expect(() => sqliteCapturePlan([child, { ...parent, uniqueKeys: [['tenant_id']] }])).toThrow(
      'conflicting_capture_schema'
    );
    expect(() => sqliteCapturePlan([])).toThrow('empty_capture_plan');
  });
  it('activates only when all expected triggers exist with the exact generated definitions', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE parents (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL);
        CREATE TABLE children (id TEXT NOT NULL PRIMARY KEY, parent_id TEXT NOT NULL);
        ${SQLITE_SNAPSHOT_SCHEMA}`);
      const plan = sqliteCapturePlan([child]);
      const start = sqliteSnapshotStartStatement([child], 'snapshot', 'tenant');
      const activate = () => db.prepare(start.sql).run(...start.params).changes;
      expect(activate()).toBe(0);
      // Child triggers alone cannot protect parent deletion or membership changes.
      for (const trigger of plan.triggers.filter((entry) => entry.table === 'children'))
        db.exec(trigger.sql);
      expect(activate()).toBe(0);
      for (const trigger of plan.triggers.filter((entry) => entry.table === 'parents'))
        db.exec(trigger.sql);
      db.exec(`DROP TRIGGER tenant_backup_parents_delete;
        CREATE TRIGGER tenant_backup_parents_delete BEFORE DELETE ON parents BEGIN SELECT 1; END;`);
      expect(activate()).toBe(0);
      db.exec('DROP TRIGGER tenant_backup_parents_delete');
      db.exec(plan.triggers.find((entry) => entry.name === 'tenant_backup_parents_delete')!.sql);
      expect(activate()).toBe(1);
      expect(db.prepare('SELECT * FROM tenant_backup_snapshots').all()).toEqual([
        { id: 'snapshot', tenant_id: 'tenant', state: 'capturing', tenant_key: null },
      ]);
      expect(activate).toThrow();
    } finally {
      db.close();
    }
  });
  it('pins legacy JSON capture to matching JSON trigger definitions', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE parents (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL);
        ${SQLITE_SNAPSHOT_SCHEMA}`);
      for (const trigger of sqliteCapturePlan([parent], 'json').triggers) db.exec(trigger.sql);
      const packed = sqliteSnapshotStartStatement([parent], 'packed', 'tenant');
      expect(db.prepare(packed.sql).run(...packed.params).changes).toBe(0);
      const json = sqliteSnapshotStartStatement([parent], 'json', 'tenant', undefined, 'json');
      expect(db.prepare(json.sql).run(...json.params).changes).toBe(1);
    } finally {
      db.close();
    }
  });
  it('binds identifiers as data and rejects missing identities', () => {
    const statement = sqliteSnapshotStartStatement([parent], "s' --", "t' --");
    expect(statement.sql).not.toContain("s' --");
    expect(statement.params.slice(0, 2)).toEqual(["s' --", "t' --"]);
    expect(() => sqliteSnapshotStartStatement([parent], '', 't')).toThrow('missing_identity');
  });
});
