import { describe, expect, it } from 'vitest';
import { inspectBackupSchema } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { assessSnapshotTable } from '../../../../../../scripts/tenant-backup/snapshot-applicability';

function assess(sql: string) {
  return assessSnapshotTable(inspectBackupSchema([sql]).tables[0]);
}

describe('snapshot structural applicability', () => {
  it('accepts explicit nonnullable identities and retains all secondary unique keys', () => {
    const result = assess(`CREATE TABLE items (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT, value TEXT);
      CREATE UNIQUE INDEX code_key ON items (tenant_id, code) WHERE code IS NOT NULL;`);
    expect(result.concerns).toEqual([]);
    expect(result.schema).toEqual({
      table: 'items',
      tenantColumn: 'tenant_id',
      columns: ['id', 'tenant_id', 'code', 'value'],
      primaryKey: ['id'],
      uniqueKeys: [['tenant_id', 'code'], ['id']],
    });
  });

  it.each([
    ['missing_primary_key', 'CREATE TABLE items (tenant_id TEXT, value TEXT)'],
    ['nullable_primary_key', 'CREATE TABLE items (id TEXT PRIMARY KEY, tenant_id TEXT)'],
    ['rowid_allocation', 'CREATE TABLE items (id INTEGER PRIMARY KEY, tenant_id TEXT) STRICT'],
    [
      'ownership_adapter_required',
      'CREATE TABLE items (id TEXT NOT NULL PRIMARY KEY, parent_id TEXT)',
    ],
    [
      'unsupported_identifier',
      'CREATE TABLE "odd-name" (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT)',
    ],
    [
      'expression_unique_index',
      `CREATE TABLE items (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT, code TEXT);
      CREATE UNIQUE INDEX normalized ON items (COALESCE(code, ''));`,
    ],
    [
      'nonbinary_unique_index',
      `CREATE TABLE items (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT, code TEXT);
      CREATE UNIQUE INDEX folded ON items (code COLLATE NOCASE);`,
    ],
  ])('requires a specialized adapter for %s', (concern, sql) => {
    const result = assess(sql);
    expect(result.concerns).toContain(concern);
    expect(result.schema).toBeNull();
  });

  it.each(['STRICT', 'WITHOUT ROWID'])(
    'recognizes implicit primary-key nonnull enforcement in %s tables',
    (flags) => {
      expect(
        assess(`CREATE TABLE items (
        tenant_id TEXT, id TEXT, PRIMARY KEY (tenant_id, id)) ${flags}`).concerns
      ).toEqual([]);
    }
  );

  it('requires explicit selection of an alternate ownership column', () => {
    const table = inspectBackupSchema([
      'CREATE TABLE items (id TEXT NOT NULL PRIMARY KEY, owner_tenant TEXT NOT NULL)',
    ]).tables[0];
    expect(assessSnapshotTable(table).schema).toBeNull();
    expect(assessSnapshotTable(table, 'owner_tenant').schema?.tenantColumn).toBe('owner_tenant');
  });
});
