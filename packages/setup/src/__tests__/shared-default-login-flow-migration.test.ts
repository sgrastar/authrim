import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listD1MigrationSqlFiles } from '../core/cloudflare.js';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const migrationsDir = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const d1Migration = '028_shared_default_login_flow.sql';
const postgresMigration = 'external/postgres/013_external_shared_default_login_flow.sql';

function findSqlite3(): string | null {
  try {
    return execFileSync('which', ['sqlite3'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function readMigration(relativePath: string): string {
  return readFileSync(join(migrationsDir, relativePath), 'utf8');
}

describe('shared default Login Flow migrations', () => {
  it('installs a published built-in version without changing the active assignment', () => {
    const sqlite3 = findSqlite3();
    if (!sqlite3) return;
    const directory = mkdtempSync(join(tmpdir(), 'authrim-shared-login-flow-'));
    const database = join(directory, 'core.db');
    try {
      const migrations = listD1MigrationSqlFiles(migrationsDir, {
        excludeTopLevelDirectories: new Set(['admin', 'archive', 'external', 'pii']),
      });
      for (const migration of migrations) {
        execFileSync(sqlite3, [database], {
          input: `PRAGMA foreign_keys = ON;\n${renderPortableMigrationSql(
            readMigration(migration),
            'sqlite'
          )}`,
          encoding: 'utf8',
        });
      }
      execFileSync(sqlite3, [database], {
        input: renderPortableMigrationSql(readMigration(d1Migration), 'sqlite'),
        encoding: 'utf8',
      });

      const flowState = execFileSync(
        sqlite3,
        [
          database,
          `SELECT status || ':' || is_builtin || ':' || template_id || ':' || published_version_id
             FROM flows
            WHERE tenant_id = 'default' AND id = 'flow-builtin-shared-default-login';`,
        ],
        { encoding: 'utf8' }
      ).trim();
      expect(flowState).toBe(
        'published:1:default-login:flow-version-builtin-shared-default-login-v1'
      );

      const topology = execFileSync(
        sqlite3,
        [
          database,
          `SELECT
             CAST(instr(editor_snapshot_json, '"value":"direct"') > 0 AS TEXT) || ':' ||
             CAST(instr(editor_snapshot_json, '"value":"oidc"') > 0 AS TEXT) || ':' ||
             CAST(instr(editor_snapshot_json, '"value":"saml"') > 0 AS TEXT) || ':' ||
             CAST(instr(editor_snapshot_json, '"id":"legal-consent"') > 0 AS TEXT)
           FROM flow_versions
          WHERE tenant_id = 'default'
            AND id = 'flow-version-builtin-shared-default-login-v1';`,
        ],
        { encoding: 'utf8' }
      ).trim();
      expect(topology).toBe('1:1:1:1');

      const assignedCount = execFileSync(
        sqlite3,
        [
          database,
          `SELECT COUNT(*) FROM flow_assignments
            WHERE tenant_id = 'default' AND flow_id = 'flow-builtin-shared-default-login';`,
        ],
        { encoding: 'utf8' }
      ).trim();
      expect(assignedCount).toBe('0');
      const duplicateCount = execFileSync(
        sqlite3,
        [
          database,
          `SELECT
             (SELECT COUNT(*) FROM flows
               WHERE tenant_id = 'default' AND id = 'flow-builtin-shared-default-login') || ':' ||
             (SELECT COUNT(*) FROM flow_versions
               WHERE tenant_id = 'default'
                 AND id = 'flow-version-builtin-shared-default-login-v1');`,
        ],
        { encoding: 'utf8' }
      ).trim();
      expect(duplicateCount).toBe('1:1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps the D1 and PostgreSQL built-in identifiers and topology in parity', () => {
    const d1 = readMigration(d1Migration);
    const postgres = readMigration(postgresMigration);
    for (const marker of [
      'flow-builtin-shared-default-login',
      'flow-version-builtin-shared-default-login-v1',
      'legal-consent',
      'protocol-condition:direct->direct-complete',
      'protocol-condition:oidc->oidc-authorization-consent',
      'protocol-condition:saml->saml-attribute-release-consent',
    ]) {
      expect(d1).toContain(marker);
      expect(postgres).toContain(marker);
    }
    expect(d1).not.toContain('INSERT INTO flow_assignments');
    expect(postgres).not.toContain('INSERT INTO flow_assignments');
  });
});
