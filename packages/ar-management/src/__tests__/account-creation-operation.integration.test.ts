import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createLookupBlindIndex,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type ExecuteResult,
  type HealthStatus,
  type PreparedStatement,
  type QueryOptions,
  type TransactionContext,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountCreationOperationRepository,
  hashAccountCreationRequest,
} from '../account-creation-operation';

type SqliteValue = string | number | bigint | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LOOKUP_KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };

function values(input: readonly unknown[] = []): SqliteValue[] {
  return input.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError('unsupported SQLite value');
  });
}

class SqliteAdapter implements DatabaseAdapter {
  readonly queryOptions: Array<QueryOptions | undefined> = [];

  constructor(private readonly database: DatabaseSync) {}

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return this.database.prepare(sql).all(...values(params)) as T[];
  }

  async queryOne<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T | null> {
    this.queryOptions.push(options);
    return (this.database.prepare(sql).get(...values(params)) as T | undefined) ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const result = this.database.prepare(sql).run(...values(params));
    return { success: true, rowsAffected: Number(result.changes) };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn({
        query: (sql, params) => this.query(sql, params),
        queryOne: (sql, params) => this.queryOne(sql, params),
        execute: (sql, params) => this.execute(sql, params),
      });
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return Promise.all(statements.map(({ sql, params }) => this.execute(sql, params)));
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'sqlite-test' };
  }

  getType(): string {
    return 'sqlite-test';
  }

  async close(): Promise<void> {}
}

class OutcomeRaceAdapter extends SqliteAdapter {
  private raced = false;

  constructor(
    database: DatabaseSync,
    private readonly race: () => void
  ) {
    super(database);
  }

  override async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    if (!this.raced && sql.includes(`SET status = 'succeeded'`)) {
      this.raced = true;
      this.race();
    }
    return super.execute(sql, params);
  }
}

async function publication(input: {
  operationId: string;
  accountId: string;
  idempotencyKey: string;
}): Promise<AccountDirectoryPublication> {
  return {
    operationId: input.operationId,
    tenantId: 'tenant-a',
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
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
    indexes: [await createLookupBlindIndex('account_id', input.accountId, LOOKUP_KEY)],
  };
}

