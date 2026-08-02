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
  shouldMirrorPiiMigrationsToCore,
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
const coreMigrationExclusions = new Set(['admin', 'archive', 'external', 'pii']);
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

function insertApprovalRequestSql(id: string, detailObjectCatalogId: string | null = null): string {
  const escapedId = id.replaceAll("'", "''");
  const detailObjectCatalogSql = detailObjectCatalogId
    ? `'${detailObjectCatalogId.replaceAll("'", "''")}'`
    : 'NULL';

  return `
INSERT INTO approval_requests (
  id,
  public_request_id,
  tenant_id,
  investigation_id,
  requester_subject_type,
  requester_subject_id,
  target_subject_type,
  target_subject_id,
  request_surface,
  requested_action,
  redaction_level,
  status,
  scope_canonical,
  scope_json,
  reason_code,
  reuse_scope,
  policy_preset,
  partial_access_allowed,
  requested_at,
  expires_at,
  detail_object_catalog_id,
  created_at,
  updated_at
) VALUES (
  '${escapedId}',
  'apr-${escapedId}',
  'default',
  'inv-${escapedId}',
  'service_principal',
  'approval-smoke',
  'user',
  'user-${escapedId}',
  'service_data',
  'detail_read',
  'masked',
  'pending',
  'surface=service_data&action=detail_read',
  '{}',
  'technical_support',
  'request',
  'technical_debug_default',
  0,
  100,
  200,
  ${detailObjectCatalogSql},
  100,
  100
);
`;
}

