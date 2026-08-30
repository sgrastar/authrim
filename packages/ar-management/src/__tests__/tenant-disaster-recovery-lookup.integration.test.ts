import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  ControlTenantDisasterRecoveryLookupProgress,
  ControlTenantDisasterRecoveryLookupWork,
  ControlTenantDisasterRecoveryTarget,
  Env,
} from '@authrim/ar-lib-core';
import { createLookupBlindIndexes } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: null as D1Database | null,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    loadVerifiedLookupBucketAssignmentProvider: vi.fn(async () => ({
      listActiveRanges: () => [
        {
          startBucket: 0,
          endBucket: 4095,
          assignmentGeneration: 1,
          lookupShardId: 'lookup-a',
          bindingRef: 'LOOKUP_A',
        },
      ],
      resolveActiveAssignment: async (virtualBucket: number) => ({
        virtualBucket,
        assignmentGeneration: 1,
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_A',
        state: 'active' as const,
      }),
    })),
  };
});

vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: vi.fn(async () => ({
    writeKeys: [{ generation: 1, secret: 'x'.repeat(32) }],
    readKeys: [{ generation: 1, secret: 'x'.repeat(32) }],
    state: {
      current: { generation: 1, keyId: 'lookup-a', slot: 'A', fingerprint: 'f'.repeat(64) },
      previous: null,
      rotationState: 'stable',
    },
  })),
}));

vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: vi.fn(async () => async () => {
    if (!mocks.lookup) throw new Error('lookup_test_binding_missing');
    return mocks.lookup;
  }),
}));

import { processTenantDisasterRecoveryLookupReprojection } from '../tenant-disaster-recovery-lookup';

type SqliteValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error(`unsupported_test_sqlite_value:${typeof value}`);
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    getBookmark() {
      return null;
    },
  };
  return {
    ...session,
    withSession() {
      return session;
    },
  } as unknown as D1Database;
}

const targets: ControlTenantDisasterRecoveryTarget[] = [
  {
    shardId: 'users-a',
    dataRole: 'tenant_core/users',
    residencyPartition: 'apac',
    assignmentGeneration: 1,
    shardGeneration: 3,
    bindingRef: 'USERS_A',
    providerDatabaseId: '11111111-1111-4111-8111-111111111111',
    migrationStreamId: 'd1-core',
    releaseId: 'test-release',
    manifestDigest: 'a'.repeat(64),
    restoreConfirmedAt: 1,
    migrationVerifiedAt: 1,
    lookupReprojectedAt: null,
    bindingSmokeVerifiedAt: null,
  },
  {
    shardId: 'pii-a',
    dataRole: 'tenant_pii',
    residencyPartition: 'apac',
    assignmentGeneration: 1,
    shardGeneration: 4,
    bindingRef: 'PII_A',
    providerDatabaseId: '22222222-2222-4222-8222-222222222222',
    migrationStreamId: 'd1-pii',
    releaseId: 'test-release',
    manifestDigest: 'b'.repeat(64),
    restoreConfirmedAt: 1,
    migrationVerifiedAt: 1,
    lookupReprojectedAt: null,
    bindingSmokeVerifiedAt: null,
  },
];

function route() {
  return {
    schemaVersion: 1,
    accountRouteGeneration: 1,
    residencyPolicyId: 'default',
    targets: [
      {
        dataRole: 'tenant_core/users' as const,
        residencyPartition: 'apac',
        shardId: 'users-a',
        bindingRef: 'USERS_A',
        requiredBindingRouteGeneration: 3,
      },
      {
        dataRole: 'tenant_pii' as const,
        residencyPartition: 'apac',
        shardId: 'pii-a',
        bindingRef: 'PII_A',
        requiredBindingRouteGeneration: 4,
      },
    ],
  };
}

async function seedSources(users: DatabaseSync, pii: DatabaseSync): Promise<void> {
  users.exec(`
    CREATE TABLE identity_accounts (
      id TEXT PRIMARY KEY, tenant_id TEXT, lifecycle_state TEXT,
      directory_publication_state TEXT, account_route_generation INTEGER, created_at INTEGER
    );
    CREATE TABLE account_routing_outbox (
      outbox_id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, event_kind TEXT,
      route_generation INTEGER, payload_json TEXT, status TEXT
    );
    CREATE TABLE passkeys (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, rp_id TEXT,
      credential_id TEXT, created_at INTEGER
    );
    CREATE TABLE anonymous_devices (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, device_id_hash TEXT,
      is_active INTEGER, created_at INTEGER
    );
  `);
  const [accountIndex] = await createLookupBlindIndexes('account_id', 'account:user-a', [
    { generation: 1, secret: 'x'.repeat(32) },
  ]);
  const publication = {
    operationId: 'account-create-a',
    tenantId: 'tenant-a',
    accountId: 'account:user-a',
    idempotencyKey: 'account-create-a',
    routeProjection: route(),
    indexes: [accountIndex],
  };
  users
    .prepare(`INSERT INTO identity_accounts VALUES (?, ?, 'active', 'active', 1, 10)`)
    .run('account:user-a', 'tenant-a');
  users
    .prepare(
      `INSERT INTO account_routing_outbox VALUES (?, ?, ?, 'account_created', 1, ?, 'succeeded')`
    )
    .run('outbox-a', 'tenant-a', 'account:user-a', JSON.stringify(publication));
  users
    .prepare(
      `INSERT INTO passkeys VALUES ('passkey-a', 'tenant-a', 'user-a', 'example.com', 'cred-a', 11)`
    )
    .run();

  pii.exec(`
    CREATE TABLE identity_sensitive_values (
      id TEXT PRIMARY KEY, tenant_id TEXT, owner_id TEXT, owner_type TEXT,
      value_key TEXT, value_json TEXT, lifecycle_state TEXT, created_at INTEGER
    );
    CREATE TABLE linked_identities (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, provider_id TEXT,
      provider_user_id TEXT, linked_at INTEGER
    );
  `);
  pii
    .prepare(
      `INSERT INTO identity_sensitive_values VALUES (
      'email-a', 'tenant-a', 'user-a', 'runtime_user', 'email', ?, 'active', 12
    )`
    )
    .run(JSON.stringify('user@example.com'));
  pii
    .prepare(
      `INSERT INTO linked_identities VALUES (
      'linked-a', 'tenant-a', 'user-a', 'https://idp.example.com', 'subject-a', 13
    )`
    )
    .run();
}

