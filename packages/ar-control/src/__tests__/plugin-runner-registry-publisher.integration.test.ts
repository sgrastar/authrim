import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  buildPluginRunnerRegistryGenerationKey,
  buildPluginRunnerRegistrySnapshotKey,
  verifyPluginRunnerRegistry,
} from '@authrim/ar-lib-core/control-plane';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginRunnerRegistryPublisher } from '../plugin-runner-registry-publisher';
import type { ControlEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
  } as unknown as D1Database;
}

describe('PluginRunnerRegistryPublisher', () => {
  let database: DatabaseSync;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let values: Map<string, string>;
  let writes: string[];
  let now: number;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'registry-key-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'registry-key-a', alg: 'EdDSA' };
  });

  beforeEach(() => {
    now = 1_800_000_000;
    values = new Map();
    writes = [];
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
       INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
       ) VALUES ('test', 'default', 'jp', 'active', 1, 1);
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         created_at, updated_at
       ) VALUES ('test', 2, 2, 10, 10, 100000, 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (
         'seed-operation', 'test', 'provision_shard', 'seed-shards', 'succeeded',
         'setup', 1, 1, 1, 1
       );
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, provider_create_state,
         provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES
         ('resource-a', 'test', 'd1', 'default-1', 'default-1', 'fingerprint-a', 'ready',
          'seed-operation', '{}', 'identified', 'database-a', 1, 1, 1),
         ('resource-b', 'test', 'd1', 'users-1', 'users-1', 'fingerprint-b', 'ready',
          'seed-operation', '{}', 'identified', 'database-b', 1, 1, 1),
         ('resource-c', 'test', 'd1', 'pii-1', 'pii-1', 'fingerprint-c', 'ready',
          'seed-operation', '{}', 'identified', 'database-c', 1, 1, 1);
       INSERT INTO control_tenant_shards (
         shard_id, environment_id, data_role, residency_policy_id, residency_partition,
         generation, logical_shard_id, binding_ref, d1_desired_resource_id,
         status, created_at, updated_at
       ) VALUES
         ('shard-a', 'test', 'tenant_core/default', 'default', 'jp', 1, 'default-1',
          'TEST_TDB_DEFAULT_JP_0001_CORE', 'resource-a', 'active', 1, 1),
         ('shard-b', 'test', 'tenant_core/users', 'default', 'jp', 2, 'users-1',
          'TEST_TDB_USERS_JP_0001_CORE', 'resource-b', 'active', 1, 1),
         ('shard-c', 'test', 'tenant_pii', 'default', 'jp', 1, 'pii-1',
          'TEST_TDB_USERS_JP_0001_PII', 'resource-c', 'active', 1, 1);`
    );
  });

  afterEach(() => database.close());

  function env(): ControlEnv {
    return {
      CONTROL_DB: d1(database),
      TENANT_RUNTIME_REGISTRY: {
        get: async (key: string) => values.get(key) ?? null,
        put: vi.fn(async (key: string, value: string) => {
          writes.push(key);
          values.set(key, value);
        }),
      } as unknown as KVNamespace,
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: JSON.stringify(privateJwk),
      RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT: 'A',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key-a',
    } as unknown as ControlEnv;
  }

  it('publishes only active tenant-core shards before the generation pointer', async () => {
    await expect(
      new PluginRunnerRegistryPublisher(env(), () => now).publishEnvironment('test')
    ).resolves.toEqual({ environmentId: 'test', generation: 1, status: 'published' });
    expect(writes).toEqual([
      buildPluginRunnerRegistrySnapshotKey('test'),
      buildPluginRunnerRegistryGenerationKey('test'),
    ]);
    const token = values.get(buildPluginRunnerRegistrySnapshotKey('test'));
    if (!token) throw new Error('missing_test_snapshot');
    await expect(
      verifyPluginRunnerRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now,
      })
    ).resolves.toMatchObject({
      generation: 1,
      shards: [
        expect.objectContaining({ shardId: 'shard-a', dataRole: 'tenant_core/default' }),
        expect.objectContaining({ shardId: 'shard-b', dataRole: 'tenant_core/users' }),
      ],
    });
  });

  it('does not republish an unchanged inventory before its refresh window', async () => {
    const publisher = new PluginRunnerRegistryPublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    writes = [];
    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 1,
      status: 'unchanged',
    });
    expect(writes).toEqual([]);
  });

  it('increments generation after the active shard inventory changes', async () => {
    const publisher = new PluginRunnerRegistryPublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    database.exec(`UPDATE control_tenant_shards SET status = 'retired' WHERE shard_id = 'shard-a'`);
    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 2,
      status: 'published',
    });
  });
});