describe('shouldMirrorPiiMigrationsToCore', () => {
  it('returns false for the standard storage profile', () => {
    const config = createDefaultConfig('dev');
    expect(shouldMirrorPiiMigrationsToCore(config)).toBe(false);
  });

  it('returns true for the single-db storage profile', () => {
    const config = createDefaultConfig('dev');
    config.profiles.defaults.storage = 'builtin:storage:single-db';
    expect(shouldMirrorPiiMigrationsToCore(config)).toBe(true);
  });

  it('returns false when profile defaults are absent', () => {
    expect(shouldMirrorPiiMigrationsToCore(undefined)).toBe(false);
    expect(shouldMirrorPiiMigrationsToCore({})).toBe(false);
  });
});

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

    const migrationPath = 'admin/030_control_plane_drift_notifications.sql';
    const tempDir = mkdtempSync(join(tmpdir(), 'authrim-control-drift-notification-'));
    const dbPath = join(tempDir, 'test.db');

    try {
      runMigrationFiles(
        sqlite3Path,
        dbPath,
        activeAdminMigrationFiles().filter((file) => file !== migrationPath)
      );
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

      runMigrationFiles(sqlite3Path, dbPath, [migrationPath]);
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
  it('keeps the applied core Flow runtime migration immutable', () => {
    expect(calculateD1MigrationChecksum(join(rootMigrationsDir, '017_core_flow_runtime.sql'))).toBe(
      '508ca3d8fcdf84a5a53ef050068d92f29ca4585f819d7c35975dffd154929b36'
    );
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

    expect(readMigrations(migrationFiles)).toContain('WHERE NOT EXISTS');
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

  it(
    'suspends built-in v3 Agent Grants when user data Tools move to a dedicated Task Set',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) return;

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-agent-user-data-split-'));
      const dbPath = join(tempDir, 'test.db');
      const splitMigration = 'admin/019_split_agent_user_data_task_set.sql';

      try {
        runMigrationFiles(
          sqlite3Path,
          dbPath,
          activeAdminMigrationFiles().filter((file) => file !== splitMigration)
        );
        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
VALUES ('admin-1', 'tenant-1', 'admin@example.test', 1, 1);

INSERT INTO admin_agent_grants (
  id, tenant_id, client_id, grantor_id, delegator_id, permissions, scopes,
  delegation_mode, generation, consent_version, status, expires_at, active_uniqueness_key,
  created_at, updated_at, task_set_id, task_set_version, scope_policy_id,
  scope_policy_version, resolved_tools, resolved_scope_constraints, access_snapshot_hash
) VALUES
  ('grant-builtin-v3', 'tenant-1', 'client-v3', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 86400000, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   'builtin_agent_task_set_read_only_inspector', 3, 'scope-1', 1,
   '[{"toolId":"admin.read.users.search"}]', '{}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('grant-builtin-v4', 'tenant-1', 'client-v4', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 86400000, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   'builtin_agent_task_set_read_only_inspector', 4, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  ('grant-custom', 'tenant-1', 'client-custom', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 86400000, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   'custom-user-support', 1, 'scope-1', 1,
   '[{"toolId":"admin.read.users.search"}]', '{}', 'ccccccccccccccccccccccccccccccccccccccccccc');

INSERT INTO agent_consents (
  id, tenant_id, consent_type, grant_id, user_id, client_id, consent_version,
  scopes, granted_at
) VALUES
  ('consent-v3', 'tenant-1', 'delegation', 'grant-builtin-v3', 'admin-1', 'client-v3', 1,
   '["agent:read"]', 1),
  ('consent-custom', 'tenant-1', 'delegation', 'grant-custom', 'admin-1', 'client-custom', 1,
   '["agent:read"]', 1);

INSERT INTO admin_agent_token_families (
  family_id, family_jti, tenant_id, grant_id, grant_generation, admin_user_id,
  client_id, consent_version, status, finalization_nonce, finalized_at,
  expires_at, created_at, updated_at
) VALUES
  ('family-v3', 'jti-v3', 'tenant-1', 'grant-builtin-v3', 1, 'admin-1',
   'client-v3', 1, 'active', 'nonce-v3', 1, CAST(strftime('%s', 'now') AS INTEGER) + 86400, 1, 1),
  ('family-custom', 'jti-custom', 'tenant-1', 'grant-custom', 1, 'admin-1',
   'client-custom', 1, 'active', 'nonce-custom', 1, CAST(strftime('%s', 'now') AS INTEGER) + 86400, 1, 1);`
        );

        runMigrationFiles(sqlite3Path, dbPath, [splitMigration]);

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || generation || '|' || consent_version
               FROM admin_agent_grants WHERE id = 'grant-builtin-v3';`
          )
        ).toBe('suspended|2|2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
               FROM admin_agent_grants
              WHERE id IN ('grant-builtin-v4', 'grant-custom') AND status = 'active';`
          )
        ).toBe('2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT (revoked_at IS NOT NULL) || '|' || revoked_reason
               FROM agent_consents WHERE id = 'consent-v3';`
          )
        ).toBe('1|grant_updated');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status FROM admin_agent_token_families WHERE family_id = 'family-v3';`
          )
        ).toBe('revoked');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM admin_audit_log
              WHERE resource_id = 'grant-builtin-v3'
                AND action = 'agent.grant.suspended'
                AND actor_sub = 'migration:019';`
          )
        ).toBe('1');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'suspends built-in v4 Agent Grants before the Discovery Profile-aware v5 cut-over',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) return;

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-agent-discovery-profile-upgrade-'));
      const dbPath = join(tempDir, 'test.db');
      const discoveryMigration = 'admin/024_agent_discovery_profile_task_set.sql';

      try {
        runMigrationFiles(
          sqlite3Path,
          dbPath,
          activeAdminMigrationFiles().filter((file) => file !== discoveryMigration)
        );
        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
VALUES ('admin-1', 'tenant-1', 'admin@example.test', 1, 1);

INSERT INTO admin_agent_grants (
  id, tenant_id, client_id, grantor_id, delegator_id, permissions, scopes,
  delegation_mode, generation, consent_version, status, expires_at, active_uniqueness_key,
  created_at, updated_at, task_set_id, task_set_version, scope_policy_id,
  scope_policy_version, resolved_tools, resolved_scope_constraints, access_snapshot_hash
) VALUES
  ('grant-builtin-v4', 'tenant-1', 'client-v4', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 86400000, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   'builtin_agent_task_set_user_data_reader', 4, 'scope-1', 1,
   '[{"toolId":"admin.read.users.search"}]', '{}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('grant-builtin-v5', 'tenant-1', 'client-v5', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 86400000, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   'builtin_agent_task_set_read_only_inspector', 5, 'scope-1', 1,
   '[{"toolId":"admin.session.discovery-profiles.select"}]', '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  ('grant-custom-v4', 'tenant-1', 'client-custom', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 86400000, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   'custom-agent-task-set', 4, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{}', 'ccccccccccccccccccccccccccccccccccccccccccc');

INSERT INTO agent_consents (
  id, tenant_id, consent_type, grant_id, user_id, client_id, consent_version,
  scopes, granted_at
) VALUES
  ('consent-v4', 'tenant-1', 'delegation', 'grant-builtin-v4', 'admin-1', 'client-v4', 1,
   '["agent:read"]', 1);

INSERT INTO admin_agent_token_families (
  family_id, family_jti, tenant_id, grant_id, grant_generation, admin_user_id,
  client_id, consent_version, status, finalization_nonce, finalized_at,
  expires_at, created_at, updated_at
) VALUES
  ('family-v4', 'jti-v4', 'tenant-1', 'grant-builtin-v4', 1, 'admin-1',
   'client-v4', 1, 'active', 'nonce-v4', 1, CAST(strftime('%s', 'now') AS INTEGER) + 86400, 1, 1);`
        );

        runMigrationFiles(sqlite3Path, dbPath, [discoveryMigration]);
        runMigrationFiles(sqlite3Path, dbPath, [discoveryMigration]);

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || generation || '|' || consent_version
               FROM admin_agent_grants WHERE id = 'grant-builtin-v4';`
          )
        ).toBe('suspended|2|2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM admin_agent_grants
              WHERE id IN ('grant-builtin-v5', 'grant-custom-v4') AND status = 'active';`
          )
        ).toBe('2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT (revoked_at IS NOT NULL) || '|' || revoked_reason
               FROM agent_consents WHERE id = 'consent-v4';`
          )
        ).toBe('1|grant_updated');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || revocation_outbox_id
               FROM admin_agent_token_families WHERE family_id = 'family-v4';`
          )
        ).toBe('revocation_pending|migration_024_revoke_grant-builtin-v4');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || json_extract(payload, '$.reason')
               FROM admin_agent_token_revocation_outbox
              WHERE id = 'migration_024_revoke_grant-builtin-v4';`
          )
        ).toBe('pending|builtin_task_set_discovery_profile_upgrade');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM admin_audit_log
              WHERE resource_id = 'grant-builtin-v4'
                AND action = 'agent.grant.suspended'
                AND actor_sub = 'migration:024';`
          )
        ).toBe('1');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'requires time-bounded Agent Grants and suspends credentials requiring recertification',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) return;

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-agent-grant-recertification-'));
      const dbPath = join(tempDir, 'test.db');
      const recertificationMigration = 'admin/027_agent_grant_recertification.sql';

      try {
        runMigrationFiles(
          sqlite3Path,
          dbPath,
          activeAdminMigrationFiles().filter((file) => file !== recertificationMigration)
        );
        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
VALUES ('admin-1', 'tenant-1', 'admin@example.test', 1, 1);

INSERT INTO admin_agent_grants (
  id, tenant_id, client_id, grantor_id, delegator_id, permissions, scopes,
  delegation_mode, generation, consent_version, status, expires_at, active_uniqueness_key,
  created_at, updated_at, task_set_id, task_set_version, scope_policy_id,
  scope_policy_version, resolved_tools, resolved_scope_constraints, access_snapshot_hash
) VALUES
  ('grant-builtin-v6', 'tenant-1', 'client-v6', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ + 2592000000, 'active',
   __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
   'builtin_agent_task_set_read_only_inspector', 6, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('grant-permanent', 'tenant-1', 'client-permanent', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', NULL, 'active',
   __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
   'custom-agent-task-set', 1, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  ('grant-custom-v7', 'tenant-1', 'client-v7', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ + 2592000000, 'active',
   __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
   'custom-agent-task-set', 7, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{}', 'ccccccccccccccccccccccccccccccccccccccccccc');

INSERT INTO agent_consents (
  id, tenant_id, consent_type, grant_id, user_id, client_id, consent_version,
  scopes, granted_at
) VALUES
  ('consent-v6', 'tenant-1', 'delegation', 'grant-builtin-v6', 'admin-1', 'client-v6', 1,
   '["agent:read"]', 1);

INSERT INTO admin_agent_token_families (
  family_id, family_jti, tenant_id, grant_id, grant_generation, admin_user_id,
  client_id, consent_version, status, finalization_nonce, finalized_at,
  expires_at, created_at, updated_at
) VALUES
  ('family-v6', 'jti-v6', 'tenant-1', 'grant-builtin-v6', 1, 'admin-1',
   'client-v6', 1, 'active', 'nonce-v6', 1,
   CAST(strftime('%s', 'now') AS INTEGER) + 86400, 1, 1);`.replaceAll(
            '__AUTHRIM_NOW_EPOCH_MILLISECONDS__',
            "CAST(strftime('%s', 'now') AS INTEGER) * 1000"
          )
        );

        runMigrationFiles(sqlite3Path, dbPath, [recertificationMigration]);
        runMigrationFiles(sqlite3Path, dbPath, [recertificationMigration]);

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM admin_agent_grants
              WHERE id IN ('grant-builtin-v6', 'grant-permanent')
                AND status = 'suspended' AND generation = 2 AND consent_version = 2;`
          )
        ).toBe('2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status FROM admin_agent_grants WHERE id = 'grant-custom-v7';`
          )
        ).toBe('active');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT (revoked_at IS NOT NULL) || '|' || revoked_reason
               FROM agent_consents WHERE id = 'consent-v6';`
          )
        ).toBe('1|grant_updated');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || revocation_outbox_id
               FROM admin_agent_token_families WHERE family_id = 'family-v6';`
          )
        ).toBe('revocation_pending|migration_027_revoke_grant-builtin-v6');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM admin_audit_log
              WHERE resource_id IN ('grant-builtin-v6', 'grant-permanent')
                AND action = 'agent.grant.suspended'
                AND actor_sub = 'migration:027';`
          )
        ).toBe('2');

        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `INSERT INTO admin_agent_grants (
              id, tenant_id, client_id, grantor_id, delegator_id, permissions, scopes,
              delegation_mode, generation, consent_version, status, expires_at,
              active_uniqueness_key, created_at, updated_at, task_set_id, task_set_version,
              scope_policy_id, scope_policy_version, resolved_tools,
              resolved_scope_constraints, access_snapshot_hash
            ) VALUES (
              'grant-invalid-new', 'tenant-1', 'client-invalid', 'admin-1', 'admin-1', '[]',
              '["agent:read"]', 'user_consent', 1, 1, 'active', NULL, 'active', 1000, 1000,
              'custom-agent-task-set', 1, 'scope-1', 1,
              '[{"toolId":"admin.read.clients.list"}]', '{}',
              'ddddddddddddddddddddddddddddddddddddddddddd'
            );`
          )
        ).toThrow(/active Agent Grant expiry must be between 1 hour and 90 days/u);

        runSqlite(
          sqlite3Path,
          dbPath,
          `INSERT INTO admin_agent_grants (
            id, tenant_id, client_id, grantor_id, delegator_id, permissions, scopes,
            delegation_mode, generation, consent_version, status, expires_at,
            active_uniqueness_key, created_at, updated_at, task_set_id, task_set_version,
            scope_policy_id, scope_policy_version, resolved_tools,
            resolved_scope_constraints, access_snapshot_hash
          ) VALUES (
            'grant-valid-new', 'tenant-1', 'client-valid', 'admin-1', 'admin-1', '[]',
            '["agent:read"]', 'user_consent', 1, 1, 'active', 2592001000, 'active', 1000, 1000,
            'custom-agent-task-set', 1, 'scope-1', 1,
            '[{"toolId":"admin.read.clients.list"}]', '{}',
            'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
          );`
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'suspends built-in v7 Agent Grants before the authority-introspection v8 cut-over',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) return;

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-agent-authority-upgrade-'));
      const dbPath = join(tempDir, 'test.db');
      const authorityMigration = 'admin/028_agent_authority_introspection.sql';
      const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

      try {
        runMigrationFiles(
          sqlite3Path,
          dbPath,
          activeAdminMigrationFiles().filter((file) => file !== authorityMigration)
        );
        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
VALUES ('admin-1', 'tenant-1', 'admin@example.test', 1, 1);

INSERT INTO admin_agent_grants (
  id, tenant_id, client_id, grantor_id, delegator_id, permissions, scopes,
  delegation_mode, generation, consent_version, status, expires_at, active_uniqueness_key,
  created_at, updated_at, task_set_id, task_set_version, scope_policy_id,
  scope_policy_version, resolved_tools, resolved_scope_constraints, access_snapshot_hash
) VALUES
  ('grant-builtin-v7', 'tenant-1', 'client-v7', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', ${now} + 2592000000, 'active', ${now}, ${now},
   'builtin_agent_task_set_read_only_inspector', 7, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('grant-custom-v7', 'tenant-1', 'client-custom-v7', 'admin-1', 'admin-1', '[]', '["agent:read"]',
   'user_consent', 1, 1, 'active', ${now} + 2592000000, 'active', ${now}, ${now},
   'custom-agent-task-set', 7, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

INSERT INTO agent_consents (
  id, tenant_id, consent_type, grant_id, user_id, client_id, consent_version,
  scopes, granted_at
) VALUES
  ('consent-v7', 'tenant-1', 'delegation', 'grant-builtin-v7', 'admin-1', 'client-v7', 1,
   '["agent:read"]', 1);

INSERT INTO admin_agent_token_families (
  family_id, family_jti, tenant_id, grant_id, grant_generation, admin_user_id,
  client_id, consent_version, status, finalization_nonce, finalized_at,
  expires_at, created_at, updated_at
) VALUES
  ('family-v7', 'jti-v7', 'tenant-1', 'grant-builtin-v7', 1, 'admin-1',
   'client-v7', 1, 'active', 'nonce-v7', 1,
   CAST(strftime('%s', 'now') AS INTEGER) + 86400, 1, 1);`
        );

        runMigrationFiles(sqlite3Path, dbPath, [authorityMigration]);
        runMigrationFiles(sqlite3Path, dbPath, [authorityMigration]);

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || generation || '|' || consent_version
               FROM admin_agent_grants WHERE id = 'grant-builtin-v7';`
          )
        ).toBe('suspended|2|2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status FROM admin_agent_grants WHERE id = 'grant-custom-v7';`
          )
        ).toBe('active');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT (revoked_at IS NOT NULL) || '|' || revoked_reason
               FROM agent_consents WHERE id = 'consent-v7';`
          )
        ).toBe('1|grant_updated');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || revocation_outbox_id
               FROM admin_agent_token_families WHERE family_id = 'family-v7';`
          )
        ).toBe('revocation_pending|migration_028_revoke_grant-builtin-v7');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || json_extract(payload, '$.reason')
               FROM admin_agent_token_revocation_outbox
              WHERE id = 'migration_028_revoke_grant-builtin-v7';`
          )
        ).toBe('pending|builtin_task_set_agent_introspection_upgrade');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM admin_audit_log
              WHERE resource_id = 'grant-builtin-v7'
                AND action = 'agent.grant.suspended'
                AND actor_sub = 'migration:028';`
          )
        ).toBe('1');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it(
    'suspends stale system-managed self-service Grants without changing current or managed Grants',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) return;

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-agent-self-service-catalog-upgrade-'));
      const dbPath = join(tempDir, 'test.db');
      const catalogMigration = 'admin/029_stale_self_service_agent_snapshots.sql';
      const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

      try {
        runMigrationFiles(
          sqlite3Path,
          dbPath,
          activeAdminMigrationFiles().filter((file) => file !== catalogMigration)
        );
        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
VALUES ('admin-1', 'tenant-1', 'admin@example.test', 1, 1);

INSERT INTO agent_task_sets (
  id, tenant_id, name, kind, status, current_version, management_mode,
  created_by, created_at, updated_at
) VALUES
  ('system-task-stale', 'tenant-1', 'System task stale', 'custom', 'active', 1,
   'system_managed', 'system', 1, 1),
  ('system-task-current', 'tenant-1', 'System task current', 'custom', 'active', 1,
   'system_managed', 'system', 1, 1),
  ('managed-task-stale', 'tenant-1', 'Managed task stale', 'custom', 'active', 1,
   'managed', 'admin-1', 1, 1);

INSERT INTO agent_task_set_versions (
  task_set_id, version, tool_entries_json, resolved_permissions_json,
  definition_digest, catalog_version, status, created_by, created_at
) VALUES
  ('system-task-stale', 1, '[]', '[]', 'digest-stale', 'admin-agent-access-v8',
   'active', 'system', 1),
  ('system-task-current', 1, '[]', '[]', 'digest-current', 'admin-agent-access-v9',
   'active', 'system', 1),
  ('managed-task-stale', 1, '[]', '[]', 'digest-managed', 'admin-agent-access-v8',
   'active', 'admin-1', 1);

INSERT INTO admin_agent_grants (
  id, tenant_id, client_id, grantor_id, delegator_id, permissions, scopes,
  delegation_mode, generation, consent_version, status, expires_at, active_uniqueness_key,
  created_at, updated_at, task_set_id, task_set_version, scope_policy_id,
  scope_policy_version, resolved_tools, resolved_scope_constraints, access_snapshot_hash,
  purpose, management_mode
) VALUES
  ('grant-self-service-stale', 'tenant-1', 'client-stale', 'admin-1', 'admin-1',
   '["admin:agent_grants:read"]', '["agent:read"]', 'user_consent', 1, 1, 'active',
   ${now} + 2592000000, 'active', ${now}, ${now}, 'system-task-stale', 1, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{"tenantIds":["tenant-1"]}',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'interactive_self_service', 'system_managed'),
  ('grant-self-service-current', 'tenant-1', 'client-current', 'admin-1', 'admin-1',
   '["admin:agent_grants:read"]', '["agent:read"]', 'user_consent', 1, 1, 'active',
   ${now} + 2592000000, 'active', ${now}, ${now}, 'system-task-current', 1, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{"tenantIds":["tenant-1"]}',
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   'interactive_self_service', 'system_managed'),
  ('grant-managed-stale', 'tenant-1', 'client-managed', 'admin-1', 'admin-1',
   '["admin:agent_grants:read"]', '["agent:read"]', 'user_consent', 1, 1, 'active',
   ${now} + 2592000000, 'active', ${now}, ${now}, 'managed-task-stale', 1, 'scope-1', 1,
   '[{"toolId":"admin.read.clients.list"}]', '{"tenantIds":["tenant-1"]}',
   'ccccccccccccccccccccccccccccccccccccccccccc',
   'managed_fixture', 'managed');

INSERT INTO agent_consents (
  id, tenant_id, consent_type, grant_id, user_id, client_id, consent_version,
  scopes, granted_at
) VALUES
  ('consent-stale', 'tenant-1', 'delegation', 'grant-self-service-stale', 'admin-1',
   'client-stale', 1, '["agent:read"]', 1);

INSERT INTO admin_agent_token_families (
  family_id, family_jti, tenant_id, grant_id, grant_generation, admin_user_id,
  client_id, consent_version, status, finalization_nonce, finalized_at,
  expires_at, created_at, updated_at
) VALUES
  ('family-stale', 'jti-stale', 'tenant-1', 'grant-self-service-stale', 1, 'admin-1',
   'client-stale', 1, 'active', 'nonce-stale', 1,
   CAST(strftime('%s', 'now') AS INTEGER) + 86400, 1, 1);`
        );

        runMigrationFiles(sqlite3Path, dbPath, [catalogMigration]);
        runMigrationFiles(sqlite3Path, dbPath, [catalogMigration]);

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || generation || '|' || consent_version
               FROM admin_agent_grants WHERE id = 'grant-self-service-stale';`
          )
        ).toBe('suspended|2|2');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status FROM admin_agent_grants WHERE id = 'grant-self-service-current';`
          )
        ).toBe('active');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status FROM admin_agent_grants WHERE id = 'grant-managed-stale';`
          )
        ).toBe('active');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT (revoked_at IS NOT NULL) || '|' || revoked_reason
               FROM agent_consents WHERE id = 'consent-stale';`
          )
        ).toBe('1|grant_updated');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || revocation_outbox_id
               FROM admin_agent_token_families WHERE family_id = 'family-stale';`
          )
        ).toBe('revocation_pending|migration_029_revoke_grant-self-service-stale');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT status || '|' || json_extract(payload, '$.reason')
               FROM admin_agent_token_revocation_outbox
              WHERE id = 'migration_029_revoke_grant-self-service-stale';`
          )
        ).toBe('pending|stale_self_service_tool_catalog');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*) FROM admin_audit_log
              WHERE resource_id = 'grant-self-service-stale'
                AND action = 'agent.grant.suspended'
                AND actor_sub = 'migration:029';`
          )
        ).toBe('1');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it('extends Flow assignment targets in follow-up migrations instead of baselines', () => {
    const coreBaseline = readMigration('017_core_flow_runtime.sql');
    const coreExtension = readMigration('020_flow_assignment_credential_profiles.sql');
    const postgresBaseline = readMigration('external/postgres/006_external_flow_runtime.sql');
    const postgresExtension = readMigration(
      'external/postgres/009_external_flow_assignment_credential_profiles.sql'
    );

    expect(coreBaseline).not.toContain("'credential_profile'");
    expect(postgresBaseline).not.toContain("'credential_profile'");
    expect(coreExtension).toContain("'credential_profile'");
    expect(postgresExtension).toContain("'credential_profile'");
    expect(postgresExtension).toContain('flow_assignments_target_type_check');
    expect(postgresExtension).toContain('flow_assignments_target_id_check');
  });

  it('keeps Admin role assignment scope normalization independent from timestamp columns', () => {
    const sql = readMigrations(activeAdminMigrationFiles());
    const updateStatement = sql.match(/UPDATE admin_role_assignments[\s\S]*?;/)?.[0];

    expect(updateStatement).toBeDefined();
    expect(updateStatement).toContain('SET scope_id = tenant_id');
    expect(updateStatement).not.toContain('updated_at');
    expect(updateStatement).not.toContain("strftime('%s', 'now')");
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
    const sql = readMigration('006_core_extended_operations.sql');

    expect(sql).not.toContain('Seed default OIDC claim schemas');
    expect(sql).not.toContain('randomblob(');
    expect(sql).not.toContain("'system_claim_' || t.id || '_name'");
    expect(sql).not.toContain("'system_claim_' || t.id || '_address_country'");
  });

  it('removes partial indexes from the final current schemas', () => {
    const partialIndexPattern = /CREATE(?: UNIQUE)? INDEX[\s\S]{0,120}?WHERE\b/;
    const transitionalMigration = 'plugin-runner/006_dynamic_worker_loader_artifacts.sql';

    for (const migrationFile of activeD1MigrationFiles()) {
      if (migrationFile === transitionalMigration) continue;
      const sql = readMigration(migrationFile);
      expect(sql).not.toMatch(partialIndexPattern);
    }

    const transitionalSql = readMigration(transitionalMigration);
    const replacementSql = readMigration(
      'plugin-runner/007_replace_dynamic_rollout_partial_index.sql'
    );
    expect(transitionalSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_runner_dynamic_rollout_active_plugin'
    );
    expect(replacementSql).toContain(
      'DROP INDEX IF EXISTS idx_plugin_runner_dynamic_rollout_active_plugin'
    );
    expect(replacementSql).toContain('trg_plugin_runner_dynamic_rollout_running_insert');
    expect(replacementSql).toContain('trg_plugin_runner_dynamic_rollout_running_update');

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
    expect(sql).toContain('UNIQUE (tenant_id, session_id, client_id)');
    expect(sql).toContain('CREATE INDEX idx_ciba_client ON ciba_requests(tenant_id, client_id)');
    expect(sql).toContain(
      'CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id)'
    );
    expect(sql).toContain(
      'CREATE INDEX idx_session_clients_client_id ON session_clients(tenant_id, client_id)'
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

        runSqlite(
          sqlite3Path,
          dbPath,
          `
PRAGMA foreign_keys = ON;
INSERT INTO session_clients (
  id,
  tenant_id,
  session_id,
  client_id,
  first_token_at,
  last_token_at
) VALUES (
  'sc-tenant-a',
  'tenant-a',
  'session-a',
  'shared-mobile',
  1,
  1
);
`
        );

        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `
PRAGMA foreign_keys = ON;
INSERT INTO session_clients (
  id,
  tenant_id,
  session_id,
  client_id,
  first_token_at,
  last_token_at
) VALUES (
  'sc-tenant-c',
  'tenant-c',
  'session-c',
  'shared-mobile',
  1,
  1
);
`
          )
        ).toThrow();

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
    'upgrades existing Flow assignments for credential profiles without losing constraints',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-flow-assignment-migration-'));
      const dbPath = join(tempDir, 'test.db');
      const extensionMigration = '020_flow_assignment_credential_profiles.sql';
      const migrationsBeforeExtension = activeCoreMigrationFiles().filter(
        (migrationFile) => migrationFile !== extensionMigration
      );

      try {
        runMigrationFiles(sqlite3Path, dbPath, migrationsBeforeExtension);
        const assignmentCountBefore = readSqlite(
          sqlite3Path,
          dbPath,
          'SELECT COUNT(*) FROM flow_assignments;'
        );

        runMigrationFiles(sqlite3Path, dbPath, [extensionMigration]);

        expect(readSqlite(sqlite3Path, dbPath, 'SELECT COUNT(*) FROM flow_assignments;')).toBe(
          assignmentCountBefore
        );

        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
INSERT INTO flow_assignments (
  id, tenant_id, target_type, target_id, flow_kind, flow_id, enabled, created_at, updated_at
) VALUES (
  'credential-profile-assignment',
  'default',
  'credential_profile',
  'credential-profile-1',
  'credential_issuance',
  'flow-default-login-no-consent',
  1,
  100,
  100
);`
        );
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT target_type || ':' || target_id
               FROM flow_assignments
              WHERE id = 'credential-profile-assignment';`
          )
        ).toBe('credential_profile:credential-profile-1');

        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `INSERT INTO flow_assignments (
  id, tenant_id, target_type, target_id, flow_kind, flow_id, created_at, updated_at
) VALUES (
  'credential-profile-missing-target',
  'default',
  'credential_profile',
  NULL,
  'credential_issuance',
  'flow-default-login-no-consent',
  100,
  100
);`
          )
        ).toThrow();
        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `INSERT INTO flow_assignments (
  id, tenant_id, target_type, target_id, flow_kind, flow_id, created_at, updated_at
) VALUES (
  'credential-profile-duplicate',
  'default',
  'credential_profile',
  'credential-profile-1',
  'credential_issuance',
  'flow-default-login-no-consent',
  100,
  100
);`
          )
        ).toThrow();
        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `INSERT INTO flow_assignments (
  id, tenant_id, target_type, target_id, flow_kind, flow_id, created_at, updated_at
) VALUES (
  'unsupported-target-assignment',
  'default',
  'unsupported',
  'target-1',
  'credential_issuance',
  'flow-default-login-no-consent',
  100,
  100
);`
          )
        ).toThrow();
        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `PRAGMA foreign_keys = ON;
INSERT INTO flow_assignments (
  id, tenant_id, target_type, target_id, flow_kind, flow_id, created_at, updated_at
) VALUES (
  'missing-flow-assignment',
  'default',
  'credential_profile',
  'credential-profile-2',
  'credential_issuance',
  'missing-flow',
  100,
  100
);`
          )
        ).toThrow();
        expect(findInvalidForeignKeyReferences(sqlite3Path, dbPath)).toEqual([]);
        expect(readSqlite(sqlite3Path, dbPath, 'PRAGMA foreign_key_check;')).toBe('');
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

  it(
    'adds OAuth/OIDC fields to existing PII linked identities',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-pii-linked-identity-migration-'));
      const dbPath = join(tempDir, 'test.db');

      try {
        runMigrationFiles(sqlite3Path, dbPath, ['pii/001_pii_schema.sql']);
        runSqlite(
          sqlite3Path,
          dbPath,
          `INSERT INTO linked_identities (
  id, tenant_id, user_id, provider_id, provider_user_id, linked_at, last_used_at
) VALUES ('link-1', 'tenant-1', 'user-1', 'provider-1', 'subject-1', 100, 200);`
        );
        runMigrationFiles(sqlite3Path, dbPath, ['pii/002_linked_identity_oidc_fields.sql']);
        runMigrationFiles(sqlite3Path, dbPath, ['pii/007_external_idp_jit_provisioning_state.sql']);

        const columns = readSqliteLines(
          sqlite3Path,
          dbPath,
          "SELECT name FROM pragma_table_info('linked_identities') ORDER BY cid;"
        );
        expect(columns).toEqual(
          expect.arrayContaining([
            'email_verified',
            'access_token_encrypted',
            'refresh_token_encrypted',
            'token_expires_at',
            'raw_claims',
            'profile_data',
            'last_login_at',
            'updated_at',
            'provisioning_state',
          ])
        );
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT email_verified || '|' || last_login_at || '|' || updated_at || '|' || provisioning_state
               FROM linked_identities WHERE id = 'link-1';`
          )
        ).toBe('0|200|200|active');
        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            "UPDATE linked_identities SET provisioning_state = 'invalid' WHERE id = 'link-1';"
          )
        ).toThrow();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it('keeps external Postgres linked identities compatible with the PII schema', () => {
    const postgresMigration = readMigration(
      'external/postgres/010_external_linked_identity_oidc_fields.sql'
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
      expect(postgresMigration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(postgresMigration).toContain('last_used_at');
    expect(postgresMigration).toContain('linked_at');
    const jitProvisioningMigration = readMigration(
      'external/postgres/019_external_idp_jit_provisioning_state.sql'
    );
    expect(jitProvisioningMigration).toContain('ADD COLUMN IF NOT EXISTS provisioning_state');
    expect(jitProvisioningMigration).toContain(
      "CHECK (provisioning_state IN ('pending', 'active'))"
    );
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
    'repairs device-code client foreign keys while retaining only redeemable codes',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-device-code-fk-repair-'));
      const dbPath = join(tempDir, 'test.db');
      const repairMigration = '018_repair_device_code_client_foreign_key.sql';
      const migrationsBeforeRepair = activeCoreMigrationFiles().filter(
        (migrationFile) => migrationFile !== repairMigration
      );

      try {
        runMigrationFiles(sqlite3Path, dbPath, migrationsBeforeRepair);
        runSqlite(
          sqlite3Path,
          dbPath,
          `
PRAGMA foreign_keys = OFF;
${insertOAuthClientSql('default', 'device-client', 'Device Client')}
INSERT INTO device_codes (
  device_code,
  user_code,
  client_id,
  scope,
  status,
  created_at,
  expires_at,
  tenant_id
) VALUES (
  'device-valid',
  'USER-VALID',
  'device-client',
  'openid',
  'pending',
  100,
  200,
  'default'
);
INSERT INTO device_codes (
  device_code,
  user_code,
  client_id,
  scope,
  status,
  created_at,
  expires_at,
  tenant_id
) VALUES (
  'device-orphan',
  'USER-ORPHAN',
  'missing-client',
  'openid',
  'pending',
  100,
  200,
  'default'
);
`
        );

        runMigrationFiles(sqlite3Path, dbPath, [repairMigration]);

        expect(readSqlite(sqlite3Path, dbPath, 'SELECT device_code FROM device_codes;')).toBe(
          'device-valid'
        );
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT group_concat("from" || ':' || "to", ',')
               FROM (
                 SELECT "from", "to"
                   FROM pragma_foreign_key_list('device_codes')
                  WHERE "table" = 'oauth_clients'
                  ORDER BY id, seq
               );`
          )
        ).toBe('tenant_id:tenant_id,client_id:client_id');
        expect(findInvalidForeignKeyReferences(sqlite3Path, dbPath)).toEqual([]);
        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `PRAGMA foreign_keys = ON;
INSERT INTO device_codes (
  device_code,
  user_code,
  client_id,
  scope,
  status,
  created_at,
  expires_at,
  tenant_id
) VALUES (
  'device-cross-tenant',
  'USER-CROSS-TENANT',
  'device-client',
  'openid',
  'pending',
  100,
  200,
  'another-tenant'
);`
          )
        ).toThrow();

        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
