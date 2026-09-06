import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const migrationPath = fileURLToPath(
  new URL('../../../../migrations/admin/d1/001_0_4_0_admin_baseline.sql', import.meta.url)
);

function findSqlite3(): string | null {
  try {
    return execFileSync('which', ['sqlite3'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function execute(sqlite3: string, database: string, sql: string): void {
  execFileSync(sqlite3, [database], { input: sql, encoding: 'utf8' });
}

function query(sqlite3: string, database: string, sql: string): string {
  return execFileSync(sqlite3, [database, sql], { encoding: 'utf8' }).trim();
}

function insertPending(id: string, adminUserId: string): string {
  return `INSERT INTO admin_invitations (
      id, tenant_id, admin_user_id, email, pending_email_key, code_hash,
      admin_role_id, admin_role_name, admin_role_display_name, scope_type,
      expires_at, last_sent_at, created_by, created_at, updated_at
    ) VALUES (
      '${id}', 'tenant-a', '${adminUserId}', 'admin@example.com', 'admin@example.com',
      'code-hash-${id}', 'role-custom', 'custom_admin', 'Custom Admin', 'tenant',
      2000, 1000, 'admin-creator', 1000, 1000
    );`;
}

describe('Admin invitation D1 migration', () => {
  it('enforces one pending email without a partial index and preserves role snapshots', () => {
    const sqlite3 = findSqlite3();
    if (!sqlite3) return;
    const directory = mkdtempSync(join(tmpdir(), 'authrim-admin-invitation-migration-'));
    const database = join(directory, 'admin.db');

    try {
      execute(
        sqlite3,
        database,
        renderPortableMigrationSql(readFileSync(migrationPath, 'utf8'), 'sqlite')
      );
      execute(sqlite3, database, insertPending('invitation-1', 'admin-user-1'));

      const duplicate = spawnSync(sqlite3, [database], {
        input: insertPending('invitation-2', 'admin-user-2'),
        encoding: 'utf8',
      });
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain('UNIQUE constraint failed');

      execute(
        sqlite3,
        database,
        `UPDATE admin_invitations
            SET status = 'revoked', pending_email_key = NULL
          WHERE id = 'invitation-1';`
      );
      execute(sqlite3, database, insertPending('invitation-2', 'admin-user-2'));

      expect(
        query(
          sqlite3,
          database,
          `SELECT status || ':' || COALESCE(pending_email_key, 'null') || ':' ||
                  admin_role_name || ':' || admin_role_display_name
             FROM admin_invitations WHERE id = 'invitation-1';`
        )
      ).toBe('revoked:null:custom_admin:Custom Admin');
      expect(
        query(
          sqlite3,
          database,
          "SELECT COUNT(*) FROM pragma_foreign_key_list('admin_invitations');"
        )
      ).toBe('0');
      execute(
        sqlite3,
        database,
        `INSERT INTO admin_invitation_enrollments (
           token_hash, invitation_id, phase, state_json, expires_at, created_at, updated_at
         ) VALUES (
           'sha256-token-hash', 'invitation-2', 'redeemed', '{}', 2000, 1000, 1000
         );`
      );
      expect(
        query(
          sqlite3,
          database,
          "SELECT token_hash || ':' || phase FROM admin_invitation_enrollments;"
        )
      ).toBe('sha256-token-hash:redeemed');
      expect(
        query(
          sqlite3,
          database,
          "SELECT COUNT(*) FROM pragma_table_info('admin_invitations') WHERE name = 'failed_attempts';"
        )
      ).toBe('0');
      expect(
        query(
          sqlite3,
          database,
          "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'admin_invitations' AND sql LIKE '% WHERE %';"
        )
      ).toBe('0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