describe('account creation operation repository', () => {
  let database: DatabaseSync;
  let adapter: SqliteAdapter;
  let repository: AccountCreationOperationRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/001_pre_1_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    adapter = new SqliteAdapter(database);
    repository = new AccountCreationOperationRepository(adapter);
  });

  afterEach(() => database.close());

  const acquire = (overrides: Record<string, unknown> = {}) =>
    repository.acquire({
      tenantId: 'tenant-a',
      actorId: 'admin-a',
      idempotencyKey: 'account-create-key-a',
      requestHash: 'a'.repeat(64),
      candidateOperationId: 'operation-a',
      candidateUserId: 'user-a',
      now: 100,
      ...overrides,
    });

  it('reads operation state from the primary consistency path', async () => {
    await acquire();
    adapter.queryOptions.length = 0;

    await repository.findForActor({
      tenantId: 'tenant-a',
      actorId: 'admin-a',
      operationId: 'operation-a',
    });

    expect(adapter.queryOptions).toEqual([{ consistencyClass: 'primary_required' }]);
  });

  it('adopts the first operation and account identity for an exact retry', async () => {
    const first = await acquire();
    const second = await acquire({
      candidateOperationId: 'operation-loser',
      candidateUserId: 'user-loser',
      now: 101,
    });
    expect(second).toEqual(first);
    expect(first.accountId).toBe('account:user-a');
    expect(first.allocationIdempotencyKey).toMatch(/^account-create:[a-f0-9]{64}$/u);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM account_creation_operations`).get()
    ).toEqual({ count: 1 });
  });

  it.each(['_'.repeat(21), `-${'a'.repeat(20)}`])(
    'persists a canonical NanoID beginning with a URL-safe symbol: %s',
    async (candidateUserId) => {
      const operation = await acquire({ candidateUserId });

      expect(operation.userId).toBe(candidateUserId);
      expect(operation.accountId).toBe(`account:${candidateUserId}`);
    }
  );

  it('rejects a non-canonical symbol-prefixed user ID', async () => {
    await expect(acquire({ candidateUserId: '_not-a-canonical-nanoid' })).rejects.toThrow(
      'account_creation_user_id_invalid'
    );
  });

  it('rejects reuse of an idempotency key with a different request', async () => {
    await acquire();
    await expect(acquire({ requestHash: 'b'.repeat(64) })).rejects.toThrow(
      'account_creation_operation_idempotency_conflict'
    );
  });

  it('persists only the exact blind publication and adopts response-loss retries', async () => {
    const operation = await acquire();
    const value = await publication({
      operationId: operation.operationId,
      accountId: operation.accountId,
      idempotencyKey: operation.allocationIdempotencyKey,
    });
    const recorded = await repository.recordPublication(operation, value, 101);
    await expect(repository.recordPublication(operation, value, 102)).resolves.toEqual(recorded);
    const stored = database
      .prepare(`SELECT publication_json FROM account_creation_operations`)
      .get() as { publication_json: string };
    expect(stored.publication_json).not.toContain('@');
    expect(JSON.parse(stored.publication_json)).toEqual(value);
  });

  it('rejects a publication belonging to another operation', async () => {
    const operation = await acquire();
    await expect(
      repository.recordPublication(
        operation,
        await publication({
          operationId: 'operation-other',
          accountId: operation.accountId,
          idempotencyKey: operation.allocationIdempotencyKey,
        }),
        101
      )
    ).rejects.toThrow('account_creation_operation_publication_mismatch');
  });

  it('advances the durable state machine and adopts an already-applied transition', async () => {
    const preparing = await acquire();
    const reserved = await repository.transition(preparing, 'reserved', 101);
    const adopted = await repository.transition(preparing, 'reserved', 102);
    expect(adopted.status).toBe('reserved');
    const writing = await repository.transition(reserved, 'writing', 103);
    const pending = await repository.transition(writing, 'directory_pending', 104);
    const succeeded = await repository.transition(pending, 'succeeded', 105);
    expect(succeeded.status).toBe('succeeded');
    expect(
      database.prepare(`SELECT status, completed_at FROM account_creation_operations`).get()
    ).toEqual({ status: 'succeeded', completed_at: 105 });
  });

  it('reads operation status only for the owning tenant and actor', async () => {
    const operation = await acquire();

    await expect(
      repository.findForActor({
        tenantId: operation.tenantId,
        actorId: operation.actorId,
        operationId: operation.operationId,
      })
    ).resolves.toEqual(operation);
    await expect(
      repository.findForActor({
        tenantId: operation.tenantId,
        actorId: 'admin-other',
        operationId: operation.operationId,
      })
    ).resolves.toBeNull();
    await expect(
      repository.findForActor({
        tenantId: 'tenant-other',
        actorId: operation.actorId,
        operationId: operation.operationId,
      })
    ).resolves.toBeNull();
  });

  it('records a coordinator success idempotently against the exact publication', async () => {
    const preparing = await acquire();
    const value = await publication({
      operationId: preparing.operationId,
      accountId: preparing.accountId,
      idempotencyKey: preparing.allocationIdempotencyKey,
    });
    const recorded = await repository.recordPublication(preparing, value, 101);
    const reserved = await repository.transition(recorded, 'reserved', 102);
    await repository.transition(reserved, 'writing', 103);
    database
      .prepare(
        `INSERT INTO identity_accounts (id, tenant_id, account_type, created_at, updated_at)
         VALUES (?, ?, 'person', ?, ?)`
      )
      .run(preparing.accountId, preparing.tenantId, 103, 103);

    const succeeded = await repository.recordDirectoryOutcome({
      publication: value,
      outcome: 'succeeded',
      now: 104,
    });

    expect(succeeded.status).toBe('succeeded');
    expect(
      database
        .prepare(
          `SELECT tenant_id, account_id, operation_id, event_type, status
             FROM account_lifecycle_event_outbox`
        )
        .get()
    ).toEqual({
      tenant_id: preparing.tenantId,
      account_id: preparing.accountId,
      operation_id: preparing.operationId,
      event_type: 'account.created',
      status: 'pending',
    });
    await expect(
      repository.recordDirectoryOutcome({
        publication: value,
        outcome: 'succeeded',
        now: 105,
      })
    ).resolves.toEqual(succeeded);
  });

  it('completes the operation and emits the lifecycle event across split core shards', async () => {
    const usersDatabase = new DatabaseSync(':memory:');
    usersDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/001_pre_1_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    try {
      const preparing = await acquire({
        candidateOperationId: 'operation-split',
        candidateUserId: 'user-split',
        idempotencyKey: 'account-create-key-split',
      });
      const value = await publication({
        operationId: preparing.operationId,
        accountId: preparing.accountId,
        idempotencyKey: preparing.allocationIdempotencyKey,
      });
      const recorded = await repository.recordPublication(preparing, value, 101);
      const reserved = await repository.transition(recorded, 'reserved', 102);
      const writing = await repository.transition(reserved, 'writing', 103);
      await repository.transition(writing, 'directory_pending', 104);
      usersDatabase
        .prepare(
          `INSERT INTO identity_accounts (id, tenant_id, account_type, created_at, updated_at)
           VALUES (?, ?, 'person', ?, ?)`
        )
        .run(preparing.accountId, preparing.tenantId, 103, 103);
      const lifecycleEventAdapter = new SqliteAdapter(usersDatabase);

      const succeeded = await repository.recordDirectoryOutcome({
        publication: value,
        outcome: 'succeeded',
        now: 105,
        lifecycleEventAdapter,
      });

      expect(succeeded.status).toBe('succeeded');
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM account_lifecycle_event_outbox`).get()
      ).toEqual({ count: 0 });
      expect(
        usersDatabase
          .prepare(
            `SELECT tenant_id, account_id, operation_id, status
               FROM account_lifecycle_event_outbox`
          )
          .get()
      ).toEqual({
        tenant_id: preparing.tenantId,
        account_id: preparing.accountId,
        operation_id: preparing.operationId,
        status: 'pending',
      });
      await expect(
        repository.recordDirectoryOutcome({
          publication: value,
          outcome: 'succeeded',
          now: 106,
          lifecycleEventAdapter,
        })
      ).resolves.toEqual(succeeded);
    } finally {
      usersDatabase.close();
    }
  });

  it('keeps only the shard-local account foreign key after migration 041', () => {
    const foreignKeys = database
      .prepare(`PRAGMA foreign_key_list(account_lifecycle_event_outbox)`)
      .all() as Array<{ from: string; table: string }>;
    expect(foreignKeys).toEqual([
      expect.objectContaining({ from: 'account_id', table: 'identity_accounts' }),
    ]);
  });

  it('does not create a lifecycle event when a concurrent block wins completion', async () => {
    const preparing = await acquire();
    const value = await publication({
      operationId: preparing.operationId,
      accountId: preparing.accountId,
      idempotencyKey: preparing.allocationIdempotencyKey,
    });
    const recorded = await repository.recordPublication(preparing, value, 101);
    const reserved = await repository.transition(recorded, 'reserved', 102);
    const writing = await repository.transition(reserved, 'writing', 103);
    await repository.transition(writing, 'directory_pending', 104);
    database
      .prepare(
        `INSERT INTO identity_accounts (id, tenant_id, account_type, created_at, updated_at)
         VALUES (?, ?, 'person', ?, ?)`
      )
      .run(preparing.accountId, preparing.tenantId, 103, 103);

    const racingRepository = new AccountCreationOperationRepository(
      new OutcomeRaceAdapter(database, () => {
        database
          .prepare(
            `UPDATE account_creation_operations
                SET status = 'blocked', last_error_code = 'directory_routing_blocked', updated_at = 105
              WHERE operation_id = ? AND status = 'directory_pending'`
          )
          .run(preparing.operationId);
      })
    );

    await expect(
      racingRepository.recordDirectoryOutcome({
        publication: value,
        outcome: 'succeeded',
        now: 106,
      })
    ).rejects.toThrow('account_creation_operation_transition_conflict');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM account_lifecycle_event_outbox`).get()
    ).toEqual({ count: 0 });
  });

  it('rejects a coordinator outcome for a mismatched publication', async () => {
    const operation = await acquire();
    const value = await publication({
      operationId: operation.operationId,
      accountId: operation.accountId,
      idempotencyKey: operation.allocationIdempotencyKey,
    });
    await repository.recordPublication(operation, value, 101);

    await expect(
      repository.recordDirectoryOutcome({
        publication: {
          ...value,
          routeProjection: { ...value.routeProjection, accountRouteGeneration: 2 },
        },
        outcome: 'succeeded',
        now: 102,
      })
    ).rejects.toThrow('account_creation_operation_publication_mismatch');
  });

  it('rejects a transition that skips identifier reservation', async () => {
    await expect(repository.transition(await acquire(), 'writing', 101)).rejects.toThrow(
      'invalid_account_creation_operation_status_transition'
    );
  });

  it('hashes semantically identical request objects independently of key order', async () => {
    await expect(
      hashAccountCreationRequest({ email: 'person@example.test', profile: { name: 'Person' } })
    ).resolves.toBe(
      await hashAccountCreationRequest({
        profile: { name: 'Person' },
        email: 'person@example.test',
      })
    );
  });

  it('rejects unsupported request values before creating an operation', async () => {
    await expect(hashAccountCreationRequest({ count: Number.POSITIVE_INFINITY })).rejects.toThrow(
      'account_creation_request_value_invalid'
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(hashAccountCreationRequest(cyclic)).rejects.toThrow(
      'account_creation_request_value_invalid'
    );
  });
});
