import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

function findWorkspaceRoot(start: string): string {
  let current = start;

  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    current = dirname(current);
  }

  throw new Error('workspace_root_not_found');
}

const workspaceRoot = findWorkspaceRoot(testDir);

function readMigration(relativePath: string): string {
  return readFileSync(join(workspaceRoot, relativePath), 'utf8');
}

function extractCreateTableBlock(sql: string, tableName: string): string {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${escaped} \\([\\s\\S]*?\\n\\);`, 'i');
  const match = sql.match(pattern);

  if (!match) {
    throw new Error(`table_not_found:${tableName}`);
  }

  return match[0];
}

const coreTables = [
  'identity_subjects',
  'identity_accounts',
  'subject_account_links',
  'profiles',
  'profile_attribute_values',
  'structured_attribute_values',
  'contact_points',
  'contact_verifications',
  'identity_bindings',
  'identity_resolution_events',
  'identity_resolution_candidates',
  'users_core',
  'passkeys',
  'roles',
  'role_assignments',
  'relationships',
  'oauth_client_consents',
  'user_consent_records',
  'user_custom_fields',
  'custom_claim_schemas',
  'custom_claim_schema_history',
  'verified_attributes',
] as const;

const piiTables = [
  'users_pii',
  'identity_sensitive_values',
  'subject_identifiers',
  'linked_identities',
  'audit_log_pii',
  'users_pii_tombstone',
] as const;

describe('external durable postgres schema', () => {
  it('keeps every shared durable core table explicitly tenant-scoped', () => {
    const coreSql = readMigration('migrations/external/postgres/001_external_durable_core.sql');

    for (const tableName of coreTables) {
      const tableBlock = extractCreateTableBlock(coreSql, tableName);
      expect(tableBlock).toMatch(/\btenant_id TEXT NOT NULL\b/i);
    }
  });

  it('keeps every shared durable PII table explicitly tenant-scoped', () => {
    const piiSql = readMigration('migrations/external/postgres/002_external_durable_pii.sql');

    for (const tableName of piiTables) {
      const tableBlock = extractCreateTableBlock(piiSql, tableName);
      expect(tableBlock).toMatch(/\btenant_id TEXT NOT NULL\b/i);
    }
  });

  it('does not use D1-only SQLite syntax in postgres migrations', () => {
    const combinedSql = [
      readMigration('migrations/external/postgres/001_external_durable_core.sql'),
      readMigration('migrations/external/postgres/002_external_durable_pii.sql'),
    ].join('\n');

    expect(combinedSql).not.toMatch(/\bAUTOINCREMENT\b/i);
    expect(combinedSql).not.toMatch(/\bWITHOUT ROWID\b/i);
    expect(combinedSql).not.toMatch(/\bjson_valid\s*\(/i);
    expect(combinedSql).not.toMatch(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/i);
  });
});
