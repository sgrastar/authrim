import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ControlWorker from '../index';
import { LookupScaleOutForecastService } from '../lookup-scale-out-forecast';
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

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  executeBatch() {
    if (this.statement.columns().length > 0) {
      return {
        success: true,
        results: this.statement.all(...this.values),
        meta: { changes: 0 },
      };
    }
    return this.executeRun();
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
    async batch(statements: unknown[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
          return statement.executeBatch();
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return binding as unknown as D1Database;
}

describe('LookupScaleOutForecastService', () => {
  let database: DatabaseSync;
  let now: number;
  let service: LookupScaleOutForecastService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES ('seed', 'test', 'provision_shard', 'seed', 'succeeded', 'setup', 1, 1, 1, 1);
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         lookup_forecast_horizon_seconds, lookup_target_active_route_count,
         lookup_scale_out_headroom_bps, lookup_registration_ewma_alpha_bps,
         created_at, updated_at
       ) VALUES ('test', 2, 2, 10, 10, 100000, 3600, 100000, 2000, 2500, 1, 1);
       INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition,
         lookup_capacity_domain_id, status, created_at, updated_at
       ) VALUES ('test', 'global', 'default', 'lookup:global:default', 'active', 1, 1);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, provider_create_state,
         provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES ('resource-a', 'test', 'd1', 'lookup-a', 'lookup-a', 'fingerprint-a',
                 'active', 'seed',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 'identified', 'database-a', 1, 1, 1);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-a', 'test', 'default', 'LOOKUP_A', 'resource-a', 'active', 1, 1);
       INSERT INTO control_lookup_bucket_assignments (
         environment_id, virtual_bucket, lookup_shard_id, assignment_generation, state, updated_at
       )
       WITH RECURSIVE bucket(value) AS (
         SELECT 0 UNION ALL SELECT value + 1 FROM bucket WHERE value < 4095
       )
       SELECT 'test', value, 'lookup-a', 1, 'active', 1 FROM bucket;`
    );
    now = 10_000;
    service = new LookupScaleOutForecastService(d1(database), () => now);
  });

  afterEach(() => database.close());

  function snapshot(active: number, publications: number) {
    return {
      ownerId: 'management-planner',
      observedAt: now,
      buckets: Array.from({ length: 4096 }, (_, virtualBucket) => ({
        virtualBucket,
        lookupShardId: 'lookup-a',
        assignmentGeneration: 1,
        activeIdentifierCount: virtualBucket === 7 ? active : 0,
        activeAliasCount: 0,
        successfulRoutePublicationCount: virtualBucket === 7 ? publications : 0,
        publicationCounterUpdatedAt: now,
        counterUpdatedAt: now,
      })),
    };
  }

  it('warms once, then emits one deterministic capacity request from the EWMA forecast', async () => {
    const first = await service.observe('test', snapshot(70_000, 1_000));
    expect(first.capacityRequest).toBeNull();
    expect(first.views[0]).toMatchObject({ status: 'warming', usableCapacityRouteCount: 80_000 });

    now += 600;
    const second = await service.observe('test', snapshot(72_000, 7_000));
    expect(second.views[0]).toMatchObject({
      status: 'provisioning',
      sampleRateMicrorowsPerSecond: 10_000_000,
      ewmaRateMicrorowsPerSecond: 2_500_000,
      forecastNewRouteCount: 9_000,
      projectedActiveRouteCount: 81_000,
      decisionGeneration: 1,
    });
    expect(second.capacityRequest).toEqual({
      lookupCapacityDomainId: 'lookup:global:default',
      residencyPolicyId: 'global',
      residencyPartition: 'default',
      idempotencyKey: 'lookup-forecast:lookup:global:default:1:1',
      decisionGeneration: 1,
    });
    if (!second.capacityRequest) throw new Error('expected_capacity_request');
    await expect(service.reconcileProvisioningOperations()).resolves.toEqual({
      settledCount: 0,
      blockedCount: 0,
      capacityRequests: [{ environmentId: 'test', ...second.capacityRequest }],
    });

    await service.recordCapacityRequestRetry(
      'test',
      second.capacityRequest,
      'lookup_scale_out_capacity_request_retry'
    );
    const retry = await service.observe('test', snapshot(72_000, 7_000));
    expect(retry.capacityRequest?.idempotencyKey).toBe('lookup-forecast:lookup:global:default:1:1');
    expect(retry.views[0]?.decisionGeneration).toBe(1);
  });

  it('combines explicitly shared residency policies into one capacity forecast', async () => {
    database.exec(`
      UPDATE control_residency_partitions
         SET lookup_capacity_domain_id = 'lookup:shared:default'
       WHERE environment_id = 'test' AND residency_policy_id = 'global';
      UPDATE control_desired_resources
         SET desired_spec_json =
           '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:shared:default"}'
       WHERE desired_resource_id = 'resource-a';
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition,
        lookup_capacity_domain_id, status, created_at, updated_at
      ) VALUES (
        'test', 'regional', 'default', 'lookup:shared:default', 'active', 1, 1
      );
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, desired_spec_json, provider_create_state,
        provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
      ) VALUES ('resource-regional', 'test', 'd1', 'lookup-regional', 'lookup-regional',
                'fingerprint-regional', 'active', 'seed',
                '{"residency_policy_id":"regional","lookup_capacity_domain_id":"lookup:shared:default"}',
                'identified', 'database-regional', 1, 1, 1);
      INSERT INTO control_lookup_physical_shards (
        lookup_shard_id, environment_id, residency_partition, binding_ref,
        d1_desired_resource_id, status, created_at, updated_at
      ) VALUES ('lookup-regional', 'test', 'default', 'LOOKUP_REGIONAL', 'resource-regional',
                'active', 1, 1);
    `);

    const result = await service.observe('test', snapshot(70_000, 1_000));

    expect(result.views).toHaveLength(1);
    expect(result.views[0]).toMatchObject({
      lookupCapacityDomainId: 'lookup:shared:default',
      residencyPolicyId: 'global',
      residencyPartition: 'default',
      capacityUnitCount: 2,
    });
  });

  it('fails closed when a physical shard is pinned to a stale capacity domain', async () => {
    database.exec(`
      UPDATE control_desired_resources
         SET desired_spec_json =
           '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:stale:default"}'
       WHERE desired_resource_id = 'resource-a';
    `);

    await expect(service.observe('test', snapshot(70_000, 1_000))).rejects.toThrow(
      'lookup_scale_out_capacity_domain_drift'
    );
  });

  it('fails closed when policies in one capacity domain have incompatible placement', async () => {
    database.exec(`
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition, jurisdiction,
        lookup_capacity_domain_id, status, created_at, updated_at
      ) VALUES (
        'test', 'regional', 'default', 'eu', 'lookup:global:default', 'active', 1, 1
      );
    `);

    await expect(service.observe('test', snapshot(70_000, 1_000))).rejects.toThrow(
      'lookup_scale_out_capacity_domain_incompatible'
    );
  });

  it('pins a bounded deterministic idempotency key for a long capacity domain', async () => {
    const capacityDomainId = `lookup:${'x'.repeat(110)}`;
    database
      .prepare(
        `UPDATE control_residency_partitions
            SET lookup_capacity_domain_id = ?
          WHERE environment_id = 'test' AND residency_policy_id = 'global'`
      )
      .run(capacityDomainId);
    database
      .prepare(
        `UPDATE control_desired_resources
            SET desired_spec_json = ?
          WHERE desired_resource_id = 'resource-a'`
      )
      .run(
        JSON.stringify({
          residency_policy_id: 'global',
          lookup_capacity_domain_id: capacityDomainId,
        })
      );

    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const first = await service.observe('test', snapshot(72_000, 7_000));
    const firstKey = first.capacityRequest?.idempotencyKey;

    expect(firstKey).toMatch(/^lookup-forecast:[0-9a-f]{64}$/u);
    expect(firstKey?.length).toBeLessThanOrEqual(128);
    const replay = await service.observe('test', snapshot(72_000, 7_000));
    expect(replay.capacityRequest?.idempotencyKey).toBe(firstKey);
    if (!firstKey) throw new Error('expected_capacity_request');
    database
      .prepare(
        `INSERT INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key, status,
           requested_by_type, attempt_count, created_at, updated_at
         ) VALUES ('long-domain-response-loss', 'test', 'provision_shard', ?,
                   'running', 'scheduler', 1, 10600, 10600)`
      )
      .run(firstKey);
    database
      .prepare(
        `INSERT INTO control_desired_resources (
           desired_resource_id, environment_id, resource_kind, logical_shard_id,
           deterministic_name, ownership_fingerprint, provisioning_state,
           origin_operation_id, desired_spec_json, created_at, updated_at
         ) VALUES ('resource-long-domain', 'test', 'd1', 'lookup-long-domain',
                   'lookup-long-domain', 'fingerprint-long-domain', 'creating',
                   'long-domain-response-loss', ?, 10600, 10600)`
      )
      .run(
        JSON.stringify({
          residency_policy_id: 'global',
          lookup_capacity_domain_id: capacityDomainId,
        })
      );
    database.exec(
      `INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-long-domain', 'test', 'default', 'LOOKUP_LONG_DOMAIN',
                 'resource-long-domain', 'provisioning', 10600, 10600);`
    );

    now += 600;
    const adopted = await service.observe('test', snapshot(73_000, 8_000));
    expect(adopted.capacityRequest).toBeNull();
    expect(adopted.views[0]).toMatchObject({
      requestedOperationId: 'long-domain-response-loss',
      capacityUnitCount: 2,
    });
  });

  it('serializes capacity requests across independent capacity domains', async () => {
    database.exec(`
      UPDATE control_residency_partitions
         SET lookup_capacity_domain_id = 'lookup:a:default'
       WHERE environment_id = 'test' AND residency_policy_id = 'global';
      UPDATE control_desired_resources
         SET desired_spec_json =
           '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:a:default"}'
       WHERE desired_resource_id = 'resource-a';
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition,
        lookup_capacity_domain_id, status, created_at, updated_at
      ) VALUES ('test', 'regional', 'default', 'lookup:b:default', 'active', 1, 1);
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        deterministic_name, ownership_fingerprint, provisioning_state,
        origin_operation_id, desired_spec_json, provider_create_state,
        provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
      ) VALUES ('resource-b', 'test', 'd1', 'lookup-b', 'lookup-b', 'fingerprint-b',
                'active', 'seed',
                '{"residency_policy_id":"regional","lookup_capacity_domain_id":"lookup:b:default"}',
                'identified', 'database-b', 1, 1, 1);
      INSERT INTO control_lookup_physical_shards (
        lookup_shard_id, environment_id, residency_partition, binding_ref,
        d1_desired_resource_id, status, created_at, updated_at
      ) VALUES ('lookup-b', 'test', 'default', 'LOOKUP_B', 'resource-b', 'active', 1, 1);
      UPDATE control_lookup_bucket_assignments
         SET lookup_shard_id = 'lookup-b', assignment_generation = 2
       WHERE virtual_bucket = 8;
    `);
    const firstSnapshot = snapshot(81_000, 1_000);
    const bucketEight = firstSnapshot.buckets[8];
    if (!bucketEight) throw new Error('missing_test_bucket');
    Object.assign(bucketEight, {
      lookupShardId: 'lookup-b',
      assignmentGeneration: 2,
      activeIdentifierCount: 81_000,
      successfulRoutePublicationCount: 1_000,
    });

    const first = await service.observe('test', firstSnapshot);
    expect(first.views.map((view) => view.lookupCapacityDomainId)).toEqual([
      'lookup:a:default',
      'lookup:b:default',
    ]);
    expect(first.capacityRequest?.lookupCapacityDomainId).toBe('lookup:a:default');
    if (!first.capacityRequest) throw new Error('expected_capacity_request');
    await service.blockCapacityRequest('test', first.capacityRequest, 'control_d1_resource_limit');

    const second = await service.observe('test', firstSnapshot);
    expect(second.capacityRequest?.lookupCapacityDomainId).toBe('lookup:b:default');
  });

  it('counts requested capacity without losing the in-flight operation state', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 7_000));
    const request = forecast.capacityRequest;
    if (!request) throw new Error('expected_capacity_request');
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, updated_at
       ) VALUES ('forecast-operation', 'test', 'provision_shard',
                 'lookup-forecast:lookup:global:default:1:1', 'running', 'scheduler', 1, 10600, 10600);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, created_at, updated_at
       ) VALUES ('resource-b', 'test', 'd1', 'lookup-b', 'lookup-b', 'fingerprint-b',
                 'creating', 'forecast-operation',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 10600, 10600);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-b', 'test', 'default', 'LOOKUP_B', 'resource-b', 'provisioning', 10600, 10600);`
    );
    await service.recordProvisioningOperation('test', request, 'forecast-operation');
    await service.recordProvisioningOperation('test', request, 'forecast-operation');

    now += 600;
    const provisioning = await service.observe('test', snapshot(73_000, 8_000));
    expect(provisioning.capacityRequest).toBeNull();
    expect(provisioning.views[0]).toMatchObject({
      status: 'provisioning',
      requestedOperationId: 'forecast-operation',
      capacityUnitCount: 2,
      usableCapacityRouteCount: 160_000,
    });

    database.exec(
      `UPDATE control_lookup_physical_shards
          SET status = 'ready', updated_at = 11200
        WHERE lookup_shard_id = 'lookup-b';
       UPDATE control_operations
          SET status = 'succeeded', completed_at = 11200, updated_at = 11200
        WHERE operation_id = 'forecast-operation';`
    );
    now += 600;
    const awaitingReflection = await service.observe('test', snapshot(73_500, 8_500));
    expect(awaitingReflection.capacityRequest).toBeNull();
    expect(awaitingReflection.views[0]).toMatchObject({
      status: 'blocked',
      requestedOperationId: 'forecast-operation',
      lastErrorCode: 'lookup_scale_out_capacity_reflection_missing',
      capacityUnitCount: 2,
    });

    database.exec(
      `UPDATE control_lookup_physical_shards
          SET status = 'active', updated_at = 11800
        WHERE lookup_shard_id = 'lookup-b';`
    );
    now += 600;
    const stable = await service.observe('test', snapshot(74_000, 9_000));
    expect(stable.capacityRequest).toBeNull();
    expect(stable.views[0]).toMatchObject({
      status: 'stable',
      requestedOperationId: null,
      capacityUnitCount: 2,
    });
  });

  it('settles a completed reflected capacity decision without requiring another load snapshot', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 7_000));
    const request = forecast.capacityRequest;
    if (!request) throw new Error('expected_capacity_request');
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES ('completed-forecast-operation', 'test', 'provision_shard',
                 'lookup-forecast:lookup:global:default:1:1', 'succeeded', 'scheduler', 1,
                 10600, 10600, 10600);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, provider_create_state,
         provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES ('resource-completed', 'test', 'd1', 'lookup-completed',
                 'lookup-completed', 'fingerprint-completed', 'ready',
                 'completed-forecast-operation',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 'identified', 'database-completed', 10600, 10600, 10600);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-completed', 'test', 'default', 'LOOKUP_COMPLETED',
                 'resource-completed', 'active', 10600, 10600);`
    );
    await service.recordProvisioningOperation(
      'test',
      request,
      'completed-forecast-operation',
      'succeeded'
    );

    now += 60;
    await expect(service.reconcileProvisioningOperations()).resolves.toEqual({
      settledCount: 1,
      blockedCount: 0,
      capacityRequests: [],
    });
    expect(
      database
        .prepare(
          `SELECT decision_state, requested_operation_id, capacity_request_idempotency_key,
                  capacity_unit_count, usable_capacity_route_count, last_error_code
             FROM control_lookup_scale_out_forecasts WHERE environment_id = 'test'`
        )
        .get()
    ).toEqual({
      decision_state: 'stable',
      requested_operation_id: null,
      capacity_request_idempotency_key: null,
      capacity_unit_count: 2,
      usable_capacity_route_count: 160_000,
      last_error_code: null,
    });
  });

  it('advances to an idempotent next decision when one completed Lookup D1 is insufficient', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 101_000));
    const request = forecast.capacityRequest;
    if (!request) throw new Error('expected_capacity_request');
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES ('insufficient-forecast-operation', 'test', 'provision_shard',
                 'lookup-forecast:lookup:global:default:1:1', 'succeeded', 'scheduler', 1,
                 10600, 10600, 10600);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, provider_create_state,
         provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES ('resource-insufficient', 'test', 'd1', 'lookup-insufficient',
                 'lookup-insufficient', 'fingerprint-insufficient', 'ready',
                 'insufficient-forecast-operation',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 'identified', 'database-insufficient', 10600, 10600, 10600);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-insufficient', 'test', 'default', 'LOOKUP_INSUFFICIENT',
                 'resource-insufficient', 'active', 10600, 10600);`
    );
    await service.recordProvisioningOperation(
      'test',
      request,
      'insufficient-forecast-operation',
      'succeeded'
    );

    now += 60;
    const reconciliation = await service.reconcileProvisioningOperations();
    expect(reconciliation).toEqual({
      settledCount: 0,
      blockedCount: 0,
      capacityRequests: [
        {
          environmentId: 'test',
          lookupCapacityDomainId: 'lookup:global:default',
          residencyPolicyId: 'global',
          residencyPartition: 'default',
          idempotencyKey: 'lookup-forecast:lookup:global:default:1:2',
          decisionGeneration: 2,
        },
      ],
    });
    expect(await service.reconcileProvisioningOperations()).toEqual({
      settledCount: 0,
      blockedCount: 0,
      capacityRequests: reconciliation.capacityRequests,
    });
  });

  it('surfaces a linked operation that becomes terminal between load snapshots', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 7_000));
    const request = forecast.capacityRequest;
    if (!request) throw new Error('expected_capacity_request');
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, updated_at
       ) VALUES ('later-blocked-operation', 'test', 'provision_shard',
                 'lookup-forecast:lookup:global:default:1:1', 'running', 'scheduler', 1,
                 10600, 10600);`
    );
    await service.recordProvisioningOperation('test', request, 'later-blocked-operation');
    database.exec(
      `UPDATE control_operations
          SET status = 'blocked', last_error_code = 'control_d1_resource_limit',
              completed_at = 10660, updated_at = 10660
        WHERE operation_id = 'later-blocked-operation'`
    );

    now += 60;
    await expect(service.reconcileProvisioningOperations()).resolves.toEqual({
      settledCount: 0,
      blockedCount: 1,
      capacityRequests: [],
    });
    expect(
      database
        .prepare(
          `SELECT decision_state, requested_operation_id, last_error_code
             FROM control_lookup_scale_out_forecasts WHERE environment_id = 'test'`
        )
        .get()
    ).toEqual({
      decision_state: 'blocked',
      requested_operation_id: 'later-blocked-operation',
      last_error_code: 'control_d1_resource_limit',
    });
  });

  it('blocks a succeeded operation whose Lookup shard was not activated', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 7_000));
    const request = forecast.capacityRequest;
    if (!request) throw new Error('expected_capacity_request');
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES ('unreflected-operation', 'test', 'provision_shard',
                 'lookup-forecast:lookup:global:default:1:1', 'succeeded', 'scheduler', 1,
                 10600, 10660, 10660);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, provider_create_state,
         provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES ('resource-unreflected', 'test', 'd1', 'lookup-unreflected',
                 'lookup-unreflected', 'fingerprint-unreflected', 'ready',
                 'unreflected-operation',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 'identified', 'database-unreflected', 10660, 10600, 10660);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-unreflected', 'test', 'default', 'LOOKUP_UNREFLECTED',
                 'resource-unreflected', 'ready', 10600, 10660);`
    );
    await service.recordProvisioningOperation(
      'test',
      request,
      'unreflected-operation',
      'succeeded'
    );

    now += 60;
    await expect(service.reconcileProvisioningOperations()).resolves.toEqual({
      settledCount: 0,
      blockedCount: 1,
      capacityRequests: [],
    });
    expect(
      database
        .prepare(
          `SELECT decision_state, last_error_code
             FROM control_lookup_scale_out_forecasts WHERE environment_id = 'test'`
        )
        .get()
    ).toEqual({
      decision_state: 'blocked',
      last_error_code: 'lookup_scale_out_capacity_reflection_missing',
    });
  });

  it('adopts a Control operation after response loss before the forecast link is recorded', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 7_000));
    expect(forecast.capacityRequest?.idempotencyKey).toBe(
      'lookup-forecast:lookup:global:default:1:1'
    );
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, updated_at
       ) VALUES ('response-loss-operation', 'test', 'provision_shard',
                 'lookup-forecast:lookup:global:default:1:1', 'running', 'scheduler', 1, 10600, 10600);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, created_at, updated_at
       ) VALUES ('resource-response-loss', 'test', 'd1', 'lookup-response-loss',
                 'lookup-response-loss', 'fingerprint-response-loss', 'creating',
                 'response-loss-operation',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 10600, 10600);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-response-loss', 'test', 'default', 'LOOKUP_RESPONSE_LOSS',
                 'resource-response-loss', 'provisioning', 10600, 10600);`
    );

    now += 600;
    const adopted = await service.observe('test', snapshot(73_000, 8_000));
    expect(adopted.capacityRequest).toBeNull();
    expect(adopted.views[0]).toMatchObject({
      status: 'provisioning',
      requestedOperationId: 'response-loss-operation',
      capacityUnitCount: 2,
    });
  });

  it('blocks a deterministic capacity rejection without issuing duplicate requests', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 7_000));
    const request = forecast.capacityRequest;
    if (!request) throw new Error('expected_capacity_request');
    await service.blockCapacityRequest('test', request, 'control_d1_resource_limit');

    const blocked = await service.observe('test', snapshot(72_000, 7_000));
    expect(blocked.capacityRequest).toBeNull();
    expect(blocked.views[0]).toMatchObject({
      status: 'blocked',
      requestedOperationId: null,
      lastErrorCode: 'control_d1_resource_limit',
      decisionGeneration: 1,
    });
  });

  it('surfaces a terminal provisioning operation instead of waiting forever', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    now += 600;
    const forecast = await service.observe('test', snapshot(72_000, 7_000));
    const request = forecast.capacityRequest;
    if (!request) throw new Error('expected_capacity_request');
    database.exec(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, last_error_code, created_at, updated_at
       ) VALUES ('blocked-forecast-operation', 'test', 'provision_shard',
                 'lookup-forecast:lookup:global:default:1:1', 'blocked', 'scheduler', 1,
                 'control_operator_executor_required', 10600, 10600);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, created_at, updated_at
       ) VALUES ('resource-blocked', 'test', 'd1', 'lookup-blocked', 'lookup-blocked',
                 'fingerprint-blocked', 'requested', 'blocked-forecast-operation',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 10600, 10600);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-blocked', 'test', 'default', 'LOOKUP_BLOCKED', 'resource-blocked',
                 'requested', 10600, 10600);`
    );
    await service.recordProvisioningOperation(
      'test',
      request,
      'blocked-forecast-operation',
      'blocked',
      'control_operator_executor_required'
    );

    now += 600;
    const blocked = await service.observe('test', snapshot(73_000, 8_000));
    expect(blocked.capacityRequest).toBeNull();
    expect(blocked.views[0]).toMatchObject({
      status: 'blocked',
      requestedOperationId: 'blocked-forecast-operation',
      lastErrorCode: 'control_operator_executor_required',
      capacityUnitCount: 2,
    });
  });

  it('accepts the source registry assignment while a bucket migration is in progress', async () => {
    await service.observe('test', snapshot(70_000, 1_000));
    database.exec(
      `INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, provider_create_state,
         provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES ('resource-target', 'test', 'd1', 'lookup-target', 'lookup-target',
                 'fingerprint-target', 'active', 'seed',
                 '{"residency_policy_id":"global","lookup_capacity_domain_id":"lookup:global:default"}',
                 'identified', 'database-target', 1, 1, 1);
       INSERT INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES ('lookup-target', 'test', 'default', 'LOOKUP_TARGET', 'resource-target',
                 'active', 1, 1);
       UPDATE control_lookup_bucket_assignments
          SET state = 'copying', target_lookup_shard_id = 'lookup-target', updated_at = 2
        WHERE virtual_bucket = 7;`
    );
    now += 600;

    await expect(service.observe('test', snapshot(71_000, 2_000))).resolves.toMatchObject({
      views: [expect.objectContaining({ capacityUnitCount: 2 })],
    });
  });

  it('rejects a stale observation and permits an explicit policy-generation rebaseline', async () => {
    await service.observe('test', snapshot(70_000, 10_000));
    now += 600;
    await service.observe('test', snapshot(71_000, 11_000));

    const stale = snapshot(70_500, 10_500);
    stale.observedAt = now - 60;
    for (const bucket of stale.buckets) {
      bucket.publicationCounterUpdatedAt = now - 60;
      bucket.counterUpdatedAt = now - 60;
    }
    await expect(service.observe('test', stale)).rejects.toThrow(
      'lookup_scale_out_observation_stale'
    );

    database.exec(
      `UPDATE control_environment_resource_policies
          SET lookup_scale_out_policy_generation = lookup_scale_out_policy_generation + 1
        WHERE environment_id = 'test'`
    );
    now += 600;
    await expect(service.observe('test', snapshot(70_000, 1_000))).resolves.toMatchObject({
      views: [expect.objectContaining({ status: 'warming' })],
    });
  });

  it('wires forecast capacity requests through the real Control RPC and durable operation state', async () => {
    now = Math.floor(Date.now() / 1000);
    database.exec(
      `INSERT INTO control_migration_release_catalog (
         environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
         state, active_stream_key, registered_by_operation_id, registered_by_actor_id,
         registered_at, activated_at
       ) VALUES (
         'test', 'd1-lookup', '0.4.0', '${'b'.repeat(64)}',
         'releases/0.4.0/${'b'.repeat(64)}/manifest.json', 'active', 'active',
         'seed', 'setup:test', 1, 1
       )`
    );
    database.exec(`
      UPDATE control_residency_partitions
         SET lookup_capacity_domain_id = NULL
       WHERE environment_id = 'test' AND residency_policy_id = 'global';
      UPDATE control_desired_resources
         SET desired_spec_json = '{"residency_policy_id":"global"}'
       WHERE desired_resource_id = 'resource-a';
    `);
    const controlDb = d1(database);
    const worker = new ControlWorker(
      {
        props: {
          caller: 'ar-management',
          environmentId: 'test',
          audience: 'authrim-control-v1',
        },
      } as ConstructorParameters<typeof ControlWorker>[0],
      {
        CONTROL_DB: controlDb,
        MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
      } as ControlEnv
    );

    const first = await worker.reconcileLookupScaleOut(snapshot(81_000, 1_000));
    expect(first[0]).toMatchObject({
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
    });
    const operationId = first[0]?.requestedOperationId;
    expect(operationId).toBeTruthy();
    expect(
      database
        .prepare(
          `SELECT status, requested_by_type, last_error_code
             FROM control_operations WHERE operation_id = ?`
        )
        .get(operationId)
    ).toEqual({
      status: 'blocked',
      requested_by_type: 'scheduler',
      last_error_code: 'operator_action_required',
    });

    now += 1;
    const reflected = await worker.reconcileLookupScaleOut(snapshot(81_001, 1_001));
    expect(reflected[0]).toMatchObject({
      status: 'blocked',
      requestedOperationId: operationId,
      capacityUnitCount: 2,
      lastErrorCode: 'operator_action_required',
    });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_lookup_physical_shards`).get()
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare(
          `SELECT json_extract(desired_spec_json, '$.lookup_capacity_domain_id') AS capacity_domain
             FROM control_desired_resources
            WHERE origin_operation_id = ?`
        )
        .get(operationId)
    ).toEqual({ capacity_domain: 'lookup:global:default' });
  });
});
