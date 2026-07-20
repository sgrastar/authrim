import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listD1MigrationSqlFiles } from '../core/cloudflare.js';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const migrationsDir = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const d1Migration = '027_consent_gate_runtime.sql';
const postgresMigration = 'external/postgres/012_external_consent_gate_runtime.sql';
const d1AttributeReleaseMigration = '012_attribute_release_consents.sql';

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

function runSqlite(sqlite3: string, database: string, sql: string): void {
  execFileSync(sqlite3, [database], { input: sql, encoding: 'utf8' });
}

function querySqlite(sqlite3: string, database: string, sql: string): string {
  return execFileSync(sqlite3, [database, sql], { encoding: 'utf8' }).trim();
}

describe('Consent Gate runtime migrations', () => {
  it('applies the D1 migration, adds indexed state, and collapses Client-specific evidence', () => {
    const sqlite3 = findSqlite3();
    if (!sqlite3) return;
    const directory = mkdtempSync(join(tmpdir(), 'authrim-consent-gate-migration-'));
    const database = join(directory, 'core.db');
    try {
      const coreMigrations = listD1MigrationSqlFiles(migrationsDir, {
        excludeTopLevelDirectories: new Set(['admin', 'archive', 'external', 'pii']),
      });
      for (const migration of coreMigrations.filter((file) => file !== d1Migration)) {
        runSqlite(
          sqlite3,
          database,
          `PRAGMA foreign_keys = ON;\n${renderPortableMigrationSql(
            readMigration(migration),
            'sqlite'
          )}`
        );
      }
      runSqlite(
        sqlite3,
        database,
        `INSERT INTO consent_records (
            id, tenant_id, subject_user_id, protocol, consent_kind, binding_type,
            statement_id, statement_version, client_id, policy_id, decision, status,
            expires_at, revoked_at, created_at, updated_at
          ) VALUES
            ('old-client-a', 'tenant-a', 'user-a', 'oidc', 'terms', 'subject',
             'tos-a', '1', 'client-a', 'policy-a', 'accepted', 'active', NULL, NULL, 100, 100),
            ('new-client-b', 'tenant-a', 'user-a', 'oidc', 'terms', 'subject',
             'tos-a', '1', 'client-b', 'policy-b', 'accepted', 'active', NULL, NULL, 200, 200),
            ('other-tenant', 'tenant-b', 'user-a', 'document', 'terms', 'subject',
             'tos-a', '1', NULL, 'policy-a', 'accepted', 'active', NULL, NULL, 300, 300),
            ('revoked', 'tenant-a', 'user-a', 'document', 'privacy', 'subject',
             'privacy-a', '1', NULL, 'policy-a', 'accepted', 'revoked', NULL, 400, 400, 400);`
      );
      runSqlite(
        sqlite3,
        database,
        renderPortableMigrationSql(readMigration(d1Migration), 'sqlite')
      );

      expect(
        querySqlite(
          sqlite3,
          database,
          `SELECT name FROM sqlite_master
              WHERE type = 'table'
                AND name IN (
                  'consent_gate_policy_bindings',
                  'document_acknowledgments_current',
                  'consent_gate_decision_receipts'
                )
              ORDER BY name;`
        ).split('\n')
      ).toEqual([
        'consent_gate_decision_receipts',
        'consent_gate_policy_bindings',
        'document_acknowledgments_current',
      ]);
      expect(
        querySqlite(
          sqlite3,
          database,
          `SELECT latest_evidence_record_id
               FROM document_acknowledgments_current
              WHERE tenant_id = 'tenant-a' AND subject_user_id = 'user-a'
                AND consent_kind = 'terms' AND statement_id = 'tos-a' AND statement_version = '1';`
        )
      ).toBe('new-client-b');
      expect(
        querySqlite(
          sqlite3,
          database,
          `SELECT COUNT(*) FROM document_acknowledgments_current
              WHERE tenant_id = 'tenant-a';`
        )
      ).toBe('1');
      expect(
        querySqlite(
          sqlite3,
          database,
          `SELECT COUNT(*) FROM pragma_table_info('oauth_client_consents')
              WHERE name IN ('release_set_hash', 'selected_claims');`
        )
      ).toBe('2');
      expect(
        querySqlite(
          sqlite3,
          database,
          `SELECT COUNT(*) FROM pragma_index_info('idx_document_acknowledgments_current_active')
              WHERE name IN (
                'tenant_id', 'subject_user_id', 'consent_kind', 'statement_id',
                'statement_version', 'status', 'expires_at'
              );`
        )
      ).toBe('7');
      expect(
        querySqlite(
          sqlite3,
          database,
          `SELECT COUNT(*) FROM pragma_index_list('consent_gate_decision_receipts')
              WHERE name = 'idx_consent_gate_decision_receipts_gate_once' AND "unique" = 1;`
        )
      ).toBe('1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps D1 and PostgreSQL Consent Gate schema fields in parity', () => {
    const d1 = readMigration(d1Migration);
    const postgres = readMigration(postgresMigration);
    for (const table of [
      'consent_gate_policy_bindings',
      'document_acknowledgments_current',
      'consent_gate_decision_receipts',
    ]) {
      expect(d1).toContain(`CREATE TABLE ${table}`);
      expect(postgres).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const field of [
      'gate_kind',
      'target_type',
      'target_id',
      'policy_id',
      'statement_version_set_hash',
      'release_set_hash',
      'protocol_request_id',
      'decision_json',
      'evidence_record_ids_json',
    ]) {
      expect(d1).toContain(field);
      expect(postgres).toContain(field);
    }
    expect(d1).toContain('COALESCE(target_id');
    expect(postgres).toContain('COALESCE(target_id');
    expect(d1).toContain('ROW_NUMBER() OVER');
    expect(postgres).toContain('ROW_NUMBER() OVER');
    expect(d1).toContain('idx_consent_gate_decision_receipts_gate_once');
    expect(postgres).toContain('idx_consent_gate_decision_receipts_gate_once');
    expect(readMigration(d1AttributeReleaseMigration)).toContain(
      'CREATE TABLE IF NOT EXISTS attribute_release_consents'
    );
    expect(postgres).toContain('CREATE TABLE IF NOT EXISTS attribute_release_consents');
    expect(postgres).toContain('ALTER TABLE oauth_client_consents RENAME COLUMN scopes TO scope');
    for (const field of [
      'selected_scopes',
      'privacy_policy_version',
      'tos_version',
      'consent_version',
      'release_set_hash',
      'selected_claims',
    ]) {
      expect(postgres).toContain(`ADD COLUMN IF NOT EXISTS ${field}`);
    }
  });
});