DELETE FROM oauth_clients
 WHERE tenant_id = 'default'
   AND client_id = 'device-client';`
        );
        expect(readSqlite(sqlite3Path, dbPath, 'SELECT COUNT(*) FROM device_codes;')).toBe('0');
        expect(readSqlite(sqlite3Path, dbPath, 'PRAGMA foreign_key_check;')).toBe('');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

  it('backfills tenant lifecycle state from is_active and drops the legacy column', () => {
    const sqlite3Path = findSqlite3();
    if (!sqlite3Path) {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'authrim-tenant-lifecycle-migration-'));
    const dbPath = join(tempDir, 'test.db');

    try {
      runMigrationFiles(sqlite3Path, dbPath, ['001_core_foundation.sql']);
      runSqlite(
        sqlite3Path,
        dbPath,
        `
INSERT INTO tenants (
  id,
  tenant_code,
  tenant_key,
  name,
  is_active,
  created_at,
  updated_at
) VALUES (
  'inactive-tenant',
  'inactive-tenant',
  'tenant-key-inactive',
  'Inactive Tenant',
  0,
  1,
  1
);
`
      );

      runMigrationFiles(sqlite3Path, dbPath, ['007_tenant_lifecycle_state.sql']);

      expect(
        readSqlite(sqlite3Path, dbPath, "SELECT lifecycle_state FROM tenants WHERE id = 'default';")
      ).toBe('active');
      expect(
        readSqlite(
          sqlite3Path,
          dbPath,
          "SELECT lifecycle_state FROM tenants WHERE id = 'inactive-tenant';"
        )
      ).toBe('suspended');
      expect(
        readSqlite(
          sqlite3Path,
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('tenants') WHERE name = 'is_active';"
        )
      ).toBe('0');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it(
    'repairs approval object-catalog foreign keys without losing approval data',
    () => {
      const sqlite3Path = findSqlite3();
      if (!sqlite3Path) {
        return;
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'authrim-admin-approval-fk-repair-'));
      const dbPath = join(tempDir, 'test.db');
      const directoryCatalogMigration = 'admin/009_directory_auth_object_catalog_classes.sql';
      const repairMigration = 'admin/010_repair_approval_object_catalog_foreign_key.sql';
      const migrationsBeforeCatalogRebuild = activeAdminMigrationFiles().filter(
        (migrationFile) =>
          migrationFile !== directoryCatalogMigration && migrationFile !== repairMigration
      );

      try {
        runMigrationFiles(sqlite3Path, dbPath, migrationsBeforeCatalogRebuild);
        runSqlite(
          sqlite3Path,
          dbPath,
          `
