import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What an administrator holds is read from `admin_effective_role_assignments`: their own
 * assignments and the ones their admin groups give. A check that reads `admin_role_assignments`
 * itself misses the groups' roles, and that is not always the safe way round (an account whose
 * standing is under-read can be acted on by someone below it; a last-administrator count that
 * reads zero lets the change through). So every line that names the table is listed here with
 * why it may, and a new or changed one fails until it is either moved to the view or listed.
 * A reader listed as `globalOnly` reads global assignments alone (groups give tenant roles only):
 * each of its statements must keep that condition.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

const DIRECT_TABLE_READERS: Record<string, { why: string; globalOnly?: true; lines: string[] }> = {
  'packages/ar-auth/src/admin-invitation-enrollment.ts': {
    why: "writes the invited admin's own assignment",
    lines: ['sql: `INSERT INTO admin_role_assignments ('],
  },
  'packages/ar-lib-core/src/types/admin.ts': {
    why: 'a comment',
    lines: ['* - admin_role_assignments + admin_roles (for permissions)'],
  },
  'packages/ar-lib-core/src/utils/system-init.ts': {
    why: "writes and finds the first administrator's own assignment",
    lines: [
      '* - Uses DB_ADMIN for Admin user management (admin_users, admin_roles, admin_role_assignments)',
      'FROM admin_role_assignments ra',
      "'SELECT id FROM admin_role_assignments WHERE tenant_id = ? AND admin_user_id = ? AND admin_role_id = ? LIMIT 1',",
      '`INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, expires_at, assigned_by, created_at)',
    ],
  },
  'packages/ar-lib-core/src/repositories/admin/admin-group.ts': {
    why: 'documents that nothing is copied into the table',
    lines: [
      '* Nothing is copied into `admin_role_assignments`. What an administrator holds is read from the',
    ],
  },
  'packages/ar-lib-core/src/repositories/admin/admin-role.ts': {
    why: "the repository of an admin's own assignments (create, edit, remove, list); effective reads go through the view",
    lines: [
      "tableName: 'admin_role_assignments',",
      'INSERT INTO admin_role_assignments (',
      "'DELETE FROM admin_role_assignments WHERE tenant_id = ? AND admin_user_id = ? AND admin_role_id = ?';",
      "'SELECT * FROM admin_role_assignments WHERE tenant_id = ? AND id = ?',",
      '`DELETE FROM admin_role_assignments WHERE tenant_id = ? AND id = ?${condition.sql}`,',
      'SELECT id FROM admin_role_assignments',
      "`UPDATE admin_role_assignments SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?${condition.sql}`,",
      "return this.readAssignmentsByUser('admin_role_assignments', adminUserId, includeExpired);",
      "source: 'admin_role_assignments' | typeof ADMIN_EFFECTIVE_ROLE_ASSIGNMENTS,",
      'FROM admin_role_assignments ra',
      "'DELETE FROM admin_role_assignments WHERE tenant_id = ? AND admin_user_id = ?',",
      "'DELETE FROM admin_role_assignments WHERE tenant_id = ? AND admin_role_id = ?',",
    ],
  },
  'packages/ar-lib-core/src/services/tenant-portability/dataset-registry.ts': {
    why: 'backs up and restores the table itself',
    lines: ['admin_role_assignments admin_storage_destination_usages admin_users agent_bulk_plans'],
  },
  'packages/ar-lib-core/src/services/tenant-portability/phase8-sqlite-foreign-keys.ts': {
    why: "the table's foreign keys for restore",
    lines: ["from: 'admin.admin_role_assignments',", "from: 'admin.admin_role_assignments',"],
  },
  'packages/ar-lib-core/src/services/tenant-portability/phase8-sqlite-references.ts': {
    why: "the table's admin references for restore",
    lines: ["'admin.admin_role_assignments': { columns: ['admin_user_id'] },"],
  },
  'packages/ar-management/src/admin-tenant-clone.ts': {
    why: 'copies and cleans up own assignments (groups are copied separately)',
    lines: [
      '(SELECT COUNT(*) FROM admin_role_assignments',
      '(SELECT MAX(created_at) FROM admin_role_assignments',
      'FROM admin_role_assignments',
      'FROM admin_role_assignments a',
      '`INSERT INTO admin_role_assignments (',
      'admin_role_assignments: 0,',
      'admin_role_assignments_skipped: 0,',
      'summary.admin_role_assignments = cloned.assignments;',
      'summary.admin_role_assignments_skipped = cloned.skippedAssignments;',
      '...(summary.admin_role_assignments_skipped > 0',
      '`${summary.admin_role_assignments_skipped} Admin assignments outside the source tenant scope were omitted.`,',
      "'DELETE FROM admin_role_assignments WHERE tenant_id = ?',",
      "await adminAdapter.execute('DELETE FROM admin_role_assignments WHERE tenant_id = ?', [",
    ],
  },
  'packages/ar-management/src/tenant-deletion-admin-accounts.ts': {
    why: "removes the deleted tenant's own assignment rows; the one read of authority (who holds a current GLOBAL assignment) may use the table because groups never give a global role (admin_group_role_grants has CHECK scope_type = 'tenant', and the repository only writes 'tenant'); the role-reference check reads the assignments and the group grants side by side",
    lines: [
      `sql: "DELETE FROM admin_role_assignments WHERE tenant_id = ? AND scope_type <> 'global'",`,
      'SELECT 1 FROM admin_role_assignments ra',
      '`SELECT DISTINCT admin_user_id FROM admin_role_assignments',
    ],
  },
  'packages/ar-management/src/tenant-backup-restore-authority.ts': {
    why: "restore authority for the table's own global rows",
    globalOnly: true,
    lines: [
      "export const ADMIN_ROLE_ASSIGNMENTS_DATASET = 'admin.admin_role_assignments';",
      '`SELECT DISTINCT admin_role_id FROM admin_role_assignments',
    ],
  },
  'packages/ar-management/src/routes/admin-management/admin-role-authority.ts': {
    why: 'global assignments only, which groups never give',
    globalOnly: true,
    lines: ['`SELECT DISTINCT admin_role_id FROM admin_role_assignments'],
  },
  'packages/ar-management/src/routes/admin-management/last-platform-admin.ts': {
    why: 'the platform role, held through a global assignment only (groups cannot give it)',
    globalOnly: true,
    lines: ['FROM admin_role_assignments ra', 'FROM admin_role_assignments ra'],
  },
  'packages/ar-management/src/routes/admin-management/admins.ts': {
    why: 'global assignments only, which groups never give',
    globalOnly: true,
    lines: [
      'FROM admin_role_assignments ra',
      'JOIN admin_role_assignments ra ON ra.admin_user_id = u.id',
    ],
  },
  'packages/ar-management/src/routes/admin-management/admin-access-control.ts': {
    why: 'counts own assignments for a statistic',
    lines: ["'SELECT COUNT(*) as count FROM admin_role_assignments WHERE tenant_id = ?',"],
  },
  'packages/setup/src/core/cloudflare.ts': {
    why: "setup writes and repairs the first administrator's own assignment",
    lines: [
      'DELETE FROM admin_role_assignments',
      'FROM admin_role_assignments existing',
      'ON copy.id = admin_role_assignments.admin_role_id',
      'WHERE existing.tenant_id = admin_role_assignments.tenant_id',
      'AND existing.admin_user_id = admin_role_assignments.admin_user_id',
      'AND existing.scope_type = admin_role_assignments.scope_type',
      "AND COALESCE(existing.scope_id, '') = COALESCE(admin_role_assignments.scope_id, '')",
      'UPDATE admin_role_assignments',
      'WHERE copy.id = admin_role_assignments.admin_role_id',
    ],
  },
};

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (
      /\.(ts|js|mjs|svelte)$/u.test(name) &&
      !/\.(test|spec|stories)\.[a-z]+$/u.test(name)
    ) {
      found.push(path);
    }
  }
  return found;
}

