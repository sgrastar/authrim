import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  createLookupBlindIndex,
  ensureDatabaseAdapter,
  signLookupShardRegistry,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutingOutboxProcessor } from '../directory-scheduled';
import { AccountCreationOperationRepository } from '../account-creation-operation';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Math.floor(Date.now() / 1000);
const HMAC_KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };

function sqlValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_sqlite_test_value');
  });
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class UnboundStatement {
  constructor(
    private readonly sql: string,
    private readonly database: DatabaseSync
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.database.prepare(this.sql), sqlValues(values));
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  private prepare(sql: string): UnboundStatement {
    return new UnboundStatement(sql, this.database);
  }

  readonly binding = {
    prepare: (sql: string) => this.prepare(sql),
    batch: async (statements: unknown[]) => this.batch(statements),
    exec: async (sql: string) => {
      this.database.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession: (_constraint: string) => this.session(),
  } as unknown as D1Database;

  private session(): D1DatabaseSession {
    return {
      prepare: (sql: string) => this.prepare(sql),
      batch: async (statements: unknown[]) => this.batch(statements),
      getBookmark: () => 'test-bookmark',
    } as unknown as D1DatabaseSession;
  }

  private async batch(statements: unknown[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
        return statement.executeRun();
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

async function publication(userId = 'user-a'): Promise<AccountDirectoryPublication> {
  const accountId = `account:${userId}`;
  return {
    operationId: 'operation-account-a',
    tenantId: 'tenant-a',
    accountId,
    idempotencyKey: `account-create:${'a'.repeat(64)}`,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          requiredBindingRouteGeneration: 3,
        },
        {
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: 'pii-1',
          bindingRef: 'TDB_PII_1',
          requiredBindingRouteGeneration: 3,
        },
      ],
    },
    indexes: [
      await createLookupBlindIndex('account_id', accountId, HMAC_KEY),
      await createLookupBlindIndex('email_exact', 'person@example.com', HMAC_KEY),
    ],
  };
}

describe('directory routing outbox processor', () => {
  let tenantDatabase: DatabaseSync;
  let lookupDatabase: DatabaseSync;
  let tenant: SqliteD1;
  let lookup: SqliteD1;
  let value: AccountDirectoryPublication;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let registry: Map<string, string>;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'lookup-test-key', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'lookup-test-key', alg: 'EdDSA' };
  });

  beforeEach(async () => {
    tenantDatabase = new DatabaseSync(':memory:');
    lookupDatabase = new DatabaseSync(':memory:');
    tenantDatabase.exec(
      `PRAGMA foreign_keys = ON;
       CREATE TABLE identity_accounts (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL,
         created_at INTEGER NOT NULL
       );
       CREATE TABLE webhook_configs (
         tenant_id TEXT NOT NULL,
         active INTEGER NOT NULL,
         scope TEXT NOT NULL
       );
       INSERT INTO identity_accounts (id, tenant_id, created_at)
       VALUES ('account:user-a', 'tenant-a', ${NOW});`
    );
    tenantDatabase.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/032_tenant_directory_and_plugin_outboxes.sql'),
        'utf8'
      )
    );
    tenantDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/036_account_lifecycle_event_outbox.sql'), 'utf8')
    );
    lookupDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/001_lookup_directory.sql'), 'utf8')
    );
    tenant = new SqliteD1(tenantDatabase);
    lookup = new SqliteD1(lookupDatabase);
    value = await publication();
    const token = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 1,
        issuedAt: NOW - 60,
        expiresAt: NOW + 3600,
        ranges: [
          {
            startBucket: 0,
            endBucket: 4095,
            assignmentGeneration: 1,
            lookupShardId: 'lookup-1',
            bindingRef: 'LOOKUP_DB_1',
          },
        ],
      },
      privateJwk,
    });
    registry = new Map([
      [buildLookupShardRegistrySnapshotKey('test'), token],
      [buildLookupShardRegistryGenerationKey('test'), '1'],
    ]);
  });

  afterEach(() => {
    tenantDatabase.close();
    lookupDatabase.close();
  });

  function insertOutbox(
    payload: unknown = value,
    options: { status?: string; attemptCount?: number; createdAt?: number } = {}
  ): void {
    const userId = value.accountId.slice('account:'.length);
    tenantDatabase
      .prepare(
        `INSERT INTO account_creation_operations (
           operation_id, tenant_id, actor_id, idempotency_key,
           allocation_idempotency_key, request_hash, user_id, account_id,
           status, publication_json, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'admin-a', 'source-request-a', ?, ?, ?,
                   ?, 'writing', ?, ?, ?)`
      )
      .run(
        value.operationId,
        value.idempotencyKey,
        'b'.repeat(64),
        userId,
        value.accountId,
        JSON.stringify(value),
        options.createdAt ?? NOW,
        NOW
      );
    tenantDatabase
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at
         ) VALUES (?, 'tenant-a', ?, 'account_created', 1, 1, 1, ?, ?, ?, ?, ?)`
      )
      .run(
        'account-routing:operation-account-a',
        value.accountId,
        JSON.stringify(payload),
        options.status ?? 'pending',
        options.attemptCount ?? 0,
        options.createdAt ?? NOW,
        NOW
      );
  }

  function insertIdentifierReservation(): void {
    const email = value.indexes.find((index) => index.indexKind === 'email_exact');
    if (!email) throw new Error('missing_test_email_index');
    lookupDatabase
      .prepare(
        `INSERT INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, lease_expires_at, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'email_exact', ?, ?, ?, 'account:user-a',
                   'reserved', 'operation-account-a', ?, ?, ?)`
      )
      .run(
        email.virtualBucket,
        email.normalizationVersion,
        email.hmacKeyGeneration,
        email.digest,
        NOW + 7200,
        NOW,
        NOW
      );
  }

  function env(options: { includeLookup?: boolean } = {}): Env {
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      CONTROL: {
        listAccountDirectorySourceShards: vi.fn(async () => [
          {
            shardId: 'users-1',
            bindingRef: 'TDB_USERS_1',
            residencyPartition: 'default',
            routeGeneration: 3,
          },
        ]),
      },
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      TDB_USERS_1: tenant.binding,
      ...(options.includeLookup === false ? {} : { LOOKUP_DB_1: lookup.binding }),
    } as unknown as Env;
  }

  function operationRepository(): AccountCreationOperationRepository {
    return new AccountCreationOperationRepository(
      ensureDatabaseAdapter(tenant.binding, 'directory-routing-operation-test')
    );
  }

  async function run(workerEnv: Env, cursor: Record<string, unknown> = {}) {
    return createRoutingOutboxProcessor(workerEnv, {
      operationRepositoryForTenant: async () => operationRepository(),
    })({
      adapter: {} as DatabaseAdapter,
      jobClass: 'routing_outbox',
      cursor,
      rowLimit: 100,
      deadlineMs: (NOW + 10) * 1000,
      ownerId: 'directory-owner',
      fencingToken: 1,
      nowMs: () => NOW * 1000,
    });
  }

  it('updates the operation fixture through the D1 adapter boundary', async () => {
    insertOutbox();
    const operation = await operationRepository().findForPublication(value);
    expect(operation?.status).toBe('writing');

    await expect(
      operationRepository().recordDirectoryOutcome({
        publication: value,
        outcome: 'succeeded',
        now: NOW,
      })
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('snapshots plugin targets and expands a durable activation event idempotently', async () => {
    insertOutbox();
    await operationRepository().recordDirectoryOutcome({
      publication: value,
      outcome: 'succeeded',
      now: NOW,
    });
    const resolveAccountEventInstallations = vi.fn(async () => [
      { installationId: 'installation-a', capability: 'hook.account.lifecycle' as const },
    ]);
    const settings = new Map<string, string>();
    const workerEnv = env() as Env & Record<string, unknown>;
    workerEnv.PLUGIN_RUNNER = {
      resolveAccountEventInstallations,
    } as unknown as Env['PLUGIN_RUNNER'];
    workerEnv.SETTINGS = {
      get: async (key: string) => settings.get(key) ?? null,
      put: async (key: string, value: string) => {
        settings.set(key, value);
      },
    } as unknown as Env['SETTINGS'];

    const processor = createRoutingOutboxProcessor(workerEnv, {
      operationRepositoryForTenant: async () => operationRepository(),
    });
    const invoke = () =>
      processor({
        adapter: {} as DatabaseAdapter,
        jobClass: 'routing_outbox',
        cursor: {},
        rowLimit: 1,
        deadlineMs: (NOW + 10) * 1000,
        ownerId: 'directory-owner',
        fencingToken: 1,
        nowMs: () => NOW * 1000,
      });

    await expect(invoke()).resolves.toMatchObject({ processedRows: 1 });
    expect(resolveAccountEventInstallations).toHaveBeenCalledTimes(1);
    expect(
      tenantDatabase
        .prepare(`SELECT status, plugin_targets_json FROM account_lifecycle_event_outbox LIMIT 1`)
        .get()
    ).toEqual({
      status: 'succeeded',
      plugin_targets_json: JSON.stringify([
        { installationId: 'installation-a', capability: 'hook.account.lifecycle' },
      ]),
    });
    expect(
      tenantDatabase
        .prepare(
          `SELECT tenant_id, plugin_installation_id, capability, event_type, status
             FROM plugin_hook_outbox`
        )
        .all()
    ).toEqual([
      {
        tenant_id: 'tenant-a',
        plugin_installation_id: 'installation-a',
        capability: 'hook.account.lifecycle',
        event_type: 'account.created',
        status: 'queued',
      },
    ]);

    tenantDatabase
      .prepare(
        `UPDATE account_routing_outbox
            SET status = 'succeeded', succeeded_at = ?, updated_at = ?
          WHERE outbox_id = 'account-routing:operation-account-a'`
      )
      .run(NOW, NOW);
    await expect(invoke()).resolves.toMatchObject({ processedRows: 0 });
    expect(resolveAccountEventInstallations).toHaveBeenCalledTimes(1);
    expect(
      tenantDatabase.prepare(`SELECT COUNT(*) AS count FROM plugin_hook_outbox`).get()
    ).toEqual({ count: 1 });
  });

  it('processes a lifecycle event for a canonical symbol-prefixed NanoID', async () => {
    const userId = `-${'a'.repeat(20)}`;
    value = await publication(userId);
    tenantDatabase
      .prepare(`INSERT INTO identity_accounts (id, tenant_id, created_at) VALUES (?, ?, ?)`)
      .run(value.accountId, value.tenantId, NOW);
    insertOutbox();
    tenantDatabase
      .prepare(
        `UPDATE account_routing_outbox
            SET status = 'succeeded', succeeded_at = ?, updated_at = ?
          WHERE outbox_id = 'account-routing:operation-account-a'`
      )
      .run(NOW, NOW);
    await operationRepository().recordDirectoryOutcome({
      publication: value,
      outcome: 'succeeded',
      now: NOW,
    });
    const workerEnv = env() as Env & Record<string, unknown>;
    workerEnv.PLUGIN_RUNNER = {
      resolveAccountEventInstallations: vi.fn(async () => []),
    } as unknown as Env['PLUGIN_RUNNER'];
    const settings = new Map<string, string>();
    workerEnv.SETTINGS = {
      get: async (key: string) => settings.get(key) ?? null,
      put: async (key: string, value: string) => {
        settings.set(key, value);
      },
    } as unknown as Env['SETTINGS'];

    await expect(run(workerEnv)).resolves.toMatchObject({ processedRows: 1 });
    expect(
      tenantDatabase
        .prepare(`SELECT status, payload_json FROM account_lifecycle_event_outbox LIMIT 1`)
        .get()
    ).toEqual({
      status: 'succeeded',
      payload_json: JSON.stringify({
        tenantId: value.tenantId,
        accountId: value.accountId,
        userId,
        eventType: 'account.created',
        eventVersion: 1,
      }),
    });
  });

  it('claims and publishes a due row, activating the account last', async () => {
    insertOutbox();
    insertIdentifierReservation();

    await expect(run(env())).resolves.toEqual({
      cursor: { after_shard_id: 'users-1' },
      processedRows: 1,
    });
    expect(
      tenantDatabase
        .prepare(
          `SELECT directory_publication_state FROM identity_accounts WHERE id = 'account:user-a'`
        )
        .get()
    ).toEqual({ directory_publication_state: 'active' });
    expect(
      tenantDatabase
        .prepare(`SELECT status, last_error_code FROM account_creation_operations`)
        .get()
    ).toEqual({ status: 'succeeded', last_error_code: null });
    expect(
      tenantDatabase
        .prepare(`SELECT status, attempt_count, lease_owner FROM account_routing_outbox`)
        .get()
    ).toEqual({ status: 'succeeded', attempt_count: 1, lease_owner: null });
  });

  it('claims identifier_added without requiring a second account-creation operation', async () => {
    insertOutbox();
    insertIdentifierReservation();
    await run(env());

    const accountIndex = value.indexes.find((index) => index.indexKind === 'account_id');
    if (!accountIndex) throw new Error('missing_test_account_index');
    const credentialIndex = await createLookupBlindIndex(
      'external_subject',
      { issuer: 'urn:authrim:passkey:example.com', subject: 'credential-a' },
      HMAC_KEY
    );
    const addition: AccountDirectoryPublication = {
      ...value,
      operationId: 'passkey-route-passkey-a',
      idempotencyKey: `auth-passkey-route:${'c'.repeat(64)}`,
      indexes: [accountIndex, credentialIndex],
    };
    lookupDatabase
      .prepare(
        `INSERT INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, lease_expires_at, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'external_subject', ?, ?, ?, 'account:user-a',
                   'reserved', ?, ?, ?, ?)`
      )
      .run(
        credentialIndex.virtualBucket,
        credentialIndex.normalizationVersion,
        credentialIndex.hmacKeyGeneration,
        credentialIndex.digest,
        addition.operationId,
        NOW + 7200,
        NOW,
        NOW
      );
    tenantDatabase
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'account:user-a', 'identifier_added', 1, 1, 1,
                   ?, 'pending', 0, ?, ?)`
      )
      .run('account-routing:passkey-route-passkey-a', JSON.stringify(addition), NOW + 1, NOW + 1);

    await expect(run(env())).resolves.toMatchObject({ processedRows: 2 });
    expect(
      tenantDatabase
        .prepare(
          `SELECT status FROM account_routing_outbox
            WHERE outbox_id = 'account-routing:passkey-route-passkey-a'`
        )
        .get()
    ).toEqual({ status: 'succeeded' });
    expect(
      lookupDatabase
        .prepare(
          `SELECT lifecycle_state FROM lookup_identifiers
            WHERE index_kind = 'external_subject' AND identifier_blind_digest = ?`
        )
        .get(credentialIndex.digest)
    ).toEqual({ lifecycle_state: 'active' });
  });

  it('stores only a fixed retry code and backoff for transient failures', async () => {
    insertOutbox();

    await expect(run(env({ includeLookup: false }))).resolves.toMatchObject({ processedRows: 1 });
    expect(
      tenantDatabase
        .prepare(
          `SELECT status, last_error_code, next_attempt_at > ${NOW} AS has_backoff,
                  lease_owner FROM account_routing_outbox`
        )
        .get()
    ).toEqual({
      status: 'retry',
      last_error_code: 'directory_routing_retryable',
      has_backoff: 1,
      lease_owner: null,
    });
  });

  it('blocks a failed row after the two-hour retry budget', async () => {
    insertOutbox(value, { createdAt: NOW - 7200 });

    await expect(run(env({ includeLookup: false }))).resolves.toMatchObject({ processedRows: 1 });
    expect(
      tenantDatabase
        .prepare(`SELECT status, last_error_code, next_attempt_at FROM account_routing_outbox`)
        .get()
    ).toEqual({
      status: 'blocked',
      last_error_code: 'directory_routing_retry_budget_exhausted',
      next_attempt_at: null,
    });
    expect(
      lookupDatabase.prepare(`SELECT COUNT(*) AS count FROM lookup_identifiers`).get()
    ).toEqual({ count: 0 });
    expect(
      tenantDatabase
        .prepare(`SELECT status, last_error_code FROM account_creation_operations`)
        .get()
    ).toEqual({
      status: 'blocked',
      last_error_code: 'directory_routing_retry_budget_exhausted',
    });
  });

  it('blocks a payload containing an unexpected raw email without touching Lookup', async () => {
    insertOutbox({ ...value, rawEmail: 'person@example.com' });

    await expect(run(env())).resolves.toMatchObject({ processedRows: 1 });
    expect(
      tenantDatabase.prepare(`SELECT status, last_error_code FROM account_routing_outbox`).get()
    ).toEqual({ status: 'blocked', last_error_code: 'directory_routing_invalid' });
    expect(
      lookupDatabase.prepare(`SELECT COUNT(*) AS count FROM lookup_identifiers`).get()
    ).toEqual({ count: 0 });
    expect(
      tenantDatabase
        .prepare(`SELECT status, last_error_code FROM account_creation_operations`)
        .get()
    ).toEqual({ status: 'blocked', last_error_code: 'directory_routing_invalid' });
  });

  it('takes over an expired lease using the incremented attempt as its fencing token', async () => {
    insertOutbox(value, { status: 'leased', attemptCount: 4 });
    insertIdentifierReservation();
    tenantDatabase.exec(
      `UPDATE account_routing_outbox
          SET lease_owner = 'expired-owner', lease_expires_at = ${NOW - 1}`
    );

    await expect(run(env())).resolves.toMatchObject({ processedRows: 1 });
    expect(
      tenantDatabase.prepare(`SELECT status, attempt_count FROM account_routing_outbox`).get()
    ).toEqual({ status: 'succeeded', attempt_count: 5 });
  });

  it('leaves an unexpired lease untouched and passes the source-shard cursor to Control', async () => {
    insertOutbox(value, { status: 'leased', attemptCount: 2 });
    tenantDatabase.exec(
      `UPDATE account_routing_outbox
          SET lease_owner = 'current-owner', lease_expires_at = ${NOW + 60}`
    );
    const workerEnv = env();

    await expect(run(workerEnv, { after_shard_id: 'users-0' })).resolves.toEqual({
      cursor: { after_shard_id: 'users-1' },
      processedRows: 0,
    });
    expect(workerEnv.CONTROL?.listAccountDirectorySourceShards).toHaveBeenCalledWith({
      afterShardId: 'users-0',
      limit: 1,
    });
    expect(
      tenantDatabase
        .prepare(`SELECT status, attempt_count, lease_owner FROM account_routing_outbox`)
        .get()
    ).toEqual({ status: 'leased', attempt_count: 2, lease_owner: 'current-owner' });
  });
});
