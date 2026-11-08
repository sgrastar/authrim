/**
 * The clean-up of unfinished sign-ups (registration-pending-cleanup.ts), over a real Core store
 * with the migrations applied: an expired mark's account checked again, then deleted by the shared
 * saga (no address fingerprint, system audit without PII), kept when proven, postponed when held,
 * unpublished or failed, and bounded by the tenant's switch and per-run limits.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env, Logger } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { openCoreStore } from './helpers/core-schema-sqlite';

const mocks = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  find: vi.fn(),
  createAuditLog: vi.fn(async () => undefined),
  settings: {},
  kv: new Map<string, string>(),
}));

vi.mock('../account-deletion', () => ({ deleteAccount: mocks.deleteAccount }));
vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountExactSearchService: class {
    find = mocks.find;
  },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: mocks.createAuditLog,
    // The route's PII binding is the test's adapter itself.
    isDatabaseSource: (source: unknown) => source !== undefined && source !== null,
    ensureDatabaseAdapter: (source: unknown) => source,
    resolveEffectiveSettings: vi.fn(async () => ({
      'account-lifecycle.registration.cleanup_enabled': true,
      'account-lifecycle.registration.cleanup_max_per_run': 20,
      'account-lifecycle.registration.cleanup_time_budget_seconds': 5,
      ...mocks.settings,
    })),
  };
});

const { processRegistrationPendingCleanup } = await import('../registration-pending-cleanup');

const TENANT = 'tenant-a';
const NOW = 2_000_000_000_000;
const NOW_SECONDS = NOW / 1000;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function store() {
  const { db, adapter } = openCoreStore(TENANT);
  db.exec(
    renderPortableMigrationSql(
      readFileSync(
        new URL(
          '../../../../migrations/core/d1/007_account_registration_pending.sql',
          import.meta.url
        ),
        'utf8'
      ),
      'sqlite'
    )
  );
  return { db, adapter };
}

let core: ReturnType<typeof store>;
const piiQueryOne = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => null);
const pii = { queryOne: piiQueryOne } as unknown as DatabaseAdapter;
const env = {
  TDB_PII_1: pii,
  AUTHRIM_CONFIG: {
    get: async (key: string) => mocks.kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      mocks.kv.set(key, value);
    },
  },
} as unknown as Env;

function account(
  userId: string,
  options: { publication?: string; lifecycle?: string; metadata?: object } = {}
) {
  core.db
    .prepare(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, display_label,
         primary_account_id, created_at, updated_at)
       VALUES (?, ?, 'person', 'active', NULL, ?, 1, 1)`
    )
    .run(`subject:${userId}`, TENANT, `account:${userId}`);
  core.db
    .prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         primary_subject_id, display_label, metadata_json, created_at, updated_at,
         directory_publication_state, registration_state)
       VALUES (?, ?, 'user', ?, ?, ?, NULL, ?, 1, 1, ?, 'registered')`
    )
    .run(
      `account:${userId}`,
      TENANT,
      options.lifecycle ?? 'active',
      userId,
      `subject:${userId}`,
      JSON.stringify(options.metadata ?? {}),
      options.publication ?? 'active'
    );
}

function mark(
  userId: string,
  expiresAt = NOW_SECONDS - 1,
  flow = 'email_code',
  createdAt = expiresAt - 72 * 3600
) {
  core.db
    .prepare(
      `INSERT INTO account_registration_pending (tenant_id, user_id, flow, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(TENANT, userId, flow, createdAt, expiresAt);
}

function marks() {
  return core.db
    .prepare('SELECT user_id, expires_at FROM account_registration_pending ORDER BY user_id')
    .all() as Array<{ user_id: string; expires_at: number }>;
}

const run = () =>
  processRegistrationPendingCleanup(
    env,
    [{ tenantId: TENANT, adapters: [{ adapter: core.adapter, bindingRef: 'TDB_CORE_1' }] }],
    log,
    () => NOW
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.kv.clear();
  piiQueryOne.mockImplementation(async () => null);
  core = store();
  mocks.find.mockImplementation(async ({ identifier }: { identifier: string }) => [
    {
      id: `account:${identifier}`,
      legacyUserId: identifier,
      coreBindingRef: 'TDB_CORE_1',
      piiBindingRef: 'TDB_PII_1',
      lifecycleState: 'active',
    },
  ]);
  mocks.deleteAccount.mockResolvedValue({ status: 'deleted' });
});

describe('the clean-up of unfinished sign-ups', () => {
  it('finishes a deletion that failed after the core moved, and writes a lost audit', async () => {
    // Deleted in the core, its directory removal not yet made ready: resumed.
    // A deletion this clean-up began (its mark's created_at 0), stopped after the core moved.
    account('user-resume', { lifecycle: 'deleted' });
    mark('user-resume', NOW_SECONDS - 2, 'email_code', 0);
    core.db
      .prepare(
        `INSERT INTO account_routing_outbox (outbox_id, tenant_id, account_id, event_kind,
           route_generation, route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at)
         VALUES ('ob-1', ?, 'account:user-resume', 'account_deleted', 1, 1, 1, '{}', 'prepared',
           0, 1, 1)`
      )
      .run(TENANT);
    // Deleted by this clean-up before, its audit lost: written now; one an administrator
    // deleted keeps its own record.
    account('user-audit', { lifecycle: 'deleted' });
    mark('user-audit', NOW_SECONDS - 100, 'email_code', 0);
    // Deleted (or being deleted) by an administrator: never taken over, never audited here.
    account('user-admin', { lifecycle: 'deleting' });
    mark('user-admin', NOW_SECONDS - 1);

    await expect(run()).resolves.toMatchObject({ deleted: 2, already_deleted: 1 });
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAccount).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ userId: 'user-resume' })
    );
    expect(
      (
        mocks.createAuditLog.mock.calls as unknown as Array<
          [unknown, { resourceId: string; createdAt: number }]
        >
      )
        .map((call) => [call[1].resourceId, call[1].createdAt])
        .sort()
    ).toEqual([
      // Its time is when the deletion was decided, kept in the mark: the same when sent again.
      ['user-audit', (NOW_SECONDS - 100) * 1000],
      ['user-resume', (NOW_SECONDS - 2) * 1000],
    ]);
    expect(marks()).toEqual([]);
  });

  it('keeps the mark when the audit is not written, and counts begun deletions in the limit', async () => {
    account('user-a');
    mark('user-a', NOW_SECONDS - 2);
    account('user-b');
    mark('user-b', NOW_SECONDS - 1);
    mocks.settings = { 'account-lifecycle.registration.cleanup_max_per_run': 1 };
    mocks.createAuditLog.mockRejectedValueOnce(new Error('audit_unavailable'));

    await expect(run()).resolves.toMatchObject({ failed: 1, deleted: 0 });
    // The first deletion began (and failed after): the limit of one is used; the second waits.
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(marks()).toEqual([
      // This clean-up's deletion now (created_at 0, its decision time kept): retried as it is.
      { user_id: 'user-a', expires_at: NOW_SECONDS },
      { user_id: 'user-b', expires_at: NOW_SECONDS - 1 },
    ]);
  });

  it('keeps the decision time of its own deletion however often it fails', async () => {
    account('user-own');
    mark('user-own', NOW_SECONDS - 50, 'email_code', 0);
    // Begun before (still active): its deletion fails again.
    mocks.deleteAccount.mockRejectedValue(new Error('account_directory_removal_route_missing'));
    await run();
    await run();
    expect(marks()).toEqual([{ user_id: 'user-own', expires_at: NOW_SECONDS - 50 }]);
  });

  it('reaches the rest though its own begun deletions keep failing', async () => {
    for (let i = 0; i < 6; i++) {
      account(`user-own-${i}`);
      mark(`user-own-${i}`, NOW_SECONDS - 100 + i, 'email_code', 0);
    }
    account('user-next');
    mark('user-next', NOW_SECONDS - 1);
    mocks.deleteAccount.mockImplementation(async (_env: Env, input: { userId: string }) => {
      if (input.userId.startsWith('user-own-'))
        throw new Error('account_directory_removal_route_missing');
      return { status: 'deleted' };
    });
    await expect(run()).resolves.toMatchObject({ deleted: 1, failed: 5 });
    expect(marks().map((row) => row.user_id)).not.toContain('user-next');
  });

  it('tries each begun deletion in turn, and gives the other marks theirs under a small limit', async () => {
    for (let i = 0; i < 6; i++) {
      account(`user-own-${i}`);
      mark(`user-own-${i}`, NOW_SECONDS - 100 + i, 'email_code', 0);
    }
    mocks.deleteAccount.mockImplementation(async (_env: Env, input: { userId: string }) => {
      if (input.userId.startsWith('user-own-'))
        throw new Error('account_directory_removal_route_missing');
      return { status: 'deleted' };
    });
    // One shard: the sixth begun deletion still comes round (one further on every other run).
    await run();
    await run();
    await run();
    const tried = new Set(
      (mocks.deleteAccount.mock.calls as unknown as Array<[Env, { userId: string }]>).map(
        (call) => call[1].userId
      )
    );
    expect(tried.has('user-own-5')).toBe(true);

    // A limit of one: the other marks still get their turn.
    account('user-next');
    mark('user-next', NOW_SECONDS - 1);
    mocks.settings = { 'account-lifecycle.registration.cleanup_max_per_run': 1 };
    await run();
    await run();
    expect(marks().map((row) => row.user_id)).not.toContain('user-next');
  });

  it('gives each kind its turn on each shard of a tenant under a small limit', async () => {
    const second = store();
    account('user-own-a');
    mark('user-own-a', NOW_SECONDS - 100, 'email_code', 0);
    account('user-next-a');
    mark('user-next-a', NOW_SECONDS - 1);
    second.db
      .prepare(
        `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, display_label,
           primary_account_id, created_at, updated_at)
         VALUES ('subject:user-own-b', ?, 'person', 'active', NULL, 'account:user-own-b', 1, 1)`
      )
      .run(TENANT);
    second.db
      .prepare(
        `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
           primary_subject_id, display_label, metadata_json, created_at, updated_at,
           directory_publication_state, registration_state)
         VALUES ('account:user-own-b', ?, 'user', 'active', 'user-own-b', 'subject:user-own-b',
           NULL, '{}', 1, 1, 'active', 'registered')`
      )
      .run(TENANT);
    second.db
      .prepare(
        `INSERT INTO account_registration_pending (tenant_id, user_id, flow, created_at, expires_at)
         VALUES (?, 'user-own-b', 'email_code', 0, ?)`
      )
      .run(TENANT, NOW_SECONDS - 100);
    mocks.find.mockImplementation(async ({ identifier }: { identifier: string }) => [
      {
        id: `account:${identifier}`,
        legacyUserId: identifier,
        coreBindingRef: identifier === 'user-own-b' ? 'TDB_CORE_2' : 'TDB_CORE_1',
        piiBindingRef: 'TDB_PII_1',
        lifecycleState: 'active',
      },
    ]);
    mocks.deleteAccount.mockImplementation(async (_env: Env, input: { userId: string }) => {
      if (input.userId.startsWith('user-own-'))
        throw new Error('account_directory_removal_route_missing');
      return { status: 'deleted' };
    });
    mocks.settings = { 'account-lifecycle.registration.cleanup_max_per_run': 1 };
    const twoShards = () =>
      processRegistrationPendingCleanup(
        env,
        [
          {
            tenantId: TENANT,
            adapters: [
              { adapter: core.adapter, bindingRef: 'TDB_CORE_1' },
              { adapter: second.adapter, bindingRef: 'TDB_CORE_2' },
            ],
          },
        ],
        log,
        () => NOW
      );
    for (let i = 0; i < 4; i++) await twoShards();
    expect(marks().map((row) => row.user_id)).not.toContain('user-next-a');
  });

  it('tries every begun deletion of two shards in turn under a limit of one', async () => {
    const second = store();
    const seed = (target: ReturnType<typeof store>, userId: string, expiresAt: number) => {
      target.db
        .prepare(
          `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, display_label,
             primary_account_id, created_at, updated_at)
           VALUES (?, ?, 'person', 'active', NULL, ?, 1, 1)`
        )
        .run(`subject:${userId}`, TENANT, `account:${userId}`);
      target.db
        .prepare(
          `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
             legacy_user_id, primary_subject_id, display_label, metadata_json, created_at,
             updated_at, directory_publication_state, registration_state)
           VALUES (?, ?, 'user', 'active', ?, ?, NULL, '{}', 1, 1, 'active', 'registered')`
        )
        .run(`account:${userId}`, TENANT, userId, `subject:${userId}`);
      target.db
        .prepare(
          `INSERT INTO account_registration_pending (tenant_id, user_id, flow, created_at,
             expires_at) VALUES (?, ?, 'email_code', 0, ?)`
        )
        .run(TENANT, userId, expiresAt);
    };
    for (let i = 0; i < 6; i++) {
      seed(core, `user-a-${i}`, NOW_SECONDS - 100 + i);
      seed(second, `user-b-${i}`, NOW_SECONDS - 100 + i);
    }
    mocks.find.mockImplementation(async ({ identifier }: { identifier: string }) => [
      {
        id: `account:${identifier}`,
        legacyUserId: identifier,
        coreBindingRef: identifier.startsWith('user-b-') ? 'TDB_CORE_2' : 'TDB_CORE_1',
        piiBindingRef: 'TDB_PII_1',
        lifecycleState: 'active',
      },
    ]);
    mocks.deleteAccount.mockRejectedValue(new Error('account_directory_removal_route_missing'));
    mocks.settings = { 'account-lifecycle.registration.cleanup_max_per_run': 1 };
    for (let i = 0; i < 2 * 2 * 6; i++) {
      await processRegistrationPendingCleanup(
        env,
        [
          {
            tenantId: TENANT,
            adapters: [
              { adapter: core.adapter, bindingRef: 'TDB_CORE_1' },
              { adapter: second.adapter, bindingRef: 'TDB_CORE_2' },
            ],
          },
        ],
        log,
        () => NOW
      );
    }
    const tried = new Set(
      (mocks.deleteAccount.mock.calls as unknown as Array<[Env, { userId: string }]>).map(
        (call) => call[1].userId
      )
    );
    expect(tried.size).toBe(12);
  });

  it('leaves a mark another run made its own since it was read', async () => {
    account('user-raced', { lifecycle: 'deleting' });
    mark('user-raced');
    // Another run begins the deletion between this run's read of the marks and its decision.
    const raced = {
      ...core.adapter,
      query: async (sql: string, params?: unknown[]) => {
        const rows = await core.adapter.query(sql, params);
        core.db
          .prepare(
            `UPDATE account_registration_pending SET created_at = 0, expires_at = ?
              WHERE user_id = 'user-raced'`
          )
          .run(NOW_SECONDS);
        return rows;
      },
    } as DatabaseAdapter;
    await processRegistrationPendingCleanup(
      env,
      [{ tenantId: TENANT, adapters: [{ adapter: raced, bindingRef: 'TDB_CORE_1' }] }],
      log,
      () => NOW
    );
    expect(marks()).toEqual([{ user_id: 'user-raced', expires_at: NOW_SECONDS }]);
  });

  it('counts a hold placed after the first check as held', async () => {
    const { AccountDeletionHeldError } = await import('../account-directory-removal-producer');
    account('user-held');
    mark('user-held');
    mocks.deleteAccount.mockRejectedValueOnce(new AccountDeletionHeldError());
    await expect(run()).resolves.toMatchObject({ held: 1, failed: 0 });
    expect(marks()).toEqual([{ user_id: 'user-held', expires_at: NOW_SECONDS + 24 * 3600 }]);
  });

  it('deletes an expired unproven account, without its address, and audits the system', async () => {
    account('user-a');
    mark('user-a');
    // Not yet expired: untouched.
    account('user-b');
    mark('user-b', NOW_SECONDS + 60);

    await expect(run()).resolves.toMatchObject({ deleted: 1 });

    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAccount).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: TENANT,
        userId: 'user-a',
        core: core.adapter,
        pii,
        email: null,
        tombstone: {
          deletedBy: 'system',
          reason: 'registration_abandoned',
          metadata: { source: 'registration_cleanup', flow: 'email_code' },
        },
      })
    );
    expect(marks().map((row) => row.user_id)).toEqual(['user-b']);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: TENANT,
        userId: 'system',
        action: 'user.deleted',
        resourceId: 'user-a',
        metadata: JSON.stringify({
          actor: 'system',
          reason: 'registration_abandoned',
          flow: 'email_code',
        }),
      })
    );
  });

  it('keeps an account proven since, and drops only its mark', async () => {
    account('user-login', { metadata: { last_login_at: 1_700_000_000 } });
    mark('user-login');
    account('user-passkey');
    mark('user-passkey', NOW_SECONDS - 1, 'passkey');
    core.db
      .prepare(
        `INSERT INTO passkeys (id, tenant_id, user_id, credential_id, rp_id, public_key, counter,
           created_at)
         VALUES ('pk-1', ?, 'user-passkey', 'cred-1', 'login.example.com', 'key', 0, 1)`
      )
      .run(TENANT);
    account('user-link');
    mark('user-link');
    piiQueryOne.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('linked_identities') && params?.[1] === 'user-link' ? { found: 1 } : null
    );

    await expect(run()).resolves.toMatchObject({ completed: 3, deleted: 0 });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(marks()).toEqual([]);
  });

  it('postpones a held, unpublished or failed account, counted by reason', async () => {
    account('user-held');
    mark('user-held', NOW_SECONDS - 3);
    account('user-pending', { publication: 'pending' });
    mark('user-pending', NOW_SECONDS - 2);
    account('user-fail');
    mark('user-fail', NOW_SECONDS - 1);
    mocks.deleteAccount.mockImplementation(async (_env: Env, input: { userId: string }) => {
      if (input.userId === 'user-held') return { status: 'held', holdId: 'hold-1' };
      throw new Error('account_directory_removal_route_missing');
    });

    await expect(run()).resolves.toMatchObject({
      held: 1,
      route_unpublished: 1,
      failed: 1,
      deleted: 0,
    });
    expect(marks()).toEqual([
      // Begun and failed: kept as this clean-up's (its decision time), retried next run.
      { user_id: 'user-fail', expires_at: NOW_SECONDS },
      { user_id: 'user-held', expires_at: NOW_SECONDS + 24 * 3600 },
      { user_id: 'user-pending', expires_at: NOW_SECONDS + 24 * 3600 },
    ]);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    // The unpublished account is never handed to the deletion.
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(2);
  });

  it('drops the mark of an account gone, deleted, or not a registered person', async () => {
    mark('user-gone');
    account('user-deleted', { lifecycle: 'deleted' });
    mark('user-deleted');
    await expect(run()).resolves.toMatchObject({ orphaned: 1, already_deleted: 1 });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(marks()).toEqual([]);
  });

  it('does nothing for a tenant that turned it off, and stops at its per-run limit', async () => {
    account('user-a');
    mark('user-a', NOW_SECONDS - 2);
    account('user-b');
    mark('user-b', NOW_SECONDS - 1);
    mocks.settings = { 'account-lifecycle.registration.cleanup_enabled': false };
    await expect(run()).resolves.toMatchObject({ skippedTenants: 1, deleted: 0 });
    expect(marks()).toHaveLength(2);

    mocks.settings = { 'account-lifecycle.registration.cleanup_max_per_run': 1 };
    await expect(run()).resolves.toMatchObject({ deleted: 1 });
    expect(marks().map((row) => row.user_id)).toEqual(['user-b']);
  });
});
