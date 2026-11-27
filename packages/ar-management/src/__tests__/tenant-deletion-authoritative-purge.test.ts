import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockVerifyTenantRuntimeRegistrySnapshotSignature } = vi.hoisted(() => ({
  mockVerifyTenantRuntimeRegistrySnapshotSignature: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    loadTenantRuntimeRegistryVerificationKeysFromEnv: vi.fn(() => []),
    verifyTenantRuntimeRegistrySnapshotSignature: mockVerifyTenantRuntimeRegistrySnapshotSignature,
  };
});

import { purgeTenantAuthoritativeShards } from '../tenant-deletion-authoritative-purge';

const tenantShards = [
  {
    shardId: 'core-1',
    dataRole: 'tenant_core/default' as const,
    residencyPolicyId: 'global',
    residencyPartition: 'global',
    bindingRef: 'TDB_CORE',
    status: 'active' as const,
    allocationScope: 'tenant_exclusive' as const,
    ownerTenantId: 'tenant-a',
  },
  {
    shardId: 'pii-1',
    dataRole: 'tenant_pii' as const,
    residencyPolicyId: 'global',
    residencyPartition: 'global',
    bindingRef: 'TDB_PII',
    status: 'active' as const,
    allocationScope: 'tenant_exclusive' as const,
    ownerTenantId: 'tenant-a',
  },
];

interface PreparedCall {
  sql: string;
  params: unknown[];
}

function createSession() {
  const calls: PreparedCall[] = [];
  const prepare = vi.fn((sql: string) => {
    let params: unknown[] = [];
    const statement = {
      sql,
      bind: vi.fn((...values: unknown[]) => {
        params = values;
        return statement;
      }),
      all: vi.fn(async () => {
        if (sql.includes('sqlite_master')) {
          return {
            success: true,
            results: [
              { name: '_cf_KV' },
              { name: 'admin_jobs' },
              { name: 'd1_migrations' },
              { name: 'tenants' },
              { name: 'users' },
            ],
          };
        }
        if (sql.includes('PRAGMA table_info')) {
          return sql.includes('"tenants"')
            ? { success: true, results: [{ name: 'id' }, { name: 'lifecycle_state' }] }
            : { success: true, results: [{ name: 'id' }, { name: 'tenant_id' }] };
        }
        return { success: true, results: [] };
      }),
      run: vi.fn(async () => {
        calls.push({ sql, params });
        return { success: true };
      }),
      first: vi.fn(async () => ({ count: 0 })),
    };
    return statement;
  });
  const batch = vi.fn(
    async (statements: Array<{ sql: string; all(): Promise<unknown>; run(): Promise<unknown> }>) =>
      Promise.all(
        statements.map((statement) =>
          statement.sql.startsWith('PRAGMA ') ? statement.all() : statement.run()
        )
      )
  );
  return {
    session: { prepare, batch },
    calls,
  };
}

