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

describe('consent canonical runtime user binding migrations', () => {
  it('rebuilds D1 consent tables without users_core foreign keys', () => {
    const sql = readMigration('migrations/034_consent_canonical_user_ids.sql');

    expect(sql).toContain('CREATE TABLE oauth_client_consents_new');
    expect(sql).toContain('CREATE TABLE user_consent_records_new');
    expect(sql).toContain('CREATE TABLE consent_item_history_new');
    expect(sql).not.toMatch(/\bREFERENCES\s+users_core\b/iu);
  });

  it('drops external postgres users_core consent foreign keys', () => {
    const sql = readMigration(
      'migrations/external/postgres/016_external_consent_canonical_user_ids.sql'
    );

    expect(sql).toMatch(/\bDROP CONSTRAINT IF EXISTS oauth_client_consents_user_fk\b/iu);
    expect(sql).toMatch(/\bDROP CONSTRAINT IF EXISTS user_consent_records_user_fk\b/iu);
  });
});
