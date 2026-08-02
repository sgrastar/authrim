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
      version: 2,
      tenantId: 'tenant-a',
      snapshotScope: 'tenant',
      deploymentTarget: 'edge-a',
      runtimeGeneration: 8,
      routeStatus: 'quarantined',
      quarantineDenyGeneration: 2,
      storageProfileId: 'builtin:storage:tenant-d1',
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
      DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
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
      version: 2,
      tenantId: 'tenant-a',
      deploymentTarget: 'edge-a',
      runtimeGeneration: 8,
      routeStatus: 'quarantined',
      quarantineDenyGeneration: 2,
      expiresAt: '2099-05-16T00:30:00.000Z',
      stores: [{ provider: 'd1', bindingRef: 'TDB_UNKNOWN' }],
      metadata: { signature: 'header.payload.signature', signatureKeyId: 'runtime-key-1' },
    };

    await expect(
      purgeTenantAuthoritativeShards(
        {
          AUTHRIM_ENVIRONMENT_NAME: 'test',
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
          DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
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
});