describe('tenant deletion authoritative purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyTenantRuntimeRegistrySnapshotSignature.mockResolvedValue('valid');
  });

  it('purges tenant-scoped rows on every allocated primary shard and preserves tombstone tables', async () => {
    const core = createSession();
    const pii = createSession();
    const snapshot = {
      version: 4,
      tenantId: 'tenant-a',
      snapshotScope: 'tenant',
      deploymentTarget: 'edge-a',
      runtimeGeneration: 8,
      routeStatus: 'quarantined',
      quarantineDenyGeneration: 2,
      backend: { provider: 'd1', resolver: 'control-plane' },
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
      publishedAt: '2026-05-16T00:00:00.000Z',
      expiresAt: '2099-05-16T00:30:00.000Z',
      stores: [
        { provider: 'd1', bindingRef: 'TDB_CORE' },
        { provider: 'd1', bindingRef: 'TDB_PII' },
      ],
      metadata: {
        storeCount: 2,
        roles: ['tenant_core', 'tenant_pii'],
        signature: 'header.payload.signature',
        signatureKeyId: 'runtime-key-1',
      },
    };
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
      TENANT_RUNTIME_REGISTRY: { get: vi.fn(async () => JSON.stringify(snapshot)) },
      TDB_CORE: { withSession: vi.fn(() => core.session) },
      TDB_PII: { withSession: vi.fn(() => pii.session) },
    };

    await purgeTenantAuthoritativeShards(env as never, tenantShards, 'tenant-a', ['job-1']);

    for (const calls of [core.calls, pii.calls]) {
      expect(calls).toEqual(
        expect.arrayContaining([
          {
            sql: 'DELETE FROM "admin_jobs" WHERE tenant_id = ? AND id NOT IN (?)',
            params: ['tenant-a', 'job-1'],
          },
          {
            sql: 'DELETE FROM "users" WHERE tenant_id = ?',
            params: ['tenant-a'],
          },
          {
            sql: "UPDATE tenants SET lifecycle_state = 'deleted', updated_at = ? WHERE id = ?",
            params: [expect.any(Number), 'tenant-a'],
          },
        ])
      );
      expect(calls.some((call) => call.sql.includes('d1_migrations'))).toBe(false);
      expect(calls.some((call) => call.sql.includes('_cf_KV'))).toBe(false);
    }
    expect(core.session.batch).toHaveBeenCalledTimes(3);
    expect(pii.session.batch).toHaveBeenCalledTimes(3);
    expect(core.session.batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(pii.session.batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(core.session.prepare).not.toHaveBeenCalledWith(
      expect.stringContaining('defer_foreign_keys')
    );
    expect(pii.session.prepare).not.toHaveBeenCalledWith(
      expect.stringContaining('defer_foreign_keys')
    );
  });

  it('fails before mutation when signed registry and Control inventory disagree', async () => {
    const core = createSession();
    const snapshot = {
      version: 4,
      tenantId: 'tenant-a',
      deploymentTarget: 'edge-a',
      runtimeGeneration: 8,
      routeStatus: 'quarantined',
      quarantineDenyGeneration: 2,
      backend: { provider: 'd1', resolver: 'control-plane' },
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
      expiresAt: '2099-05-16T00:30:00.000Z',
      stores: [{ provider: 'd1', bindingRef: 'TDB_UNKNOWN' }],
      metadata: { signature: 'header.payload.signature', signatureKeyId: 'runtime-key-1' },
    };

    await expect(
      purgeTenantAuthoritativeShards(
        {
          AUTHRIM_ENVIRONMENT_NAME: 'test',
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
          TENANT_RUNTIME_REGISTRY: { get: vi.fn(async () => JSON.stringify(snapshot)) },
          TDB_CORE: { withSession: vi.fn(() => core.session) },
        } as never,
        [tenantShards[0]],
        'tenant-a',
        ['job-1']
      )
    ).rejects.toThrow('tenant_deletion_authoritative_registry_inventory_mismatch');
    expect(core.calls).toEqual([]);
  });

  it('purges groups, memberships and group grants on the real schema of every shard', async () => {
    const { coreSchemaDatabase } = await import('./core-schema-sqlite');
    type Db = ReturnType<typeof coreSchemaDatabase>['db'];
    /** A D1 primary session over a real SQLite database with the deployed core schema. */
    const realSession = (db: Db) => {
      const prepare = (sql: string) => {
        let params: unknown[] = [];
        const values = () => params as never[];
        const statement = {
          sql,
          bind: (...bound: unknown[]) => {
            params = bound;
            return statement;
          },
          all: async () => ({ success: true, results: db.prepare(sql).all(...values()) }),
          run: async () => {
            db.prepare(sql).run(...values());
            return { success: true };
          },
          first: async () => db.prepare(sql).get(...values()) ?? null,
        };
        return statement;
      };
      return {
        prepare,
        batch: async (statements: ReturnType<typeof prepare>[]) => {
          const results = [];
          for (const statement of statements)
            results.push(
              /^\s*(PRAGMA|SELECT)/i.test(statement.sql)
                ? await statement.all()
                : await statement.run()
            );
          return results;
        },
      };
    };
    const metadata = coreSchemaDatabase();
    const usersA = coreSchemaDatabase();
    const usersB = coreSchemaDatabase();
    for (const tenant of ['tenant-a', 'tenant-b']) {
      metadata.db
        .exec(`INSERT INTO "groups"(id, tenant_id, group_key, display_name, kind, created_at, updated_at)
        VALUES ('g-${tenant}', '${tenant}', 'k', 'G', 'dynamic', 1, 1);
        INSERT INTO group_role_assignments(id, tenant_id, group_id, role_id, created_at, updated_at)
        VALUES ('gr-${tenant}', '${tenant}', 'g-${tenant}', 'reader', 1, 1)`);
      for (const [shard, subject] of [
        [usersA, 'u1'],
        [usersB, 'u2'],
      ] as const)
        shard.db
          .exec(`INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
          VALUES ('m-${tenant}-${subject}', '${tenant}', 'g-${tenant}', '${subject}', 'dynamic', 'r', 1, 1);
          INSERT INTO role_assignments(id, tenant_id, subject_id, role_id, created_at, updated_at)
          VALUES ('ra-${tenant}-${subject}', '${tenant}', '${subject}', 'reader', 1, 1);
          INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at)
          VALUES ('s-${tenant}-${subject}', '${tenant}', 'g-${tenant}', '${subject}', 'scim', 'scim', 1, 1);
          INSERT INTO service_group_manual(tenant_id, user_id, group_id) VALUES ('${tenant}', '${subject}', 'g-${tenant}')`);
    }
    const shards = [
      { ...tenantShards[0], shardId: 'meta-1', bindingRef: 'TDB_META' },
      {
        ...tenantShards[0],
        shardId: 'users-a',
        dataRole: 'tenant_core/users' as const,
        bindingRef: 'TDB_USERS_A',
      },
      {
        ...tenantShards[0],
        shardId: 'users-b',
        dataRole: 'tenant_core/users' as const,
        bindingRef: 'TDB_USERS_B',
      },
    ];
    const snapshot = {
      version: 4,
      tenantId: 'tenant-a',
      deploymentTarget: 'edge-a',
      runtimeGeneration: 8,
      routeStatus: 'quarantined',
      quarantineDenyGeneration: 2,
      backend: { provider: 'd1', resolver: 'control-plane' },
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
      expiresAt: '2099-05-16T00:30:00.000Z',
      stores: shards.map((shard) => ({ provider: 'd1', bindingRef: shard.bindingRef })),
      metadata: { signature: 'header.payload.signature', signatureKeyId: 'runtime-key-1' },
    };
    await purgeTenantAuthoritativeShards(
      {
        AUTHRIM_ENVIRONMENT_NAME: 'test',
        AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
        TENANT_RUNTIME_REGISTRY: { get: vi.fn(async () => JSON.stringify(snapshot)) },
        TDB_META: { withSession: () => realSession(metadata.db) },
        TDB_USERS_A: { withSession: () => realSession(usersA.db) },
        TDB_USERS_B: { withSession: () => realSession(usersB.db) },
      } as never,
      shards,
      'tenant-a',
      []
    );
    const count = (db: Db, table: string, tenant: string) =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE tenant_id = ?`).get(tenant) as {
          n: number;
        }
      ).n;
    for (const db of [metadata.db, usersA.db, usersB.db])
      for (const table of [
        'groups',
        'group_memberships',
        'group_role_assignments',
        'role_assignments',
        'service_group_manual',
        // Written by the delete triggers of the rows above: purged after them.
        'service_group_inputs',
      ]) {
        expect(count(db, table, 'tenant-a')).toBe(0);
      }
    // Another tenant's rows on the same shards stay.
    expect(count(metadata.db, 'groups', 'tenant-b')).toBe(1);
    expect(count(metadata.db, 'group_role_assignments', 'tenant-b')).toBe(1);
    expect(count(usersA.db, 'group_memberships', 'tenant-b')).toBe(2);
    expect(count(usersB.db, 'group_memberships', 'tenant-b')).toBe(2);
    expect(count(usersA.db, 'service_group_manual', 'tenant-b')).toBe(1);
    for (const db of [metadata.db, usersA.db, usersB.db]) db.close();
  });
});
