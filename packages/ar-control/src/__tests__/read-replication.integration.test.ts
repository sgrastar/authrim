import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareD1Database } from '@authrim/ar-lib-core/control-plane';
import { ReadReplicationService } from '../read-replication';

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
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN');
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

function seedEnvironment(database: DatabaseSync, environmentId = 'test'): void {
  database.exec(
    `INSERT INTO control_environments (
       environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
     ) VALUES ('${environmentId}', '${environmentId}', 'urn:authrim:control:${environmentId}', 'active', 1, 1);
     INSERT INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key, status,
       requested_by_type, attempt_count, created_at, started_at, completed_at, updated_at
     ) VALUES ('bootstrap-${environmentId}', '${environmentId}', 'bootstrap', 'bootstrap',
       'succeeded', 'setup', 1, 1, 1, 1, 1);
     INSERT INTO control_environment_resource_policies (
       environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
       daily_d1_create_budget, target_account_count, created_at, updated_at
     ) VALUES ('${environmentId}', 2, 2, 1000, 20, 100000, 1, 1);
     INSERT INTO control_residency_partitions (
       environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
     ) VALUES ('${environmentId}', 'builtin:residency:default', 'default', 'active', 1, 1);`
  );
}

function addResource(
  database: DatabaseSync,
  input: {
    environmentId?: string;
    id: string;
    role: 'lookup' | 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
    residencyPartition?: string;
  }
): void {
  const environmentId = input.environmentId ?? 'test';
  const residencyPartition = input.residencyPartition ?? 'default';
  const desiredId = `desired-${environmentId}-${input.id}`;
  const observedId = `observed-${environmentId}-${input.id}`;
  database.exec(
    `INSERT INTO control_desired_resources (
       desired_resource_id, environment_id, resource_kind, logical_shard_id,
       deterministic_name, ownership_fingerprint, provisioning_state,
       origin_operation_id, provider_create_state, provider_resource_id,
       provider_identity_checkpointed_at, created_at, updated_at
     ) VALUES ('${desiredId}', '${environmentId}', 'd1', '${input.id}',
       '${environmentId}-${input.id}', 'owner-${input.id}', 'active',
       'bootstrap-${environmentId}', 'identified', 'db-${environmentId}-${input.id}', 1, 1, 1);
     INSERT INTO control_observed_resources (
       observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
       provider_name, resource_kind, observed_state, observed_at
     ) VALUES ('${observedId}', '${environmentId}', '${desiredId}', 'db-${environmentId}-${input.id}',
       'cloudflare', 'd1', 'present', 1);
     UPDATE control_desired_resources SET observed_resource_id = '${observedId}'
      WHERE desired_resource_id = '${desiredId}';`
  );
  if (input.role === 'lookup') {
    database.exec(
      `INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('${input.id}', '${environmentId}', '${residencyPartition}', 'LOOKUP_${input.id.toUpperCase()}',
         '${desiredId}', 'active', 1, 1)`
    );
    return;
  }
  database.exec(
    `INSERT INTO control_tenant_shards (
       shard_id, environment_id, data_role, residency_policy_id, residency_partition,
       generation, logical_shard_id, binding_ref, d1_desired_resource_id,
       status, created_at, updated_at
     ) VALUES ('${input.id}', '${environmentId}', '${input.role}', 'builtin:residency:${residencyPartition}',
       '${residencyPartition}', 1, '${input.id}', 'TDB_${input.id.toUpperCase()}', '${desiredId}', 'active', 1, 1)`
  );
}

function providerApi(states: Map<string, 'auto' | 'disabled'>) {
  return {
    getD1Database: vi.fn(
      async (databaseId: string): Promise<CloudflareD1Database> => ({
        uuid: databaseId,
        name: databaseId,
        read_replication: { mode: states.get(databaseId) ?? 'disabled' },
      })
    ),
    updateD1Database: vi.fn(
      async (
        databaseId: string,
        input: { read_replication: { mode: 'auto' | 'disabled' } }
      ): Promise<CloudflareD1Database> => {
        states.set(databaseId, input.read_replication.mode);
        return {
          uuid: databaseId,
          name: databaseId,
          read_replication: { mode: input.read_replication.mode },
        };
      }
    ),
  };
}

