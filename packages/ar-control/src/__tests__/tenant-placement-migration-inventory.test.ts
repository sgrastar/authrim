import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyTenantMigrationSchema,
  inspectTenantMigrationSchema,
  orderTenantMigrationTables,
  type TenantMigrationTableSchema,
} from '../tenant-placement-migration-inventory';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_ROOT = join(ROOT_DIR, 'migrations');

interface ManifestStream {
  id: string;
  files: Array<{ path: string }>;
}

function renderSql(sql: string): string {
  return sql
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

function currentStreamSchema(streamId: 'd1-core' | 'd1-pii'): TenantMigrationTableSchema[] {
  const manifest = JSON.parse(
    readFileSync(join(MIGRATIONS_ROOT, 'release-manifest.draft.json'), 'utf8')
  ) as { streams: ManifestStream[] };
  const stream = manifest.streams.find((candidate) => candidate.id === streamId);
  if (!stream) throw new Error(`missing stream: ${streamId}`);
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    const directory = streamId === 'd1-core' ? MIGRATIONS_ROOT : join(MIGRATIONS_ROOT, 'pii');
    for (const file of stream.files) {
      database.exec(renderSql(readFileSync(join(directory, file.path), 'utf8')));
    }
    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    return tables.map(({ name }) => ({
      name,
      columns: (
        database.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as Array<{
          name: string;
          pk: number;
        }>
      ).map((column) => ({
        name: column.name,
        primaryKeyPosition: column.pk,
      })),
      foreignKeys: (
        database
          .prepare(`PRAGMA foreign_key_list("${name.replaceAll('"', '""')}")`)
          .all() as Array<{
          from: string;
          table: string;
          to: string;
        }>
      ).map((foreignKey) => ({
        column: foreignKey.from,
        parentTable: foreignKey.table,
        parentColumn: foreignKey.to,
      })),
    }));
  } finally {
    database.close();
  }
}

describe('tenant placement migration inventory', () => {
  it('classifies every table in the current core migration stream', () => {
    const result = classifyTenantMigrationSchema(
      'tenant_core/users',
      currentStreamSchema('d1-core')
    );

    expect(result).toMatchObject({ state: 'ready', blockedReasons: [] });
    expect(result.tables.find((table) => table.table === 'users')?.ownership).toEqual({
      kind: 'tenant_column',
      column: 'tenant_id',
    });
    expect(
      result.tables.find((table) => table.table === 'internal_notification_delivery_attempts')
        ?.ownership
    ).toMatchObject({ kind: 'parent', parentTable: 'internal_notification_events' });
    expect(result.tables.find((table) => table.table === 'log_object_catalog')?.ownership).toEqual({
      kind: 'tenant_key',
      column: 'tenant_key',
    });
    expect(result.tables.find((table) => table.table === 'did_document_cache')).toMatchObject({
      disposition: 'retain_target_local',
      ownership: { kind: 'global_reference' },
    });
    expect(() => orderTenantMigrationTables(result.tables)).not.toThrow();
  });

  it('classifies every table in the current PII migration stream', () => {
    const result = classifyTenantMigrationSchema('tenant_pii', currentStreamSchema('d1-pii'));

    expect(result).toMatchObject({ state: 'ready', blockedReasons: [] });
    expect(result.tables.find((table) => table.table === 'users_pii')?.ownership).toEqual({
      kind: 'tenant_column',
      column: 'tenant_id',
    });
    expect(result.tables.find((table) => table.table === 'subject_identifiers')?.ownership).toEqual(
      {
        kind: 'parent',
        foreignKeyColumn: 'user_id',
        parentTable: 'users_pii',
        parentKeyColumn: 'id',
        parentTenantColumn: 'tenant_id',
      }
    );
  });

  it('blocks an unclassified table and a broken indirect ownership rule', () => {
    const unknown = classifyTenantMigrationSchema('tenant_core/users', [
      {
        name: 'custom_extension_rows',
        columns: [{ name: 'id', primaryKeyPosition: 1 }],
      },
    ]);
    expect(unknown).toMatchObject({
      state: 'blocked',
      blockedReasons: ['tenant_migration_table_unclassified:custom_extension_rows'],
    });

    const missingParent = classifyTenantMigrationSchema('tenant_pii', [
      {
        name: 'subject_identifiers',
        columns: [
          { name: 'id', primaryKeyPosition: 1 },
          { name: 'user_id', primaryKeyPosition: 0 },
        ],
      },
    ]);
    expect(missingParent).toMatchObject({
      state: 'blocked',
      blockedReasons: ['tenant_migration_table_parent_missing:subject_identifiers'],
    });
  });

  it('rejects unsafe schema identifiers before constructing PRAGMA statements', async () => {
    const executor = {
      queryD1: vi.fn(async () => [
        { success: true, results: [{ name: 'users; DROP TABLE tenants' }] },
      ]),
      queryD1Batch: vi.fn(async () => []),
    };

    await expect(inspectTenantMigrationSchema(executor, 'database-a')).rejects.toThrow(
      'tenant_migration_schema_identifier_invalid'
    );
    expect(executor.queryD1Batch).not.toHaveBeenCalled();
  });

  it('rejects a dependency cycle instead of using an unsafe backfill order', () => {
    const table = (name: string, parentTable: string) => ({
      table: name,
      columns: [{ name: 'id', primaryKeyPosition: 1 }],
      primaryKey: ['id'],
      ownership: { kind: 'tenant_row' as const, column: 'id' as const },
      disposition: 'migrate' as const,
      foreignKeys: [{ column: 'id', parentTable, parentColumn: 'id' }],
    });

    expect(() =>
      orderTenantMigrationTables([table('alpha', 'beta'), table('beta', 'alpha')])
    ).toThrow('tenant_migration_table_dependency_cycle');
  });
});
