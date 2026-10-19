import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDefaultCanonicalCatalogSeedSql,
  DEFAULT_CANONICAL_CATALOG_ENTRIES,
  listD1MigrationSqlFiles,
} from '../core/cloudflare.js';
import { createDefaultConfig } from '../core/config.js';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

/**
 * Admin migration 041 seeds the platform's standard canonical field catalog. It is a file of SQL,
 * so nothing but this test ties it to DEFAULT_CANONICAL_CATALOG_ENTRIES, the definition the
 * tenant's catalog is seeded from: the rows it makes must be the rows that definition gives.
 */

const adminMigrationsDir = fileURLToPath(
  new URL('../../../../migrations/admin/d1', import.meta.url)
);
const MIGRATION = '041_platform_default_canonical_catalog.sql';
const sqlite3 = (() => {
  try {
    return execFileSync('which', ['sqlite3'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
})();

function expectedEntryRows() {
  return DEFAULT_CANONICAL_CATALOG_ENTRIES.map((entry) => ({
    id: `platform_${entry.stableFieldId.replace(/^field\.canonical\./, 'canonical_').replace(/[^a-zA-Z0-9_]/g, '_')}`,
    tenant_id: 'platform',
    catalog_version_id: 'platform_default_canonical_catalog_v1',
    stable_field_id: entry.stableFieldId,
    namespace: 'authrim.canonical',
    path: entry.path,
    target_taxonomy: 'canonical',
    value_type: entry.valueType,
    cardinality: entry.cardinality,
    classification: entry.classification,
    aliases_json: '[]',
    validation_json: '{}',
    ui_group_key: entry.groupKey,
    ui_group_label: entry.groupLabel,
    ui_group_order: entry.groupOrder,
    ui_field_order: entry.fieldOrder,
    examples_json: JSON.stringify(entry.examples),
    note: null,
  }));
}

describe.skipIf(!sqlite3)('admin migration 041: the platform canonical field catalog', () => {
  let tempDir: string;
  let dbPath: string;
  const run = (sql: string) =>
    execFileSync(sqlite3!, [dbPath], { input: sql, encoding: 'utf-8', stdio: 'pipe' });
  const read = <T = Record<string, unknown>>(sql: string): T[] =>
    JSON.parse(
      execFileSync(sqlite3!, ['-json', dbPath, sql], { encoding: 'utf-8' }).trim() || '[]'
    );
  const apply = (file: string) =>
    run(
      `PRAGMA foreign_keys = ON;\n${renderPortableMigrationSql(
        readFileSync(join(adminMigrationsDir, file), 'utf-8'),
        'sqlite'
      )}`
    );
  const platformEntries = () =>
    read(
      `SELECT id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
              value_type, cardinality, classification, aliases_json, validation_json, ui_group_key,
              ui_group_label, ui_group_order, ui_field_order, examples_json, note
         FROM field_catalog_entries WHERE tenant_id = 'platform' ORDER BY stable_field_id`
    );

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'authrim-platform-catalog-migration-'));
    dbPath = join(tempDir, 'admin.db');
    for (const file of listD1MigrationSqlFiles(adminMigrationsDir)) apply(file);
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it('is one of the admin migrations, after the existing ones', () => {
    const files = listD1MigrationSqlFiles(adminMigrationsDir);
    expect(files).toContain(MIGRATION);
    // Later migrations may follow; it must come after every admin migration that predates it.
    expect(files.indexOf(MIGRATION)).toBe(
      files.indexOf('040_settings_legacy_import_state.sql') + 1
    );
  });

  it('makes exactly the rows that the field definition gives', () => {
    const expected = [...expectedEntryRows()].sort((a, b) =>
      a.stable_field_id.localeCompare(b.stable_field_id)
    );

    expect(expected.length).toBeGreaterThan(20);
    expect(platformEntries()).toEqual(expected);
    expect(
      read(
        "SELECT id, tenant_id, catalog_key, display_name, lifecycle_state FROM field_catalogs WHERE tenant_id = 'platform'"
      )
    ).toEqual([
      {
        id: 'platform_default_canonical_catalog',
        tenant_id: 'platform',
        catalog_key: 'authrim.platform_default_canonical',
        display_name: 'Authrim Platform Default Canonical Catalog',
        lifecycle_state: 'active',
      },
    ]);
    expect(
      read(
        "SELECT id, tenant_id, catalog_id, lifecycle_state, compatibility_range FROM field_catalog_versions WHERE tenant_id = 'platform'"
      )
    ).toEqual([
      {
        id: 'platform_default_canonical_catalog_v1',
        tenant_id: 'platform',
        catalog_id: 'platform_default_canonical_catalog',
        lifecycle_state: 'active',
        compatibility_range: '*',
      },
    ]);
  });

  it('classifies every field as the tenant’s seeded catalog does', () => {
    run(buildDefaultCanonicalCatalogSeedSql(createDefaultConfig('dev')));

    const classify = (tenantId: string) =>
      read(
        `SELECT stable_field_id, namespace, path, value_type, cardinality, classification, ui_group_key, ui_group_order, ui_field_order
           FROM field_catalog_entries WHERE tenant_id = '${tenantId}' ORDER BY stable_field_id`
      );

    expect(classify('platform')).toEqual(classify('default'));
    expect(read('SELECT COUNT(*) AS n FROM field_catalogs')).toEqual([{ n: 2 }]);
  });

  it('can be applied again, and leaves a row an operator changed as it is', () => {
    run(
      "UPDATE field_catalog_entries SET classification = 'regulated' WHERE tenant_id = 'platform' AND stable_field_id = 'field.canonical.email'"
    );
    run(
      "DELETE FROM field_catalog_entries WHERE tenant_id = 'platform' AND stable_field_id = 'field.canonical.name'"
    );

    apply(MIGRATION);
    apply(MIGRATION);

    expect(read("SELECT COUNT(*) AS n FROM field_catalogs WHERE tenant_id = 'platform'")).toEqual([
      { n: 1 },
    ]);
    expect(
      read(
        "SELECT classification FROM field_catalog_entries WHERE tenant_id = 'platform' AND stable_field_id = 'field.canonical.email'"
      )
    ).toEqual([{ classification: 'regulated' }]);
    // A field that is missing is added back.
    expect(platformEntries()).toHaveLength(DEFAULT_CANONICAL_CATALOG_ENTRIES.length);
  });

  it('does not depend on a tenant row, and does not touch the tenant’s catalog', () => {
    expect(read("SELECT COUNT(*) AS n FROM field_catalogs WHERE tenant_id <> 'platform'")).toEqual([
      { n: 0 },
    ]);
    run(buildDefaultCanonicalCatalogSeedSql(createDefaultConfig('dev')));
    const tenantBefore = read(
      "SELECT * FROM field_catalog_entries WHERE tenant_id = 'default' ORDER BY id"
    );

    apply(MIGRATION);

    expect(
      read("SELECT * FROM field_catalog_entries WHERE tenant_id = 'default' ORDER BY id")
    ).toEqual(tenantBefore);
  });

  it('stamps its rows with a real time, not a placeholder', () => {
    const rows = read<{ created_at: number; updated_at: number }>(
      "SELECT created_at, updated_at FROM field_catalog_entries WHERE tenant_id = 'platform'"
    );

    expect(
      rows.every((row) => row.created_at > 1_700_000_000_000 && row.updated_at === row.created_at)
    ).toBe(true);
  });
});
