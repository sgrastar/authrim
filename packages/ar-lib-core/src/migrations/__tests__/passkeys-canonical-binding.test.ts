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

describe('passkeys canonical runtime user binding migrations', () => {
  it('creates new core passkeys without a users_core foreign key', () => {
    const sql = readMigration('migrations/003_core_policy_identity_tables.sql');
    const passkeysBlock = sql.match(/CREATE TABLE "passkeys" \([\s\S]*?\n\);/u)?.[0] ?? '';

    expect(passkeysBlock).toContain('user_id TEXT NOT NULL');
    expect(passkeysBlock).toContain('UNIQUE(tenant_id, credential_id)');
    expect(passkeysBlock).not.toMatch(/\bREFERENCES\s+users_core\b/iu);
  });

  it('rebuilds existing passkeys without preserving the users_core foreign key', () => {
    const sql = readMigration('migrations/013_passkeys_canonical_user_binding.sql');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS passkeys_canonical');
    expect(sql).toContain('UNIQUE(tenant_id, credential_id)');
    expect(sql).toContain('DROP TABLE passkeys');
    expect(sql).toContain('ALTER TABLE passkeys_canonical RENAME TO passkeys');
    expect(sql).not.toMatch(/\bREFERENCES\s+users_core\b/iu);
  });
});
