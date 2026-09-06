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
  it('defines final D1 consent tables without users_core foreign keys', () => {
    const sql = readMigration('migrations/core/d1/001_0_4_0_core_baseline.sql');

    for (const table of ['oauth_client_consents', 'user_consent_records', 'consent_item_history']) {
      const block =
        sql.match(
          new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\([\\s\\S]*?\\n\\);`, 'u')
        )?.[0] ?? '';
      expect(block).not.toBe('');
      expect(block).not.toMatch(/\bREFERENCES\s+users_core\b/iu);
    }
  });

  it('defines final PostgreSQL consent tables without users_core foreign keys', () => {
    const sql = readMigration('migrations/core/postgresql/001_0_4_0_core_baseline.sql');

    for (const table of ['oauth_client_consents', 'user_consent_records']) {
      const block =
        sql.match(new RegExp(`CREATE TABLE public\\.${table} \\([\\s\\S]*?\\n\\);`, 'u'))?.[0] ??
        '';
      expect(block).not.toBe('');
      expect(block).not.toMatch(/\bREFERENCES\s+public\.users_core\b/iu);
    }
  });
});
