/**
 * The clean-up of an unfinished sign-up whose account route was never published
 * (registration-pending-cleanup.ts, cleanUpUnpublished), over a real Core store: taken only once
 * its creation has stood still (so a provisioning token's resume, #772, and a re-send that moved
 * it keep it), its operation given up first, its removal prepared on its creation's route with
 * the move to `deleting` and its publication blocked, its reserved Control allocation released
 * and a committed one counted.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLookupBlindIndex,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
  type Logger,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { openCoreStore } from './helpers/core-schema-sqlite';

const LOOKUP_KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };

const mocks = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  find: vi.fn(),
  createAuditLog: vi.fn(async () => undefined),
  releaseAccountRoute: vi.fn(),
  hold: vi.fn(async (): Promise<unknown> => null),
  operationsAdapter: null as DatabaseAdapter | null,
  kv: new Map<string, string>(),
}));

vi.mock('../account-deletion', () => ({ deleteAccount: mocks.deleteAccount }));
vi.mock('../account-legal-hold-guard', () => ({ findActiveAccountLegalHold: mocks.hold }));
vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountExactSearchService: class {
    find = mocks.find;
  },
}));
vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: async () => ({
    readKeys: [{ generation: 1, secret: '0123456789abcdef0123456789abcdef' }],
    writeKeys: [{ generation: 1, secret: '0123456789abcdef0123456789abcdef' }],
  }),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: mocks.createAuditLog,
    isDatabaseSource: (source: unknown) => source !== undefined && source !== null,
    ensureDatabaseAdapter: (source: unknown) => source,
    // The operations are in the same Core store here.
    resolveAuthCorePersistenceAdapterFromEnv: async () => mocks.operationsAdapter,
    resolveEffectiveSettings: vi.fn(async () => ({
      'account-lifecycle.registration.cleanup_enabled': true,
      'account-lifecycle.registration.cleanup_max_per_run': 20,
      'account-lifecycle.registration.cleanup_time_budget_seconds': 5,
    })),
  };
});

const { processRegistrationPendingCleanup } = await import('../registration-pending-cleanup');

const TENANT = 'tenant-a';
const NOW = 2_000_000_000_000;
const NOW_SECONDS = NOW / 1000;
const USER = 'user-unpublished';
const ACCOUNT = `account:${USER}`;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

let db: ReturnType<typeof openCoreStore>['db'];
let core: DatabaseAdapter;
const piiQueryOne = vi.fn(async (): Promise<unknown> => null);
const pii = {
  queryOne: piiQueryOne,
  query: vi.fn(async () => []),
} as unknown as DatabaseAdapter;
const env = {
  TDB_PII_1: pii,
  CONTROL: { releaseAccountRoute: mocks.releaseAccountRoute },
  AUTHRIM_CONFIG: {
    get: async (key: string) => mocks.kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      mocks.kv.set(key, value);
    },
  },
} as unknown as Env;

async function creation(): Promise<AccountDirectoryPublication> {
  return {
    operationId: 'operation-unpublished',
    tenantId: TENANT,
    accountId: ACCOUNT,
    idempotencyKey: `account-create:${'c'.repeat(64)}`,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'policy-a',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_CORE_1',
          requiredBindingRouteGeneration: 1,
        },
        {
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: 'pii-1',
          bindingRef: 'TDB_PII_1',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
    indexes: [
      await createLookupBlindIndex('account_id', ACCOUNT, LOOKUP_KEY),
      await createLookupBlindIndex('email_exact', 'person@example.com', LOOKUP_KEY),
    ],
  };
}

/** An unfinished sign-up: written, never published, its creation's publication still pending. */
async function unpublished(
  options: {
    operationStatus?: string;
    operationUpdatedAt?: number;
    outbox?: { status: string; leaseExpiresAt?: number };
    publicationState?: string;
  } = {}
) {
  const publication = await creation();
  db.prepare(
    `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, display_label,
       primary_account_id, created_at, updated_at)
     VALUES (?, ?, 'person', 'active', NULL, ?, 1, 1)`
  ).run(`subject:${USER}`, TENANT, ACCOUNT);
  db.prepare(
    `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
       primary_subject_id, metadata_json, created_at, updated_at, directory_publication_state,
       registration_state)
     VALUES (?, ?, 'user', 'active', ?, ?, '{}', 1, 1, ?, 'registered')`
  ).run(ACCOUNT, TENANT, USER, `subject:${USER}`, options.publicationState ?? 'pending');
  const outbox = options.outbox ?? { status: 'pending' };
  db.prepare(
    `INSERT INTO account_routing_outbox (outbox_id, tenant_id, account_id, event_kind,
       route_generation, route_schema_version, hmac_key_generation, payload_json, status,
       attempt_count, lease_owner, lease_expires_at, next_attempt_at, last_error_code, created_at,
       updated_at)
     VALUES ('created-1', ?, ?, 'account_created', 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1)`
  ).run(
    TENANT,
    ACCOUNT,
    JSON.stringify(publication),
    outbox.status,
    outbox.status === 'leased' ? 1 : 0,
    outbox.status === 'leased' ? 'worker' : null,
    outbox.status === 'leased' ? (outbox.leaseExpiresAt ?? NOW_SECONDS + 60) : null,
    outbox.status === 'retry' ? NOW_SECONDS + 60 : null,
    outbox.status === 'retry' ? 'x' : null
  );
  db.prepare(
    `INSERT INTO account_creation_operations (operation_id, tenant_id, actor_id, idempotency_key,
       allocation_idempotency_key, request_hash, user_id, account_id, status, publication_json,
       created_at, updated_at)
     VALUES ('operation-unpublished', ?, 'auth:email_code', ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    TENANT,
    `auth-account:${'a'.repeat(64)}`,
    publication.idempotencyKey,
    'b'.repeat(64),
    USER,
    ACCOUNT,
    options.operationStatus ?? 'directory_pending',
    JSON.stringify(publication),
    options.operationUpdatedAt ?? NOW_SECONDS - 4 * 3600
  );
  // The mark's time is up (the sign-up began 72 hours before).
  db.prepare(
    `INSERT INTO account_registration_pending (tenant_id, user_id, flow, created_at, expires_at)
     VALUES (?, ?, 'email_code', ?, ?)`
  ).run(TENANT, USER, NOW_SECONDS - 73 * 3600, NOW_SECONDS - 3600);
}

const run = () =>
  processRegistrationPendingCleanup(
    env,
    [{ tenantId: TENANT, adapters: [{ adapter: core, bindingRef: 'TDB_CORE_1' }] }],
    log,
    () => NOW
  );

const one = <T>(sql: string, ...params: Array<string | number>) =>
  db.prepare(sql).get(...params) as T;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.kv.clear();
  const store = openCoreStore(TENANT);
  db = store.db;
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
  // As D1: the removal's prepare runs as one batch.
  core = { ...store.adapter, getType: () => 'd1' };
  mocks.operationsAdapter = core;
  // The account was written, so its allocation is committed (Control never releases one).
  mocks.releaseAccountRoute.mockRejectedValue(
    new Error('control_account_allocation_release_committed')
  );
  // The shared saga, as far as this store: its removal prepared through the job's hook.
  mocks.deleteAccount.mockImplementation(
    async (
      _env: Env,
      input: {
        tenantId: string;
        userId: string;
        core: DatabaseAdapter;
        pii: DatabaseAdapter;
        prepareRemoval?: (removal: object) => Promise<unknown>;
      }
    ) => {
      await input.prepareRemoval?.({
        tenantId: input.tenantId,
        userId: input.userId,
        core: input.core,
        pii: input.pii,
      });
      return { status: 'deleted' };
    }
  );
});

describe('the clean-up of an unfinished sign-up whose route was never published', () => {
  it('gives up its creation and deletes it on its creation route', async () => {
    await unpublished();

    await expect(run()).resolves.toMatchObject({ deleted_unpublished: 1, route_unpublished: 0 });

    // Given up first: a re-send acquiring it from now on is refused.
    expect(
      one(
        'SELECT status, last_error_code FROM account_creation_operations WHERE account_id = ?',
        ACCOUNT
      )
    ).toEqual({ status: 'blocked', last_error_code: 'registration_abandoned' });
    // Moved to deleting (publication disabled), its publication blocked, its removal prepared
    // with what the creation reserved (account id and address).
    expect(
      one(
        'SELECT lifecycle_state, directory_publication_state FROM identity_accounts WHERE id = ?',
        ACCOUNT
      )
    ).toEqual({ lifecycle_state: 'deleting', directory_publication_state: 'disabled' });
    expect(
      one(
        `SELECT status, last_error_code FROM account_routing_outbox
          WHERE account_id = ? AND event_kind = 'account_created'`,
        ACCOUNT
      )
    ).toEqual({ status: 'blocked', last_error_code: 'registration_abandoned' });
    const removal = one<{ status: string; payload_json: string }>(
      `SELECT status, payload_json FROM account_routing_outbox
        WHERE account_id = ? AND event_kind = 'account_deleted'`,
      ACCOUNT
    );
    expect(removal.status).toBe('prepared');
    const payload = JSON.parse(removal.payload_json) as {
      scope: string;
      indexes: Array<{ indexKind: string }>;
      routeProjection: { targets: Array<{ bindingRef: string }> };
    };
    expect(payload.scope).toBe('account');
    expect(payload.indexes.map((index) => index.indexKind).sort()).toEqual([
      'account_id',
      'email_exact',
    ]);
    expect(payload.routeProjection.targets.map((target) => target.bindingRef)).toEqual([
      'TDB_CORE_1',
      'TDB_PII_1',
    ]);
    // The deletion is the shared saga's, with the unfinished sign-up's tombstone and no address.
    expect(mocks.deleteAccount).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        userId: USER,
        email: null,
        tombstone: expect.objectContaining({ reason: 'registration_abandoned' }) as unknown,
      })
    );
    // Its committed allocation is counted in the run's log; the audit names the system only.
    expect(mocks.releaseAccountRoute).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      'Unpublished sign-up accounts deleted with their Control allocation kept',
      { allocationsCommitted: 1 }
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ userId: 'system', action: 'user.deleted', resourceId: USER })
    );
    expect(one('SELECT COUNT(*) AS n FROM account_registration_pending')).toEqual({ n: 0 });
  });

  it('releases an allocation still only reserved, and counts none', async () => {
    await unpublished();
    mocks.releaseAccountRoute.mockResolvedValueOnce(undefined);

    await expect(run()).resolves.toMatchObject({ deleted_unpublished: 1 });
    expect(log.warn).not.toHaveBeenCalledWith(
      'Unpublished sign-up accounts deleted with their Control allocation kept',
      expect.anything()
    );
  });

  it.each([
    ['a resume of its provisioning token five minutes ago', NOW_SECONDS - 5 * 60],
    ['a re-send that moved it an hour ago', NOW_SECONDS - 3600],
    ['the directory worker retrying it within its two hours', NOW_SECONDS - 2 * 3600 + 60],
  ])('keeps one still moving (%s), its creation untouched', async (_case, updatedAt) => {
    await unpublished({ operationUpdatedAt: updatedAt });

    await expect(run()).resolves.toMatchObject({ route_unpublished: 1, deleted_unpublished: 0 });

    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(
      one('SELECT status FROM account_creation_operations WHERE account_id = ?', ACCOUNT)
    ).toEqual({ status: 'directory_pending' });
    expect(one('SELECT lifecycle_state FROM identity_accounts WHERE id = ?', ACCOUNT)).toEqual({
      lifecycle_state: 'active',
    });
    // Moved later (24 h), still its own: not this clean-up's deletion.
    expect(
      one<{ created_at: number; expires_at: number }>(
        'SELECT created_at, expires_at FROM account_registration_pending'
      )
    ).toMatchObject({ expires_at: NOW_SECONDS + 24 * 3600 });
  });

  it('keeps one a worker is publishing now (its lease still running)', async () => {
    await unpublished({ outbox: { status: 'leased', leaseExpiresAt: NOW_SECONDS + 120 } });

    await expect(run()).resolves.toMatchObject({ route_unpublished: 1 });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(
      one('SELECT status FROM account_creation_operations WHERE account_id = ?', ACCOUNT)
    ).toEqual({ status: 'directory_pending' });
  });

  it('takes one whose worker lease has run out', async () => {
    await unpublished({ outbox: { status: 'leased', leaseExpiresAt: NOW_SECONDS - 60 } });

    await expect(run()).resolves.toMatchObject({ deleted_unpublished: 1 });
    expect(
      one(
        `SELECT status, lease_owner FROM account_routing_outbox
          WHERE account_id = ? AND event_kind = 'account_created'`,
        ACCOUNT
      )
    ).toEqual({ status: 'blocked', lease_owner: null });
  });

  it('leaves a published account to the published path', async () => {
    await unpublished({ outbox: { status: 'succeeded' }, publicationState: 'active' });
    db.prepare(
      `UPDATE account_routing_outbox SET succeeded_at = 1 WHERE event_kind = 'account_created'`
    ).run();
    mocks.find.mockResolvedValue([]);

    await run();
    expect(
      one('SELECT status FROM account_creation_operations WHERE account_id = ?', ACCOUNT)
    ).toEqual({ status: 'directory_pending' });
    expect(mocks.releaseAccountRoute).not.toHaveBeenCalled();
  });

  it('changes nothing when a publication succeeds between the check and the removal', async () => {
    await unpublished();
    mocks.deleteAccount.mockImplementationOnce(
      async (
        _env: Env,
        input: { prepareRemoval: (removal: object) => Promise<unknown> } & object
      ) => {
        // The worker published it meanwhile.
        db.prepare(
          `UPDATE account_routing_outbox SET status = 'succeeded', succeeded_at = 1
            WHERE event_kind = 'account_created'`
        ).run();
        await input.prepareRemoval({ ...input });
        return { status: 'deleted' };
      }
    );

    await expect(run()).resolves.toMatchObject({ failed: 1 });
    expect(
      one(
        'SELECT lifecycle_state, directory_publication_state FROM identity_accounts WHERE id = ?',
        ACCOUNT
      )
    ).toEqual({ lifecycle_state: 'active', directory_publication_state: 'pending' });
    expect(
      one(`SELECT COUNT(*) AS n FROM account_routing_outbox WHERE event_kind = 'account_deleted'`)
    ).toEqual({ n: 0 });
  });

  it('resumes its own unpublished deletion that stopped after the account moved', async () => {
    await unpublished();
    // The first attempt stops after its removal was prepared (the account moved to deleting).
    mocks.deleteAccount.mockImplementationOnce(
      async (
        _env: Env,
        input: { prepareRemoval: (removal: object) => Promise<unknown> } & object
      ) => {
        await input.prepareRemoval({ ...input });
        throw new Error('account_pii_erasure_batch_failed');
      }
    );
    await expect(run()).resolves.toMatchObject({ failed: 1 });
    expect(
      one<{ created_at: number }>('SELECT created_at FROM account_registration_pending')
    ).toEqual({ created_at: 0 });

    // The next run resumes it as it is (nothing checked again), adopting the prepared removal.
    await expect(run()).resolves.toMatchObject({ deleted_unpublished: 1 });
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(2);
    expect(
      one(`SELECT COUNT(*) AS n FROM account_routing_outbox WHERE event_kind = 'account_deleted'`)
    ).toEqual({ n: 1 });
    expect(mocks.createAuditLog).toHaveBeenCalledOnce();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      env,
      // Its decision time, kept in its mark since the first attempt.
      expect.objectContaining({ createdAt: NOW_SECONDS * 1000 })
    );
    expect(one('SELECT COUNT(*) AS n FROM account_registration_pending')).toEqual({ n: 0 });
  });

  it('lets a resume that arrives while it is being taken keep its creation', async () => {
    await unpublished();
    // The re-send resumes the creation between the clean-up's read and its giving up.
    const { AccountCreationOperationRepository } = await import('../account-creation-operation');
    const repository = new AccountCreationOperationRepository(core);
    const execute = core.execute.bind(core);
    let resumed = false;
    core = {
      ...core,
      execute: async (sql: string, params?: unknown[]) => {
        if (
          !resumed &&
          sql.includes("SET status = 'blocked', last_error_code = 'registration_abandoned'")
        ) {
          resumed = true;
          const found = await repository.findByAccountId({ tenantId: TENANT, accountId: ACCOUNT });
          await repository.touch(found!.operation, NOW_SECONDS);
        }
        return execute(sql, params);
      },
    };
    mocks.operationsAdapter = core;

    await expect(run()).resolves.toMatchObject({ route_unpublished: 1, deleted_unpublished: 0 });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(
      one('SELECT status FROM account_creation_operations WHERE account_id = ?', ACCOUNT)
    ).toEqual({ status: 'directory_pending' });
    expect(one('SELECT lifecycle_state FROM identity_accounts WHERE id = ?', ACCOUNT)).toEqual({
      lifecycle_state: 'active',
    });
  });

  it('refuses a resume once the creation was given up', async () => {
    await unpublished();
    await run();
    const { AccountCreationOperationRepository } = await import('../account-creation-operation');
    const repository = new AccountCreationOperationRepository(core);
    const found = await repository.findByAccountId({ tenantId: TENANT, accountId: ACCOUNT });

    await expect(
      repository.touch({ ...found!.operation, status: 'directory_pending' }, NOW_SECONDS)
    ).rejects.toThrow('account_creation_operation_blocked');
  });

  it('carries on a deletion another run began and gave the creation up for', async () => {
    await unpublished();
    // Another run began it (its mark this clean-up's) and gave the creation up just now, then
    // stopped before the account moved.
    db.prepare(
      `UPDATE account_creation_operations SET status = 'blocked',
          last_error_code = 'registration_abandoned', updated_at = ?`
    ).run(NOW_SECONDS - 10);
    db.prepare('UPDATE account_registration_pending SET created_at = 0, expires_at = ?').run(
      NOW_SECONDS - 10
    );

    await expect(run()).resolves.toMatchObject({ deleted_unpublished: 1 });
    expect(one('SELECT COUNT(*) AS n FROM account_registration_pending')).toEqual({ n: 0 });
  });

  it('gives up nothing for an account under a legal hold', async () => {
    await unpublished();
    mocks.hold.mockResolvedValueOnce({ holdId: 'hold-1', reasonCode: 'litigation' });

    await expect(run()).resolves.toMatchObject({ held: 1, deleted_unpublished: 0 });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(mocks.releaseAccountRoute).not.toHaveBeenCalled();
    expect(
      one('SELECT status FROM account_creation_operations WHERE account_id = ?', ACCOUNT)
    ).toEqual({ status: 'directory_pending' });
  });

  it('keeps the account under a hold placed meanwhile, its creation given up', async () => {
    await unpublished();
    mocks.deleteAccount.mockResolvedValueOnce({ status: 'held', holdId: 'hold-1' });

    await expect(run()).resolves.toMatchObject({ held: 1 });
    // A creation under a hold is not resumed; nothing of the account is released.
    expect(
      one(
        'SELECT status, last_error_code FROM account_creation_operations WHERE account_id = ?',
        ACCOUNT
      )
    ).toEqual({ status: 'blocked', last_error_code: 'registration_abandoned' });
    expect(mocks.releaseAccountRoute).not.toHaveBeenCalled();
  });

  it("deletes one whose directory worker's retries ran out (both blocked)", async () => {
    await unpublished({ outbox: { status: 'pending' } });
    // The worker's retry budget is used up: the operation and its publication are blocked.
    db.prepare(
      `UPDATE account_creation_operations SET status = 'blocked',
          last_error_code = 'directory_routing_retry_budget_exhausted'`
    ).run();
    db.prepare(
      `UPDATE account_routing_outbox SET status = 'blocked', last_error_code = 'x'
        WHERE event_kind = 'account_created'`
    ).run();

    await expect(run()).resolves.toMatchObject({ deleted_unpublished: 1 });
    expect(
      one(
        'SELECT status, last_error_code FROM account_creation_operations WHERE account_id = ?',
        ACCOUNT
      )
    ).toEqual({ status: 'blocked', last_error_code: 'registration_abandoned' });
    expect(one('SELECT lifecycle_state FROM identity_accounts WHERE id = ?', ACCOUNT)).toEqual({
      lifecycle_state: 'deleting',
    });
  });

  it('does not take a given-up read for a creation that is no longer given up', async () => {
    await unpublished();
    const { AccountCreationOperationRepository } = await import('../account-creation-operation');
    const repository = new AccountCreationOperationRepository(core);
    const found = await repository.findByAccountId({ tenantId: TENANT, accountId: ACCOUNT });

    // A stale read says blocked; the row says otherwise.
    await expect(
      repository.abandon({
        operation: {
          ...found!.operation,
          status: 'blocked',
          lastErrorCode: 'registration_abandoned',
        },
        updatedAt: found!.updatedAt,
        now: NOW_SECONDS,
      })
    ).resolves.toBe(false);
  });

  it('counts a kept allocation only for an account deleted', async () => {
    await unpublished();
    mocks.deleteAccount.mockRejectedValueOnce(new Error('account_pii_erasure_batch_failed'));

    await expect(run()).resolves.toMatchObject({ failed: 1 });
    expect(mocks.releaseAccountRoute).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(
      'Unpublished sign-up accounts deleted with their Control allocation kept',
      expect.anything()
    );
  });

  it("never moves a creation's time past now however often it is resumed", async () => {
    await unpublished({ operationUpdatedAt: NOW_SECONDS - 4 * 3600 });
    const { AccountCreationOperationRepository } = await import('../account-creation-operation');
    const repository = new AccountCreationOperationRepository(core);
    for (let i = 0; i < 5; i++) {
      const found = await repository.findByAccountId({ tenantId: TENANT, accountId: ACCOUNT });
      await repository.touch(found!.operation, NOW_SECONDS);
    }
    expect(
      one('SELECT updated_at FROM account_creation_operations WHERE account_id = ?', ACCOUNT)
    ).toEqual({ updated_at: NOW_SECONDS });
  });
});