PRAGMA foreign_keys = ON;
INSERT INTO object_catalog (
  id,
  public_artifact_id,
  tenant_id,
  object_class,
  created_at,
  updated_at
) VALUES (
  'catalog-existing',
  'artifact-existing',
  'default',
  'approval_transport_detail',
  100,
  100
);
${insertApprovalRequestSql('request-existing')}
INSERT INTO approval_request_approvals (
  id,
  approval_request_id,
  step_key,
  side,
  subject_type,
  subject_id,
  status,
  method,
  requested_at,
  expires_at,
  created_at,
  updated_at,
  last_notification_action,
  last_notified_at,
  notification_count
) VALUES (
  'approval-existing',
  'request-existing',
  'customer-owner',
  'customer_data_owner',
  'end_user',
  'user-existing',
  'pending',
  'portal_confirm',
  100,
  200,
  100,
  100,
  'initial',
  101,
  3
);
INSERT INTO elevation_grants (
  id,
  public_grant_id,
  approval_request_id,
  tenant_id,
  status,
  target_audience,
  resource_class,
  redaction_level,
  scope_canonical,
  scope_json,
  requester_subject_type,
  requester_subject_id,
  actor_subject_type,
  actor_subject_id,
  issued_at,
  expires_at,
  created_at,
  updated_at
) VALUES (
  'grant-existing',
  'egr-existing',
  'request-existing',
  'default',
  'active',
  'admin-api',
  'customer_profile',
  'masked',
  'surface=service_data&action=detail_read',
  '{}',
  'service_principal',
  'approval-smoke',
  'service_principal',
  'approval-smoke',
  100,
  200,
  100,
  100
);
`
        );

        runMigrationFiles(sqlite3Path, dbPath, [directoryCatalogMigration]);

        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT "table"
               FROM pragma_foreign_key_list('approval_requests')
              WHERE "from" = 'detail_object_catalog_id';`
          )
        ).toBe('object_catalog_old');
        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `PRAGMA foreign_keys = ON;${insertApprovalRequestSql('request-before-repair')}`
          )
        ).toThrow();

        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;\n${renderPortableMigrationSql(
            readMigration(repairMigration),
            'sqlite'
          )}`
        );

        expect(findInvalidForeignKeyReferences(sqlite3Path, dbPath)).toEqual([]);
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT "table"
               FROM pragma_foreign_key_list('approval_requests')
              WHERE "from" = 'detail_object_catalog_id';`
          )
        ).toBe('object_catalog');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT "table"
               FROM pragma_foreign_key_list('approval_request_approvals')
              WHERE "from" = 'approval_request_id';`
          )
        ).toBe('approval_requests');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT "table"
               FROM pragma_foreign_key_list('elevation_grants')
              WHERE "from" = 'approval_request_id';`
          )
        ).toBe('approval_requests');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT public_request_id FROM approval_requests WHERE id = 'request-existing';"
          )
        ).toBe('apr-request-existing');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT last_notification_action || ':' || last_notified_at || ':' || notification_count
               FROM approval_request_approvals
              WHERE id = 'approval-existing';`
          )
        ).toBe('initial:101:3');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT public_grant_id FROM elevation_grants WHERE id = 'grant-existing';"
          )
        ).toBe('egr-existing');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
               FROM sqlite_master
              WHERE type = 'table'
                AND (name LIKE '%_old' OR name LIKE '%_repaired');`
          )
        ).toBe('0');
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            `SELECT COUNT(*)
               FROM sqlite_master
              WHERE type = 'index'
                AND name IN (
                  'idx_approval_requests_tenant_status_requested',
                  'idx_approval_requests_investigation',
                  'idx_approval_requests_requester',
                  'idx_approval_requests_target',
                  'idx_approval_requests_expires',
                  'idx_approval_requests_detail_object_catalog',
                  'idx_approval_request_approvals_unique_subject',
                  'idx_approval_request_approvals_request_status',
                  'idx_approval_request_approvals_subject',
                  'idx_approval_request_approvals_expires',
                  'idx_elevation_grants_tenant_status_issued',
                  'idx_elevation_grants_request',
                  'idx_elevation_grants_actor',
                  'idx_elevation_grants_expires'
                );`
          )
        ).toBe('14');

        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `PRAGMA foreign_keys = ON;${insertApprovalRequestSql('request-after-repair')}`
          )
        ).not.toThrow();
        expect(() =>
          runSqlite(
            sqlite3Path,
            dbPath,
            `PRAGMA foreign_keys = ON;${insertApprovalRequestSql(
              'request-invalid-catalog',
              'catalog-missing'
            )}`
          )
        ).toThrow();

        runSqlite(
          sqlite3Path,
          dbPath,
          `PRAGMA foreign_keys = ON;
UPDATE approval_requests
   SET detail_object_catalog_id = 'catalog-existing'
 WHERE id = 'request-existing';
DELETE FROM object_catalog WHERE id = 'catalog-existing';`
        );
        expect(
          readSqlite(
            sqlite3Path,
            dbPath,
            "SELECT detail_object_catalog_id IS NULL FROM approval_requests WHERE id = 'request-existing';"
          )
        ).toBe('1');
        expect(readSqlite(sqlite3Path, dbPath, 'PRAGMA foreign_key_check;')).toBe('');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    sqliteMigrationApplyTimeoutMs
  );

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

  it('keeps unified identity mapping schema migrations annotated with schema-readiness IDs', () => {
    const migrationSql = [
      readMigration('008_unified_identity_canonical_schema.sql'),
      readMigration('admin/007_identity_mapping_control_plane.sql'),
    ].join('\n');
    const migrationIds = new Set(migrationSql.match(/UIM-SCH-\d{3}/g) ?? []);
    const expectedIds = [
      ...Array.from({ length: 84 }, (_, index) => `UIM-SCH-${String(index + 1).padStart(3, '0')}`),
      'UIM-SCH-088',
      'UIM-SCH-089',
      'UIM-SCH-090',
      'UIM-SCH-091',
      'UIM-SCH-092',
      'UIM-SCH-093',
      'UIM-SCH-094',
      'UIM-SCH-095',
    ];

    expect([...migrationIds].sort()).toEqual(expectedIds.sort());
    expect(migrationIds.has('UIM-SCH-032A')).toBe(false);
    expect(migrationIds.has('UIM-SCH-085')).toBe(false);
    expect(migrationIds.has('UIM-SCH-086')).toBe(false);
    expect(migrationIds.has('UIM-SCH-087')).toBe(false);
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
