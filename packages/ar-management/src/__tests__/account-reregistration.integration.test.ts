/**
 * Signing up again after the account was deleted (account-creation-generation.ts). An auth
 * request's key is fixed by the request, so the same sign-up after a deletion has the first one's
 * key; it must reach a new operation and a new account, not the deleted one, while the same
 * request sent again (or two at once) still makes one account.
 *
 * Real SQL on the tenant core baseline (operations, accounts and their routing outbox). The
 * deletion is the shared saga (account-deletion.ts) the administrator's delete, SCIM's delete and
 * the clean-up of unfinished sign-ups all run, with its own lifecycle moves and outbox writes; only
 * the steps outside this database (Lookup, PII, sessions, tombstones) are stubbed.
 */
import { readFileSync } from 'node:fs';
import {
  accountDirectoryRemovalOutboxId,
  CanonicalIdentityRepository,
  createLookupBlindIndex,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
  type PreparedStatement,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

interface TestState {
  core: unknown;
  /** The tenant's current core shards, as the runtime registry assigns them. */
  coreShards: Array<{ bindingRef: string; shardId: string; source: unknown }>;
  /** What the immediate attempt of a directory removal does: succeed, or leave it to the worker. */
  removalOutcome: 'succeeded' | 'pending';
  removalCount: number;
}
const state = vi.hoisted(
  (): TestState => ({
    core: undefined,
    coreShards: [],
    removalOutcome: 'succeeded',
    removalCount: 0,
  })
);

vi.mock('../account-legal-hold-guard', () => ({ findActiveAccountLegalHold: async () => null }));
vi.mock('../account-tombstone-write', () => ({
  prepareAccountTombstone: async () => ({}),
  writeAccountTombstone: async () => undefined,
}));
vi.mock('../session-end-logout', () => ({ transitionEndingSessions: async () => undefined }));
vi.mock('../account-directory-removal-producer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../account-directory-removal-producer')>();
  const { CanonicalIdentityRepository: Repository } = await import('@authrim/ar-lib-core');
  return {
    ...actual,
    // The hold-checked move to `deleting` and a prepared account_deleted row, as the real one.
    prepareAccountDirectoryRemoval: async (
      _env: Env,
      input: { tenantId: string; userId: string; core: DatabaseAdapter }
    ) => {
      const accountId = `account:${input.userId}`;
      await new Repository(input.core, input.tenantId).transitionAccountLifecycle(
        accountId,
        'deleting'
      );
      const operationId = `removal-${++state.removalCount}`;
      await input.core.execute(
        `INSERT INTO account_routing_outbox (outbox_id, tenant_id, account_id, event_kind,
           route_generation, route_schema_version, hmac_key_generation, payload_json, status,
           created_at, updated_at)
         VALUES (?, ?, ?, 'account_deleted', 1, 1, 1, '{}', 'prepared', 100, 100)`,
        [accountDirectoryRemovalOutboxId(operationId), input.tenantId, accountId]
      );
      return [{ operationId }];
    },
    eraseAccountPiiAfterDirectoryRemovalPrepared: async () => undefined,
    attemptImmediateAccountDirectoryRemovals: async (
      _binding: unknown,
      removals: Array<{ operationId: string }>
    ) => {
      if (state.removalOutcome !== 'succeeded') return;
      for (const removal of removals) await succeedRemoval(removal.operationId);
    },
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantAssignedDatabaseSourcesFromRegistry: async (
      _env: unknown,
      input: { tenantId: string; dataRole: string }
    ) =>
      input.dataRole === 'tenant_core/users'
        ? state.coreShards.map((shard) => ({
            tenantId: input.tenantId,
            dataRole: 'tenant_core/users',
            shardId: shard.shardId,
            bindingRef: shard.bindingRef,
            residencyPartition: 'default',
            bindingRouteGeneration: 1,
            source: shard.source,
          }))
        : [],
    // The runtime user's removal ends in the account's move to `deleted` (its core trigger).
    CanonicalRuntimeUserWriter: class {
      constructor(
        private readonly repository: InstanceType<typeof actual.CanonicalIdentityRepository>
      ) {}
      async deleteRuntimeUser(userId: string) {
        await this.repository.transitionAccountLifecycle(`account:${userId}`, 'deleted');
      }
    },
  };
});

