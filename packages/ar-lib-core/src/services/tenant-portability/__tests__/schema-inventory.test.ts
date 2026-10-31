import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectBackupSchema,
  inventoryBackupSchemas,
} from '../../../../../../scripts/tenant-backup/schema-inventory';

const repositoryRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));

function withMigrationFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'authrim-backup-schema-'));
  try {
    cpSync(join(repositoryRoot, 'migrations'), join(root, 'migrations'), { recursive: true });
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('tenant backup executable schema inventory', () => {
  it('uses the manifest selection and reports unselected SQL without executing it', () => {
    withMigrationFixture((root) => {
      writeFileSync(join(root, 'migrations/core/d1/999_unselected.sql'), 'INVALID SQL;');
      const inventory = inventoryBackupSchemas(root);
      expect(inventory.productVersion).toBe(
        JSON.parse(readFileSync(join(root, 'migrations/release-manifest.draft.json'), 'utf8'))
          .productVersion
      );
      expect(inventory.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      const core = inventory.inspectedStreams.find((stream) => stream.id === 'core-d1')!;
      expect(core.unselectedMigrationFiles).toContain('999_unselected.sql');
      expect(core.migrations.some((file) => file.file.endsWith('999_unselected.sql'))).toBe(false);
    });
  });

  it('rejects modified selected SQL before accepting a stale inventory', () => {
    withMigrationFixture((root) => {
      const baseline = inventoryBackupSchemas(root).inspectedStreams[0].migrations[0].file;
      writeFileSync(join(root, baseline), 'CREATE TABLE unexpected (id TEXT);');
      expect(() => inventoryBackupSchemas(root)).toThrow('backup_schema_checksum_mismatch');
    });
  });

  it('inventories the final schema, including renames and composite ownership references', () => {
    const result = inspectBackupSchema([
      `CREATE TABLE parents (tenant TEXT, id TEXT, PRIMARY KEY (tenant, id));
       CREATE TABLE temporary_child (
         tenant TEXT, parent TEXT, value TEXT,
         FOREIGN KEY (tenant, parent) REFERENCES parents (tenant, id) ON DELETE CASCADE
       );
       CREATE TABLE obsolete (id TEXT);`,
      `ALTER TABLE temporary_child RENAME TO children;
       ALTER TABLE children ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
       DROP TABLE obsolete;
       CREATE INDEX child_parent ON children (tenant, parent);
       CREATE VIEW child_view AS SELECT * FROM children;`,
    ]);
    expect(result.tables.map((table) => table.name)).toEqual(['children', 'parents']);
    expect(result.tables[0].foreignKeys).toEqual([
      {
        id: 0,
        position: 0,
        parentTable: 'parents',
        column: 'tenant',
        parentColumn: 'tenant',
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
      {
        id: 0,
        position: 1,
        parentTable: 'parents',
        column: 'parent',
        parentColumn: 'id',
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ]);
    expect(result.tables[0].columns.at(-1)).toMatchObject({
      name: 'enabled',
      notNull: true,
      defaultSql: '1',
      generated: false,
    });
    expect(result.tables[1].columns.map((column) => column.primaryKeyPosition)).toEqual([1, 2]);
    expect(result.objects.map((object) => [object.type, object.name])).toEqual([
      ['index', 'child_parent'],
      ['view', 'child_view'],
    ]);
  });

  it('distinguishes generated columns and handles identifiers without SQL interpolation', () => {
    const result = inspectBackupSchema([
      `CREATE TABLE "owner's files" (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         bytes INTEGER,
         doubled INTEGER GENERATED ALWAYS AS (bytes * 2) STORED
       );`,
    ]);
    expect(result.tables.map((table) => table.name)).toEqual(["owner's files"]);
    expect(result.tables[0].columns.find((column) => column.name === 'doubled')?.generated).toBe(
      true
    );
  });

  it('retains unique-index expressions, predicates, and collations for adapter selection', () => {
    const result = inspectBackupSchema([
      `
      CREATE TABLE items (tenant_id TEXT NOT NULL, id TEXT NOT NULL, code TEXT,
        PRIMARY KEY (tenant_id, id)) WITHOUT ROWID;
      CREATE UNIQUE INDEX item_code ON items (tenant_id, code COLLATE NOCASE) WHERE code IS NOT NULL;
      CREATE UNIQUE INDEX item_normalized ON items (tenant_id, COALESCE(code, ''));
    `,
    ]);
    expect(result.tables[0].withoutRowid).toBe(true);
    expect(result.tables[0].indexes.find((index) => index.name === 'item_code')).toMatchObject({
      unique: true,
      partial: true,
      columns: expect.arrayContaining([
        expect.objectContaining({ name: 'code', collation: 'NOCASE', key: true }),
      ]),
    });
    expect(
      result.tables[0].indexes.find((index) => index.name === 'item_normalized')
    ).toMatchObject({
      unique: true,
      partial: false,
      columns: expect.arrayContaining([expect.objectContaining({ name: null, key: true })]),
    });
  });

  it('rejects a failed migration instead of publishing a partial schema', () => {
    expect(() =>
      inspectBackupSchema(['CREATE TABLE kept (id TEXT);', 'ALTER TABLE absent ADD x TEXT;'])
    ).toThrow();
    expect(
      inspectBackupSchema(['CREATE TABLE fresh (id TEXT);']).tables.map((table) => table.name)
    ).toEqual(['fresh']);
  });

  it('executes every current D1 stream and explicitly leaves PostgreSQL unverified', () => {
    const inventory = inventoryBackupSchemas(repositoryRoot);
    expect(inventory.inspectedStreams.map((stream) => stream.id)).toEqual([
      'core-d1',
      'pii-d1',
      'admin-d1',
      'control-d1',
      'lookup-d1',
      'plugin-runner-d1',
    ]);
    expect(inventory.uninspectedStreams).toEqual([
      { id: 'core-postgresql', reason: 'requires_native_backend_schema_inspection' },
      { id: 'pii-postgresql', reason: 'requires_native_backend_schema_inspection' },
    ]);
    const core = inventory.inspectedStreams.find((stream) => stream.id === 'core-d1')!;
    expect(core.tables.some((table) => table.name === 'identity_accounts')).toBe(true);
    expect(core.tables.some((table) => table.name === 'anonymous_devices')).toBe(false);
    expect(
      core.tables
        .find((table) => table.name === 'identity_accounts')
        ?.columns.some((column) => column.name === 'registration_state')
    ).toBe(true);
    for (const stream of inventory.inspectedStreams) {
      expect(stream.tables.length).toBeGreaterThan(0);
      for (const migration of stream.migrations) expect(migration.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
