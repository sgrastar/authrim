import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  verifyLookupShardRegistry,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LookupRegistryPublisher } from '../lookup-registry-publisher';
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

describe('LookupRegistryPublisher', () => {
  let database: DatabaseSync;
  let privateJwk: JWK;
  let publicJwk: JWK;
  let now: number;
  let values: Map<string, string>;
  let writes: string[];
  let failGenerationWrite: boolean;
  let adoptGenerationWrite: boolean;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'registry-key-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'registry-key-a', alg: 'EdDSA' };
  });

  beforeEach(() => {
    now = 1_800_000_000;
    values = new Map();
    writes = [];
    failGenerationWrite = false;
    adoptGenerationWrite = false;
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
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         created_at, updated_at
       ) VALUES ('test', 2, 2, 10, 10, 100000, 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (
         'seed-operation', 'test', 'provision_shard', 'seed-lookup', 'succeeded',
         'setup', 1, 1, 1, 1
       );
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, provider_create_state,
         provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES (
         'lookup-resource-1', 'test', 'd1', 'lookup-1', 'lookup-1',
         'lookup-fingerprint-1', 'ready', 'seed-operation', '{}', 'identified',
         'lookup-database-1', 1, 1, 1
       );
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES (
         'lookup-1', 'test', 'global', 'LOOKUP_DB_1', 'lookup-resource-1', 'active', 1, 1
       );
       WITH RECURSIVE buckets(bucket) AS (
         SELECT 0 UNION ALL SELECT bucket + 1 FROM buckets WHERE bucket < 4095
       )
       INSERT INTO control_lookup_bucket_assignments (
         environment_id, virtual_bucket, lookup_shard_id, assignment_generation,
         state, updated_at
       ) SELECT 'test', bucket, 'lookup-1', 1, 'active', 1 FROM buckets;`
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
          if (failGenerationWrite && key.endsWith(':generation')) {
            failGenerationWrite = false;
            throw new Error('simulated_kv_response_loss');
          }
          values.set(key, value);
          if (adoptGenerationWrite && key.endsWith(':generation')) {
            adoptGenerationWrite = false;
            database.exec(
              `UPDATE control_lookup_registry_publications SET status = 'active' WHERE status = 'publishing'`
            );
          }
        }),
      } as unknown as KVNamespace,
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: JSON.stringify(privateJwk),
      RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT: 'A',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key-a',
    } as unknown as ControlEnv;
  }

  it('publishes one compressed full-range snapshot before its generation pointer', async () => {
    const result = await new LookupRegistryPublisher(env(), () => now).publishEnvironment('test');

    expect(result).toEqual({ environmentId: 'test', generation: 1, status: 'published' });
    expect(writes).toEqual([
      buildLookupShardRegistrySnapshotKey('test'),
      buildLookupShardRegistryGenerationKey('test'),
    ]);
    const token = values.get(buildLookupShardRegistrySnapshotKey('test'));
    if (!token) throw new Error('missing_test_snapshot');
    await expect(
      verifyLookupShardRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now,
      })
    ).resolves.toMatchObject({
      generation: 1,
      ranges: [
        {
          startBucket: 0,
          endBucket: 4095,
          assignmentGeneration: 1,
          lookupShardId: 'lookup-1',
          bindingRef: 'LOOKUP_DB_1',
        },
      ],
    });
  });

  it('does not republish an unchanged snapshot outside the refresh window', async () => {
    const publisher = new LookupRegistryPublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    writes = [];

    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 1,
      status: 'unchanged',
    });
    expect(writes).toEqual([]);
  });

  it('republishes an active Control record when either KV value is missing', async () => {
    const publisher = new LookupRegistryPublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    values.delete(buildLookupShardRegistrySnapshotKey('test'));
    writes = [];

    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 1,
      status: 'resumed',
    });
    expect(writes).toEqual([
      buildLookupShardRegistrySnapshotKey('test'),
      buildLookupShardRegistryGenerationKey('test'),
    ]);
  });

  it('resumes the exact prepared JWS after a generation-pointer write failure', async () => {
    const workerEnv = env();
    const publisher = new LookupRegistryPublisher(workerEnv, () => now);
    failGenerationWrite = true;

    await expect(publisher.publishEnvironment('test')).rejects.toThrow(
      'simulated_kv_response_loss'
    );
    const preparedToken = database
      .prepare(`SELECT snapshot_jws FROM control_lookup_registry_publications`)
      .get() as { snapshot_jws: string };
    expect(
      database.prepare(`SELECT status FROM control_lookup_registry_publications`).get()
    ).toEqual({ status: 'publishing' });

    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 1,
      status: 'resumed',
    });
    expect(values.get(buildLookupShardRegistrySnapshotKey('test'))).toBe(
      preparedToken.snapshot_jws
    );
    expect(
      database.prepare(`SELECT status FROM control_lookup_registry_publications`).get()
    ).toEqual({ status: 'active' });
  });

  it('refreshes an expiring unchanged mapping with a new publication generation', async () => {
    const publisher = new LookupRegistryPublisher(env(), () => now);
    await publisher.publishEnvironment('test');
    now += 1201;

    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 2,
      status: 'published',
    });
    expect(values.get(buildLookupShardRegistryGenerationKey('test'))).toBe('2');
  });

  it('replaces an expiring prepared publication instead of resending a stale generation', async () => {
    const publisher = new LookupRegistryPublisher(env(), () => now);
    failGenerationWrite = true;
    await expect(publisher.publishEnvironment('test')).rejects.toThrow(
      'simulated_kv_response_loss'
    );
    now += 1201;

    await expect(publisher.publishEnvironment('test')).resolves.toEqual({
      environmentId: 'test',
      generation: 2,
      status: 'published',
    });
    expect(values.get(buildLookupShardRegistryGenerationKey('test'))).toBe('2');
  });

  it('adopts an identical publication completed by an overlapping invocation', async () => {
    adoptGenerationWrite = true;

    await expect(
      new LookupRegistryPublisher(env(), () => now).publishEnvironment('test')
    ).resolves.toEqual({ environmentId: 'test', generation: 1, status: 'published' });
    expect(
      database.prepare(`SELECT status FROM control_lookup_registry_publications`).get()
    ).toEqual({ status: 'active' });
  });

  it('uses only the configured active private-key slot', async () => {
    const workerEnv = env();
    workerEnv.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A = '{not-json';
    workerEnv.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B = JSON.stringify(privateJwk);
    workerEnv.RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT = 'B';

    await expect(
      new LookupRegistryPublisher(workerEnv, () => now).publishEnvironment('test')
    ).resolves.toMatchObject({ generation: 1, status: 'published' });
  });

  it('rejects an active key ID mismatch before writing KV', async () => {
    const workerEnv = env();
    workerEnv.TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID = 'different-key';

    await expect(
      new LookupRegistryPublisher(workerEnv, () => now).publishEnvironment('test')
    ).rejects.toThrow('lookup_registry_signing_key_id_mismatch');
    expect(writes).toEqual([]);
  });

  it('fails closed without writing KV when bucket coverage is incomplete', async () => {
    database.exec(`DELETE FROM control_lookup_bucket_assignments WHERE virtual_bucket = 4095`);
    const workerEnv = env();

    await expect(
      new LookupRegistryPublisher(workerEnv, () => now).publishEnvironment('test')
    ).rejects.toThrow('lookup_registry_assignment_coverage_incomplete');
    expect(writes).toEqual([]);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_lookup_registry_publications`).get()
    ).toEqual({ count: 0 });
  });

  it('defers scheduled publication until every bucket resolves to an active shard', async () => {
    database.exec(`UPDATE control_lookup_physical_shards SET status = 'provisioning'`);
    const publisher = new LookupRegistryPublisher(env(), () => now);

    await expect(publisher.reconcile()).resolves.toEqual([]);
    expect(writes).toEqual([]);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_lookup_registry_publications`).get()
    ).toEqual({ count: 0 });

    await expect(publisher.publishEnvironment('test')).rejects.toThrow(
      'lookup_registry_assignment_coverage_incomplete'
    );
  });
});
