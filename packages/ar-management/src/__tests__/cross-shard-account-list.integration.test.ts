// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  createLookupBlindIndex,
  fingerprintLookupHmacKey,
  lookupVirtualBucket,
  signLookupShardRegistry,
  signLookupHmacKeyState,
  type AccountDirectoryPublication,
  type Env,
} from '@authrim/ar-lib-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveTenantAssignedDatabaseSourcesFromRegistry = vi.hoisted(() =>
  vi.fn(async (env: any, input: { dataRole: string }) => {
    const shards =
      input.dataRole === 'tenant_pii'
        ? await env.CONTROL.listAccountRouteSourceShards()
        : await env.CONTROL.listAccountDirectorySourceShards();
    return shards.map((shard: any) => ({
      tenantId: 'tenant-a',
      dataRole: input.dataRole,
      shardId: shard.shardId,
      bindingRef: shard.bindingRef,
      residencyPartition: shard.residencyPartition,
      bindingRouteGeneration: shard.routeGeneration,
      source: env[shard.bindingRef],
    }));
  })
);

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantAssignedDatabaseSourcesFromRegistry,
  };
});

import {
  CrossShardAccountExactSearchService,
  CrossShardAccountListService,
} from '../cross-shard-account-list';
import { resetLookupHmacRuntimeKeyCacheForTest } from '../lookup-hmac-runtime';

type SqlValue = string | number | null;

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    getBookmark: () => 'test-bookmark',
  } as unknown as D1DatabaseSession;
  return {
    prepare: session.prepare,
    batch: async () => [],
    withSession: (_constraint: string) => session,
  } as unknown as D1Database;
}

