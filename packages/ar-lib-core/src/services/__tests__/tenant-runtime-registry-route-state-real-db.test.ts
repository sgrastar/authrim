/**
 * Route-state transitions against a REAL SQLite database (node:sqlite) with the real admin DDL, the
 * real TenantDatabaseRegistryRepository, the real transition functions and the real snapshot
 * publisher. Only the KV store is an in-memory fake.
 *
 * Regression: a route-state change bumps the runtime_registry cache generation, and the snapshot
 * publisher/resolver require every published store's runtime generation (copied from the active
 * pointer) to equal max(pointer generations, cache generation). The pointers must follow.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1Adapter } from '../../db/adapters/d1-adapter';
import {
  TenantDatabaseRegistryRepository,
  type TenantDatabaseActivePointer,
} from '../../repositories/admin/tenant-database-registry';
import {
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  publishTenantRuntimeRegistrySnapshot,
  reactivateTenantRuntimeRegistryRouteState,
  transitionTenantRuntimeRegistryRouteState,
  type TenantRuntimeRegistrySnapshot,
} from '../tenant-runtime-registry-snapshot';
import {
  clearTenantDatabaseResolverMemoryCache,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type TenantDatabaseResolverEnv,
} from '../tenant-database-resolver';

type SqliteValue = string | number | null | Uint8Array;

const BASELINE = fileURLToPath(
  new URL('../../../../../migrations/admin/d1/001_0_5_0_admin_baseline.sql', import.meta.url)
);
const TENANT = 'tenant-a';
const TARGET = 'edge-a';
// The resolver checks snapshot expiry against the wall clock, so publish with the current time.
const NOW = new Date();
const PLACEMENT = { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 } as const;

function sqliteValues(values: unknown[]): SqliteValue[] {
  return values as SqliteValue[];
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[]
  ) {}
  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }
  async first<T>() {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return {
        bind: (...values: unknown[]) => new BoundStatement(statement, sqliteValues(values)),
      };
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
  } as unknown as D1Database;
}

/** The exact CREATE TABLE statements of the real admin baseline for the tables under test. */
function createRealTables(database: DatabaseSync): void {
  const baseline = readFileSync(BASELINE, 'utf8');
  for (const table of [
    'tenant_database_registry',
    'tenant_database_active_pointers',
    'tenant_runtime_cache_generations',
    'tenant_runtime_registry_snapshots',
  ]) {
    const match = new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`, 'u').exec(baseline);
    if (!match) throw new Error(`baseline_ddl_missing:${table}`);
    database.exec(match[0]);
  }
}

interface StoreSeed {
  role: 'tenant_core' | 'tenant_pii';
  shardGroup: string;
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  bindingRef: string;
}

const STORES: StoreSeed[] = [
  {
    role: 'tenant_core',
    shardGroup: 'default',
    dataRole: 'tenant_core/default',
    bindingRef: 'TDB_A_CORE',
  },
  {
    role: 'tenant_core',
    shardGroup: 'users',
    dataRole: 'tenant_core/users',
    bindingRef: 'TDB_A_USERS',
  },
  { role: 'tenant_pii', shardGroup: 'default', dataRole: 'tenant_pii', bindingRef: 'TDB_A_PII' },
];

function seedStores(database: DatabaseSync, runtimeGeneration = 1): void {
  for (const store of STORES) {
    database
      .prepare(
        `INSERT INTO tenant_database_registry (
           tenant_id, role, generation, shard_group, shard_index, provider, database_id,
           database_name, binding_ref, schema_version, status, shard_count, shard_key_strategy,
           deployment_target, metadata_json
         ) VALUES (?, ?, 1, ?, 0, 'd1', ?, ?, ?, 2, 'active', 1, 'none', ?, ?)`
      )
      .run(
        TENANT,
        store.role,
        store.shardGroup,
        `db-${store.bindingRef}`,
        `name-${store.bindingRef}`,
        store.bindingRef,
        TARGET,
        JSON.stringify({
          control_data_role: store.dataRole,
          control_residency_policy_id: 'builtin:residency:default',
          control_residency_partition: 'default',
          control_shard_id: `shard-${store.bindingRef}`,
          control_assignment_generation: 7,
          control_allocation_scope: 'tenant_exclusive',
          control_owner_tenant_id: TENANT,
          control_placement_policy_generation: 7,
        })
      );
    database
      .prepare(
        `INSERT INTO tenant_database_active_pointers (
           tenant_id, role, shard_group, generation, shard_count, shard_key_strategy,
           runtime_generation, status
         ) VALUES (?, ?, ?, 1, 1, 'none', ?, 'active')`
      )
      .run(TENANT, store.role, store.shardGroup, runtimeGeneration);
  }
}

function createKv() {
  const entries = new Map<string, string>();
  return {
    entries,
    async put(key: string, value: string) {
      entries.set(key, value);
    },
    async get(key: string) {
      return entries.get(key) ?? null;
    },
  };
}

async function generateKeys() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  for (const jwk of [privateJwk, publicJwk]) {
    jwk.kid = 'rr-key-1';
    jwk.alg = 'EdDSA';
    jwk.use = 'sig';
  }
  return { privateJwk, publicJwk };
}

describe('route-state transitions with real SQLite and the real registry repository', () => {
  let database: DatabaseSync;
  let repository: TenantDatabaseRegistryRepository;
  let kv: ReturnType<typeof createKv>;
  let privateJwk: JsonWebKey;
  let publicJwk: JsonWebKey;

  const publish = () =>
    publishTenantRuntimeRegistrySnapshot({
      tenantId: TENANT,
      placement: PLACEMENT,
      deploymentTarget: TARGET,
      repository,
      snapshotStore: kv,
      actorId: 'test',
      now: NOW,
      signingKey: { privateJwk, keyId: 'rr-key-1' },
    });
  const readSnapshot = (): TenantRuntimeRegistrySnapshot =>
    JSON.parse(
      kv.entries.get(buildTenantRuntimeRegistrySnapshotKey(TENANT, TARGET)) as string
    ) as TenantRuntimeRegistrySnapshot;
  const pointers = () =>
    database
      .prepare(
        'SELECT role, shard_group, runtime_generation, status FROM tenant_database_active_pointers ORDER BY role, shard_group'
      )
      .all() as unknown as Pick<
      TenantDatabaseActivePointer,
      'role' | 'shard_group' | 'runtime_generation' | 'status'
    >[];
  const cacheGeneration = () =>
    (
      database
        .prepare(
          "SELECT generation FROM tenant_runtime_cache_generations WHERE tenant_id = ? AND cache_namespace = 'runtime_registry'"
        )
        .get(TENANT) as { generation: number }
    ).generation;
  const transition = (
    routeStatus: 'quarantining' | 'quarantined' | 'disabled',
    operationId = 'job-1'
  ) =>
    transitionTenantRuntimeRegistryRouteState(repository, {
      tenantId: TENANT,
      routeStatus,
      operationId,
      actorId: operationId,
      now: NOW,
    });

  beforeEach(async () => {
    clearTenantDatabaseResolverMemoryCache();
    database = new DatabaseSync(':memory:');
    createRealTables(database);
    seedStores(database);
    repository = new TenantDatabaseRegistryRepository(
      new D1Adapter({ db: sqliteD1(database), retryConfig: { maxRetries: 0 } })
    );
    kv = createKv();
    ({ privateJwk, publicJwk } = await generateKeys());
    // An already published snapshot: cache generation 1, every pointer at 1.
    await publish();
    expect(cacheGeneration()).toBe(1);
  });

  afterEach(() => database.close());

  it('publishes quarantining, quarantined and disabled for a tenant that already has a snapshot', async () => {
    const first = await transition('quarantining');
    expect(first).toMatchObject({ changed: true, runtimeGeneration: 2 });
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'quarantining', runtimeGeneration: 2 });
    expect(readSnapshot().stores).toHaveLength(3);
    expect(readSnapshot().stores.every((store) => store.runtimeGeneration === 2)).toBe(true);

    expect(await transition('quarantined')).toMatchObject({ changed: true, runtimeGeneration: 3 });
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'quarantined', runtimeGeneration: 3 });
    expect(readSnapshot().stores.every((store) => store.runtimeGeneration === 3)).toBe(true);

    // The deletion publishes `disabled` while the pointers are still active, so stores exist here.
    expect(await transition('disabled')).toMatchObject({ changed: true, runtimeGeneration: 4 });
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'disabled', runtimeGeneration: 4 });
    expect(readSnapshot().stores).toHaveLength(3);
    expect(readSnapshot().stores.every((store) => store.runtimeGeneration === 4)).toBe(true);
    expect(pointers().every((pointer) => pointer.runtime_generation === 4)).toBe(true);

    // Then the deletion disables the pointers (+1). Nothing is published as a store any more.
    database
      .prepare(
        "UPDATE tenant_database_active_pointers SET status = 'disabled', runtime_generation = runtime_generation + 1 WHERE tenant_id = ?"
      )
      .run(TENANT);
    const retry = await transition('disabled');
    expect(retry).toMatchObject({ changed: false, runtimeGeneration: 4 });
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'disabled', runtimeGeneration: 4 });
    expect(readSnapshot().stores).toHaveLength(0);
  });

  it('converges from the stuck state (cache 2, quarantining, pointers 1) on a same-operation retry', async () => {
    // What the failed deletion left behind: the transition committed, nothing raised the pointers.
    database
      .prepare(
        `UPDATE tenant_runtime_cache_generations
            SET generation = 2,
                metadata_json = '{"route_status":"quarantining","quarantine_deny_generation":1,"route_state_operation_id":"job-1"}'
          WHERE tenant_id = ?`
      )
      .run(TENANT);
    await expect(publish()).rejects.toThrow('tenant_runtime_registry_snapshot_generation_mismatch');
    // degraded_pending_snapshot pointers are published as stores too, so they must be raised too.
    database
      .prepare(
        "UPDATE tenant_database_active_pointers SET status = 'degraded_pending_snapshot' WHERE tenant_id = ?"
      )
      .run(TENANT);

    const retry = await transition('quarantining', 'job-1');
    expect(retry).toMatchObject({ changed: false, runtimeGeneration: 2 });
    expect(pointers().every((pointer) => pointer.runtime_generation === 2)).toBe(true);
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'quarantining', runtimeGeneration: 2 });
    expect(readSnapshot().stores.every((store) => store.runtimeGeneration === 2)).toBe(true);
  });

  it('converges a deletion stuck at disabled (cache 4, pointers still active) on a same-operation retry', async () => {
    // Observed after control finalisation: the disabled transition committed (generation 4) but the
    // publish failed, so no snapshot says disabled yet. The pointers are still active.
    await transition('quarantining');
    await transition('quarantined');
    await transition('disabled');
    expect(cacheGeneration()).toBe(4);
    kv.entries.delete(buildTenantRuntimeRegistrySnapshotKey(TENANT, TARGET));
    kv.entries.delete(buildTenantRuntimeRegistryGenerationKey(TENANT, TARGET));

    // The retry re-runs the transition (a no-op for the same operation) and republishes.
    expect(await transition('disabled', 'job-1')).toMatchObject({
      changed: false,
      runtimeGeneration: 4,
    });
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'disabled', runtimeGeneration: 4 });
    expect(readSnapshot().stores).toHaveLength(3);
    expect(
      JSON.parse(kv.entries.get(buildTenantRuntimeRegistryGenerationKey(TENANT, TARGET)) as string)
    ).toMatchObject({ routeStatus: 'disabled', runtimeGeneration: 4 });
    // A different operation must not take over the disabled route.
    await expect(transition('disabled', 'job-2')).rejects.toThrow(
      'runtime_registry_route_state_operation_conflict'
    );
  });

  it('refuses a disabled publish while pointers are active but the registry rows are deleting, and publishes zero stores once the pointers are disabled first', async () => {
    await transition('quarantining');
    await transition('quarantined');
    await transition('disabled');
    // (a) The old broken intermediate state: registry updated first, pointer update failed.
    database
      .prepare("UPDATE tenant_database_registry SET status = 'deleting' WHERE tenant_id = ?")
      .run(TENANT);
    await expect(publish()).rejects.toThrow(
      'tenant_runtime_registry_snapshot_inactive_registry_row'
    );
    // Nothing in the retry path can fix this: it republishes before the lifecycle step.

    // (b) The new order's intermediate state: pointers disabled, registry rows still active.
    database
      .prepare("UPDATE tenant_database_registry SET status = 'active' WHERE tenant_id = ?")
      .run(TENANT);
    database
      .prepare(
        "UPDATE tenant_database_active_pointers SET status = 'disabled', runtime_generation = runtime_generation + 1 WHERE tenant_id = ?"
      )
      .run(TENANT);
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'disabled', runtimeGeneration: 4 });
    expect(readSnapshot().stores).toHaveLength(0);
  });

  it('converges when the cache bump committed but the pointer raise did not (changed:true crash)', async () => {
    await repository.compareAndSetRuntimeCacheGeneration(
      {
        tenant_id: TENANT,
        cache_namespace: 'runtime_registry',
        generation: 2,
        updated_by: 'job-1',
        metadata_json: JSON.stringify({
          route_status: 'quarantining',
          quarantine_deny_generation: 1,
          route_state_operation_id: 'job-1',
        }),
      },
      await repository.getRuntimeCacheGeneration(TENANT, 'runtime_registry')
    );
    expect((await transition('quarantining', 'job-1')).changed).toBe(false);
    await publish();
    expect(readSnapshot().runtimeGeneration).toBe(2);
  });

  it('publishes a DR reactivation from a denied state and the resolver accepts the snapshot', async () => {
    await transition('quarantining', 'dr-1');
    await publish();
    await transition('quarantined', 'dr-1');
    await publish();
    const denied = readSnapshot();
    expect(denied).toMatchObject({ routeStatus: 'quarantined', runtimeGeneration: 3 });

    const env: TenantDatabaseResolverEnv & Record<string, unknown> = {
      TENANT_RUNTIME_REGISTRY: kv,
      AUTHRIM_DEPLOYMENT_TARGET: TARGET,
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWK: JSON.stringify(publicJwk),
    };
    // The resolver parses (and so validates) the snapshot before it reports the route as denied:
    // a generation mismatch would surface as invalid_route_contract instead.
    await expect(
      resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
        tenantId: TENANT,
        role: 'tenant_core',
        deploymentTarget: TARGET,
      })
    ).rejects.toMatchObject({ code: 'quarantined_route' });

    const reactivated = await reactivateTenantRuntimeRegistryRouteState(repository, {
      tenantId: TENANT,
      operationId: 'dr-1',
      expectedQuarantineDenyGeneration: denied.quarantineDenyGeneration,
      actorId: 'dr-1',
      now: NOW,
    });
    expect(reactivated).toMatchObject({ changed: true, runtimeGeneration: 4 });
    await publish();
    expect(readSnapshot()).toMatchObject({ routeStatus: 'active', runtimeGeneration: 4 });
    expect(readSnapshot().stores.every((store) => store.runtimeGeneration === 4)).toBe(true);
    expect(
      JSON.parse(kv.entries.get(buildTenantRuntimeRegistryGenerationKey(TENANT, TARGET)) as string)
    ).toMatchObject({ routeStatus: 'active', runtimeGeneration: 4 });

    // Same-operation retry of the reactivation is a no-op that still leaves the pointers aligned.
    await expect(
      reactivateTenantRuntimeRegistryRouteState(repository, {
        tenantId: TENANT,
        operationId: 'dr-1',
        expectedQuarantineDenyGeneration: denied.quarantineDenyGeneration,
        actorId: 'dr-1',
        now: NOW,
      })
    ).resolves.toMatchObject({ changed: false, runtimeGeneration: 4 });

    // The resolver now accepts the active snapshot (the signature, generation and binding checks
    // pass, so resolution reaches the store lookup).
    const bindingEnv = Object.fromEntries(
      STORES.map((store) => [store.bindingRef, sqliteD1(new DatabaseSync(':memory:'))])
    );
    const resolved = await resolveTenantAssignedDatabaseSourcesFromRegistry(
      { ...env, ...bindingEnv },
      { tenantId: TENANT, role: 'tenant_core', deploymentTarget: TARGET }
    );
    expect(resolved).toHaveLength(2);
  });

  it('never lowers a higher pointer generation and is idempotent', async () => {
    database
      .prepare(
        "UPDATE tenant_database_active_pointers SET runtime_generation = 9 WHERE tenant_id = ? AND shard_group = 'users'"
      )
      .run(TENANT);
    expect(await repository.raiseActivePointerRuntimeGeneration(TENANT, 4, 'a')).toBe(2);
    expect(pointers().map((pointer) => pointer.runtime_generation)).toEqual([4, 9, 4]);
    expect(await repository.raiseActivePointerRuntimeGeneration(TENANT, 4, 'a')).toBe(0);
    expect(await repository.raiseActivePointerRuntimeGeneration(TENANT, 2, 'a')).toBe(0);
    expect(pointers().map((pointer) => pointer.runtime_generation)).toEqual([4, 9, 4]);
    // Pointers that are not published as stores, and other tenants, are left alone.
    database
      .prepare(
        "UPDATE tenant_database_active_pointers SET status = 'disabled' WHERE tenant_id = ? AND role = 'tenant_pii'"
      )
      .run(TENANT);
    expect(await repository.raiseActivePointerRuntimeGeneration(TENANT, 20, 'a')).toBe(2);
    expect(await repository.raiseActivePointerRuntimeGeneration('other-tenant', 20, 'a')).toBe(0);
    expect(pointers().map((pointer) => pointer.runtime_generation)).toEqual([20, 20, 4]);
    await expect(repository.raiseActivePointerRuntimeGeneration(TENANT, 0, 'a')).rejects.toThrow(
      'tenant_database_active_pointer_runtime_generation_invalid'
    );
  });
});
