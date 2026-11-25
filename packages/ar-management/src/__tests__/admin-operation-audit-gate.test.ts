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
  // Retries that reuse a stable audit ID: the admin log refuses one ID with another payload.
  'admin-rbac.ts',
  'admin-user-assurance.ts',
  'compliance/access-reviews.ts',
  'routes/guest-users.ts',
]);

/**
 * Modules that write the end-user audit log directly (createAuditLog / writeLegacyAuditLog), and
 * why that is the right log. An admin operation is not a reason: it goes through
 * recordAdminOperationAudit or recordAdminOperationAuditFromEnv.
 */
const DIRECT_END_USER_WRITERS: Readonly<Record<string, string>> = {
  'account-directory-producer.ts': 'an end user’s own account creation',
  'account-identifier-erasure.ts': 'an end user’s identifier erasure',
  'account-operation-log.ts': 'an end user’s own account operations',
  'admin-operation-audit.ts': 'the end user’s history of an admin operation on them',
  'admin-shared.ts': 'the admin audit repository’s own createAuditLog method',
  'client-config.ts': 'a client managing its own registration (RFC 7592)',
  'guest-deletion-audit-outbox.ts': 'a guest deletion, from its durable outbox',
  'guest-deletion-worker.ts': 'a guest deletion, by the worker',
  'identifier-replacement-scheduled.ts': 'an end user’s scheduled identifier replacement',
  'registration-pending-cleanup.ts': 'abandoned registrations removed by the scheduler',
  'routes/admin-management/admin-abac.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/admin-policies.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/admin-rebac.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/admin-roles.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/admins.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/database-connections.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/ip-allowlist.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/my-passkeys.ts': 'a local admin audit writer of the same name',
  'routes/admin-management/storage-destinations.ts': 'a local admin audit writer of the same name',
  'session-end-logout.ts': 'an end user’s sessions ending and downstream logout',
  'tenant-deletion-admin-accounts.ts': 'the admin audit repository, by stable ID',
};

/**
 * Admin operations still written directly to the end-user audit log, for the same reason as
 * STILL_ON_THE_END_USER_LOG: they retry with a stable audit ID.
 */
const DIRECT_WRITES_STILL_TO_MOVE = new Set([
  // A member removed from an organization by a bulk admin job.
  'admin-job-executor.ts',
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

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

function usesOlderHelper(text: string): boolean {
  return OLDER_HELPER.test(stripComments(text));
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

  const DIRECT_WRITE = /\b(?:createAuditLog|writeLegacyAuditLog)\s*\(/u;
  const directWriters = sourceFiles(sourceRoot)
    .filter((path) => DIRECT_WRITE.test(stripComments(readFileSync(path, 'utf8'))))
    .map((path) => relative(sourceRoot, path).split(sep).join('/'))
    .sort();

  it('lets no module write the end-user audit log directly without a reason', () => {
    expect(
      directWriters.filter(
        (file) => !(file in DIRECT_END_USER_WRITERS) && !DIRECT_WRITES_STILL_TO_MOVE.has(file)
      )
    ).toEqual([]);
  });

  it('drops a direct writer from the list once it stopped', () => {
    expect(
      [...Object.keys(DIRECT_END_USER_WRITERS), ...DIRECT_WRITES_STILL_TO_MOVE].filter(
        (file) => !directWriters.includes(file)
      )
    ).toEqual([]);
  });
});