async function insertAccount(
  database: DatabaseSync,
  id: string,
  createdAt: number,
  options: {
    tenantId?: string;
    publicationState?: string;
    accountType?: string;
    lifecycleState?: string;
    coreShardId?: string;
    coreBindingRef?: string;
    coreRouteGeneration?: number;
    piiShardId?: string;
    piiBindingRef?: string;
    piiRouteGeneration?: number;
    lastLoginAt?: number;
  } = {}
): Promise<void> {
  const tenantId = options.tenantId ?? 'tenant-a';
  const publicationState = options.publicationState ?? 'active';
  const digest = 'a'.repeat(64);
  const publication: AccountDirectoryPublication = {
    operationId: `operation:${id}`,
    tenantId,
    accountId: id,
    idempotencyKey: `idempotency:${id}`,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: options.coreShardId ?? 'users-a',
          bindingRef: options.coreBindingRef ?? 'TDB_USERS_A',
          requiredBindingRouteGeneration: options.coreRouteGeneration ?? 3,
        },
        {
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: options.piiShardId ?? 'pii-a',
          bindingRef: options.piiBindingRef ?? 'TDB_PII_A',
          requiredBindingRouteGeneration: options.piiRouteGeneration ?? 5,
        },
      ],
    },
    indexes: [
      {
        indexKind: 'account_id',
        normalizationVersion: 1,
        hmacKeyGeneration: 1,
        digest,
        virtualBucket: await lookupVirtualBucket('account_id', digest),
      },
    ],
  };
  database
    .prepare(
      `INSERT INTO identity_accounts (
         id, legacy_user_id, tenant_id, account_type, lifecycle_state, display_label, created_at,
         directory_publication_state, account_route_generation, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      id,
      `user-${id}`,
      tenantId,
      options.accountType ?? 'user',
      options.lifecycleState ?? 'active',
      `Account ${id}`,
      createdAt,
      publicationState,
      JSON.stringify(
        options.lastLoginAt === undefined ? {} : { last_login_at: options.lastLoginAt }
      )
    );
  database
    .prepare(
      `INSERT INTO account_routing_outbox (
         outbox_id, tenant_id, account_id, event_kind, route_generation, payload_json, status
       ) VALUES (?, ?, ?, 'account_created', 1, ?, ?)`
    )
    .run(
      `outbox:${id}`,
      tenantId,
      id,
      JSON.stringify(publication),
      publicationState === 'active' ? 'succeeded' : 'prepared'
    );
}

describe('CrossShardAccountListService', () => {
  let shardA: DatabaseSync;
  let shardB: DatabaseSync;
  let lookup: DatabaseSync;
  let privateJwk: JWK;
  let publicJwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'search-registry-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'search-registry-a', alg: 'EdDSA' };
  });

  beforeEach(async () => {
    resetLookupHmacRuntimeKeyCacheForTest();
    shardA = new DatabaseSync(':memory:');
    shardB = new DatabaseSync(':memory:');
    lookup = new DatabaseSync(':memory:');
    for (const database of [shardA, shardB]) {
      database.exec(
        `CREATE TABLE identity_accounts (
           id TEXT PRIMARY KEY,
           legacy_user_id TEXT NOT NULL,
           tenant_id TEXT NOT NULL,
           account_type TEXT NOT NULL,
           lifecycle_state TEXT NOT NULL,
           display_label TEXT,
           created_at INTEGER NOT NULL,
           directory_publication_state TEXT NOT NULL,
           account_route_generation INTEGER NOT NULL,
           metadata_json TEXT
         );
         CREATE TABLE account_routing_outbox (
           outbox_id TEXT PRIMARY KEY,
           tenant_id TEXT NOT NULL,
           account_id TEXT NOT NULL,
           event_kind TEXT NOT NULL,
           route_generation INTEGER NOT NULL,
           payload_json TEXT NOT NULL,
           status TEXT NOT NULL
         );`
      );
    }
    shardA.exec(
      `CREATE TABLE identity_sensitive_values (
         tenant_id TEXT NOT NULL,
         owner_type TEXT NOT NULL,
         owner_id TEXT NOT NULL,
         value_key TEXT NOT NULL,
         value_json TEXT,
         lifecycle_state TEXT NOT NULL
       );
       CREATE TABLE users_pii_tombstone (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL
       );
       INSERT INTO identity_sensitive_values (
         tenant_id, owner_type, owner_id, value_key, value_json, lifecycle_state
       ) VALUES (
         'tenant-a', 'runtime_user', 'user-account-5', 'email', '"user@example.com"', 'active'
       );`
    );
    lookup.exec(
      `CREATE TABLE lookup_identifiers (
         virtual_bucket INTEGER NOT NULL,
         index_kind TEXT NOT NULL,
         normalization_version INTEGER NOT NULL,
         hmac_key_generation INTEGER NOT NULL,
         identifier_blind_digest TEXT NOT NULL,
         tenant_id TEXT NOT NULL,
         account_id TEXT NOT NULL,
         route_schema_version INTEGER NOT NULL,
         account_route_generation INTEGER NOT NULL,
         required_binding_route_generation INTEGER NOT NULL,
         residency_policy_id TEXT NOT NULL,
         route_projection_json TEXT NOT NULL,
         tenant_lifecycle_state TEXT NOT NULL,
         runtime_route_status TEXT NOT NULL,
         lifecycle_state TEXT NOT NULL
       );`
    );
    await insertAccount(shardA, 'account-5', 5);
    await insertAccount(shardA, 'account-3', 3);
    await insertAccount(shardA, 'account-1', 1);
    await insertAccount(shardB, 'account-4', 4, {
      coreShardId: 'users-b',
      coreBindingRef: 'TDB_USERS_B',
      coreRouteGeneration: 4,
    });
    await insertAccount(shardB, 'account-2', 2, {
      coreShardId: 'users-b',
      coreBindingRef: 'TDB_USERS_B',
      coreRouteGeneration: 4,
    });
  });

  afterEach(() => {
    shardA.close();
    shardB.close();
    lookup.close();
  });

  function sourceShards() {
    return [
      {
        shardId: 'users-a',
        bindingRef: 'TDB_USERS_A',
        residencyPartition: 'default',
        routeGeneration: 3,
      },
      {
        shardId: 'users-b',
        bindingRef: 'TDB_USERS_B',
        residencyPartition: 'default',
        routeGeneration: 4,
      },
    ];
  }

  function env(shards = sourceShards()): Env {
    return {
      CONTROL: {
        listAccountDirectorySourceShards: vi.fn(async () => shards),
        listAccountRouteSourceShards: vi.fn(async () => [
          {
            dataRole: 'tenant_pii' as const,
            shardId: 'pii-a',
            bindingRef: 'TDB_PII_A',
            residencyPartition: 'default',
            routeGeneration: 5,
          },
        ]),
      },
      LOGGING_CURSOR_HMAC_SECRET: 'cross-shard-test-secret-32-bytes-minimum',
      TDB_USERS_A: d1(shardA),
      TDB_USERS_B: d1(shardB),
      TDB_PII_A: d1(shardA),
    } as unknown as Env;
  }

  it('performs a stable k-way merge and resumes each shard without duplicates', async () => {
    const service = new CrossShardAccountListService(env(), () => 100);
    const first = await service.list({ tenantId: 'tenant-a', limit: 3 });

    expect(first.items.map((item) => item.id)).toEqual(['account-5', 'account-4', 'account-3']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.list({
      tenantId: 'tenant-a',
      limit: 3,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((item) => item.id)).toEqual(['account-2', 'account-1']);
    expect(second.nextCursor).toBeNull();
  });

  it('returns only active directory publications from the requested tenant and filter', async () => {
    await insertAccount(shardA, 'pending-account', 9, { publicationState: 'pending' });
    await insertAccount(shardA, 'inactive-account', 10, { lifecycleState: 'suspended' });
    await insertAccount(shardB, 'other-tenant', 8, {
      tenantId: 'tenant-b',
      coreShardId: 'users-b',
      coreBindingRef: 'TDB_USERS_B',
      coreRouteGeneration: 4,
    });
    await insertAccount(shardB, 'service-account', 7, {
      accountType: 'service_account',
      coreShardId: 'users-b',
      coreBindingRef: 'TDB_USERS_B',
      coreRouteGeneration: 4,
    });

    const page = await new CrossShardAccountListService(env(), () => 100).list({
      tenantId: 'tenant-a',
      accountType: 'user',
    });

    expect(page.items.map((item) => item.id)).toEqual([
      'account-5',
      'account-4',
      'account-3',
      'account-2',
      'account-1',
    ]);
  });

  it('counts published users across shards without loading every account projection', async () => {
    await insertAccount(shardA, 'deprovisioned-account', 11, {
      lifecycleState: 'deprovisioned',
    });
    await insertAccount(shardA, 'pending-account', 10, { publicationState: 'pending' });
    await insertAccount(shardB, 'service-account', 9, {
      accountType: 'service_account',
      coreShardId: 'users-b',
      coreBindingRef: 'TDB_USERS_B',
      coreRouteGeneration: 4,
    });
    const service = new CrossShardAccountListService(env(), () => 100);

    await expect(
      service.count({ tenantId: 'tenant-a', accountType: 'user', includeInactive: true })
    ).resolves.toBe(6);
    await expect(
      service.count({ tenantId: 'tenant-a', accountType: 'user', includeInactive: false })
    ).resolves.toBe(5);
  });

  it('aggregates dashboard users and canonical login timestamps across active shards', async () => {
    await insertAccount(shardA, 'account-new', 980);
    shardA
      .prepare(`UPDATE identity_accounts SET metadata_json = ? WHERE id = 'account-5'`)
      .run(JSON.stringify({ last_login_at: 950 }));
    shardB
      .prepare(`UPDATE identity_accounts SET metadata_json = ? WHERE id = 'account-4'`)
      .run(JSON.stringify({ last_login_at: 1000 }));

    const stats = await new CrossShardAccountListService(env(), () => 100).dashboardStats({
      tenantId: 'tenant-a',
      activeSince: 400,
      todayStart: 900,
    });

    expect(stats).toEqual({
      activeUsers: 2,
      totalUsers: 6,
      newUsersToday: 1,
      loginsToday: 2,
    });
  });

  it('merges recent login activity across shards and excludes inactive accounts', async () => {
    await insertAccount(shardA, 'inactive-login-account', 12, {
      lifecycleState: 'suspended',
      lastLoginAt: 1100,
    });
    shardA
      .prepare(`UPDATE identity_accounts SET metadata_json = ? WHERE id = 'account-5'`)
      .run(JSON.stringify({ last_login_at: 900 }));
    shardB
      .prepare(`UPDATE identity_accounts SET metadata_json = ? WHERE id = 'account-4'`)
      .run(JSON.stringify({ last_login_at: 1000 }));
    shardB
      .prepare(`UPDATE identity_accounts SET metadata_json = ? WHERE id = 'account-2'`)
      .run(JSON.stringify({ last_login_at: 800 }));

    const logins = await new CrossShardAccountListService(env(), () => 100).recentLogins({
      tenantId: 'tenant-a',
      limit: 2,
    });

    expect(logins.map((login) => [login.activityId, login.account.id, login.timestamp])).toEqual([
      ['account-4', 'account-4', 1000],
      ['account-5', 'account-5', 900],
    ]);
  });

  it('rejects cursor tampering and reuse with a different query', async () => {
    const service = new CrossShardAccountListService(env(), () => 100);
    const first = await service.list({ tenantId: 'tenant-a', limit: 2 });
    if (!first.nextCursor) throw new Error('missing_test_cursor');
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('a') ? 'b' : 'a'}`;

    await expect(
      service.list({ tenantId: 'tenant-a', limit: 2, cursor: tampered })
    ).rejects.toThrow('invalid_cross_shard_cursor');
    await expect(
      service.list({
        tenantId: 'tenant-a',
        limit: 2,
        accountType: 'service_account',
        cursor: first.nextCursor,
      })
    ).rejects.toThrow('cross_shard_cursor_query_mismatch');
  });

  it('rejects a cursor after the source-shard topology changes', async () => {
    const first = await new CrossShardAccountListService(env(), () => 100).list({
      tenantId: 'tenant-a',
      limit: 2,
    });
    if (!first.nextCursor) throw new Error('missing_test_cursor');
    const changed = sourceShards().map((shard) =>
      shard.shardId === 'users-b' ? { ...shard, routeGeneration: 5 } : shard
    );

    await expect(
      new CrossShardAccountListService(env(changed), () => 100).list({
        tenantId: 'tenant-a',
        limit: 2,
        cursor: first.nextCursor,
      })
    ).rejects.toThrow('cursor_stale');
  });

  it('rejects an expired continuation cursor', async () => {
    const workerEnv = env();
    const first = await new CrossShardAccountListService(workerEnv, () => 100).list({
      tenantId: 'tenant-a',
      limit: 2,
    });
    if (!first.nextCursor) throw new Error('missing_test_cursor');

    await expect(
      new CrossShardAccountListService(workerEnv, () => 1000).list({
        tenantId: 'tenant-a',
        limit: 2,
        cursor: first.nextCursor,
      })
    ).rejects.toThrow('cross_shard_cursor_expired');
  });

  it('fails before fan-out when the source set exceeds the fixed bound', async () => {
    const shards = Array.from({ length: 33 }, (_, index) => ({
      shardId: `users-${String(index).padStart(2, '0')}`,
      bindingRef: `TDB_USERS_${String(index).padStart(2, '0')}`,
      residencyPartition: 'default',
      routeGeneration: 1,
    }));

    await expect(
      new CrossShardAccountListService(env(shards), () => 100).list({ tenantId: 'tenant-a' })
    ).rejects.toThrow('cross_shard_account_fanout_limit_exceeded');
  });

  it('fails closed when a continuation is required but no cursor key is configured', async () => {
    const workerEnv = env();
    workerEnv.LOGGING_CURSOR_HMAC_SECRET = undefined;

    await expect(
      new CrossShardAccountListService(workerEnv, () => 100).list({
        tenantId: 'tenant-a',
        limit: 2,
      })
    ).rejects.toThrow('cross_shard_cursor_signing_key_unavailable');
  });

  it('rejects an outbox route that does not match the active PII inventory', async () => {
    const row = shardA
      .prepare(`SELECT payload_json FROM account_routing_outbox WHERE account_id = 'account-5'`)
      .get() as { payload_json: string };
    const publication = JSON.parse(row.payload_json) as AccountDirectoryPublication;
    const pii = publication.routeProjection.targets.find(
      (target) => target.dataRole === 'tenant_pii'
    );
    if (!pii) throw new Error('missing_test_pii_route');
    pii.bindingRef = 'TDB_PII_WRONG';
    shardA
      .prepare(`UPDATE account_routing_outbox SET payload_json = ? WHERE account_id = 'account-5'`)
      .run(JSON.stringify(publication));

    await expect(
      new CrossShardAccountListService(env(), () => 100).list({
        tenantId: 'tenant-a',
        limit: 2,
      })
    ).rejects.toThrow('cross_shard_account_route_invalid');
  });

  it('resolves exact email search through signed Lookup routing and revalidates both destinations', async () => {
    const hmacSecret = 'lookup-search-hmac-secret-32-bytes-minimum';
    const emailIndex = await createLookupBlindIndex('email_exact', 'user@example.com', {
      generation: 1,
      secret: hmacSecret,
    });
    const routeProjection = {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users' as const,
          residencyPartition: 'default',
          shardId: 'users-a',
          bindingRef: 'TDB_USERS_A',
          requiredBindingRouteGeneration: 3,
        },
        {
          dataRole: 'tenant_pii' as const,
          residencyPartition: 'default',
          shardId: 'pii-a',
          bindingRef: 'TDB_PII_A',
          requiredBindingRouteGeneration: 5,
        },
      ],
    };
    lookup
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state
         ) VALUES (?, ?, ?, ?, ?, 'tenant-a', 'account-5', 1, 1, 5, 'default-policy', ?,
                   'active', 'active', 'active')`
      )
      .run(
        emailIndex.virtualBucket,
        emailIndex.indexKind,
        emailIndex.normalizationVersion,
        emailIndex.hmacKeyGeneration,
        emailIndex.digest,
        JSON.stringify(routeProjection)
      );
    const userNameIndex = await createLookupBlindIndex(
      'external_subject',
      {
        issuer: 'urn:authrim:scim:tenant-a:username',
        subject: 'user-name',
      },
      { generation: 1, secret: hmacSecret }
    );
    lookup
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state
         ) VALUES (?, ?, ?, ?, ?, 'tenant-a', 'account-5', 1, 1, 5, 'default-policy', ?,
                   'active', 'active', 'active')`
      )
      .run(
        userNameIndex.virtualBucket,
        userNameIndex.indexKind,
        userNameIndex.normalizationVersion,
        userNameIndex.hmacKeyGeneration,
        userNameIndex.digest,
        JSON.stringify(routeProjection)
      );
    const now = Math.floor(Date.now() / 1000);
    const token = await signLookupShardRegistry({
      registry: {
        environmentId: 'test',
        generation: 1,
        issuedAt: now - 1,
        expiresAt: now + 3600,
        ranges: [
          {
            startBucket: 0,
            endBucket: 4095,
            assignmentGeneration: 1,
            lookupShardId: 'lookup-a',
            bindingRef: 'LOOKUP_A',
          },
        ],
      },
      privateJwk,
    });
    const hmacStateToken = await signLookupHmacKeyState({
      state: {
        environmentId: 'test',
        generation: 1,
        issuedAt: now - 1,
        expiresAt: now + 3600,
        rotationState: 'stable',
        writeMode: 'current_only',
        current: {
          generation: 1,
          keyId: 'lookup-key-1',
          slot: 'A',
          fingerprint: await fingerprintLookupHmacKey(hmacSecret),
        },
        previous: null,
      },
      privateJwk,
    });
    const workerEnv = env();
    workerEnv.AUTHRIM_ENVIRONMENT_NAME = 'test';
    workerEnv.LOOKUP_HMAC_KEY_SLOT_A = hmacSecret;
    workerEnv.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS = JSON.stringify({
      keys: [publicJwk],
    });
    workerEnv.TENANT_RUNTIME_REGISTRY = {
      get: async (key: string) => {
        if (key === buildLookupShardRegistrySnapshotKey('test')) return token;
        if (key === buildLookupShardRegistryGenerationKey('test')) return '1';
        if (key === buildLookupHmacKeyStateSnapshotKey('test')) return hmacStateToken;
        if (key === buildLookupHmacKeyStateGenerationKey('test')) return '1';
        return null;
      },
    } as KVNamespace;
    (workerEnv as unknown as Record<string, unknown>).LOOKUP_A = d1(lookup);

    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'USER@example.com',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'account-5',
        legacyUserId: 'user-account-5',
        coreBindingRef: 'TDB_USERS_A',
        piiBindingRef: 'TDB_PII_A',
      }),
    ]);
    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user-name',
        indexKind: 'external_subject',
        externalSubjectIssuer: 'urn:authrim:scim:tenant-a:username',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'account-5',
        legacyUserId: 'user-account-5',
      }),
    ]);

    shardA
      .prepare(
        `UPDATE identity_accounts SET account_type = 'service_account' WHERE id = 'account-5'`
      )
      .run();
    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user@example.com',
      })
    ).resolves.toEqual([]);

    const accountIndex = await createLookupBlindIndex('account_id', 'account:user-account-5', {
      generation: 1,
      secret: hmacSecret,
    });
    const staleRouteProjection = {
      ...routeProjection,
      targets: routeProjection.targets.map((target) =>
        target.dataRole === 'tenant_core/users'
          ? {
              ...target,
              shardId: 'users-b',
              bindingRef: 'TDB_USERS_B',
              requiredBindingRouteGeneration: 4,
            }
          : target
      ),
    };
    lookup
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state
         ) VALUES (?, ?, ?, ?, ?, 'tenant-a', 'account-5', 1, 1, 5, 'default-policy', ?,
                   'active', 'active', 'active')`
      )
      .run(
        accountIndex.virtualBucket,
        accountIndex.indexKind,
        accountIndex.normalizationVersion,
        accountIndex.hmacKeyGeneration,
        accountIndex.digest,
        JSON.stringify(staleRouteProjection)
      );

    shardA
      .prepare(
        `UPDATE identity_accounts
            SET account_type = 'user', lifecycle_state = 'deprovisioned',
                directory_publication_state = 'active'
          WHERE id = 'account-5'`
      )
      .run();
    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user-account-5',
        purpose: 'account_lifecycle',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'account-5',
        lifecycleState: 'deprovisioned',
      }),
    ]);
    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user-account-5',
        purpose: 'account_delete_retry',
      })
    ).resolves.toHaveLength(1);

    shardA
      .prepare(
        `UPDATE identity_accounts
            SET account_type = 'user', lifecycle_state = 'deleting',
                directory_publication_state = 'disabled'
          WHERE id = 'account-5'`
      )
      .run();
    shardA
      .prepare(
        `UPDATE identity_sensitive_values SET lifecycle_state = 'deleted'
          WHERE tenant_id = 'tenant-a' AND owner_id = 'user-account-5'`
      )
      .run();

    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user@example.com',
      })
    ).rejects.toThrow();
    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user@example.com',
        purpose: 'account_delete_retry',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'account-5',
        lifecycleState: 'deleting',
      }),
    ]);

    shardA
      .prepare(
        `DELETE FROM identity_sensitive_values
          WHERE tenant_id = 'tenant-a' AND owner_id = 'user-account-5'`
      )
      .run();
    shardA
      .prepare(`INSERT INTO users_pii_tombstone (id, tenant_id) VALUES (?, ?)`)
      .run('user-account-5', 'tenant-a');
    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user@example.com',
        purpose: 'account_delete_retry',
      })
    ).resolves.toHaveLength(1);

    shardA.prepare(`UPDATE users_pii_tombstone SET tenant_id = 'tenant-b'`).run();
    await expect(
      new CrossShardAccountExactSearchService(workerEnv).find({
        tenantId: 'tenant-a',
        identifier: 'user@example.com',
        purpose: 'account_delete_retry',
      })
    ).rejects.toThrow();
  });
});