const { deleteAccount } = await import('../account-deletion');
const { AccountCreationOperationRepository } = await import('../account-creation-operation');
const {
  ACCOUNT_CREATION_GENERATIONS_EXHAUSTED,
  ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING,
  MAX_ACCOUNT_CREATION_GENERATIONS,
  accountCreationGenerationKey,
  previousAccountStateReader,
  resolveAccountCreationGenerationKey,
} = await import('../account-creation-generation');

const TENANT = 'tenant-a';
const ACTOR = 'auth:email_code';
const KEY = `auth-account:${'a'.repeat(64)}`;
const REQUEST_HASH = 'b'.repeat(64);
const LOOKUP_KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };

let database: SQLiteDatabase;
let core: DatabaseAdapter;
let repository: InstanceType<typeof AccountCreationOperationRepository>;

async function succeedRemoval(operationId: string): Promise<void> {
  await (state.core as DatabaseAdapter).execute(
    `UPDATE account_routing_outbox SET status = 'succeeded', succeeded_at = 101, updated_at = 101,
        next_attempt_at = NULL
      WHERE outbox_id = ?`,
    [accountDirectoryRemovalOutboxId(operationId)]
  );
}

/** A D1 binding over the same SQLite database (sessions read it directly). */
function d1Over(db: SQLiteDatabase): unknown {
  const values = (params: unknown[]) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const session = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => db.prepare(sql).get(...values(params)) ?? null,
        all: async () => ({ success: true, results: db.prepare(sql).all(...values(params)) }),
      }),
    }),
  };
  return { prepare: session.prepare, batch: async () => [], withSession: () => session };
}

