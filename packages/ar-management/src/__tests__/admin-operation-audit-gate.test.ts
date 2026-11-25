import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Admin operations are recorded with recordAdminOperationAudit (admin-operation-audit.ts), in
 * the admin audit log. The older createAuditLogFromContext / scheduleAuditLogFromContext write
 * them to the end-user audit log. No module may start using them, and the modules that still do
 * are listed here until they move; a module that moved must leave the list.
 */
const STILL_ON_THE_END_USER_LOG = new Set([
  // Admin actions on end users, which move with the admin records they already write beside.
  'admin-identifier-replacements.ts',
  // Retries that reuse a stable audit ID: the admin log refuses one ID with another payload.
  'admin-rbac.ts',
  'admin-user-assurance.ts',
  'admin-user-sessions.ts',
  'admin-users.ts',
  'admin.ts',
  // Retries that reuse a stable audit ID, as above.
  'compliance/access-reviews.ts',
  'routes/guest-users.ts',
]);

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(path);
  }
  return out;
}

/** A call or import of the older context helpers, not a mention in a comment. */
const OLDER_HELPER = /\b(?:createAuditLogFromContext|scheduleAuditLogFromContext)\b\s*[(,}]/u;

function usesOlderHelper(text: string): boolean {
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  return OLDER_HELPER.test(code);
}

describe('admin operation audit gate', () => {
  const users = sourceFiles(sourceRoot)
    .filter((path) => usesOlderHelper(readFileSync(path, 'utf8')))
    .map((path) => relative(sourceRoot, path).split(sep).join('/'))
    .sort();

  it('lets no new module write admin operations to the end-user audit log', () => {
    expect(users.filter((file) => !STILL_ON_THE_END_USER_LOG.has(file))).toEqual([]);
  });

  it('drops a module from the list once it has moved', () => {
    expect([...STILL_ON_THE_END_USER_LOG].filter((file) => !users.includes(file))).toEqual([]);
  });
});