function readers(): Record<string, string> {
  const packages = join(REPO_ROOT, 'packages');
  const found: Record<string, string> = {};
  for (const pkg of readdirSync(packages)) {
    // The legacy Admin UI talks to the API only; its mock server is not authorization.
    if (pkg === 'ar-admin-ui') continue;
    const src = join(packages, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('admin_role_assignments')) found[relative(REPO_ROOT, file)] = text;
    }
  }
  return found;
}

describe('readers of admin_role_assignments', () => {
  it('names the table only on the listed lines, where its own rows are meant', () => {
    const lines = Object.fromEntries(
      Object.entries(readers()).map(([file, text]) => [
        file,
        text
          .split('\n')
          .filter((line) => line.includes('admin_role_assignments'))
          .map((line) => line.trim()),
      ])
    );
    expect(lines).toEqual(
      Object.fromEntries(
        Object.entries(DIRECT_TABLE_READERS).map(([file, entry]) => [file, entry.lines])
      )
    );
  });

  it('keeps every statement of a global-only reader to global assignments', () => {
    const texts = readers();
    for (const [file, entry] of Object.entries(DIRECT_TABLE_READERS)) {
      if (!entry.globalOnly) continue;
      const text = texts[file] ?? '';
      const statements = [...text.matchAll(/(?:FROM|JOIN) admin_role_assignments\b/gu)];
      expect(statements.length, file).toBeGreaterThan(0);
      for (const match of statements) {
        // The rest of the SQL template the table is named in.
        const rest = text.slice(match.index, text.indexOf('`', match.index));
        expect(rest, `${file}: ${rest.slice(0, 80)}`).toMatch(/scope_type\s*=\s*'global'/u);
      }
    }
  });
});