function openCore(): { database: SQLiteDatabase; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  db.exec(
    renderPortableMigrationSql(
      readFileSync(
        new URL('../../../../migrations/core/d1/001_0_5_0_core_baseline.sql', import.meta.url),
        'utf8'
      ),
      'sqlite'
    )
  );
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const run = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run({ sql, params }),
    // Atomic, as D1's batch (the lifecycle moves' guarded plans depend on it).
    batch: async (statements: PreparedStatement[]) => {
      db.exec('BEGIN');
      try {
        const result = statements.map(run);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    getType: () => 'd1',
    close: async () => undefined,
  } as unknown as DatabaseAdapter;
  return { database: db, adapter };
}

async function publicationFor(operation: {
  operationId: string;
  accountId: string;
  allocationIdempotencyKey: string;
}): Promise<AccountDirectoryPublication> {
  return {
    operationId: operation.operationId,
    tenantId: TENANT,
    accountId: operation.accountId,
    idempotencyKey: operation.allocationIdempotencyKey,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'policy-a',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
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
    indexes: [await createLookupBlindIndex('account_id', operation.accountId, LOOKUP_KEY)],
  };
}

/** What provisionValidatedAccount does before the producer: the generation, then acquire. */
async function acquireSignUp(candidate: string) {
  const idempotencyKey = await resolveAccountCreationGenerationKey({
    repository,
    tenantId: TENANT,
    actorId: ACTOR,
    idempotencyKey: KEY,
    requestHash: REQUEST_HASH,
    readPreviousAccount: previousAccountStateReader({} as Env),
  });
  return repository.acquire({
    tenantId: TENANT,
    actorId: ACTOR,
    idempotencyKey,
    requestHash: REQUEST_HASH,
    candidateOperationId: `operation-${candidate}`,
    candidateUserId: candidate,
    now: 100,
  });
}

/** The producer's write of the operation's account, through to its published route. */
async function completeSignUp(operation: Awaited<ReturnType<typeof acquireSignUp>>): Promise<void> {
  if (operation.status === 'succeeded') return;
  const publication = await publicationFor(operation);
  let current = await repository.recordPublication(operation, publication, 100);
  current = await repository.transition(current, 'reserved', 100);
  await repository.transition(current, 'writing', 100);
  await core.execute(
    `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
       created_at, updated_at, directory_publication_state)
     VALUES (?, ?, 'user', 'active', ?, 100, 100, 'active')`,
    [operation.accountId, TENANT, operation.userId]
  );
  await repository.recordDirectoryOutcome({ publication, outcome: 'succeeded', now: 100 });
}

async function signUp(candidate: string) {
  const operation = await acquireSignUp(candidate);
  await completeSignUp(operation);
  return operation;
}

// The three deletion paths, as each calls the shared saga (their tombstones and session-end
// wrappers differ; what the saga leaves in the core database does not).
const DELETION_PATHS = [
  {
    name: "the administrator's delete",
    email: 'person@example.com' as string | null,
    tombstone: { deletedBy: 'admin', reason: 'admin_action', metadata: { source: 'admin_api' } },
    erasedAtSeconds: undefined as number | undefined,
  },
  {
    name: "SCIM's delete",
    email: 'person@example.com' as string | null,
    tombstone: { deletedBy: 'scim_api', reason: 'scim_delete', metadata: { source: 'scim_api' } },
    erasedAtSeconds: 100 as number | undefined,
  },
  {
    name: 'the clean-up of unfinished sign-ups (#789)',
    email: null,
    tombstone: {
      deletedBy: 'system',
      reason: 'registration_abandoned',
      metadata: { source: 'registration_cleanup', flow: 'email_code' },
    },
    erasedAtSeconds: undefined as number | undefined,
  },
];

function deleteVia(path: (typeof DELETION_PATHS)[number], userId: string) {
  return deleteAccount({ ACCOUNT_DIRECTORY: {} } as unknown as Env, {
    tenantId: TENANT,
    userId,
    core,
    pii: core,
    email: path.email,
    tombstone: path.tombstone,
    ...(path.erasedAtSeconds === undefined ? {} : { erasedAtSeconds: path.erasedAtSeconds }),
    endSessions: async (_operationId, work) => work([]),
  });
}

function operationCount(): number {
  return Number(
    (
      database.prepare('SELECT COUNT(*) AS count FROM account_creation_operations').get() as {
        count: number;
      }
    ).count
  );
}

beforeEach(() => {
  ({ database, adapter: core } = openCore());
  state.core = core;
  state.coreShards = [{ bindingRef: 'TDB_USERS_1', shardId: 'users-1', source: d1Over(database) }];
  state.removalOutcome = 'succeeded';
  state.removalCount = 0;
  repository = new AccountCreationOperationRepository(core);
});

afterEach(() => database.close());

describe('signing up again after the account was deleted', () => {
  it.each(DELETION_PATHS)('makes a new account after $name', async (path) => {
    const first = await signUp('user-first');
    expect(first.idempotencyKey).toBe(KEY);
    await expect(deleteVia(path, first.userId)).resolves.toEqual({ status: 'deleted' });

    const second = await signUp('user-second');

    expect(second.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));
    expect(second.userId).toBe('user-second');
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.allocationIdempotencyKey).not.toBe(first.allocationIdempotencyKey);
    expect(second.requestHash).toBe(first.requestHash);
  });

  it('sends the same sign-up again to the same new account, not a third one', async () => {
    const first = await signUp('user-first');
    await deleteVia(DELETION_PATHS[0], first.userId);
    const second = await signUp('user-second');

    // A retry of the same request (a new candidate each time, as ar-auth sends) and a resume
    // after the account was written both land on the second generation's operation.
    const retried = await acquireSignUp('user-retry');
    const resumed = await acquireSignUp('user-resume');

    expect(retried.operationId).toBe(second.operationId);
    expect(retried.userId).toBe('user-second');
    expect(resumed.operationId).toBe(second.operationId);
    expect(operationCount()).toBe(2);
  });

  it('keeps an unfinished new generation for the request that resumes it', async () => {
    const first = await signUp('user-first');
    await deleteVia(DELETION_PATHS[1], first.userId);
    // Acquired, not yet written (a 202 whose resume token is still out).
    const pending = await acquireSignUp('user-second');
    expect(pending.status).toBe('preparing');

    const again = await acquireSignUp('user-third');

    expect(again.operationId).toBe(pending.operationId);
    expect(again.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));
    expect(operationCount()).toBe(2);
  });

  it('makes one new generation for two sign-ups at once; the loser gets the winner', async () => {
    const first = await signUp('user-first');
    await deleteVia(DELETION_PATHS[2], first.userId);

    // Both read the generations before either acquires: both choose generation 1.
    const resolve = () =>
      resolveAccountCreationGenerationKey({
        repository,
        tenantId: TENANT,
        actorId: ACTOR,
        idempotencyKey: KEY,
        requestHash: REQUEST_HASH,
        readPreviousAccount: previousAccountStateReader({} as Env),
      });
    const [keyA, keyB] = await Promise.all([resolve(), resolve()]);
    expect(keyA).toBe(keyB);
    const acquireAs = (candidate: string, idempotencyKey: string) =>
      repository.acquire({
        tenantId: TENANT,
        actorId: ACTOR,
        idempotencyKey,
        requestHash: REQUEST_HASH,
        candidateOperationId: `operation-${candidate}`,
        candidateUserId: candidate,
        now: 100,
      });
    const a = await acquireAs('user-a', keyA);
    const b = await acquireAs('user-b', keyB);

    expect(a.operationId).toBe(b.operationId);
    expect(a.operationId).toBe('operation-user-a');
    expect(a.userId).toBe(b.userId);
    expect(a.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));
    expect(operationCount()).toBe(2);
  });

  it('keeps the same request on the live account it already made (no deletion)', async () => {
    const first = await signUp('user-first');

    const again = await acquireSignUp('user-again');

    expect(again.operationId).toBe(first.operationId);
    expect(again.status).toBe('succeeded');
    expect(operationCount()).toBe(1);
  });

  it('refuses, retryably, while the old account is still being deleted', async () => {
    const first = await signUp('user-first');
    await new CanonicalIdentityRepository(core, TENANT).transitionAccountLifecycle(
      first.accountId,
      'deleting'
    );

    await expect(acquireSignUp('user-second')).rejects.toThrow(
      ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING
    );
    expect(operationCount()).toBe(1);
  });

  it('refuses until the directory removal of the deleted account has succeeded', async () => {
    state.removalOutcome = 'pending';
    const first = await signUp('user-first');
    await deleteVia(DELETION_PATHS[0], first.userId);
    expect(
      database
        .prepare(`SELECT lifecycle_state FROM identity_accounts WHERE id = ?`)
        .get(first.accountId)
    ).toEqual({ lifecycle_state: 'deleted' });

    // The removal is left to the worker: pending, leased, then waiting for a retry.
    const moves = [
      `UPDATE account_routing_outbox SET status = 'leased', lease_owner = 'worker',
          lease_expires_at = 300, next_attempt_at = NULL`,
      `UPDATE account_routing_outbox SET status = 'retry', lease_owner = NULL,
          lease_expires_at = NULL, next_attempt_at = 400, last_error_code = 'x'`,
    ];
    for (const move of [undefined, ...moves]) {
      if (move) database.prepare(`${move} WHERE event_kind = 'account_deleted'`).run();
      await expect(acquireSignUp('user-second')).rejects.toThrow(
        ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING
      );
    }
    expect(operationCount()).toBe(1);

    await succeedRemoval('removal-1');
    const second = await signUp('user-second');
    expect(second.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));
  });

  it.each(['blocked', 'dead_letter'])(
    'keeps refusing when the directory removal failed for good (%s)',
    async (status) => {
      state.removalOutcome = 'pending';
      const first = await signUp('user-first');
      await deleteVia(DELETION_PATHS[1], first.userId);
      database
        .prepare(
          `UPDATE account_routing_outbox SET status = 'leased', lease_owner = 'worker',
              lease_expires_at = 300, next_attempt_at = NULL WHERE event_kind = 'account_deleted'`
        )
        .run();
      database
        .prepare(
          `UPDATE account_routing_outbox SET status = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = 'x' WHERE event_kind = 'account_deleted'`
        )
        .run(status);

      await expect(acquireSignUp('user-second')).rejects.toThrow(
        ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING
      );
      expect(operationCount()).toBe(1);
    }
  );

  it('goes on generation by generation and refuses past the limit', async () => {
    for (let generation = 0; generation < MAX_ACCOUNT_CREATION_GENERATIONS; generation++) {
      const operation = await signUp(`user-${generation}`);
      expect(operation.idempotencyKey).toBe(accountCreationGenerationKey(KEY, generation));
      await deleteVia(DELETION_PATHS[generation % DELETION_PATHS.length], operation.userId);
    }

    await expect(acquireSignUp('user-over')).rejects.toThrow(
      ACCOUNT_CREATION_GENERATIONS_EXHAUSTED
    );
    expect(operationCount()).toBe(MAX_ACCOUNT_CREATION_GENERATIONS);
  });

  it("reads the account where the tenant's placement has it now, not the first route", async () => {
    // A placement migration moved the tenant: its operations still carry the first route
    // (TDB_USERS_1), whose stale copy shows the account active. The registry assigns the target.
    const first = await signUp('user-first');
    const target = openCore();
    try {
      target.database
        .prepare(
          `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
             legacy_user_id, created_at, updated_at, directory_publication_state)
           VALUES (?, ?, 'user', 'deleted', ?, 100, 100, 'disabled')`
        )
        .run(first.accountId, TENANT, first.userId);
      target.database
        .prepare(
          `INSERT INTO account_routing_outbox (outbox_id, tenant_id, account_id, event_kind,
             route_generation, route_schema_version, hmac_key_generation, payload_json, status,
             created_at, updated_at, succeeded_at)
           VALUES ('removal-target', ?, ?, 'account_deleted', 1, 1, 1, '{}', 'succeeded', 100,
             100, 100)`
        )
        .run(TENANT, first.accountId);
      state.coreShards = [
        { bindingRef: 'TDB_USERS_9', shardId: 'users-9', source: d1Over(target.database) },
      ];

      const second = await signUp('user-second');
      expect(second.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));

      // And a written account found on no current shard is refused, not taken as removed.
      state.coreShards = [];
      await expect(acquireSignUp('user-third')).rejects.toThrow(
        ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING
      );
    } finally {
      target.database.close();
    }
  });

  it('takes a deleted account whose removals were not carried over (a restore) as removed', async () => {
    const first = await signUp('user-first');
    await deleteVia(DELETION_PATHS[0], first.userId);
    database
      .prepare(`DELETE FROM account_routing_outbox WHERE event_kind = 'account_deleted'`)
      .run();

    const second = await signUp('user-second');

    expect(second.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));
  });

  it('makes a new account after the clean-up gave up an unpublished creation', async () => {
    // Written but never published: the clean-up gives its operation up, then deletes it.
    const acquired = await acquireSignUp('user-first');
    let pending = await repository.recordPublication(acquired, await publicationFor(acquired), 100);
    pending = await repository.transition(pending, 'reserved', 100);
    pending = await repository.transition(pending, 'writing', 100);
    const found = await repository.findByAccountId({
      tenantId: TENANT,
      accountId: pending.accountId,
    });
    expect(found).not.toBeNull();
    await core.execute(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         created_at, updated_at, directory_publication_state)
       VALUES (?, ?, 'user', 'active', ?, 100, 100, 'pending')`,
      [pending.accountId, TENANT, pending.userId]
    );
    await expect(
      repository.abandon({ operation: found!.operation, updatedAt: found!.updatedAt, now: 200 })
    ).resolves.toBe(true);
    await core.execute(
      `UPDATE identity_accounts SET lifecycle_state = 'deleted', directory_publication_state = 'disabled'
        WHERE id = ?`,
      [pending.accountId]
    );
    await core.execute(
      `INSERT INTO account_routing_outbox (outbox_id, tenant_id, account_id, event_kind,
         route_generation, route_schema_version, hmac_key_generation, payload_json, status,
         created_at, updated_at, succeeded_at)
       VALUES ('removal-unpublished', ?, ?, 'account_deleted', 1, 1, 1, '{}', 'succeeded', 200,
         200, 200)`,
      [TENANT, pending.accountId]
    );

    const second = await signUp('user-second');

    expect(second.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));
    expect(second.userId).toBe('user-second');
  });

  it('leaves another flow and another request on their own keys', async () => {
    const first = await signUp('user-first');
    await deleteVia(DELETION_PATHS[0], first.userId);

    // Another actor's operation of the same key text is not a generation of this one.
    const other = await repository.acquire({
      tenantId: TENANT,
      actorId: 'auth:passkey',
      idempotencyKey: KEY,
      requestHash: REQUEST_HASH,
      candidateOperationId: 'operation-other',
      candidateUserId: 'user-other',
      now: 100,
    });
    expect(other.idempotencyKey).toBe(KEY);
    const second = await signUp('user-second');
    expect(second.idempotencyKey).toBe(accountCreationGenerationKey(KEY, 1));
  });
});
