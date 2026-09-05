import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountScaleOutForecastService } from '../account-scale-out-forecast';

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
  const binding = {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    withSession() {
      return binding;
    },
  };
  return binding as unknown as D1Database;
}

describe('AccountScaleOutForecastService', () => {
  let database: DatabaseSync;
  let now: number;
  let service: AccountScaleOutForecastService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES ('seed', 'test', 'provision_shard', 'seed', 'succeeded', 'setup', 1, 1, 1, 1);
      INSERT INTO control_environment_resource_policies (
        environment_id, max_concurrent_provisioning, max_ready_spares,
        max_d1_resources, daily_d1_create_budget, target_account_count,
        account_forecast_horizon_seconds, account_scale_out_headroom_bps,
        account_registration_ewma_alpha_bps, created_at, updated_at
      ) VALUES ('test', 2, 2, 100, 100, 100, 900, 2000, 5000, 1, 1);
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition,
        status, created_at, updated_at
      ) VALUES ('test', 'global', 'default', 'active', 1, 1);
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, desired_spec_json, provider_create_state,
        provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
      ) VALUES ('resource-users-a', 'test', 'd1', 'users-a', 'users-a', 'fingerprint-a',
                'active', 'seed', '{}', 'identified', 'database-users-a', 1, 1, 1);
      INSERT INTO control_tenant_shards (
        shard_id, environment_id, data_role, residency_policy_id, residency_partition,
        generation, logical_shard_id, binding_ref, d1_desired_resource_id,
        allocation_scope, owner_tenant_id, status, created_at, updated_at
      ) VALUES ('users-a', 'test', 'tenant_core/users', 'global', 'default', 1,
                'users-a', 'TDB_USERS_A', 'resource-users-a', 'shared_pool', NULL,
                'active', 1, 1);
      INSERT INTO control_shard_capacity (
        shard_id, target_account_count, allocated_account_count,
        health_status, allocation_status, updated_at
      ) VALUES ('users-a', 100, 70, 'healthy', 'eligible', 1);
      INSERT INTO control_account_scale_out_forecasts (
        environment_id, allocation_scope, owner_tenant_key, owner_tenant_id,
        data_role, residency_policy_id, residency_partition, policy_generation,
        successful_allocation_count, observed_at, observed_successful_allocation_count,
        sample_interval_seconds, sample_rate_microaccounts_per_second,
        ewma_rate_microaccounts_per_second, forecast_horizon_seconds,
        forecast_new_account_count, observed_allocated_account_count,
        projected_account_count, usable_capacity_account_count, capacity_unit_count,
        decision_generation, decision_state, snapshot_digest,
        created_at, updated_at
      ) VALUES ('test', 'shared_pool', '', NULL, 'tenant_core/users', 'global', 'default', 1,
                70, 400, 10, 0, 0, 80000, 900, 0, 10, 10, 80, 1, 0, 'stable',
                '${'0'.repeat(64)}', 1, 1);
    `);
    now = 1_000;
    service = new AccountScaleOutForecastService(d1(database), () => now);
  });

  afterEach(() => database.close());

  it('emits one deterministic request and does not duplicate it while provisioning', async () => {
    const first = await service.observe('test');
    expect(first.views).toEqual([
      expect.objectContaining({
        allocationScope: 'shared_pool',
        dataRole: 'tenant_core/users',
        status: 'provisioning',
        sampleRateMicroaccountsPerSecond: 100_000,
        ewmaRateMicroaccountsPerSecond: 90_000,
        forecastNewAccountCount: 81,
        projectedAccountCount: 151,
        usableCapacityAccountCount: 80,
        additionalUnitsRequired: 1,
        decisionGeneration: 1,
      }),
    ]);
    expect(first.capacityRequests).toHaveLength(1);
    const request = first.capacityRequests[0];
    expect(request.idempotencyKey).toMatch(/^account-forecast:[a-f0-9]{48}$/u);

    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES ('predict-users-1', 'test', 'provision_shard', '${request.idempotencyKey}',
                'queued', 'scheduler', 0, 1000, 1000);
    `);
    await service.recordProvisioningOperation({
      request,
      operationId: 'predict-users-1',
      operationStatus: 'queued',
      lastErrorCode: null,
    });

    const inFlight = await service.observe('test');
    expect(inFlight.capacityRequests).toEqual([]);
    expect(inFlight.views[0]).toMatchObject({
      status: 'provisioning',
      decisionGeneration: 1,
      requestedOperationId: 'predict-users-1',
    });
  });

  it('clears a succeeded decision only after its new shard is active', async () => {
    const first = await service.observe('test');
    const request = first.capacityRequests[0];
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES ('predict-users-1', 'test', 'provision_shard', '${request.idempotencyKey}',
                'succeeded', 'scheduler', 1, 1000, 1001, 1001);
    `);
    await service.recordProvisioningOperation({
      request,
      operationId: 'predict-users-1',
      operationStatus: 'succeeded',
      lastErrorCode: null,
    });

    now = 1_060;
    const notReflected = await service.observe('test');
    expect(notReflected.capacityRequests).toEqual([]);
    expect(notReflected.views[0]).toMatchObject({
      status: 'provisioning',
      lastErrorCode: 'account_scale_out_capacity_reflection_missing',
    });

    database.exec(`
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, desired_spec_json, provider_create_state,
        provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
      ) VALUES ('resource-users-b', 'test', 'd1', 'users-b', 'users-b', 'fingerprint-b',
                'active', 'predict-users-1', '{}', 'identified', 'database-users-b',
                1060, 1000, 1060);
      INSERT INTO control_tenant_shards (
        shard_id, environment_id, data_role, residency_policy_id, residency_partition,
        generation, logical_shard_id, binding_ref, d1_desired_resource_id,
        allocation_scope, owner_tenant_id, status, created_at, updated_at
      ) VALUES ('users-b', 'test', 'tenant_core/users', 'global', 'default', 2,
                'users-b', 'TDB_USERS_B', 'resource-users-b', 'shared_pool', NULL,
                'active', 1000, 1060);
      INSERT INTO control_shard_capacity (
        shard_id, target_account_count, allocated_account_count,
        health_status, allocation_status, updated_at
      ) VALUES ('users-b', 100, 0, 'healthy', 'eligible', 1060);
    `);
    now = 1_120;
    const reflected = await service.observe('test');
    expect(reflected.capacityRequests).toEqual([]);
    expect(reflected.views[0]).toMatchObject({
      status: 'stable',
      capacityUnitCount: 2,
      usableCapacityAccountCount: 160,
      requestedOperationId: null,
      lastErrorCode: null,
    });
  });

  it('keeps transient request failure retryable with the same decision', async () => {
    const first = await service.observe('test');
    const request = first.capacityRequests[0];
    await service.recordCapacityRequestFailure(
      request,
      'account_scale_out_capacity_request_retry',
      false
    );

    const retry = await service.observe('test');
    expect(retry.capacityRequests[0]).toEqual(request);
    expect(retry.views[0]).toMatchObject({ status: 'provisioning', decisionGeneration: 1 });
  });

  it('keeps terminal failures blocked until the policy generation changes', async () => {
    const first = await service.observe('test');
    const request = first.capacityRequests[0];
    await service.recordCapacityRequestFailure(request, 'control_d1_resource_limit', true);

    const blocked = await service.observe('test');
    expect(blocked.capacityRequests).toEqual([]);
    expect(blocked.views[0]).toMatchObject({
      status: 'blocked',
      decisionGeneration: 1,
      lastErrorCode: 'control_d1_resource_limit',
    });

    database.exec(`
      UPDATE control_environment_resource_policies
         SET account_scale_out_policy_generation = 2
       WHERE environment_id = 'test';
    `);
    now += 60;
    const warming = await service.observe('test');
    expect(warming.capacityRequests).toEqual([]);
    expect(warming.views[0]).toMatchObject({ status: 'warming', decisionGeneration: 1 });
    database.exec(`
      UPDATE control_account_scale_out_forecasts
         SET successful_allocation_count = successful_allocation_count + 10
       WHERE environment_id = 'test';
      UPDATE control_shard_capacity
         SET allocated_account_count = allocated_account_count + 10
       WHERE shard_id = 'users-a';
    `);
    now += 60;
    const replanned = await service.observe('test');
    expect(replanned.capacityRequests).toHaveLength(1);
    expect(replanned.views[0]).toMatchObject({
      status: 'provisioning',
      decisionGeneration: 2,
      lastErrorCode: null,
    });
    expect(replanned.capacityRequests[0].idempotencyKey).not.toBe(request.idempotencyKey);
  });
});
