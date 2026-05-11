import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRecordMigrationSql,
  buildRuntimeProfileSeedSql,
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

describe('migration seed SQL portability', () => {
  it('keeps current and setup mirror seed migrations free of INSERT OR IGNORE', () => {
    const migrationFiles = [
      new URL('../../../../migrations/057_add_tenants_table.sql', import.meta.url),
      new URL('../../../../migrations/pii/001_pii_initial.sql', import.meta.url),
      new URL('../../../../migrations/admin/002_admin_rbac.sql', import.meta.url),
      new URL('../../../../migrations/admin/005_admin_abac_rebac.sql', import.meta.url),
      new URL('../../../../migrations/admin/008_admin_rebac_definitions.sql', import.meta.url),
      new URL('../../migrations/pii/001_pii_initial.sql', import.meta.url),
      new URL('../../migrations/admin/002_admin_rbac.sql', import.meta.url),
      new URL('../../migrations/admin/005_admin_abac_rebac.sql', import.meta.url),
      new URL('../../migrations/admin/008_admin_rebac_definitions.sql', import.meta.url),
    ];

    for (const fileUrl of migrationFiles) {
      const sql = readFileSync(fileUrl, 'utf-8');
      expect(sql).not.toContain('INSERT OR IGNORE');
      expect(sql).toContain('WHERE NOT EXISTS');
    }
  });

  it('replaces backend-specific epoch helpers in current and setup migration assets', () => {
    const migrationFiles = [
      new URL('../../../../migrations/000_fresh_schema.sql', import.meta.url),
      new URL('../../../../migrations/052_consent_management.sql', import.meta.url),
      new URL('../../../../migrations/057_add_tenants_table.sql', import.meta.url),
      new URL('../../../../migrations/061_seed_default_claim_schemas.sql', import.meta.url),
      new URL('../../../../migrations/admin/002_admin_rbac.sql', import.meta.url),
      new URL('../../../../migrations/admin/005_admin_abac_rebac.sql', import.meta.url),
      new URL('../../../../migrations/admin/008_admin_rebac_definitions.sql', import.meta.url),
      new URL('../../migrations/000_fresh_schema.sql', import.meta.url),
      new URL('../../migrations/admin/002_admin_rbac.sql', import.meta.url),
      new URL('../../migrations/admin/005_admin_abac_rebac.sql', import.meta.url),
      new URL('../../migrations/admin/008_admin_rebac_definitions.sql', import.meta.url),
    ];

    for (const fileUrl of migrationFiles) {
      const sql = readFileSync(fileUrl, 'utf-8');
      expect(sql).not.toContain("strftime('%s', 'now')");
      expect(sql).not.toContain("datetime('now')");
      expect(sql).toMatch(/__AUTHRIM_NOW_EPOCH_(SECONDS|MILLISECONDS)__/);
    }
  });

  it('uses deterministic claim schema IDs instead of sqlite randomblob seeds', () => {
    const sql = readFileSync(
      new URL('../../../../migrations/061_seed_default_claim_schemas.sql', import.meta.url),
      'utf-8'
    );

    expect(sql).not.toContain('randomblob(');
    expect(sql).toContain("'system_claim_' || t.id || '_name'");
    expect(sql).toContain("'system_claim_' || t.id || '_address_country'");
  });

  it('removes partial indexes from current and setup migration assets in the current gate', () => {
    const migrationFiles = [
      new URL('../../../../migrations/000_fresh_schema.sql', import.meta.url),
      new URL('../../../../migrations/052_consent_management.sql', import.meta.url),
      new URL('../../../../migrations/053_custom_claim_schemas.sql', import.meta.url),
      new URL('../../../../migrations/057_add_tenants_table.sql', import.meta.url),
      new URL('../../../../migrations/058_add_tenant_domain_mappings.sql', import.meta.url),
      new URL('../../../../migrations/064_add_tenant_vanity_domains.sql', import.meta.url),
      new URL('../../migrations/000_fresh_schema.sql', import.meta.url),
    ];

    const partialIndexPattern = /CREATE(?: UNIQUE)? INDEX[\s\S]{0,120}?WHERE\b/;

    for (const fileUrl of migrationFiles) {
      const sql = readFileSync(fileUrl, 'utf-8');
      expect(sql).not.toMatch(partialIndexPattern);
    }
  });

  it('scopes OAuth client identifiers by tenant in fresh schema assets', () => {
    const migrationFiles = [
      new URL('../../../../migrations/000_fresh_schema.sql', import.meta.url),
      new URL('../../migrations/000_fresh_schema.sql', import.meta.url),
    ];

    for (const fileUrl of migrationFiles) {
      const sql = readFileSync(fileUrl, 'utf-8');
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
    }
  });

  it('applies the tenant-scoped OAuth client migration in SQLite', () => {
    const sqlite3Path = findSqlite3();
    if (!sqlite3Path) {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'authrim-oauth-client-migration-'));
    const dbPath = join(tempDir, 'test.db');

    try {
      runSqlite(
        sqlite3Path,
        dbPath,
        `
PRAGMA foreign_keys = ON;
CREATE TABLE users_core (id TEXT PRIMARY KEY);
CREATE TABLE consent_statements (id TEXT PRIMARY KEY);
CREATE TABLE sessions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default');
`
      );

      const migrationSql = readFileSync(
        new URL('../../../../migrations/077_oauth_client_tenant_scoped_identity.sql', import.meta.url),
        'utf-8'
      );
      runSqlite(sqlite3Path, dbPath, migrationSql);

      runSqlite(
        sqlite3Path,
        dbPath,
        `
PRAGMA foreign_keys = ON;
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
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
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
