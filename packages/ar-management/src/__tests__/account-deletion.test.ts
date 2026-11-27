/**
 * The shared account deletion saga (account-deletion.ts): a legal hold refuses it before anything
 * changes; otherwise its steps run in the deletion-race rules' order, inside the caller's
 * session-end wrapper, with the tombstone the caller asks for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const calls: string[] = [];
const mocks = vi.hoisted(() => ({
  hold: vi.fn(),
  prepareTombstone: vi.fn(),
  writeTombstone: vi.fn(),
  prepareRemoval: vi.fn(),
  fence: vi.fn(),
  erase: vi.fn(),
  ready: vi.fn(),
  attempt: vi.fn(),
  transition: vi.fn(),
  deleteRuntimeUser: vi.fn(),
  eraseIdentifiers: vi.fn(),
}));

vi.mock('../account-legal-hold-guard', () => ({ findActiveAccountLegalHold: mocks.hold }));
vi.mock('../account-tombstone-write', () => ({
  prepareAccountTombstone: mocks.prepareTombstone,
  writeAccountTombstone: mocks.writeTombstone,
}));
vi.mock('../account-directory-removal-producer', () => ({
  prepareAccountDirectoryRemoval: mocks.prepareRemoval,
  fenceAccountDeletion: mocks.fence,
  eraseAccountPiiAfterDirectoryRemovalPrepared: mocks.erase,
  markAccountDirectoryRemovalsReady: mocks.ready,
  attemptImmediateAccountDirectoryRemovals: mocks.attempt,
}));
vi.mock('../session-end-logout', () => ({ transitionEndingSessions: mocks.transition }));
vi.mock('../account-identifier-erasure', () => ({
  eraseAccountIdentifierValues: mocks.eraseIdentifiers,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    CanonicalIdentityRepository: class {},
    CanonicalRuntimeUserWriter: class {
      deleteRuntimeUser = mocks.deleteRuntimeUser;
    },
  };
});

const { deleteAccount, deleteAccountAuthorizationRows } = await import('../account-deletion');
const { coreSchemaDatabase } = await import('./core-schema-sqlite');

const coreBatch = vi.fn(async (statements: Array<{ sql: string; params: unknown[] }>) => {
  calls.push('authorization_rows_delete');
  return statements.map(() => ({ success: true, rowsAffected: 0 }));
});
const core = { name: 'core', batch: coreBatch } as unknown as DatabaseAdapter;
const pii = { name: 'pii' } as unknown as DatabaseAdapter;
const env = { ACCOUNT_DIRECTORY: {} } as unknown as Env;

function input(
  endSessions = vi.fn(async (_operationId: string, work: (ended: never[]) => Promise<unknown>) => {
    calls.push('sessions_start');
    const result = await work([]);
    calls.push('sessions_end');
    return result;
  })
) {
  return {
    tenantId: 't1',
    userId: 'u1',
    core,
    pii,
    email: null,
    tombstone: { deletedBy: 'system', reason: 'registration_abandoned', metadata: { source: 'x' } },
    endSessions: endSessions as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.hold.mockResolvedValue(null);
  mocks.prepareTombstone.mockImplementation(async () => {
    calls.push('tombstone_prepare');
    return { emailBlindIndex: null, retentionDays: 90 };
  });
  for (const [name, mock] of [
    ['removal_prepare', mocks.prepareRemoval],
    ['fence', mocks.fence],
    ['tombstone_write', mocks.writeTombstone],
    ['erase', mocks.erase],
    ['erase_identifiers', mocks.eraseIdentifiers],
    ['runtime_user_delete', mocks.deleteRuntimeUser],
    ['removal_ready', mocks.ready],
    ['removal_attempt', mocks.attempt],
  ] as const) {
    mock.mockImplementation(async () => {
      calls.push(name);
      return name === 'removal_prepare' ? ['removal'] : undefined;
    });
  }
  mocks.transition.mockImplementation(
    async (_env: Env, _ended: unknown, input: { lifecycle: string }) => {
      calls.push(`auth_${input.lifecycle}`);
    }
  );
});

describe('the shared account deletion', () => {
  it('runs its steps in the deletion-race order inside the session-end wrapper', async () => {
    await expect(deleteAccount(env, input())).resolves.toEqual({ status: 'deleted' });
    expect(calls).toEqual([
      'tombstone_prepare',
      'sessions_start',
      'auth_deleting',
      'removal_prepare',
      'fence',
      'tombstone_write',
      'erase',
      // The stored identifiers and identifier-source values imported for the account.
      'erase_identifiers',
      'runtime_user_delete',
      // Its direct role assignments and group memberships, after the account is deleted.
      'authorization_rows_delete',
      'auth_deleted',
      'removal_ready',
      'removal_attempt',
      'sessions_end',
    ]);
    expect(mocks.prepareTombstone).toHaveBeenCalledWith(env, { tenantId: 't1', email: null });
    expect(mocks.writeTombstone).toHaveBeenCalledWith(
      pii,
      expect.objectContaining({
        tenantId: 't1',
        userId: 'u1',
        deletedBy: 'system',
        reason: 'registration_abandoned',
      })
    );
    // No erasure time given: the producer's own (two arguments, as the administrator's delete).
    expect(mocks.erase).toHaveBeenCalledWith(pii, { tenantId: 't1', userId: 'u1', core });
    expect(mocks.eraseIdentifiers).toHaveBeenCalledWith(env, { tenantId: 't1', userId: 'u1' });
    expect(coreBatch.mock.calls[0][0]).toEqual([
      {
        sql: 'DELETE FROM role_assignments WHERE tenant_id = ? AND subject_id = ?',
        params: ['t1', 'u1'],
      },
      {
        sql: 'DELETE FROM group_memberships WHERE tenant_id = ? AND subject_id = ?',
        params: ['t1', 'u1'],
      },
      {
        sql: 'DELETE FROM dynamic_membership_publications WHERE tenant_id = ? AND subject_id = ?',
        params: ['t1', 'u1'],
      },
    ]);
  });

  it('removes the subject authorization rows on its own shard only (two account shards)', async () => {
    const shardA = coreSchemaDatabase();
    const shardB = coreSchemaDatabase();
    const seed = (db: typeof shardA.db, subject: string, tenant = 't1') => {
      db.prepare(
        `INSERT INTO role_assignments(id, tenant_id, subject_id, role_id, created_at, updated_at)
          VALUES (?, ?, ?, 'reader', 1, 1)`
      ).run(`ra-${tenant}-${subject}`, tenant, subject);
      for (const source of ['manual', 'scim', 'rule', 'dynamic', 'invitation'])
        db.prepare(
          `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
            source_ref, created_at, updated_at) VALUES (?, ?, 'g', ?, ?, '', 1, 1)`
        ).run(`gm-${tenant}-${subject}-${source}`, tenant, subject, source);
    };
    seed(shardA.db, 'u1');
    seed(shardA.db, 'u2');
    seed(shardA.db, 'u1', 'other-tenant');
    seed(shardB.db, 'u3');
    const put = vi.fn(async () => undefined);
    await deleteAccountAuthorizationRows(shardA.adapter, { tenantId: 't1', userId: 'u1' }, {
      put,
    } as never);
    const count = (db: typeof shardA.db, table: string, subject: string, tenant = 't1') =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND subject_id = ?`)
          .get(tenant, subject) as { n: number }
      ).n;
    expect(count(shardA.db, 'role_assignments', 'u1')).toBe(0);
    expect(count(shardA.db, 'group_memberships', 'u1')).toBe(0);
    expect(count(shardA.db, 'group_memberships', 'u2')).toBe(5);
    expect(count(shardA.db, 'group_memberships', 'u1', 'other-tenant')).toBe(5);
    expect(count(shardB.db, 'group_memberships', 'u3')).toBe(5);
    expect(put).toHaveBeenCalledWith('rbac:v2:subject-version:t1:u1', expect.any(String));
    // Idempotent.
    await deleteAccountAuthorizationRows(shardA.adapter, { tenantId: 't1', userId: 'u1' });
    shardA.db.close();
    shardB.db.close();
  });

  it('refuses a held account before anything changes', async () => {
    mocks.hold.mockResolvedValue({ holdId: 'hold-1' });
    const endSessions = vi.fn();
    await expect(deleteAccount(env, input(endSessions as never))).resolves.toEqual({
      status: 'held',
      holdId: 'hold-1',
    });
    expect(endSessions).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