function progress(): ControlTenantDisasterRecoveryLookupProgress {
  return {
    stage: 'cleanup',
    targetIndex: 0,
    afterCreatedAt: 0,
    afterId: '',
    afterRowId: 0,
    projectedRows: 0,
    verifiedRows: 0,
    registryDigestPinned: true,
    leaseActive: false,
  };
}

describe('tenant disaster recovery Lookup reprojection', () => {
  let lookup: DatabaseSync;
  let users: DatabaseSync;
  let pii: DatabaseSync;

  beforeEach(async () => {
    lookup = new DatabaseSync(':memory:');
    users = new DatabaseSync(':memory:');
    pii = new DatabaseSync(':memory:');
    lookup.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/001_pre_1_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    await seedSources(users, pii);
    mocks.lookup = d1(lookup);
  });

  it('rebuilds account, email, passkey, and linked-subject routes with bounded checkpoints', async () => {
    const state = progress();
    let completed = false;
    let fencingToken = 0;
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'env-test',
      TENANT_RUNTIME_REGISTRY: { get: vi.fn() },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
      LOOKUP_A: mocks.lookup,
      USERS_A: d1(users),
      PII_A: d1(pii),
      CONTROL: {
        claimNextTenantDisasterRecoveryLookupReprojection: vi.fn(async (input) => {
          if (completed) return null;
          fencingToken += 1;
          return {
            operationId: 'tenant-dr-a',
            environmentId: 'env-test',
            tenantId: 'tenant-a',
            pinnedRouteGeneration: 1,
            registryDigest: input.registryDigest,
            lookupShardCount: 1,
            ownerId: input.ownerId,
            fencingToken,
            leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
            progress: { ...state, leaseActive: undefined },
            targets,
          } as unknown as ControlTenantDisasterRecoveryLookupWork;
        }),
        checkpointTenantDisasterRecoveryLookupReprojection: vi.fn(async (input) => {
          expect(input.stage).toBe(state.stage);
          state.stage = input.nextStage;
          state.targetIndex = input.targetIndex;
          state.afterCreatedAt = input.afterCreatedAt;
          state.afterId = input.afterId;
          state.afterRowId = input.afterRowId;
          state.projectedRows += input.projectedRowsDelta;
          state.verifiedRows += input.verifiedRowsDelta;
          return {} as never;
        }),
        completeTenantDisasterRecoveryLookupReprojection: vi.fn(async () => {
          completed = true;
          return {} as never;
        }),
      },
    } as unknown as Env;

    for (let attempt = 0; attempt < 40 && !completed; attempt += 1) {
      await processTenantDisasterRecoveryLookupReprojection(env);
    }
    expect(completed).toBe(true);
    expect(state.projectedRows).toBe(4);
    expect(state.verifiedRows).toBe(4);
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifiers WHERE tenant_id = 'tenant-a' AND lifecycle_state = 'active'`
        )
        .get()
    ).toEqual({ count: 4 });
    expect(
      lookup
        .prepare(
          `SELECT SUM(successful_route_publication_count) AS count
             FROM lookup_bucket_counters`
        )
        .get()
    ).toEqual({ count: 4 });
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifier_reservations WHERE tenant_id = 'tenant-a' AND reservation_state = 'committed'`
        )
        .get()
    ).toEqual({ count: 3 });
    expect(
      lookup
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifier_replacements WHERE tenant_id = 'tenant-a'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('rejects an authoritative route that points at a different physical shard', async () => {
    const row = users.prepare(`SELECT payload_json FROM account_routing_outbox`).get() as {
      payload_json: string;
    };
    const value = JSON.parse(row.payload_json) as { routeProjection: ReturnType<typeof route> };
    value.routeProjection.targets[0]!.bindingRef = 'USERS_WRONG';
    users.prepare(`UPDATE account_routing_outbox SET payload_json = ?`).run(JSON.stringify(value));

    const state = progress();
    state.stage = 'account_id';
    let fencingToken = 0;
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'env-test',
      TENANT_RUNTIME_REGISTRY: { get: vi.fn() },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
      LOOKUP_A: mocks.lookup,
      USERS_A: d1(users),
      PII_A: d1(pii),
      CONTROL: {
        claimNextTenantDisasterRecoveryLookupReprojection: vi.fn(async (input) => ({
          operationId: 'tenant-dr-wrong',
          environmentId: 'env-test',
          tenantId: 'tenant-a',
          pinnedRouteGeneration: 1,
          registryDigest: input.registryDigest,
          lookupShardCount: 1,
          ownerId: input.ownerId,
          fencingToken: ++fencingToken,
          leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
          progress: { ...state, leaseActive: undefined },
          targets,
        })),
      },
    } as unknown as Env;
    await expect(processTenantDisasterRecoveryLookupReprojection(env)).rejects.toThrow(
      'tenant_dr_lookup_route_mismatch'
    );
  });
});
