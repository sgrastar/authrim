import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_SMOKE_LOOKUP_METADATA_KEY,
  type ReleaseArtifactStore,
} from '@authrim/ar-lib-core/control-plane';
import {
  executeSetupControlOperatorCreate,
  executeSetupControlOperatorMigration,
  type SetupOperatorD1Client,
} from '../core/control-operator-executor';
import { listPendingControlOperatorOperations } from '../core/control-operator-operations';

type SqlValue = string | number | bigint | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENV = 'env-test';
const LOOKUP_SQL = `CREATE TABLE lookup_schema_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;
const MANIFEST = `${JSON.stringify({
  formatVersion: 2,
  productVersion: '0.4.2',
  streams: [
    {
      id: 'lookup-d1',
      schemaFamily: 'lookup',
      dialect: 'sqlite',
      targetKind: 'cloudflare-d1',
      logicalRoles: ['lookup'],
      files: [
        { path: '001_lookup.sql', checksum: createHash('sha256').update(LOOKUP_SQL).digest('hex') },
      ],
    },
  ],
})}\n`;
const DIGEST = createHash('sha256').update(MANIFEST).digest('hex');
const OPERATION = 'op_26349f8b2e439a9c077e06b692c71ea0';
const DESIRED = 'd1_26349f8b2e439a9c077e06b692c71ea0';
const SHARD = 'lookup_26349f8b2e439a9c077e06b692c71ea0';
const DATABASE_NAME = 'env-test-authrim-tenant-lookup-default-db-26349f8b';
const DATABASE_ID = '11111111-1111-4111-8111-111111111111';

function statementResult(database: DatabaseSync, sql: string, params: unknown[] = []) {
  const statement = database.prepare(sql);
  const values = params as SqlValue[];
  if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql))
    return { success: true, results: statement.all(...values), meta: { changes: 0 } };
  const run = statement.run(...values);
  return { success: true, results: [], meta: { changes: Number(run.changes) } };
}

function batchOn(database: DatabaseSync, batch: readonly { sql: string; params?: unknown[] }[]) {
  database.exec('BEGIN');
  try {
    const results = batch.map(({ sql, params }) => statementResult(database, sql, params));
    database.exec('COMMIT');
    return results;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

const artifactStore: ReleaseArtifactStore = {
  get: async (key) => {
    const value = new Map([
      [`releases/0.4.2/${DIGEST}/manifest.json`, MANIFEST],
      [`releases/0.4.2/${DIGEST}/streams/lookup-d1/001_lookup.sql`, LOOKUP_SQL],
    ]).get(key);
    if (value === undefined) return null;
    const bytes = new TextEncoder().encode(value);
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  },
};

/** The Cloudflare side of the setup operator: Control and the new lookup D1, both on SQLite. */
function client(
  control: DatabaseSync,
  lookup: DatabaseSync,
  existing: string[] = []
): SetupOperatorD1Client & { created: string[] } {
  const target = (databaseId: string) => {
    if (databaseId === 'control-db') return control;
    if (databaseId === DATABASE_ID) return lookup;
    throw new Error(`unexpected_database:${databaseId}`);
  };
  const databases: Array<{
    uuid: string;
    name: string;
    read_replication: { mode: 'auto' | 'disabled' };
  }> = existing.map((name) => ({
    uuid: DATABASE_ID,
    name,
    read_replication: { mode: 'disabled' },
  }));
  const created: string[] = [];
  return {
    created,
    async listD1Databases() {
      return [...databases];
    },
    async getD1Database(id: string) {
      const found = databases.find(({ uuid }) => uuid === id);
      if (!found) throw new Error('not_found');
      return found;
    },
    async createD1Database(input: { name: string }) {
      const database = {
        uuid: DATABASE_ID,
        name: input.name,
        read_replication: { mode: 'disabled' as const },
      };
      databases.push(database);
      created.push(input.name);
      return database;
    },
    async updateD1Database() {
      throw new Error('unused');
    },
    async queryD1(databaseId: string, sql: string, params?: unknown[]) {
      return [statementResult(target(databaseId), sql, params)];
    },
    async queryD1Batch(databaseId, batch) {
      return batchOn(target(databaseId), batch);
    },
  } as unknown as SetupOperatorD1Client & { created: string[] };
}

/** A lookup shard as Control requests it (createShardPlan), handed to the operator. */
function requestLookupShard(control: DatabaseSync) {
  control.exec(`
    INSERT INTO control_environments (environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at)
      VALUES ('${ENV}', 'test', 'urn:authrim:control:${ENV}', 'active', 1, 1);
    INSERT INTO control_environment_resource_policies (environment_id, max_concurrent_provisioning,
      max_ready_spares, max_d1_resources, daily_d1_create_budget, target_account_count, created_at, updated_at)
      VALUES ('${ENV}', 2, 2, 10, 5, 100000, 1, 1);
    INSERT INTO control_residency_partitions (environment_id, residency_policy_id, residency_partition,
      location_hint, status, created_at, updated_at)
      VALUES ('${ENV}', 'default', 'default', NULL, 'active', 1, 1);
    INSERT INTO control_operations (operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, completed_at, updated_at)
      VALUES ('op-release', '${ENV}', 'register_migration_release', 'release:0.4.2', 'succeeded', 'setup', 1, 1, 1, 1);
    INSERT INTO control_migration_release_catalog (environment_id, stream_id, release_id, manifest_digest,
      manifest_r2_object_key, state, active_stream_key, registered_by_operation_id, registered_by_actor_id,
      registered_at, activated_at)
      VALUES ('${ENV}', 'lookup-d1', '0.4.2', '${DIGEST}', 'releases/0.4.2/${DIGEST}/manifest.json',
        'active', 'active', 'op-release', 'setup:test', 1, 1);
    INSERT INTO control_operations (operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, updated_at, release_id, release_stream_id, release_manifest_digest)
      VALUES ('${OPERATION}', '${ENV}', 'provision_shard', 'lookup:default', 'queued', 'scheduler', 0, 10, 10,
        '0.4.2', 'lookup-d1', '${DIGEST}');
    INSERT INTO control_operation_release_pins (operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at)
      VALUES ('${OPERATION}', '${ENV}', 'lookup-d1', '0.4.2', '${DIGEST}', 10);
  `);
  for (const [step, order] of [
    ['create_d1', 10],
    ['apply_migrations', 20],
    ['reconcile_worker_bindings', 30],
    ['smoke_bindings', 40],
    ['stabilize_bindings', 50],
  ] as const)
    control
      .prepare(
        `INSERT INTO control_operation_steps (operation_id, step_key, display_order, status, attempt_count, updated_at)
         VALUES (?, ?, ?, 'queued', 0, 10)`
      )
      .run(OPERATION, step, order);
  control
    .prepare(
      `INSERT INTO control_desired_resources (desired_resource_id, environment_id, resource_kind,
         logical_shard_id, resource_scope, tenant_id, deterministic_name, ownership_fingerprint,
         provisioning_state, origin_operation_id, desired_spec_json, created_at, updated_at)
       VALUES (?, ?, 'd1', ?, 'platform', NULL, ?, ?, 'requested', ?, ?, 10, 10)`
    )
    .run(
      DESIRED,
      ENV,
      SHARD,
      DATABASE_NAME,
      'b'.repeat(64),
      OPERATION,
      JSON.stringify({
        data_role: 'lookup',
        residency_policy_id: 'default',
        residency_partition: 'default',
        read_replication_mode: 'disabled',
        allocation_scope: 'shared_pool',
        owner_tenant_id: null,
      })
    );
  control
    .prepare(
      `INSERT INTO control_lookup_physical_shards (lookup_shard_id, environment_id, residency_partition,
         binding_ref, d1_desired_resource_id, status, created_at, updated_at)
       VALUES (?, ?, 'default', 'ENV_TEST_TDB_LOOKUP_26349F8B_LOOKUP', ?, 'requested', 10, 10)`
    )
    .run(SHARD, ENV, DESIRED);
  control
    .prepare(
      `INSERT INTO control_tenant_database_migration_state (desired_resource_id, environment_id,
         operation_id, stream_id, release_id, manifest_digest, state, applied_file_count, updated_at)
       VALUES (?, ?, ?, 'lookup-d1', '0.4.2', ?, 'requested', 0, 10)`
    )
    .run(DESIRED, ENV, OPERATION, DIGEST);
  // markOperationAwaitingOperator: automatic provisioning is off.
  control.exec(`
    UPDATE control_operations SET status = 'blocked', next_attempt_at = NULL,
      last_error_code = 'operator_action_required', lock_owner = NULL, lock_expires_at = NULL, updated_at = 11
     WHERE operation_id = '${OPERATION}';
    UPDATE control_operation_steps SET status = 'blocked', next_attempt_at = NULL,
      last_error_code = 'operator_action_required', updated_at = 11
     WHERE operation_id = '${OPERATION}';
  `);
}

describe('setup operator on a lookup shard', () => {
  let control: DatabaseSync;
  let lookup: DatabaseSync;
  beforeEach(() => {
    control = new DatabaseSync(':memory:');
    lookup = new DatabaseSync(':memory:');
    control.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    requestLookupShard(control);
  });
  afterEach(() => {
    control.close();
    lookup.close();
  });

  const pending = async () => {
    const [operation] = await listPendingControlOperatorOperations({
      controlDatabaseName: 'control-db',
      query: async <T>(_name: string, sql: string) => control.prepare(sql).all() as T[],
    });
    return operation;
  };
  const stepStatus = (step: string) =>
    control
      .prepare('SELECT status FROM control_operation_steps WHERE operation_id = ? AND step_key = ?')
      .get(OPERATION, step);
  const shardStatus = () =>
    control
      .prepare('SELECT status FROM control_lookup_physical_shards WHERE lookup_shard_id = ?')
      .get(SHARD);

  it('creates the D1 of a lookup physical shard and moves it to provisioning', async () => {
    const operation = await pending();
    expect(operation).toMatchObject({ operationId: OPERATION, dataRole: 'lookup', shardId: SHARD });
    const operator = client(control, lookup);
    const result = await executeSetupControlOperatorCreate({
      controlDatabaseId: 'control-db',
      operation,
      client: operator,
      now: () => 100,
    });
    expect(operator.created).toEqual([DATABASE_NAME]);
    expect(result).toMatchObject({ operationId: OPERATION });
    expect(shardStatus()).toEqual({ status: 'provisioning' });
    expect(
      control
        .prepare(
          `SELECT o.observed_state, o.provider_resource_id, m.provider_database_id
             FROM control_observed_resources o
             JOIN control_tenant_database_migration_state m ON m.desired_resource_id = o.desired_resource_id
            WHERE o.desired_resource_id = ?`
        )
        .get(DESIRED)
    ).toEqual({
      observed_state: 'present',
      provider_resource_id: DATABASE_ID,
      provider_database_id: DATABASE_ID,
    });
    expect(stepStatus('create_d1')).toEqual({ status: 'succeeded' });
  });

  it('takes over a create whose operator lease expired, and leaves a live one alone', async () => {
    // The state a failed claim left behind: Control's rows say running under an old setup lease.
    const leave = (expiresAt: string) =>
      control.exec(`
        UPDATE control_operations SET status = 'running', last_error_code = NULL,
          lock_owner = 'setup:previous', lock_expires_at = ${expiresAt}, attempt_count = 1,
          fencing_token = 1, updated_at = 12
         WHERE operation_id = '${OPERATION}';
        UPDATE control_operation_steps SET status = 'running', last_error_code = NULL, attempt_count = 1
         WHERE operation_id = '${OPERATION}' AND step_key = 'create_d1';
        UPDATE control_desired_resources SET provisioning_state = 'creating', create_started_at = 12
         WHERE desired_resource_id = '${DESIRED}';
      `);
    leave('unixepoch() + 300');
    expect(await pending()).toBeUndefined();

    leave('50');
    const operation = await pending();
    expect(operation).toMatchObject({ status: 'running', currentStep: 'create_d1' });
    const operator = client(control, lookup);
    await create(operator);
    expect(operator.created).toEqual([DATABASE_NAME]);
    expect(shardStatus()).toEqual({ status: 'provisioning' });
    expect(stepStatus('create_d1')).toEqual({ status: 'succeeded' });
    expect(
      control
        .prepare(
          'SELECT attempt_count, fencing_token FROM control_operations WHERE operation_id = ?'
        )
        .get(OPERATION)
    ).toEqual({ attempt_count: 2, fencing_token: 2 });
  });

  it('resumes from the create checkpoint read under the new lease, not from the listing', async () => {
    // The previous operator issued the create, and its lease expired.
    control.exec(`
      UPDATE control_operations SET status = 'running', last_error_code = NULL,
        lock_owner = 'setup:previous', lock_expires_at = 50, attempt_count = 1,
        fencing_token = 1, updated_at = 12
       WHERE operation_id = '${OPERATION}';
      UPDATE control_operation_steps SET status = 'running', last_error_code = NULL
       WHERE operation_id = '${OPERATION}' AND step_key = 'create_d1';
      UPDATE control_desired_resources SET provisioning_state = 'creating',
        provider_create_state = 'issued', create_started_at = 12
       WHERE desired_resource_id = '${DESIRED}';
    `);
    const operation = await pending();
    expect(operation).toMatchObject({ providerCreateState: 'issued' });
    // The previous operator records the created D1 after the listing was read.
    control
      .prepare(
        `UPDATE control_desired_resources SET provider_create_state = 'identified',
           provider_resource_id = ?, provider_identity_checkpointed_at = 12
         WHERE desired_resource_id = ?`
      )
      .run(DATABASE_ID, DESIRED);
    const operator = client(control, lookup, [DATABASE_NAME]);
    await expect(
      executeSetupControlOperatorCreate({
        controlDatabaseId: 'control-db',
        operation: operation!,
        client: operator,
        now: () => 100,
      })
    ).resolves.toMatchObject({ operationId: OPERATION });
    expect(operator.created).toEqual([]);
    expect(stepStatus('create_d1')).toEqual({ status: 'succeeded' });
  });

  it('takes over a migration whose operator lease expired while applying', async () => {
    const operator = client(control, lookup);
    await create(operator);
    control.exec(`
      UPDATE control_operations SET status = 'running', last_error_code = NULL,
        lock_owner = 'setup:previous', lock_expires_at = 50, updated_at = 150
       WHERE operation_id = '${OPERATION}';
      UPDATE control_operation_steps SET status = 'running', last_error_code = NULL
       WHERE operation_id = '${OPERATION}' AND step_key = 'apply_migrations';
      UPDATE control_tenant_database_migration_state SET state = 'applying'
       WHERE desired_resource_id = '${DESIRED}';
    `);
    expect(await pending()).toMatchObject({ status: 'running', currentStep: 'apply_migrations' });
    await expect(migrate(operator)).resolves.toMatchObject({ state: 'awaiting_worker_bindings' });
    expect(stepStatus('apply_migrations')).toEqual({ status: 'succeeded' });
  });

  const create = async (operator: ReturnType<typeof client>) =>
    executeSetupControlOperatorCreate({
      controlDatabaseId: 'control-db',
      operation: await pending(),
      client: operator,
      now: () => 100,
    });
  const migrate = async (operator: ReturnType<typeof client>) =>
    executeSetupControlOperatorMigration({
      controlDatabaseId: 'control-db',
      migrationReleaseBucketName: 'unused',
      operation: await pending(),
      client: operator,
      artifactStore,
      now: () => 200,
    });

  it('migrates the lookup D1 and records the runtime smoke metadata in the lookup table', async () => {
    const operator = client(control, lookup);
    await create(operator);
    const operation = await pending();
    expect(operation).toMatchObject({
      currentStep: 'apply_migrations',
      migration: { databaseId: DATABASE_ID, streamId: 'lookup-d1', manifestDigest: DIGEST },
    });
    await expect(migrate(operator)).resolves.toMatchObject({
      operationId: OPERATION,
      state: 'awaiting_worker_bindings',
    });
    const [row] = lookup
      .prepare('SELECT metadata_key, metadata_value FROM lookup_schema_metadata')
      .all() as Array<{ metadata_key: string; metadata_value: string }>;
    expect(row?.metadata_key).toBe(RUNTIME_SMOKE_LOOKUP_METADATA_KEY);
    expect(JSON.parse(row?.metadata_value ?? '')).toEqual({
      binding_ref: 'ENV_TEST_TDB_LOOKUP_26349F8B_LOOKUP',
      data_role: 'lookup',
      residency_partition: 'default',
      migration_generation: operation?.migration?.generation,
      release_id: '0.4.2',
      manifest_digest: DIGEST,
      expected_file_count: 1,
      last_filename: '001_lookup.sql',
    });
    expect(shardStatus()).toEqual({ status: 'ready' });
    expect(stepStatus('apply_migrations')).toEqual({ status: 'succeeded' });
    expect(stepStatus('reconcile_worker_bindings')).toEqual({ status: 'blocked' });
  });

  it('does not mark the migration done when the metadata does not read back', async () => {
    const operator = client(control, lookup);
    await create(operator);
    // The migration creates the table; corrupt every write to it afterwards.
    const original = operator.queryD1Batch.bind(operator);
    operator.queryD1Batch = async (databaseId, batch) => {
      if (batch.some(({ sql }) => sql.includes('INSERT INTO lookup_schema_metadata')))
        lookup.exec(`CREATE TRIGGER IF NOT EXISTS corrupt AFTER INSERT ON lookup_schema_metadata
          BEGIN UPDATE lookup_schema_metadata SET metadata_value = '{' WHERE metadata_key = NEW.metadata_key; END`);
      return original(databaseId, batch);
    };
    const result = await migrate(operator);
    expect(result.state).not.toBe('awaiting_worker_bindings');
    expect(result.errorCode).toBe('control_migration_metadata_write_failed');
    expect(shardStatus()).toEqual({ status: 'provisioning' });
    expect(stepStatus('apply_migrations')).not.toEqual({ status: 'succeeded' });
  });
});
