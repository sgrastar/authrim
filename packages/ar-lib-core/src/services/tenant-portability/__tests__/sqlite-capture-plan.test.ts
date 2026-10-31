import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { inspectBackupSchema } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { splitMigrationSql } from '../../control-plane/migration-sql';
import { sqliteCapturePlan, sqliteSnapshotStartStatement } from '../sqlite-capture-plan';
import { assessSnapshotTable } from '../sqlite-schema-assessment';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggerStatements,
  sqliteSnapshotTriggers,
  type CaptureSchema,
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

  describe('trigger statements', () => {
    const partitioned: SnapshotTableSchema = {
      ...parent,
      table: 'permissions',
      columns: ['id', 'tenant_id', 'subject_type'],
      rowPartition: { column: 'subject_type', values: ['user', 'role', 'org'] },
    };
    const expressionSchema = (() => {
      const result = assessSnapshotTable(
        inspectBackupSchema([
          `CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,subject_id TEXT);
          CREATE UNIQUE INDEX subject_key ON items(tenant_id,COALESCE(subject_id,''));`,
        ]).tables[0]
      );
      if (!result.schema) throw new Error('missing_schema');
      return result.schema;
    })();
    const schemas: Array<[string, CaptureSchema]> = [
      ['plain', parent],
      ['child of a parent', child],
      ['row partition', partitioned],
      ['unique expression', expressionSchema],
    ];

    // The plan used to join the triggers into a script and lex it back into statements. The
    // statements are now built one by one, so this pins that the script still lexes into exactly
    // them: no statement boundary the lexer would see differently from the generator.
    it.each(schemas)('are what the script of the %s splits into', (_name, schema) => {
      for (const representation of ['packed', 'json'] as const) {
        const statements = sqliteSnapshotTriggerStatements(schema, representation);
        expect(statements).toHaveLength(3);
        expect(splitMigrationSql(sqliteSnapshotTriggers(schema, representation))).toEqual(
          statements
        );
      }
    });

    // SHA-256 of the script and of the plan's triggers (name, table, sql), taken from the
    // implementation that built the script as one string and lexed it into statements. The parity
    // test above ignores whitespace, so these are what pin the output byte for byte, in the order of
    // `schemas`.
    const pinned = [
      {
        packed: {
          script: '71ff85b25c582b8f51589193d182b37cc4a6311f4b274fdc87ce485b2a3608cd',
          plan: '2acfca5e4f578752cbcf2af642fd478d93b5538b5beae4e8bc394581f16d0286',
        },
        json: {
          script: '139516224de3099cfa93da8d4deb101ef59d9f3ffc3013430749d6587703c2b2',
          plan: 'e4115442c7c89a9f31429c84f7b403e89b5142e3a399b13e85c1c9919d281875',
        },
      },
      {
        packed: {
          script: '4298a4c907153cec23348bc95b0c4ea8aa37f5f418b0b59c467fa8220034c108',
          plan: 'bac275e01086d60629f0c318bd741450bb38c5a5fc5e7d598bea965d326ef7af',
        },
        json: {
          script: 'c1c0fae122e5d5eb3c4c2a54b3843b13c46b6ac83ca9568a2963386f14e3b78d',
          plan: '679b789eb6ed63362d6dc17b02637d8beb629e872a68fdbd3f29f774855a9f45',
        },
      },
      {
        packed: {
          script: '790088d8e41d32418cdd7c5b123471e9dce79c883e34d70c1d20dda71fdd1c6d',
          plan: '6d94d97e7e6a36ad387e8960b49be3c07d5e2d40ea505442dcf3768130f67a5a',
        },
        json: {
          script: '0fa07cfd9a78d3327713a3f0c69a399da017311997ddf3eba57b1df4ee1561f7',
          plan: 'c8e37f8c6697c0ad9287b26c12a1da472671ced573dc2a2d5a596191eaa2e203',
        },
      },
      {
        packed: {
          script: '01d987b1bbb62d78d6754585f6c3c386896ee87db31b2a69b85a9db270d457d8',
          plan: '3b8e2f5f13655495f678f6f0b624db389087964bdc3fab751f5ac72c8ae60904',
        },
        json: {
          script: 'eea72f17a7a1adc127bd92aeacd626fcc745efd0f1bfa7451b3a217daee57980',
          plan: '53d6b2c67372f5519e440eb693069b1d5b389d7aedd76019efee7e383f9de626',
        },
      },
    ] as const;

    it.each(schemas.map((entry, index) => [...entry, pinned[index]] as const))(
      'keep the output of the %s byte for byte',
      (_name, schema, expected) => {
        const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
        for (const representation of ['packed', 'json'] as const) {
          expect(sha256(sqliteSnapshotTriggers(schema, representation))).toBe(
            expected[representation].script
          );
          expect(sha256(JSON.stringify(sqliteCapturePlan([schema], representation).triggers))).toBe(
            expected[representation].plan
          );
        }
      }
    );

    it.each(schemas)(
      'give the plan the triggers without the trailing semicolon (%s)',
      (_n, schema) => {
        const { triggers, schemas: planned } = sqliteCapturePlan([schema]);
        const expected = planned.flatMap((entry) =>
          splitMigrationSql(sqliteSnapshotTriggers(entry)).map((sql) => sql.replace(/;+$/, ''))
        );
        expect(triggers.map((trigger) => trigger.sql)).toEqual(expected);
      }
    );

    it('refuses a trigger beyond the statement size every migration statement is held to', () => {
      const columns = Array.from({ length: 400 }, (_, index) => `column_with_a_long_name_${index}`);
      const wide: SnapshotTableSchema = {
        ...parent,
        table: 'wide_items',
        columns: ['id', 'tenant_id', ...columns],
      };
      expect(() => sqliteCapturePlan([wide])).toThrow('migration_sql_statement_too_large');
    });
  });
});
