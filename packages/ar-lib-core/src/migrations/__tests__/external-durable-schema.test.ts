import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROFILE_CLAIM_KEYS,
  BUILTIN_PROFILE_CLAIM_SCHEMAS,
} from '../../services/custom-claims/schema-catalog.js';

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
  const pattern = new RegExp(
    `CREATE TABLE (?:IF NOT EXISTS )?(?:public\\.)?"?${escaped}"? \\([\\s\\S]*?\\n\\);`,
    'i'
  );
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
    const coreSql = readMigration('migrations/core/postgresql/001_0_4_0_core_baseline.sql');

    for (const tableName of coreTables) {
      const tableBlock = extractCreateTableBlock(coreSql, tableName);
      expect(tableBlock).toMatch(/\btenant_id text\b[^\n]*\bNOT NULL\b/i);
    }
  });

  it('keeps every shared durable PII table explicitly tenant-scoped', () => {
    const piiSql = readMigration('migrations/pii/postgresql/001_0_4_0_pii_baseline.sql');

    for (const tableName of piiTables) {
      const tableBlock = extractCreateTableBlock(piiSql, tableName);
      expect(tableBlock).toMatch(/\btenant_id text\b[^\n]*\bNOT NULL\b/i);
    }
  });

  it('does not use D1-only SQLite syntax in postgres migrations', () => {
    const combinedSql = [
      readMigration('migrations/core/postgresql/001_0_4_0_core_baseline.sql'),
      readMigration('migrations/pii/postgresql/001_0_4_0_pii_baseline.sql'),
    ].join('\n');

    expect(combinedSql).not.toMatch(/\bAUTOINCREMENT\b/i);
    expect(combinedSql).not.toMatch(/\bWITHOUT ROWID\b/i);
    expect(combinedSql).not.toMatch(/\bjson_valid\s*\(/i);
    expect(combinedSql).not.toMatch(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/i);
  });

  it('separates pairwise subjects from the canonical PII identifier registry', () => {
    const piiSql = readMigration('migrations/pii/postgresql/001_0_4_0_pii_baseline.sql');

    expect(piiSql).toMatch(/CREATE TABLE public\.pairwise_subject_identifiers\s*\(/i);
    expect(piiSql).toMatch(/CREATE TABLE public\.subject_identifiers\s*\(/i);
    expect(extractCreateTableBlock(piiSql, 'pairwise_subject_identifiers')).toMatch(
      /\btenant_id text\b[^\n]*\bNOT NULL\b[\s\S]*\buser_id text NOT NULL\b/i
    );
    expect(extractCreateTableBlock(piiSql, 'subject_identifiers')).toMatch(
      /\btenant_id text NOT NULL\b[\s\S]*\bsubject_id text NOT NULL\b/i
    );
  });

  it('removes the superseded verified-attribute compatibility table from the final core schema', () => {
    const coreSql = readMigration('migrations/core/postgresql/001_0_4_0_core_baseline.sql');

    expect(coreSql).not.toMatch(/CREATE TABLE public\.verified_attributes\s*\(/i);
    expect(coreSql).toMatch(/CREATE TABLE public\.user_verified_attributes\s*\(/i);
    expect(coreSql).toMatch(/CREATE TABLE public\.attribute_verifications\s*\(/i);
  });

  it('keeps passkeys bound to canonical runtime user ids instead of users_core rows', () => {
    const coreSql = readMigration('migrations/core/postgresql/001_0_4_0_core_baseline.sql');
    const passkeysBlock = extractCreateTableBlock(coreSql, 'passkeys');

    expect(passkeysBlock).toMatch(/\buser_id text NOT NULL\b/i);
    expect(coreSql).toMatch(
      /ADD CONSTRAINT passkeys_unique_credential UNIQUE \(tenant_id, credential_id\)/i
    );
    expect(passkeysBlock).not.toMatch(/\bREFERENCES\s+users_core\b/i);
  });

  it('uses the canonical optional profile catalog without tenant-specific baseline rows', () => {
    const profileSql = readMigration('migrations/core/postgresql/001_0_4_0_core_baseline.sql');
    const expectedKeys = [
      'email',
      'email_verified',
      'display_name',
      'given_name',
      'family_name',
      'preferred_username',
      'picture_url',
      'locale',
    ];

    expect([...BUILTIN_PROFILE_CLAIM_KEYS]).toEqual(expectedKeys);
    expect(BUILTIN_PROFILE_CLAIM_SCHEMAS).toHaveLength(expectedKeys.length);
    for (const schema of BUILTIN_PROFILE_CLAIM_SCHEMAS) {
      expect(schema.is_required ?? 0).toBe(0);
    }
    expect(profileSql).toContain('CREATE TABLE public.custom_claim_schemas');
    expect(profileSql).not.toContain('builtin:default:');
    expect(BUILTIN_PROFILE_CLAIM_KEYS).not.toContain('name');
  });
});