describe('ReadReplicationService', () => {
  let database: DatabaseSync;
  let now: number;
  let ids: number;
  let states: Map<string, 'auto' | 'disabled'>;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    seedEnvironment(database);
    addResource(database, { id: 'lookup-1', role: 'lookup' });
    addResource(database, { id: 'default-1', role: 'tenant_core/default' });
    addResource(database, { id: 'users-1', role: 'tenant_core/users' });
    addResource(database, { id: 'pii-1', role: 'tenant_pii' });
    now = 100;
    ids = 0;
    states = new Map();
  });

  afterEach(() => database.close());

  it('enables every eligible role and verifies reflected provider state before convergence', async () => {
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );

    await expect(service.getStatus('test')).resolves.toMatchObject({
      desiredMode: 'disabled',
      aggregateStatus: 'off',
      eligiblePolicyCount: 0,
    });
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'enable-1',
      requestedById: 'admin-1',
    });
    expect(started).toMatchObject({
      desiredMode: 'enabled',
      aggregateStatus: 'updating',
      eligiblePolicyCount: 4,
      targetCount: 4,
      pendingTargetCount: 4,
    });

    await expect(service.reconcile(10, started.operationId ?? undefined)).resolves.toBe(4);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      desiredMode: 'enabled',
      aggregateStatus: 'on',
      operationStatus: 'succeeded',
      convergedPolicyCount: 4,
      targetCount: 4,
      convergedTargetCount: 4,
      pendingTargetCount: 0,
      failedTargetCount: 0,
    });
    expect(api.updateD1Database).toHaveBeenCalledTimes(4);
    expect(api.getD1Database).toHaveBeenCalledTimes(8);
    expect([...states.values()]).toEqual(['auto', 'auto', 'auto', 'auto']);
  });

  it('keeps idempotent retries stable and rejects conflicting or concurrent rollouts', async () => {
    const service = new ReadReplicationService(
      d1(database),
      providerApi(states),
      () => now,
      () => `id-${++ids}`
    );
    const request = {
      desiredMode: 'enabled' as const,
      idempotencyKey: 'same-request',
      requestedById: 'admin-1',
    };
    const first = await service.start('test', request);
    await expect(service.start('test', request)).resolves.toMatchObject({
      operationId: first.operationId,
    });
    await expect(service.start('test', { ...request, desiredMode: 'disabled' })).rejects.toThrow(
      'read_replication_rollout_idempotency_conflict'
    );
    await expect(
      service.start('test', { ...request, idempotencyKey: 'second-request' })
    ).rejects.toThrow('read_replication_rollout_in_progress');
  });

  it('retries transient provider failures without reporting attention until the budget expires', async () => {
    const api = providerApi(states);
    api.getD1Database.mockRejectedValueOnce(new Error('provider timeout'));
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'retry-1',
      requestedById: 'admin-1',
    });

    await expect(service.reconcile(1, started.operationId ?? undefined)).resolves.toBe(1);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'updating',
      failedTargetCount: 0,
    });
    now += 31;
    await service.reconcile(10, started.operationId ?? undefined);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'on',
      operationStatus: 'succeeded',
    });
  });

  it('adds a physical D1 created while the rollout is active before declaring success', async () => {
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'catch-up-1',
      requestedById: 'admin-1',
    });
    addResource(database, { id: 'users-2', role: 'tenant_core/users' });

    await service.reconcile(10, started.operationId ?? undefined);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'on',
      targetCount: 5,
      convergedTargetCount: 5,
    });
    expect(states.get('db-test-users-2')).toBe('auto');
  });

  it('fails closed after the two-hour retry budget without exposing provider error text', async () => {
    const api = providerApi(states);
    api.getD1Database.mockRejectedValue(new Error('Bearer secret-provider-detail'));
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'blocked-1',
      requestedById: 'admin-1',
    });
    now += 2 * 60 * 60;
    await service.reconcile(1, started.operationId ?? undefined);

    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'attention_required',
      operationStatus: 'attention_required',
      failedPolicyCount: 1,
      failedTargetCount: 1,
    });
    const stored = database
      .prepare(
        `SELECT last_error_code FROM control_read_replication_rollout_targets
          WHERE status = 'blocked'`
      )
      .get() as { last_error_code: string };
    expect(stored.last_error_code).toBe('read_replication_provider_request_failed');
    expect(JSON.stringify(stored)).not.toContain('secret-provider-detail');
  });

  it('isolates environment policy and target state', async () => {
    seedEnvironment(database, 'other');
    addResource(database, { environmentId: 'other', id: 'lookup-other', role: 'lookup' });
    const service = new ReadReplicationService(
      d1(database),
      providerApi(states),
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'isolated-1',
      requestedById: 'admin-1',
    });
    await service.reconcile(10, started.operationId ?? undefined);

    await expect(service.getStatus('other')).resolves.toMatchObject({
      desiredMode: 'disabled',
      aggregateStatus: 'off',
      eligiblePolicyCount: 0,
      targetCount: 0,
    });
    expect(states.has('db-other-lookup-other')).toBe(false);
  });

  it('excludes resources in inactive residency partitions from the environment rollout', async () => {
    database.exec(
      `INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
       ) VALUES ('test', 'builtin:residency:archive', 'archive', 'disabled', 1, 1);`
    );
    addResource(database, {
      id: 'users-archive',
      role: 'tenant_core/users',
      residencyPartition: 'archive',
    });
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'active-partitions-only',
      requestedById: 'admin-1',
    });

    expect(started).toMatchObject({ eligiblePolicyCount: 4, targetCount: 4 });
    await service.reconcile(10, started.operationId ?? undefined);
    expect(states.has('db-test-users-archive')).toBe(false);
    expect(
      database
        .prepare(
          `SELECT read_replication_mode, observed_replication_state
             FROM control_tenant_shards WHERE shard_id = 'users-archive'`
        )
        .get()
    ).toMatchObject({ read_replication_mode: 'disabled', observed_replication_state: 'unknown' });
  });

  it('disables the same resources through the same architecture', async () => {
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const enabled = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'enable-before-disable',
      requestedById: 'admin-1',
    });
    await service.reconcile(10, enabled.operationId ?? undefined);
    now += 1;
    const disabled = await service.start('test', {
      desiredMode: 'disabled',
      idempotencyKey: 'disable-1',
      requestedById: 'admin-1',
    });
    await service.reconcile(10, disabled.operationId ?? undefined);

    await expect(service.getStatus('test')).resolves.toMatchObject({
      desiredMode: 'disabled',
      aggregateStatus: 'off',
      operationStatus: 'succeeded',
      convergedTargetCount: 4,
    });
    expect([...states.values()]).toEqual(['disabled', 'disabled', 'disabled', 'disabled']);
  });

  it('fences a stale reconciler after its target lease expires', async () => {
    let releaseFirst: ((value: CloudflareD1Database) => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolveStarted) => {
      firstStarted = resolveStarted;
    });
    let getCount = 0;
    const api = providerApi(states);
    api.getD1Database.mockImplementation(async (databaseId: string) => {
      getCount += 1;
      if (getCount === 1) {
        firstStarted?.();
        return new Promise<CloudflareD1Database>((resolveFirst) => {
          releaseFirst = resolveFirst;
        });
      }
      return {
        uuid: databaseId,
        name: databaseId,
        read_replication: { mode: states.get(databaseId) ?? 'disabled' },
      };
    });
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'lease-1',
      requestedById: 'admin-1',
    });
    const staleRun = service.reconcile(1, started.operationId ?? undefined);
    await startedPromise;
    now += 91;
    await service.reconcile(1, started.operationId ?? undefined);
    releaseFirst?.({
      uuid: 'db-test-default-1',
      name: 'db-test-default-1',
      read_replication: { mode: 'disabled' },
    });
    await staleRun;

    const target = database
      .prepare(
        `SELECT status, fencing_token, last_error_code
           FROM control_read_replication_rollout_targets
          WHERE operation_id = ? AND desired_resource_id = 'desired-test-default-1'`
      )
      .get(started.operationId) as {
      status: string;
      fencing_token: number;
      last_error_code: string | null;
    };
    expect(target).toEqual({ status: 'succeeded', fencing_token: 2, last_error_code: null });
  });

  it('rejects unknown environments instead of returning a misleading off state', async () => {
    const service = new ReadReplicationService(
      d1(database),
      providerApi(states),
      () => now,
      () => `id-${++ids}`
    );
    await expect(service.getStatus('missing')).rejects.toThrow(
      'read_replication_environment_not_found'
    );
  });

  it('rejects an environment with no active residency policy before provider access', async () => {
    database.exec(
      `UPDATE control_residency_partitions SET status = 'disabled' WHERE environment_id = 'test';`
    );
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );

    await expect(
      service.start('test', {
        desiredMode: 'enabled',
        idempotencyKey: 'no-eligible-policies',
        requestedById: 'admin-1',
      })
    ).rejects.toThrow('read_replication_no_eligible_policies');
    expect(api.getD1Database).not.toHaveBeenCalled();
    expect(api.updateD1Database).not.toHaveBeenCalled();
  });

  it('detects and automatically repairs provider drift with redacted audit evidence', async () => {
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'drift-1',
      requestedById: 'admin-1',
    });
    await service.reconcile(10, started.operationId ?? undefined);
    states.set('db-test-lookup-1', 'disabled');
    now += 8 * 60 * 60 + 1;

    await expect(service.reconcileDrift(1)).resolves.toBe(1);
    expect(states.get('db-test-lookup-1')).toBe('auto');
    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'on',
      convergedPolicyCount: 4,
    });
    const auditRow = database
      .prepare(
        `SELECT outcome, redacted_payload_json
           FROM control_audit_events
          WHERE event_type = 'read_replication.drift_reconcile'`
      )
      .get() as { outcome: string; redacted_payload_json: string };
    expect(auditRow.outcome).toBe('succeeded');
    expect(JSON.parse(auditRow.redacted_payload_json)).toEqual({
      desired_mode: 'enabled',
      error_code: null,
    });
  });

  it('reports drift repair failure and retries the failed target after a bounded delay', async () => {
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'drift-retry-1',
      requestedById: 'admin-1',
    });
    await service.reconcile(10, started.operationId ?? undefined);
    await service.reconcileDrift(2);
    await service.reconcileDrift(2);

    now += 8 * 60 * 60 + 1;
    states.set('db-test-lookup-1', 'disabled');
    api.updateD1Database.mockRejectedValueOnce(new Error('provider secret detail'));
    await service.reconcileDrift(1);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'attention_required',
      failedPolicyCount: 1,
      failedTargetCount: 1,
    });
    const failed = database
      .prepare(
        `SELECT replication_error_code
           FROM control_lookup_physical_shards
          WHERE lookup_shard_id = 'lookup-1'`
      )
      .get() as { replication_error_code: string };
    expect(failed.replication_error_code).toBe('read_replication_provider_request_failed');

    now += 61;
    await service.reconcileDrift(1);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'on',
      failedPolicyCount: 0,
      failedTargetCount: 0,
    });
  });

  it('keeps a multi-shard policy failed when a healthy sibling is checked later', async () => {
    addResource(database, { id: 'users-2', role: 'tenant_core/users' });
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    const started = await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'multi-shard-drift-1',
      requestedById: 'admin-1',
    });
    await service.reconcile(10, started.operationId ?? undefined);
    database.exec(`
      UPDATE control_lookup_physical_shards SET replication_checked_at = ${now};
      UPDATE control_tenant_shards SET replication_checked_at = ${now};
      UPDATE control_tenant_shards
         SET replication_checked_at = NULL
       WHERE data_role = 'tenant_core/users';
    `);
    api.getD1Database.mockImplementation(async (databaseId: string) => {
      if (databaseId === 'db-test-users-1') throw new Error('provider timeout');
      return {
        uuid: databaseId,
        name: databaseId,
        read_replication: { mode: states.get(databaseId) ?? 'disabled' },
      };
    });

    await service.reconcileDrift(1);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      failedPolicyCount: 1,
      failedTargetCount: 1,
    });

    await service.reconcileDrift(1);
    await expect(service.getStatus('test')).resolves.toMatchObject({
      aggregateStatus: 'attention_required',
      failedPolicyCount: 1,
      failedTargetCount: 1,
    });
  });

  it('does not run background drift repair while a rollout owns the environment', async () => {
    const api = providerApi(states);
    const service = new ReadReplicationService(
      d1(database),
      api,
      () => now,
      () => `id-${++ids}`
    );
    await service.start('test', {
      desiredMode: 'enabled',
      idempotencyKey: 'drift-exclusion-1',
      requestedById: 'admin-1',
    });

    await expect(service.reconcileDrift(2)).resolves.toBe(0);
    expect(api.getD1Database).not.toHaveBeenCalled();
  });
});
