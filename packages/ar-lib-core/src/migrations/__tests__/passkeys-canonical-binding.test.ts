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
  it('defines final core passkeys without a users_core foreign key', () => {
    const sql = readMigration('migrations/core/d1/001_0_4_0_core_baseline.sql');
    const passkeysBlock =
      sql.match(/CREATE TABLE IF NOT EXISTS "passkeys" \([\s\S]*?\n\);/u)?.[0] ?? '';

    expect(passkeysBlock).not.toBe('');
    expect(passkeysBlock).toContain('user_id TEXT NOT NULL');
    expect(passkeysBlock).toContain('UNIQUE(tenant_id, credential_id)');
    expect(passkeysBlock).not.toMatch(/\bREFERENCES\s+users_core\b/iu);
  });

  it('defines final PostgreSQL passkeys without a users_core foreign key', () => {
    const sql = readMigration('migrations/core/postgresql/001_0_4_0_core_baseline.sql');
    const passkeysBlock = sql.match(/CREATE TABLE public\.passkeys \([\s\S]*?\n\);/u)?.[0] ?? '';

    expect(passkeysBlock).not.toBe('');
    expect(passkeysBlock).toContain('user_id text NOT NULL');
    expect(passkeysBlock).not.toMatch(/\bREFERENCES\s+public\.users_core\b/iu);
  });
});
