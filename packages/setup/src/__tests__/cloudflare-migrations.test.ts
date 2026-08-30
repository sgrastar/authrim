import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDefaultCanonicalCatalogSeedSql,
  buildInitialTenantBootstrapSql,
  buildRecordMigrationSql,
  calculateD1MigrationChecksum,
  buildRuntimeProfileSeedSql,
  listD1MigrationSqlFiles,
} from '../core/cloudflare.js';
import { createDefaultConfig } from '../core/config.js';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

function findSqlite3(): string | null {
  try {
    const path = execFileSync('which', ['sqlite3'], { encoding: 'utf-8' }).trim();
    return path || null;
  } catch {
    return null;
  }
}

function runSqlite(sqlite3Path: string, dbPath: string, sql: string): void {
  execFileSync(sqlite3Path, [dbPath], {
    input: sql,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function readSqlite(sqlite3Path: string, dbPath: string, sql: string): string {
  return execFileSync(sqlite3Path, [dbPath, sql], { encoding: 'utf-8' }).trim();
}

const rootMigrationsDir = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const docsTestingDir = fileURLToPath(new URL('../../../../docs/testing', import.meta.url));
const coreMigrationExclusions = new Set([
  'admin',
  'archive',
  'control',
  'external',
  'lookup',
  'pii',
  'plugin-runner',
  'releases',
]);
const sqliteMigrationApplyTimeoutMs = 20_000;

function activeCoreMigrationFiles(): string[] {
  return listD1MigrationSqlFiles(rootMigrationsDir, {
    excludeTopLevelDirectories: coreMigrationExclusions,
  });
}

function activeAdminMigrationFiles(): string[] {
  return listD1MigrationSqlFiles(join(rootMigrationsDir, 'admin')).map((file) => `admin/${file}`);
}

function activePiiMigrationFiles(): string[] {
  return listD1MigrationSqlFiles(join(rootMigrationsDir, 'pii')).map((file) => `pii/${file}`);
}

function activePluginRunnerMigrationFiles(): string[] {
  return listD1MigrationSqlFiles(join(rootMigrationsDir, 'plugin-runner')).map(
    (file) => `plugin-runner/${file}`
  );
}

function activeD1MigrationFiles(): string[] {
  return [
    ...activeCoreMigrationFiles(),
    ...activeAdminMigrationFiles(),
    ...activePiiMigrationFiles(),
  ];
}

function readMigration(relativePath: string): string {
  return readFileSync(join(rootMigrationsDir, relativePath), 'utf-8');
}

function readTestingDoc(relativePath: string): string {
  return readFileSync(join(docsTestingDir, relativePath), 'utf-8');
}

function readMigrations(relativePaths: string[]): string {
  return relativePaths.map((relativePath) => readMigration(relativePath)).join('\n');
}

function runMigrationFiles(sqlite3Path: string, dbPath: string, relativePaths: string[]): void {
  for (const relativePath of relativePaths) {
    runSqlite(
      sqlite3Path,
      dbPath,
      `PRAGMA foreign_keys = ON;\n${renderPortableMigrationSql(
        readMigration(relativePath),
        'sqlite'
      )}`
    );
  }
}

type ForeignKeyReference = {
  sourceTable: string;
  targetTable: string;
};

function readSqliteLines(sqlite3Path: string, dbPath: string, sql: string): string[] {
  const output = readSqlite(sqlite3Path, dbPath, sql);
  return output ? output.split(/\r?\n/u) : [];
}

function listForeignKeyReferences(sqlite3Path: string, dbPath: string): ForeignKeyReference[] {
  const tableNames = readSqliteLines(
    sqlite3Path,
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  );

  return tableNames.flatMap((sourceTable) => {
    const escapedTable = sourceTable.replaceAll("'", "''");
    return readSqliteLines(
      sqlite3Path,
      dbPath,
      `SELECT DISTINCT "table" FROM pragma_foreign_key_list('${escapedTable}') ORDER BY "table";`
    ).map((targetTable) => ({ sourceTable, targetTable }));
  });
}

function findInvalidForeignKeyReferences(
  sqlite3Path: string,
  dbPath: string
): ForeignKeyReference[] {
  const existingTables = new Set(
    readSqliteLines(
      sqlite3Path,
      dbPath,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
    )
  );

  return listForeignKeyReferences(sqlite3Path, dbPath).filter(
    ({ targetTable }) =>
      !existingTables.has(targetTable) ||
      targetTable.endsWith('_old') ||
      targetTable.endsWith('_repaired')
  );
}

function insertOAuthClientSql(tenantId: string, clientId: string, clientName: string): string {
  return `
INSERT INTO oauth_clients (
  tenant_id,
  client_id,
  client_name,
  redirect_uris,
  grant_types,
  response_types,
  created_at,
  updated_at
) VALUES (
  '${tenantId}',
  '${clientId}',
  '${clientName}',
  '[]',
  '[]',
  '[]',
  1,
  1
);
`;
}

describe('buildRuntimeProfileSeedSql', () => {
  it('builds idempotent SQL for seeded runtime profiles', () => {
    const config = createDefaultConfig('dev');
    config.profiles.seed.audit = [
      {
        id: 'custom:audit:http-export',
        label: 'HTTP Export',
        primary: null,
        archive: null,
        sinks: [
          {
            type: 'http',
            url: 'https://example.com/audit',
          },
        ],
      },
    ];

    const sql = buildRuntimeProfileSeedSql(config);
    expect(sql).toContain('INSERT INTO profile_registry');
    expect(sql).toContain("'custom:audit:http-export'");
    expect(sql).toContain('"type":"http"');
    expect(sql).toContain('UPDATE profile_registry');
    expect(sql).toContain('WHERE NOT EXISTS');
  });
});

describe('buildDefaultCanonicalCatalogSeedSql', () => {
  it('builds idempotent SQL for the default canonical field catalog', () => {
    const sql = buildDefaultCanonicalCatalogSeedSql(createDefaultConfig('dev'));

    expect(sql).toContain('INSERT INTO field_catalogs');
    expect(sql).toContain('INSERT INTO field_catalog_versions');
    expect(sql).toContain('INSERT INTO field_catalog_entries');
    expect(sql).toContain("'authrim.default_canonical'");
    expect(sql).toContain("'field.canonical.given_name'");
    expect(sql).toContain('ui_group_key');
    expect(sql).toContain("'name'");
    expect(sql).toContain('examples_json');
    expect(sql).toContain('John Doe');
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).not.toContain('INSERT OR IGNORE');
  });

  it('applies the default canonical field catalog seed in SQLite', () => {
    const sqlite3Path = findSqlite3();
    if (!sqlite3Path) {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'authrim-canonical-catalog-seed-'));
    const dbPath = join(tempDir, 'test.db');

    try {
      runMigrationFiles(sqlite3Path, dbPath, activeAdminMigrationFiles());
      runSqlite(
        sqlite3Path,
        dbPath,
        buildDefaultCanonicalCatalogSeedSql(createDefaultConfig('dev'))
      );

      expect(readSqlite(sqlite3Path, dbPath, 'SELECT COUNT(*) FROM field_catalogs;')).toBe('1');
      expect(readSqlite(sqlite3Path, dbPath, 'SELECT COUNT(*) FROM field_catalog_versions;')).toBe(
        '1'
      );
      expect(readSqlite(sqlite3Path, dbPath, 'SELECT COUNT(*) FROM field_catalog_entries;')).toBe(
        '27'
      );
      expect(
        readSqlite(
          sqlite3Path,
          dbPath,
          "SELECT ui_group_label FROM field_catalog_entries WHERE stable_field_id = 'field.canonical.given_name';"
        )
      ).toBe('Name');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('buildRecordMigrationSql', () => {
  it('uses a portable insert pattern for migration tracking', () => {
    const sql = buildRecordMigrationSql("seed'file.sql", 1234567890);

    expect(sql).toContain('INSERT INTO authrim_migrations');
    expect(sql).toContain("SELECT 'seed''file.sql', '', 1234567890");
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).not.toContain('INSERT OR IGNORE');
  });
});

describe('Control plane drift notification migration', () => {
  it('preserves existing events and accepts the new category', () => {
    const sqlite3Path = findSqlite3();
    if (!sqlite3Path) {
      return;
    }

    const migrationPath = 'admin/001_pre_1_0_admin_baseline.sql';
    const tempDir = mkdtempSync(join(tmpdir(), 'authrim-control-drift-notification-'));
    const dbPath = join(tempDir, 'test.db');

    try {
      runMigrationFiles(sqlite3Path, dbPath, [migrationPath]);
      runSqlite(
        sqlite3Path,
        dbPath,
        `INSERT INTO internal_notification_events (
           id, tenant_id, category, event_type, severity, payload_json
         ) VALUES (
           'existing-event', 'tenant-a', 'tenant_database_health',
           'tenant.database.unhealthy', 'high', '{}'
         );`
      );

      runSqlite(
        sqlite3Path,
        dbPath,
        `INSERT INTO internal_notification_events (
           id, tenant_id, category, event_type, severity, payload_json
         ) VALUES (
           'control-event', '__control__', 'control_plane_drift',
           'control.worker_inventory.actual_only', 'medium', '{}'
         );`
      );

      expect(
        readSqlite(
          sqlite3Path,
          dbPath,
          'SELECT id || ":" || category FROM internal_notification_events ORDER BY id;'
        )
      ).toBe('control-event:control_plane_drift\nexisting-event:tenant_database_health');
      expect(
        readSqlite(
          sqlite3Path,
          dbPath,
          `SELECT COUNT(*) FROM sqlite_master
            WHERE type = 'index' AND name LIKE 'idx_internal_notification_events_%';`
        )
      ).toBe('3');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('calculateD1MigrationChecksum', () => {
  it('keeps the generated pre-1.0 core baseline checksum stable', () => {
    expect(
      calculateD1MigrationChecksum(join(rootMigrationsDir, '001_pre_1_0_core_baseline.sql'))
    ).toBe('3891d1101810b9bafbbf33554641e26fa9d1dfafbec7c9c6c4f286c6e4219c4f');
  });

  it('changes when rendered migration SQL changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authrim-migration-checksum-'));
    const file = join(dir, '001_test.sql');
    try {
      writeFileSync(file, 'CREATE TABLE example(id TEXT);');
      const first = calculateD1MigrationChecksum(file);
      writeFileSync(file, 'CREATE TABLE example(id TEXT, name TEXT);');
      const second = calculateD1MigrationChecksum(file);

      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(second).toMatch(/^[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listD1MigrationSqlFiles', () => {
  it('discovers nested phase directory migrations in explicit relative order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authrim-migrations-'));
    try {
      mkdirSync(join(dir, 'logging-storage', 'phase2'), { recursive: true });
      mkdirSync(join(dir, 'logging-storage', 'phase1'), { recursive: true });
      writeFileSync(join(dir, '001_core_foundation.sql'), '-- foundation');
      writeFileSync(join(dir, '002_core_protocol.sql'), '-- protocol');
      writeFileSync(join(dir, 'logging-storage', 'phase2', '002_policy.sql'), '-- phase2');
      writeFileSync(join(dir, 'logging-storage', 'phase1', '001_destination.sql'), '-- phase1');
      writeFileSync(join(dir, '.ignored.sql'), '-- ignored');

      expect(listD1MigrationSqlFiles(dir)).toEqual([
        '001_core_foundation.sql',
        '002_core_protocol.sql',
        'logging-storage/phase1/001_destination.sql',
        'logging-storage/phase2/002_policy.sql',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can exclude top-level database-specific migration directories for core runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authrim-migrations-'));
    try {
      mkdirSync(join(dir, 'admin'), { recursive: true });
      mkdirSync(join(dir, 'pii'), { recursive: true });
      mkdirSync(join(dir, 'logging-storage', 'phase1'), { recursive: true });
      writeFileSync(join(dir, '001_core_foundation.sql'), '-- foundation');
      writeFileSync(join(dir, 'admin', '001_admin.sql'), '-- admin');
      writeFileSync(join(dir, 'pii', '001_pii.sql'), '-- pii');
      writeFileSync(join(dir, 'logging-storage', 'phase1', '001_destination.sql'), '-- phase1');

      expect(
        listD1MigrationSqlFiles(dir, {
          excludeTopLevelDirectories: new Set(['admin', 'pii']),
        })
      ).toEqual(['001_core_foundation.sql', 'logging-storage/phase1/001_destination.sql']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migration seed SQL portability', () => {
  it('keeps seed migrations free of INSERT OR IGNORE', () => {
    const migrationFiles = activeD1MigrationFiles();
    expect(migrationFiles.length).toBeGreaterThan(0);

    for (const migrationFile of migrationFiles) {
      const sql = readMigration(migrationFile);
      expect(sql).not.toContain('INSERT OR IGNORE');
    }
  });

  it('keeps oauth_clients device secret policy columns in the core baseline', () => {
    const sql = readMigrations(activeCoreMigrationFiles());

    expect(sql).toContain('device_secret_revoke_enabled INTEGER');
    expect(sql).toContain('device_secret_revoke_trust_groups TEXT');
    expect(sql).toContain('device_secret_introspection_enabled INTEGER');
    expect(sql).toContain('device_secret_introspection_trust_groups TEXT');
  });

  it(
    'adds the Agent refresh-family revocation owner through an additive admin migration',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) return;

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-agent-revocation-owner-'));
      const dbPath = join(tempDir, 'test.db');

      try {
        runMigrationFiles(sqlite3Path, dbPath, activeAdminMigrationFiles());

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM pragma_table_info('admin_agent_token_families')
             WHERE name = 'revocation_outbox_id';`
          )
        ).toBe('1');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM sqlite_master
             WHERE type = 'index'
               AND name = 'idx_admin_agent_token_families_revocation_outbox';`
          )
        ).toBe('1');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it('includes credential-profile Flow assignment targets in both final baselines', () => {
    const coreBaseline = readMigration('001_pre_1_0_core_baseline.sql');
    const postgresBaseline = readMigration(
      'external/postgres/001_pre_1_0_external_postgres_core_baseline.sql'
    );

    expect(coreBaseline).toContain("'credential_profile'");
    expect(postgresBaseline).toContain("'credential_profile'");
    expect(postgresBaseline).toContain('flow_assignments_target_type_check');
    expect(postgresBaseline).toContain('flow_assignments_target_id_check');
  });

  it('keeps normalized Admin role assignment scope columns in the final baseline', () => {
    const sql = readMigrations(activeAdminMigrationFiles());

    expect(sql).toContain('scope_type TEXT NOT NULL');
    expect(sql).toContain('scope_id TEXT NOT NULL');
  });

  it('replaces backend-specific epoch helpers in migration assets', () => {
    const migrationFiles = activeD1MigrationFiles();
    const migrationsWithEpochHelpers: string[] = [];

    for (const migrationFile of migrationFiles) {
      const sql = readMigration(migrationFile);
      expect(sql).not.toContain("strftime('%s', 'now')");
      expect(sql).not.toContain("datetime('now')");
      if (/__AUTHRIM_NOW_EPOCH_(SECONDS|MILLISECONDS)__/.test(sql)) {
        migrationsWithEpochHelpers.push(migrationFile);
      }
    }

    expect(migrationsWithEpochHelpers.length).toBeGreaterThan(0);
  });

  it('does not auto-seed OIDC custom claim schemas from core migrations', () => {
    const sql = readMigration('001_pre_1_0_core_baseline.sql');

    expect(sql).not.toContain('Seed default OIDC claim schemas');
    expect(sql).not.toContain("'system_claim_' || t.id || '_name'");
    expect(sql).not.toContain("'system_claim_' || t.id || '_address_country'");
  });

  it('uses triggers instead of the removed plugin rollout partial index', () => {
    const baselineSql = readMigration('plugin-runner/001_pre_1_0_plugin_runner_baseline.sql');
    expect(baselineSql).not.toContain('idx_plugin_runner_dynamic_rollout_active_plugin');
    expect(baselineSql).toContain('trg_plugin_runner_dynamic_rollout_running_insert');
    expect(baselineSql).toContain('trg_plugin_runner_dynamic_rollout_running_update');

    const sqlite3Path = findSqlite3();
    if (!sqlite3Path) return;
    const tempDir = mkdtempSync(join(tmpdir(), 'authrim-plugin-runner-index-gate-'));
    const dbPath = join(tempDir, 'test.db');
    try {
      runMigrationFiles(sqlite3Path, dbPath, activePluginRunnerMigrationFiles());
      expect(
        readSqlite(
          sqlite3Path,
          dbPath,
          `SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND upper(sql) LIKE '% WHERE %';`
        )
      ).toBe('0');
      expect(
        readSqlite(
          sqlite3Path,
          dbPath,
          `SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'trigger'
               AND name IN (
                 'trg_plugin_runner_dynamic_rollout_running_insert',
                 'trg_plugin_runner_dynamic_rollout_running_update'
               );`
        )
      ).toBe('2');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps D1 REST migration triggers compatible with the query parser', () => {
    for (const migrationFile of activeD1MigrationFiles()) {
      const sql = readMigration(migrationFile);
      expect(sql, migrationFile).not.toMatch(/SELECT\s+CASE\s+WHEN/iu);
    }
  });

  it('scopes OAuth client identifiers by tenant in the core baseline', () => {
    const sql = readMigrations(activeCoreMigrationFiles());

    expect(sql).not.toContain('client_id TEXT PRIMARY KEY');
    expect(sql).toContain('PRIMARY KEY (tenant_id, client_id)');
    expect(sql).toContain(
      'FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id)'
    );
    expect(sql).toContain('UNIQUE (tenant_id, user_id, client_id)');
    expect(sql).toContain('CREATE INDEX idx_ciba_client ON ciba_requests(tenant_id, client_id)');
    expect(sql).toContain(
      'CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id)'
    );
  });

  it(
    'applies the consolidated core baseline in SQLite',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-oauth-client-migration-'));
      const dbPath = join(tempDir, 'test.db');

      try {
        runMigrationFiles(sqlite3Path, dbPath, activeCoreMigrationFiles());

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT f.status
                    || ':' || f.is_active
                    || ':' || f.published_version_id
                    || ':' || v.version_number
                    || ':' || a.enabled
             FROM flows f
             JOIN flow_versions v
               ON v.tenant_id = f.tenant_id AND v.id = f.published_version_id
             JOIN flow_assignments a
               ON a.tenant_id = f.tenant_id AND a.flow_id = f.id
             WHERE f.tenant_id = 'default'
               AND f.slug = 'default-login-no-consent'
               AND f.template_id = 'default-login-no-consent'
               AND a.target_type = 'tenant'
               AND a.target_id IS NULL
               AND a.flow_kind = 'login';`
          )
        ).toBe('published:1:flow-version-default-login-no-consent-v1:1:1');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT f.status
                    || ':' || f.is_active
                    || ':' || f.published_version_id
                    || ':' || v.version_number
                    || ':' || a.enabled
             FROM flows f
             JOIN flow_versions v
               ON v.tenant_id = f.tenant_id AND v.id = f.published_version_id
             JOIN flow_assignments a
               ON a.tenant_id = f.tenant_id AND a.flow_id = f.id
             WHERE f.tenant_id = 'default'
               AND f.slug = 'default-registration-no-consent'
               AND f.template_id = 'default-registration-no-consent'
               AND a.target_type = 'tenant'
               AND a.target_id IS NULL
               AND a.flow_kind = 'registration';`
          )
        ).toBe('published:1:flow-version-default-registration-no-consent-v1:1:1');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM flow_versions
             WHERE flow_id IN ('flow-default-login-no-consent', 'flow-default-registration-no-consent')
               AND editor_snapshot_json LIKE '%"type":"consent"%';`
          )
        ).toBe('0');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM flow_versions
             WHERE flow_id = 'flow-default-login-no-consent'
               AND runtime_snapshot_json LIKE '%"screen_ref":"login"%';`
          )
        ).toBe('1');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM flow_versions
             WHERE flow_id = 'flow-default-registration-no-consent'
               AND runtime_snapshot_json LIKE '%"screen_ref":"registration"%';`
          )
        ).toBe('1');

        runSqlite(
          sqlite3Path,
          dbPath,
          `
PRAGMA foreign_keys = ON;
INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
VALUES ('tenant-a', 'tenant-a', 'tenant-key-a', 'Tenant A', 1, 1);
INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
VALUES ('tenant-b', 'tenant-b', 'tenant-key-b', 'Tenant B', 1, 1);
INSERT INTO users_core (id, tenant_id, created_at, updated_at)
VALUES ('user-a', 'tenant-a', 1, 1);
INSERT INTO sessions (id, tenant_id, user_id, expires_at, created_at)
VALUES ('session-a', 'tenant-a', 'user-a', 9999999999, 1);
${insertOAuthClientSql('tenant-a', 'shared-mobile', 'Tenant A Mobile')}
${insertOAuthClientSql('tenant-b', 'shared-mobile', 'Tenant B Mobile')}
`
        );

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT COUNT(*) FROM oauth_clients WHERE client_id = 'shared-mobile';"
          )
        ).toBe('2');
        for (const tableName of [
          'subject_account_links',
          'profiles',
          'profile_attribute_values',
          'structured_attribute_values',
          'contact_points',
          'identity_bindings',
        ]) {
          expect(
            readSqlite(
              sqlite3Path,
              dbPath,
              `SELECT COUNT(*) FROM pragma_table_info('${tableName}') WHERE name = 'deleted_at';`
            )
          ).toBe('1');
        }
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM pragma_foreign_key_list('user_custom_fields') WHERE "table" = 'users_core';`
          )
        ).toBe('0');

        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `
PRAGMA foreign_keys = ON;
${insertOAuthClientSql('tenant-a', 'shared-mobile', 'Duplicate Tenant A Mobile')}
`
          )
        ).toThrow();

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_clients';`
          )
        ).toBe('0');

        runSqlite(
          sqlite3Path,
          dbPath,
          `
PRAGMA foreign_keys = ON;
INSERT INTO oauth_clients (
  tenant_id,
  client_id,
  client_name,
  redirect_uris,
  grant_types,
  response_types,
  device_secret_revoke_enabled,
  device_secret_revoke_trust_groups,
  device_secret_introspection_enabled,
  device_secret_introspection_trust_groups,
  created_at,
  updated_at
) VALUES (
  'tenant-a',
  'device-policy-client',
  'Device Policy Client',
  '[]',
  '[]',
  '[]',
  1,
  '["trusted"]',
  1,
  '["trusted"]',
  1,
  1
);
`
        );

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT device_secret_revoke_enabled || ':' || device_secret_introspection_enabled FROM oauth_clients WHERE tenant_id = 'tenant-a' AND client_id = 'device-policy-client';"
          )
        ).toBe('1:1');

        expect(readSqlite(sqlite3Path, dbPath, 'SELECT COUNT(*) FROM device_secrets;')).toBe('0');
        expect(readSqlite(sqlite3Path, dbPath, 'SELECT COUNT(*) FROM device_installations;')).toBe(
          '0'
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'materializes the configured initial tenant placement exactly once',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-initial-tenant-placement-'));
      const dbPath = join(tempDir, 'test.db');
      const sharedConfig = createDefaultConfig('mt');
      sharedConfig.tenant.placementPolicy = 'shared_pool';

      try {
        runMigrationFiles(sqlite3Path, dbPath, activeCoreMigrationFiles());
        runSqlite(sqlite3Path, dbPath, buildInitialTenantBootstrapSql(sharedConfig));

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT isolation_policy FROM tenants WHERE id = 'default';"
          )
        ).toBe('shared_pool');

        const exclusiveConfig = createDefaultConfig('mt');
        exclusiveConfig.tenant.placementPolicy = 'tenant_exclusive';
        runSqlite(sqlite3Path, dbPath, buildInitialTenantBootstrapSql(exclusiveConfig));

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT isolation_policy FROM tenants WHERE id = 'default';"
          )
        ).toBe('tenant_exclusive');
        expect(() =>
          runSqlite(sqlite3Path, dbPath, buildInitialTenantBootstrapSql(sharedConfig))
        ).toThrow();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'keeps seeded no-consent Flows assigned after initial tenant rename',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-flow-initial-tenant-'));
      const dbPath = join(tempDir, 'test.db');
      const config = createDefaultConfig('mt');
      config.tenant.name = 'first';
      config.tenant.displayName = 'First Tenant';

      try {
        runMigrationFiles(sqlite3Path, dbPath, activeCoreMigrationFiles());
        runSqlite(sqlite3Path, dbPath, buildInitialTenantBootstrapSql(config));

        expect(readSqlite(sqlite3Path, dbPath, 'SELECT id FROM tenants;')).toBe('first');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM flows
             WHERE tenant_id = 'first'
               AND status = 'published'
               AND is_active = 1
               AND published_version_id IS NOT NULL
               AND slug IN ('default-login-no-consent', 'default-registration-no-consent');`
          )
        ).toBe('2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM screens
             WHERE tenant_id = 'first'
               AND is_active = 1
               AND is_system = 1
               AND screen_key IN ('login', 'registration', 'profile_completion', 'code_input');`
          )
        ).toBe('4');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM flow_versions
             WHERE tenant_id = 'first'
               AND flow_id IN ('flow-default-login-no-consent', 'flow-default-registration-no-consent');`
          )
        ).toBe('2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM flow_assignments
             WHERE tenant_id = 'first'
               AND target_type = 'tenant'
               AND target_id IS NULL
               AND enabled = 1
               AND flow_kind IN ('login', 'registration');`
          )
        ).toBe('2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM flows
             WHERE tenant_id = 'default'
               AND slug IN ('default-login-no-consent', 'default-registration-no-consent');`
          )
        ).toBe('0');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
             FROM screens
             WHERE tenant_id = 'default'
               AND screen_key IN ('login', 'registration', 'profile_completion', 'code_input');`
          )
        ).toBe('0');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'reconciles stale default screens without overwriting initial-tenant customizations',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-screen-bootstrap-rerun-'));
      const dbPath = join(tempDir, 'test.db');
      const config = createDefaultConfig('mt');
      config.tenant.name = 'first';
      config.tenant.displayName = 'First Tenant';

      try {
        runMigrationFiles(sqlite3Path, dbPath, activeCoreMigrationFiles());
        runSqlite(sqlite3Path, dbPath, buildInitialTenantBootstrapSql(config));
        runSqlite(
          sqlite3Path,
          dbPath,
          `
UPDATE screens
SET display_name = 'Customized Login',
    fields_json = '[{"field":"custom"}]',
    updated_at = 123
WHERE tenant_id = 'first' AND screen_key = 'login';

INSERT INTO screens (
  id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
  localizations_json, settings_json, is_active, is_system, created_at, updated_at
)
SELECT
  'stale-default-' || screen_key,
  'default',
  screen_key,
  'Stale default ' || screen_key,
  description,
  screen_kind,
  '[]',
  NULL,
  settings_json,
  is_active,
  is_system,
  0,
  0
FROM screens
WHERE tenant_id = 'first'
  AND screen_key IN ('login', 'registration', 'profile_completion', 'code_input');

INSERT INTO screens (
  id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
  localizations_json, settings_json, is_active, is_system, created_at, updated_at
) VALUES (
  'stale-default-legacy-custom',
  'default',
  'legacy_custom',
  'Legacy custom',
  NULL,
  'custom',
  '[]',
  NULL,
  '{"canvas_layout":"narrow"}',
  1,
  0,
  0,
  0
);
`
        );

        runSqlite(sqlite3Path, dbPath, buildInitialTenantBootstrapSql(config));
        runSqlite(sqlite3Path, dbPath, buildInitialTenantBootstrapSql(config));

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT display_name || ':' || fields_json || ':' || updated_at
             FROM screens
             WHERE tenant_id = 'first' AND screen_key = 'login';`
          )
        ).toBe('Customized Login:[{"field":"custom"}]:123');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT display_name
             FROM screens
             WHERE tenant_id = 'first' AND screen_key = 'legacy_custom';`
          )
        ).toBe('Legacy custom');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT COUNT(*) FROM screens WHERE tenant_id = 'default';"
          )
        ).toBe('0');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'applies the consolidated PII baseline in SQLite',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-pii-migration-'));
      const dbPath = join(tempDir, 'test.db');

      try {
        runMigrationFiles(sqlite3Path, dbPath, activePiiMigrationFiles());

        for (const tableName of ['users_pii', 'users_pii_tombstone', 'identity_sensitive_values']) {
          expect(
            readSqlite(
              sqlite3Path,
              dbPath,
              `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '${tableName}';`
            )
          ).toBe('1');
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it('keeps external Postgres linked identities compatible with the PII schema', () => {
    const postgresMigration = readMigration(
      'external/postgres/002_pre_1_0_external_postgres_pii_baseline.sql'
    );

    for (const column of [
      'email_verified',
      'access_token_encrypted',
      'refresh_token_encrypted',
      'token_expires_at',
      'raw_claims',
      'profile_data',
      'last_login_at',
      'updated_at',
    ]) {
      expect(postgresMigration).toMatch(new RegExp(`\\b${column}\\b`, 'u'));
    }
    expect(postgresMigration).toContain('last_used_at');
    expect(postgresMigration).toContain('linked_at');
    expect(postgresMigration).toContain('provisioning_state');
    expect(postgresMigration).toContain('linked_identities_provisioning_state_check');
    expect(postgresMigration).toContain("ARRAY['pending'::text, 'active'::text]");
  });

  for (const [databaseRole, migrationFiles] of [
    ['core', activeCoreMigrationFiles()],
    ['admin', activeAdminMigrationFiles()],
    ['pii', activePiiMigrationFiles()],
  ] as const) {
    it(
      `keeps every ${databaseRole} foreign-key target valid after all migrations`,
      () => {
        const sqlite3Path = findSqlite3();
        if (!sqlite3Path) {
          return;
        }

        const tempDir = mkdtempSync(join(tmpdir(), `authrim-${databaseRole}-foreign-keys-`));
        const dbPath = join(tempDir, 'test.db');

        try {
          runMigrationFiles(sqlite3Path, dbPath, migrationFiles);

          expect(findInvalidForeignKeyReferences(sqlite3Path, dbPath)).toEqual([]);
          expect(readSqlite(sqlite3Path, dbPath, 'PRAGMA foreign_key_check;')).toBe('');
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
      sqliteMigrationApplyTimeoutMs
    );
  }

  it(
    'applies the unified identity mapping admin control-plane baseline in SQLite',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-uim-admin-migration-'));
      const dbPath = join(tempDir, 'test.db');

      try {
        runMigrationFiles(sqlite3Path, dbPath, activeAdminMigrationFiles());

        expect(
          Number(
            readSqlite(
              sqlite3Path,
              dbPath,
              "SELECT COUNT(*) FROM pragma_table_info('mapping_rules');"
            )
          )
        ).toBeGreaterThan(0);
        expect(
          Number(
            readSqlite(
              sqlite3Path,
              dbPath,
              "SELECT COUNT(*) FROM pragma_table_info('federation_trust_sources');"
            )
          )
        ).toBeGreaterThan(0);
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT COUNT(*) FROM pragma_table_info('tenant_discovery_indexes') WHERE name = 'mapping_snapshot_id';"
          )
        ).toBe('1');
        expect(() =>
          readSqlite(
            sqlite3Path,
            dbPath,
            "INSERT INTO tenant_runtime_cache_generations (tenant_id, cache_namespace) VALUES ('tenant-a', 'users_core');"
          )
        ).toThrow();
        expect(() =>
          readSqlite(
            sqlite3Path,
            dbPath,
            "INSERT INTO tenant_runtime_cache_generations (tenant_id, cache_namespace) VALUES ('tenant-a', 'identity_core');"
          )
        ).not.toThrow();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it('retains unified identity migration provenance in semantic baseline evidence', () => {
    const evidence = readFileSync(
      join(rootMigrationsDir, 'semantic-baseline.evidence.json'),
      'utf8'
    );

    expect(evidence).toContain('008_unified_identity_canonical_schema.sql');
    expect(evidence).toContain('007_identity_mapping_control_plane.sql');
  });

  it('keeps PR6 canonical runtime cutover items closed in the readiness snapshot', () => {
    const readinessSnapshot = readTestingDoc('unified-identity-mapping-cutover-hardening.md');
    const requiredClosedIds = [
      'UIM-SCH-001',
      'UIM-SCH-002',
      'UIM-SCH-003',
      'UIM-SCH-004',
      'UIM-SCH-005',
      'UIM-SCH-006',
      'UIM-SCH-007',
      'UIM-SCH-032A',
    ];

    for (const id of requiredClosedIds) {
      const row = readinessSnapshot
        .split('\n')
        .find((line) => new RegExp(`^\\|\\s+${id}\\s+\\|`).test(line));
      expect(row, `${id} is listed in PR6 readiness snapshot`).toBeDefined();
      expect(row, `${id} has PR6 cutover hardening evidence`).toContain('PR6 hardening');
      expect(row, `${id} is tested before PR6 exits`).toContain('| tested |');
    }
  });
});

describe('renderPortableMigrationSql', () => {
  const sql = `
INSERT INTO test_table (created_at_s, created_at_ms)
VALUES (__AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__);
`.trim();

  it('renders sqlite expressions for D1 execution', () => {
    const rendered = renderPortableMigrationSql(sql, 'sqlite');
    expect(rendered).toContain('unixepoch()');
    expect(rendered).toContain('(unixepoch() * 1000)');
  });

  it('renders postgres expressions for external profiles', () => {
    const rendered = renderPortableMigrationSql(sql, 'postgres');
    expect(rendered).toContain('EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)');
    expect(rendered).toContain('* 1000');
  });

  it('renders mysql expressions for external profiles', () => {
    const rendered = renderPortableMigrationSql(sql, 'mysql');
    expect(rendered).toContain('UNIX_TIMESTAMP()');
    expect(rendered).toContain('* 1000');
  });
});
