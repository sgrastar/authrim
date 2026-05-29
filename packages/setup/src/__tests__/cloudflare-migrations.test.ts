import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRecordMigrationSql,
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
      renderPortableMigrationSql(readMigration(relativePath), 'sqlite')
    );
  }
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

describe('buildRecordMigrationSql', () => {
  it('uses a portable insert pattern for migration tracking', () => {
    const sql = buildRecordMigrationSql("seed'file.sql", 1234567890);

    expect(sql).toContain('INSERT INTO authrim_migrations');
    expect(sql).toContain("SELECT 'seed''file.sql', 1234567890");
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).not.toContain('INSERT OR IGNORE');
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

  it('uses deterministic claim schema IDs instead of sqlite randomblob seeds', () => {
    const sql = readMigration('006_core_extended_operations.sql');

    const claimSeedSql = sql.slice(sql.indexOf('Seed default OIDC claim schemas'));
    expect(claimSeedSql).not.toContain('randomblob(');
    expect(sql).toContain("'system_claim_' || t.id || '_name'");
    expect(sql).toContain("'system_claim_' || t.id || '_address_country'");
  });

  it('removes partial indexes from migration assets in the current gate', () => {
    const partialIndexPattern = /CREATE(?: UNIQUE)? INDEX[\s\S]{0,120}?WHERE\b/;

    for (const migrationFile of activeD1MigrationFiles()) {
      const sql = readMigration(migrationFile);
      expect(sql).not.toMatch(partialIndexPattern);
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
      readMigration('admin/007_identity_mapping_control_plane_schema.sql'),
    ].join('\n');
    const migrationIds = new Set(migrationSql.match(/UIM-SCH-\d{3}/g) ?? []);
    const expectedIds = [
      ...Array.from({ length: 84 }, (_, index) => `UIM-SCH-${String(index + 1).padStart(3, '0')}`),
      'UIM-SCH-088',
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
