import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CloudflareControlApiClient,
  calculateControlBootstrapOwnershipFingerprint,
  digestCloudflareWorkerSettings,
  signBootstrapAcceleratorProof,
  type CloudflareWorkerDeployment,
  type ControlBootstrapOwnershipResource,
} from '@authrim/ar-lib-core/control-plane';
import {
  BootstrapHandoffVerifier,
  D1BootstrapHandoffRepository,
} from '@authrim/ar-control/bootstrap-handoff';
import type { AuthrimLock } from './lock.js';
import {
  executeSetupControlOperatorWorkerBindings,
  type SetupOperatorExecutionResult,
} from './control-operator-executor.js';
import { listPendingControlOperatorOperations } from './control-operator-operations.js';
import {
  buildInitialControlPlaneResourcePlans,
  type InitialControlPlaneResourcePlan,
} from './control-plane-bootstrap.js';
import {
  executeD1Command,
  getAccountId,
  getCloudflareApiToken,
  queryD1Rows,
} from './cloudflare.js';
import {
  createSetupOperatorD1Client,
  type SetupOperatorControlClient,
  type SetupOperatorD1Client,
} from './control-operator-executor.js';
import type { ReleaseMigrationManifest } from './release-migrations.js';
import type { DeployResult } from './deploy.js';
import { isValidTenantId } from './tenant-id.js';
import { fetchWithTimeout } from './http-limits.js';

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function initialDefaultRouteIdentity(
  environmentId: string,
  tenantId: string
): {
  allocationId: string;
  idempotencyKey: string;
} {
  const digest = sha256Hex(
    [environmentId, tenantId, 'builtin:residency:default', 'default'].join('\0')
  );
  return {
    allocationId: `tenant_default_${digest.slice(0, 32)}`,
    idempotencyKey: `bootstrap:default-route:${tenantId}:v1`,
  };
}

class OperatorD1PreparedStatement {
  constructor(
    readonly client: Pick<SetupOperatorD1Client, 'queryD1Batch'>,
    readonly databaseId: string,
    readonly sql: string,
    readonly params: readonly unknown[] = []
  ) {}

  bind(...params: unknown[]): OperatorD1PreparedStatement {
    return new OperatorD1PreparedStatement(this.client, this.databaseId, this.sql, params);
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: unknown }> {
    const [result] = await executeOperatorD1Batch(this.client, this.databaseId, [
      { sql: this.sql, params: this.params },
    ]);
    if (!result) throw new Error('control_bootstrap_operator_d1_result_missing');
    return {
      success: true,
      results: (result.results ?? []) as T[],
      meta: result.meta ?? {},
    };
  }
}

class OperatorD1Database {
  constructor(
    private readonly databaseId: string,
    private readonly client: Pick<SetupOperatorD1Client, 'queryD1Batch'>
  ) {}

  prepare(sql: string): OperatorD1PreparedStatement {
    return new OperatorD1PreparedStatement(this.client, this.databaseId, sql);
  }

  async batch(
    statements: readonly OperatorD1PreparedStatement[]
  ): Promise<Array<{ success: true; results?: unknown[]; meta?: unknown }>> {
    if (
      statements.some(
        (statement) =>
          !(statement instanceof OperatorD1PreparedStatement) ||
          statement.databaseId !== this.databaseId
      )
    ) {
      throw new Error('control_bootstrap_operator_d1_statement_invalid');
    }
    return executeOperatorD1Batch(
      this.client,
      this.databaseId,
      statements.map((statement) => ({ sql: statement.sql, params: statement.params }))
    );
  }
}

async function executeOperatorD1Batch(
  client: Pick<SetupOperatorD1Client, 'queryD1Batch'>,
  databaseId: string,
  statements: ReadonlyArray<{ sql: string; params?: readonly unknown[] }>
): Promise<Array<{ success: true; results?: unknown[]; meta?: unknown }>> {
  const results = await client.queryD1Batch(
    databaseId,
    statements.map((statement) => ({
      sql: statement.sql,
      ...(statement.params ? { params: [...statement.params] } : {}),
    }))
  );
  if (results.length !== statements.length || results.some((result) => result.success !== true)) {
    throw new Error('control_bootstrap_operator_d1_batch_unsuccessful');
  }
  return results as Array<{ success: true; results?: unknown[]; meta?: unknown }>;
}

export function createOperatorBootstrapHandoffRepository(
  controlDatabaseId: string,
  client: Pick<SetupOperatorD1Client, 'queryD1Batch'>
): D1BootstrapHandoffRepository {
  const database = new OperatorD1Database(controlDatabaseId, client);
  return new D1BootstrapHandoffRepository(
    database as unknown as ConstructorParameters<typeof D1BootstrapHandoffRepository>[0]
  );
}

async function executeInitialBootstrapWorkerBindingsAsOperator(input: {
  controlDatabaseId: string;
  controlDatabaseName: string;
  environmentId: string;
  accountId: string;
  client: SetupOperatorControlClient;
}): Promise<void> {
  const operations = (
    await listPendingControlOperatorOperations({
      controlDatabaseName: input.controlDatabaseName,
    })
  ).filter(
    (operation) =>
      operation.environmentId === input.environmentId &&
      operation.operationId.startsWith('op_bootstrap_') &&
      operation.requestedByType === 'setup' &&
      operation.currentStep === 'reconcile_worker_bindings'
  );
  for (const operation of operations) {
    const result = await executeSetupControlOperatorWorkerBindings({
      controlDatabaseId: input.controlDatabaseId,
      operation,
      client: input.client,
      expectedAccountId: input.accountId,
    });
    assertInitialBootstrapBindingExecutionCanContinue(result);
  }
}

async function createInitialBootstrapOperatorClient(input: {
  accountId?: string;
  token?: string;
  createClient?: (input: { expectedAccountId?: string }) => Promise<SetupOperatorControlClient>;
}): Promise<{ accountId: string; client: SetupOperatorControlClient }> {
  const accountId = input.accountId?.trim() || (await getAccountId());
  if (!accountId) throw new Error('control_bootstrap_operator_account_missing');
  const explicitToken = input.token?.trim();
  const client = explicitToken
    ? new CloudflareControlApiClient({
        accountId,
        tokens: { d1: explicitToken, workers: explicitToken },
      })
    : await (input.createClient ?? createSetupOperatorD1Client)({ expectedAccountId: accountId });
  return { accountId, client };
}

export async function advanceInitialBootstrapWorkerBindingsAsOperator(input: {
  controlDatabaseId: string;
  controlDatabaseName: string;
  environmentId: string;
  accountId?: string;
  token?: string;
  createClient?: (input: { expectedAccountId?: string }) => Promise<SetupOperatorControlClient>;
}): Promise<void> {
  const { accountId, client } = await createInitialBootstrapOperatorClient(input);
  await executeInitialBootstrapWorkerBindingsAsOperator({
    controlDatabaseId: input.controlDatabaseId,
    controlDatabaseName: input.controlDatabaseName,
    environmentId: input.environmentId,
    accountId,
    client,
  });
}

export async function reconcileInitialBootstrapHandoffAsOperator(input: {
  controlDatabaseId: string;
  controlDatabaseName?: string;
  environmentId?: string;
  executeWorkerBindings?: boolean;
  accountId?: string;
  token?: string;
  createClient?: (input: { expectedAccountId?: string }) => Promise<SetupOperatorControlClient>;
  now?: () => number;
}): Promise<{ attempted: number; accepted: number; blocked: number; retrying: number }> {
  const { accountId, client } = await createInitialBootstrapOperatorClient(input);
  if (input.executeWorkerBindings) {
    if (!input.controlDatabaseName || !input.environmentId) {
      throw new Error('control_bootstrap_operator_binding_context_missing');
    }
    await executeInitialBootstrapWorkerBindingsAsOperator({
      controlDatabaseId: input.controlDatabaseId,
      controlDatabaseName: input.controlDatabaseName,
      environmentId: input.environmentId,
      accountId,
      client,
    });
  }
  const repository = createOperatorBootstrapHandoffRepository(input.controlDatabaseId, client);
  return new BootstrapHandoffVerifier(
    repository,
    {
      getD1Database: (databaseId) => client.getD1Database(databaseId),
      queryD1Batch: (databaseId, queries) => client.queryD1Batch(databaseId, queries),
      getWorkerSettings: (scriptName) => client.getWorkerSettings(scriptName),
      listWorkerDeployments: (scriptName) => client.listWorkerDeployments(scriptName),
    },
    input.now ?? (() => Math.floor(Date.now() / 1000))
  ).reconcile(1);
}

export function assertInitialBootstrapBindingExecutionCanContinue(
  result: SetupOperatorExecutionResult
): void {
  if (result.state === 'awaiting_smoke' || result.state === 'retry_required') return;
  if (
    result.state === 'lease_unavailable' &&
    result.errorCode === 'control_worker_deployment_lease_busy'
  ) {
    return;
  }
  throw new Error(result.errorCode ?? `control_bootstrap_operator_${result.state}`);
}

function operationSql(
  plan: InitialControlPlaneResourcePlan,
  environmentId: string,
  now: number,
  automaticProvisioning: boolean
) {
  const tenantShard = plan.role !== 'lookup';
  const operatorActionRequired = tenantShard && !automaticProvisioning;
  const operationStatus = tenantShard
    ? operatorActionRequired
      ? 'blocked'
      : 'waiting_retry'
    : 'succeeded';
  const completedAt = tenantShard ? 'NULL' : String(now);
  const statements = [
    `INSERT OR IGNORE INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key, status,
       requested_by_type, requested_by_id, attempt_count, last_error_code,
       last_error_redacted, release_id,
       release_stream_id, release_manifest_digest, created_at, completed_at, updated_at
     ) VALUES (
       ${sqlString(plan.operationId)}, ${sqlString(environmentId)},
       ${sqlString(tenantShard ? 'provision_shard' : 'bootstrap_lookup')},
       ${sqlString(`bootstrap:${plan.role}:v1`)}, ${sqlString(operationStatus)},
       'setup', 'setup:init', 1,
       ${operatorActionRequired ? "'operator_action_required'" : 'NULL'},
       ${operatorActionRequired ? "'Continue this operation with setup.'" : 'NULL'},
       ${sqlString(plan.releaseId)},
       ${sqlString(plan.migrationStreamId)}, ${sqlString(plan.manifestDigest)},
       ${now}, ${completedAt}, ${now}
     );`,
    `INSERT OR IGNORE INTO control_operation_release_pins (
       operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
     ) VALUES (
       ${sqlString(plan.operationId)}, ${sqlString(environmentId)},
       ${sqlString(plan.migrationStreamId)}, ${sqlString(plan.releaseId)},
       ${sqlString(plan.manifestDigest)}, ${now}
     );`,
  ];
  if (tenantShard) {
    statements.push(
      ...[
        ['create_d1', 10, 'succeeded', now],
        ['apply_migrations', 20, 'succeeded', now],
        ['reconcile_worker_bindings', 30, operatorActionRequired ? 'blocked' : 'queued', null],
        ['smoke_bindings', 40, 'queued', null],
        ['stabilize_bindings', 50, 'queued', null],
      ].map(
        ([stepKey, order, status, completed]) =>
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count,
             progress_current, progress_total, started_at, completed_at, updated_at
           ) VALUES (
             ${sqlString(plan.operationId)}, ${sqlString(String(stepKey))}, ${Number(order)},
             ${sqlString(String(status))}, ${status === 'succeeded' ? 1 : 0},
             ${status === 'succeeded' ? 1 : 'NULL'},
             ${status === 'succeeded' ? 1 : 'NULL'},
             ${status === 'succeeded' ? now : 'NULL'},
             ${completed === null ? 'NULL' : completed}, ${now}
           );`
      )
    );
  }
  return statements.join('\n');
}

function resourceSql(
  plan: InitialControlPlaneResourcePlan,
  environmentId: string,
  tenantId: string,
  placementPolicy: 'shared_pool' | 'tenant_exclusive',
  now: number
) {
  const tenantExclusive = placementPolicy === 'tenant_exclusive';
  const spec = JSON.stringify({
    bootstrap: true,
    bootstrap_role: plan.role,
    data_role: plan.role,
    residency_policy_id: 'builtin:residency:default',
    residency_partition: 'default',
    read_replication_mode: 'disabled',
    allocation_scope: plan.role === 'lookup' ? undefined : placementPolicy,
    owner_tenant_id: plan.role === 'lookup' || !tenantExclusive ? undefined : tenantId,
    migration_stream_id: plan.migrationStreamId,
    release_id: plan.releaseId,
    manifest_digest: plan.manifestDigest,
    migration_files: plan.migrationFiles,
  });
  const sentinel = JSON.stringify({
    stream_id: plan.migrationStreamId,
    release_id: plan.releaseId,
    manifest_digest: plan.manifestDigest,
    applied_file_count: plan.migrationFiles.length,
    last_filename: plan.migrationFiles.at(-1)?.path,
    state: 'ready',
  });
  const statements = [
    `INSERT OR IGNORE INTO control_desired_resources (
       desired_resource_id, environment_id, resource_kind, logical_shard_id,
       resource_scope, tenant_id, deterministic_name, ownership_fingerprint, desired_state,
       provisioning_state, origin_operation_id, observed_resource_id,
       desired_spec_json, created_at, updated_at
     ) VALUES (
       ${sqlString(plan.desiredResourceId)}, ${sqlString(environmentId)}, 'd1',
       ${sqlString(plan.logicalShardId)}, ${plan.role === 'lookup' || !tenantExclusive ? "'platform'" : "'tenant'"},
       ${plan.role === 'lookup' || !tenantExclusive ? 'NULL' : sqlString(tenantId)}, ${sqlString(plan.databaseName)},
       ${sqlString(plan.ownershipFingerprint)}, 'present', 'ready',
       ${sqlString(plan.operationId)}, ${sqlString(plan.observedResourceId)},
       ${sqlString(spec)}, ${now}, ${now}
     );`,
    `INSERT OR IGNORE INTO control_observed_resources (
       observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
       provider_name, resource_kind, ownership_fingerprint, observed_state,
       observed_spec_json, observed_at
     ) VALUES (
       ${sqlString(plan.observedResourceId)}, ${sqlString(environmentId)},
       ${sqlString(plan.desiredResourceId)}, ${sqlString(plan.databaseId)},
       ${sqlString(plan.databaseName)}, 'd1', ${sqlString(plan.ownershipFingerprint)},
       'present', ${sqlString(JSON.stringify({ binding_ref: plan.binding, bootstrap: true }))},
       ${now}
     );`,
    `INSERT OR IGNORE INTO control_tenant_database_migration_state (
       desired_resource_id, environment_id, operation_id, stream_id, release_id,
       manifest_digest, provider_database_id, state, expected_file_count,
       applied_file_count, last_filename, observed_sentinel_json,
       started_at, completed_at, updated_at
     ) VALUES (
       ${sqlString(plan.desiredResourceId)}, ${sqlString(environmentId)},
       ${sqlString(plan.operationId)}, ${sqlString(plan.migrationStreamId)},
       ${sqlString(plan.releaseId)}, ${sqlString(plan.manifestDigest)},
       ${sqlString(plan.databaseId)}, 'ready', ${plan.migrationFiles.length},
       ${plan.migrationFiles.length}, ${sqlString(plan.migrationFiles.at(-1)!.path)},
       ${sqlString(sentinel)}, ${now}, ${now}, ${now}
     );`,
  ];
  if (plan.role === 'lookup') {
    statements.push(
      `INSERT OR IGNORE INTO control_lookup_physical_shards (
         lookup_shard_id, environment_id, residency_partition, binding_ref,
         d1_desired_resource_id, status, created_at, updated_at
       ) VALUES (
         ${sqlString(plan.lookupShardId!)}, ${sqlString(environmentId)}, 'default',
         ${sqlString(plan.binding)}, ${sqlString(plan.desiredResourceId)}, 'ready', ${now}, ${now}
       );`,
      `WITH RECURSIVE buckets(virtual_bucket) AS (
         SELECT 0 UNION ALL SELECT virtual_bucket + 1 FROM buckets WHERE virtual_bucket < 4095
       )
       INSERT OR IGNORE INTO control_lookup_bucket_assignments (
         environment_id, virtual_bucket, lookup_shard_id, assignment_generation,
         state, updated_at
       ) SELECT ${sqlString(environmentId)}, virtual_bucket, ${sqlString(plan.lookupShardId!)},
                1, 'active', ${now}
           FROM buckets;`
    );
  } else {
    statements.push(
      `INSERT OR IGNORE INTO control_tenant_shards (
         shard_id, environment_id, data_role, residency_policy_id, residency_partition,
         generation, logical_shard_id, binding_ref, d1_desired_resource_id,
         read_replication_mode, observed_replication_state, status,
         allocation_scope, owner_tenant_id, created_at, updated_at
       ) VALUES (
         ${sqlString(plan.shardId!)}, ${sqlString(environmentId)}, ${sqlString(plan.role)},
         'builtin:residency:default', 'default', 1, ${sqlString(plan.logicalShardId)},
         ${sqlString(plan.binding)}, ${sqlString(plan.desiredResourceId)},
         'disabled', 'disabled', 'ready', ${sqlString(placementPolicy)}, ${tenantExclusive ? sqlString(tenantId) : 'NULL'}, ${now}, ${now}
       );`,
      `INSERT OR IGNORE INTO control_tenant_shard_assignments (
         environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
         shard_id, assignment_generation, assignment_state, source_operation_id,
         created_at, activated_at, updated_at
       ) VALUES (
         ${sqlString(environmentId)}, ${sqlString(tenantId)}, ${sqlString(plan.role)},
         'builtin:residency:default', 'default', ${sqlString(plan.shardId!)}, 1, 'active',
         ${sqlString(plan.operationId)}, ${now}, ${now}, ${now}
       );`
    );
  }
  return statements.join('\n');
}

function initialDefaultRouteSql(
  plans: readonly InitialControlPlaneResourcePlan[],
  environmentId: string,
  tenantId: string,
  now: number
): string {
  const defaultPlan = plans.find((plan) => plan.role === 'tenant_core/default');
  if (!defaultPlan?.shardId) {
    throw new Error('control_bootstrap_default_shard_missing');
  }
  const identity = initialDefaultRouteIdentity(environmentId, tenantId);
  return [
    `INSERT OR IGNORE INTO control_tenant_default_allocations (
       allocation_id, environment_id, tenant_id, residency_policy_id,
       residency_partition, selected_shard_id, reservation_state,
       idempotency_key, route_generation, capacity_counted_at,
       created_at, committed_at, updated_at
     ) VALUES (
       ${sqlString(identity.allocationId)}, ${sqlString(environmentId)}, ${sqlString(tenantId)},
       'builtin:residency:default', 'default', ${sqlString(defaultPlan.shardId)}, 'committed',
       ${sqlString(identity.idempotencyKey)}, 1, ${now},
       ${now}, ${now}, ${now}
     );`,
    `UPDATE control_shard_capacity
        SET allocated_account_count =
              (SELECT COUNT(*) FROM control_tenant_shard_allocations allocation
                WHERE allocation.selected_shard_id = control_shard_capacity.shard_id
                  AND allocation.reservation_state IN ('reserved', 'committed')
                  AND allocation.capacity_counted_at IS NOT NULL) +
              (SELECT COUNT(*) FROM control_tenant_default_allocations allocation
                WHERE allocation.selected_shard_id = control_shard_capacity.shard_id
                  AND allocation.reservation_state IN ('reserved', 'committed')
                  AND allocation.capacity_counted_at IS NOT NULL),
            updated_at = ${now}
      WHERE shard_id = ${sqlString(defaultPlan.shardId)};`,
  ].join('\n');
}

export async function buildInitialControlTopologyRegistration(input: {
  environmentId: string;
  tenantId: string;
  lock: AuthrimLock;
  release: ReleaseMigrationManifest;
  releaseDraft?: boolean;
  automaticProvisioning?: boolean;
  placementPolicy: 'shared_pool' | 'tenant_exclusive';
  now?: number;
}): Promise<{
  plans: InitialControlPlaneResourcePlan[];
  ownershipFingerprint: string;
  manifestDigest: string;
  sql: string;
}> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('control_bootstrap_time_invalid');
  const tenantId = input.tenantId.trim();
  if (!isValidTenantId(tenantId)) throw new Error('control_bootstrap_tenant_id_invalid');
  const plans = buildInitialControlPlaneResourcePlans({
    env: input.environmentId,
    lock: input.lock,
    release: input.release,
    releaseDraft: input.releaseDraft,
  });
  const ownershipFingerprint = await calculateControlBootstrapOwnershipFingerprint(
    plans.map(
      (plan): ControlBootstrapOwnershipResource => ({
        role: plan.role,
        desiredResourceId: plan.desiredResourceId,
        providerDatabaseId: plan.databaseId,
        providerName: plan.databaseName,
        ownershipFingerprint: plan.ownershipFingerprint,
        bindingRef: plan.binding,
        manifestDigest: plan.manifestDigest,
      })
    )
  );
  const manifestDigest = plans[0]!.manifestDigest;
  const sql = [
    `INSERT OR IGNORE INTO control_tenant_placement_policies (
       environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
       source_operation_id, idempotency_key, activated_at, created_at, updated_at
     ) VALUES (
       ${sqlString(input.environmentId)}, ${sqlString(tenantId)}, ${sqlString(input.placementPolicy)}, 1, 'active',
       ${sqlString(plans.find((plan) => plan.role === 'tenant_core/default')!.operationId)},
       ${sqlString(`bootstrap:placement:${tenantId}:v1`)}, ${now}, ${now}, ${now}
     );`,
    ...plans.flatMap((plan) => [
      operationSql(plan, input.environmentId, now, input.automaticProvisioning === true),
      resourceSql(plan, input.environmentId, tenantId, input.placementPolicy, now),
    ]),
    initialDefaultRouteSql(plans, input.environmentId, tenantId, now),
    `INSERT INTO control_bootstrap_handoffs (
       environment_id, state, ownership_fingerprint, release_manifest_digest, updated_at
     ) VALUES (
       ${sqlString(input.environmentId)}, 'creating', ${sqlString(ownershipFingerprint)},
       ${sqlString(manifestDigest)}, ${now}
     ) ON CONFLICT(environment_id) DO UPDATE SET
       ownership_fingerprint = excluded.ownership_fingerprint,
       release_manifest_digest = excluded.release_manifest_digest,
       state = 'creating',
       verification_error_code = NULL,
       verified_at = NULL,
       accepted_at = NULL,
       updated_at = excluded.updated_at
     WHERE control_bootstrap_handoffs.state = 'creating'
        OR (
          control_bootstrap_handoffs.state = 'blocked'
          AND (
            control_bootstrap_handoffs.verification_error_code GLOB 'control_bootstrap_worker_*'
            OR control_bootstrap_handoffs.verification_error_code =
               'control_bootstrap_provider_capability_rejected'
          )
        );`,
  ].join('\n\n');
  return { plans, ownershipFingerprint, manifestDigest, sql };
}

export async function registerInitialControlTopology(input: {
  environmentId: string;
  tenantId: string;
  controlDatabaseName: string;
  lock: AuthrimLock;
  release: ReleaseMigrationManifest;
  releaseDraft?: boolean;
  automaticProvisioning?: boolean;
  placementPolicy: 'shared_pool' | 'tenant_exclusive';
  now?: number;
  execute?: typeof executeD1Command;
  query?: typeof queryD1Rows;
}): Promise<{ ownershipFingerprint: string; manifestDigest: string }> {
  const plan = await buildInitialControlTopologyRegistration(input);
  const tenantId = input.tenantId.trim();
  const defaultPlan = plan.plans.find((entry) => entry.role === 'tenant_core/default');
  if (!defaultPlan?.shardId) throw new Error('control_bootstrap_default_shard_missing');
  const defaultRouteIdentity = initialDefaultRouteIdentity(input.environmentId, tenantId);
  const tenantExclusive = input.placementPolicy === 'tenant_exclusive';
  const placementSql = sqlString(input.placementPolicy);
  const shardOwnershipSql = tenantExclusive
    ? `shard.owner_tenant_id = ${sqlString(tenantId)}
               AND desired.resource_scope = 'tenant'
               AND desired.tenant_id = ${sqlString(tenantId)}
               AND json_extract(desired.desired_spec_json, '$.owner_tenant_id') =
                   ${sqlString(tenantId)}`
    : `shard.owner_tenant_id IS NULL
               AND desired.resource_scope = 'platform'
               AND desired.tenant_id IS NULL
               AND json_extract(desired.desired_spec_json, '$.owner_tenant_id') IS NULL`;
  const assignmentOwnershipSql = tenantExclusive
    ? 'shard.owner_tenant_id = assignment.tenant_id'
    : 'shard.owner_tenant_id IS NULL';
  const defaultRouteOwnershipSql = tenantExclusive
    ? 'shard.owner_tenant_id = allocation.tenant_id'
    : 'shard.owner_tenant_id IS NULL';
  await (input.execute ?? executeD1Command)(input.controlDatabaseName, plan.sql);
  const rows = await (input.query ?? queryD1Rows)<{
    state: string;
    ownership_fingerprint: string;
    release_manifest_digest: string;
    resource_count: number | string;
    migration_count: number | string;
    shard_count: number | string;
    placement_shard_count: number | string;
    placement_policy_count: number | string;
    active_assignment_count: number | string;
    default_route_count: number | string;
    lookup_count: number | string;
    bucket_count: number | string;
  }>(
    input.controlDatabaseName,
    `SELECT handoff.state, handoff.ownership_fingerprint, handoff.release_manifest_digest,
            (SELECT COUNT(*) FROM control_desired_resources desired
              WHERE desired.environment_id = handoff.environment_id
                AND json_extract(desired.desired_spec_json, '$.bootstrap') = 1
                AND json_extract(desired.desired_spec_json, '$.manifest_digest') =
                    handoff.release_manifest_digest) AS resource_count,
            (SELECT COUNT(*) FROM control_tenant_database_migration_state migration
              JOIN control_desired_resources desired
                ON desired.desired_resource_id = migration.desired_resource_id
               AND desired.environment_id = migration.environment_id
             WHERE migration.environment_id = handoff.environment_id
               AND migration.state = 'ready'
               AND migration.manifest_digest = handoff.release_manifest_digest
               AND json_extract(desired.desired_spec_json, '$.bootstrap') = 1) AS migration_count,
            (SELECT COUNT(*) FROM control_tenant_shards shard
              JOIN control_desired_resources desired
                ON desired.desired_resource_id = shard.d1_desired_resource_id
             WHERE shard.environment_id = handoff.environment_id
               AND json_extract(desired.desired_spec_json, '$.bootstrap') = 1) AS shard_count,
            (SELECT COUNT(*) FROM control_tenant_shards shard
              JOIN control_desired_resources desired
                ON desired.desired_resource_id = shard.d1_desired_resource_id
               AND desired.environment_id = shard.environment_id
             WHERE shard.environment_id = handoff.environment_id
               AND shard.allocation_scope = ${placementSql}
               AND ${shardOwnershipSql}
               AND json_extract(desired.desired_spec_json, '$.bootstrap') = 1
               AND json_extract(desired.desired_spec_json, '$.allocation_scope') =
                   ${placementSql}) AS placement_shard_count,
            (SELECT COUNT(*) FROM control_tenant_placement_policies policy
             WHERE policy.environment_id = handoff.environment_id
               AND policy.tenant_id = ${sqlString(input.tenantId.trim())}
               AND policy.isolation_policy = ${placementSql}
               AND policy.policy_state = 'active') AS placement_policy_count,
            (SELECT COUNT(*) FROM control_tenant_shard_assignments assignment
              JOIN control_tenant_shards shard
                ON shard.environment_id = assignment.environment_id
               AND shard.shard_id = assignment.shard_id
             WHERE assignment.environment_id = handoff.environment_id
               AND assignment.tenant_id = ${sqlString(input.tenantId.trim())}
               AND assignment.assignment_state = 'active'
               AND shard.allocation_scope = ${placementSql}
               AND ${assignmentOwnershipSql}
               AND shard.data_role = assignment.data_role
               AND shard.residency_policy_id = assignment.residency_policy_id
               AND shard.residency_partition = assignment.residency_partition)
                AS active_assignment_count,
            (SELECT COUNT(*) FROM control_tenant_default_allocations allocation
              JOIN control_tenant_shard_assignments assignment
                ON assignment.environment_id = allocation.environment_id
               AND assignment.tenant_id = allocation.tenant_id
               AND assignment.data_role = 'tenant_core/default'
               AND assignment.residency_policy_id = allocation.residency_policy_id
               AND assignment.residency_partition = allocation.residency_partition
               AND assignment.shard_id = allocation.selected_shard_id
               AND assignment.assignment_state = 'active'
               AND assignment.assignment_generation = allocation.route_generation
               AND assignment.source_operation_id = ${sqlString(defaultPlan.operationId)}
              JOIN control_tenant_shards shard
                ON shard.environment_id = allocation.environment_id
               AND shard.shard_id = allocation.selected_shard_id
             WHERE allocation.environment_id = handoff.environment_id
               AND allocation.tenant_id = ${sqlString(tenantId)}
               AND allocation.allocation_id = ${sqlString(defaultRouteIdentity.allocationId)}
               AND allocation.idempotency_key = ${sqlString(defaultRouteIdentity.idempotencyKey)}
               AND allocation.reservation_state = 'committed'
               AND allocation.capacity_counted_at IS NOT NULL
               AND allocation.selected_shard_id = ${sqlString(defaultPlan.shardId)}
               AND allocation.route_generation = 1
               AND shard.generation = allocation.route_generation
               AND shard.data_role = 'tenant_core/default'
               AND shard.residency_policy_id = allocation.residency_policy_id
               AND shard.residency_partition = allocation.residency_partition
               AND shard.allocation_scope = ${placementSql}
               AND ${defaultRouteOwnershipSql}
               AND shard.d1_desired_resource_id = ${sqlString(defaultPlan.desiredResourceId)})
                AS default_route_count,
            (SELECT COUNT(*) FROM control_lookup_physical_shards lookup
              JOIN control_desired_resources desired
                ON desired.desired_resource_id = lookup.d1_desired_resource_id
             WHERE lookup.environment_id = handoff.environment_id
               AND json_extract(desired.desired_spec_json, '$.bootstrap') = 1) AS lookup_count,
            (SELECT COUNT(*) FROM control_lookup_bucket_assignments assignment
             WHERE assignment.environment_id = handoff.environment_id) AS bucket_count
       FROM control_bootstrap_handoffs handoff
      WHERE handoff.environment_id = ${sqlString(input.environmentId)}`
  );
  const row = rows[0];
  const count = (value: number | string | undefined) => Number(value ?? 0);
  if (
    !row ||
    !['creating', 'pending_verification'].includes(row.state) ||
    row.ownership_fingerprint !== plan.ownershipFingerprint ||
    row.release_manifest_digest !== plan.manifestDigest ||
    count(row.resource_count) !== 4 ||
    count(row.migration_count) !== 4 ||
    count(row.shard_count) !== 3 ||
    count(row.placement_shard_count) !== 3 ||
    count(row.placement_policy_count) !== 1 ||
    count(row.active_assignment_count) !== 3 ||
    count(row.default_route_count) !== 1 ||
    count(row.lookup_count) !== 1 ||
    count(row.bucket_count) !== 4096
  ) {
    throw new Error('control_bootstrap_topology_registration_mismatch');
  }
  return {
    ownershipFingerprint: plan.ownershipFingerprint,
    manifestDigest: plan.manifestDigest,
  };
}

function activeWorkerDeployment(deployments: readonly CloudflareWorkerDeployment[]): {
  deploymentId: string;
  versionId: string;
} {
  const candidates = deployments
    .map((deployment) => {
      const version =
        deployment.versions.length === 1 && deployment.versions[0]?.percentage === 100
          ? deployment.versions[0]
          : null;
      const createdAt = Date.parse(deployment.created_on);
      if (!deployment.id || !version?.version_id || !Number.isFinite(createdAt)) return null;
      return { deploymentId: deployment.id, versionId: version.version_id, createdAt };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.deploymentId.localeCompare(left.deploymentId)
    );
  if (!candidates[0]) throw new Error('control_bootstrap_worker_deployment_missing');
  if (candidates[1]?.createdAt === candidates[0].createdAt) {
    throw new Error('control_bootstrap_worker_deployment_ambiguous');
  }
  return candidates[0];
}

function isSecretOnlyWorkerVersionAdvance(input: {
  deployments: readonly CloudflareWorkerDeployment[];
  expectedVersionId: string;
  activeVersionId: string;
}): boolean {
  const versions = input.deployments
    .flatMap((deployment) => {
      const version =
        deployment.versions.length === 1 && deployment.versions[0]?.percentage === 100
          ? deployment.versions[0]
          : null;
      const createdAt = Date.parse(deployment.created_on);
      if (!version?.version_id || !Number.isFinite(createdAt)) return [];
      return [
        {
          versionId: version.version_id,
          createdAt,
          triggeredBy: deployment.annotations?.['workers/triggered_by'],
        },
      ];
    })
    .sort((left, right) => left.createdAt - right.createdAt);
  const expectedIndex = versions.findIndex(
    (version) => version.versionId === input.expectedVersionId
  );
  const activeIndex = versions.findIndex((version) => version.versionId === input.activeVersionId);
  return (
    expectedIndex >= 0 &&
    activeIndex > expectedIndex &&
    versions
      .slice(expectedIndex + 1, activeIndex + 1)
      .every((version) => version.triggeredBy === 'secret')
  );
}

function workerDeploymentIdentity(
  workerScriptName: string,
  deploymentId: string,
  versionId: string
) {
  return `${workerScriptName}\0${deploymentId}\0${versionId}`;
}

export function workerVersionIdentity(workerScriptName: string, versionId: string): string {
  return `${workerScriptName}\0${versionId}`;
}

export async function listInitialBootstrapReconciledWorkerVersions(input: {
  environmentId: string;
  controlDatabaseName: string;
  query?: typeof queryD1Rows;
}): Promise<Set<string>> {
  const query = input.query ?? queryD1Rows;
  const rows = await query<{
    worker_script_name: string;
    patch_result_version_id: string;
  }>(
    input.controlDatabaseName,
    `SELECT DISTINCT worker_script_name, patch_result_version_id
       FROM control_worker_binding_reconciliations
      WHERE environment_id = ${sqlString(input.environmentId)}
        AND state IN ('settings_patched', 'smoke_verifying', 'stabilizing', 'succeeded')
        AND patch_result_version_id IS NOT NULL`
  );
  return new Set(
    rows.map((row) => workerVersionIdentity(row.worker_script_name, row.patch_result_version_id))
  );
}

export async function recordInitialBootstrapWorkerEvidence(input: {
  environmentId: string;
  controlDatabaseName: string;
  deployments: readonly DeployResult[];
  allowSecretTriggeredVersionAdvanceFor?: readonly string[];
  now?: number;
  accountId?: string;
  token?: string;
  createClient?: (
    accountId: string,
    token: string
  ) => Pick<CloudflareControlApiClient, 'getWorkerSettings' | 'listWorkerDeployments'>;
  execute?: typeof executeD1Command;
  query?: typeof queryD1Rows;
}): Promise<{ workerCount: number; controlDeploymentId: string; controlVersionId: string }> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('control_bootstrap_time_invalid');
  const accountId = input.accountId?.trim() || (await getAccountId());
  const workersToken =
    input.token?.trim() ||
    process.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim() ||
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
    (await getCloudflareApiToken())?.token;
  if (!accountId || !workersToken) {
    throw new Error('control_bootstrap_worker_read_credentials_missing');
  }
  const client = input.createClient
    ? input.createClient(accountId, workersToken)
    : new CloudflareControlApiClient({ accountId, tokens: { workers: workersToken } });
  const query = input.query ?? queryD1Rows;
  const inventory = await query<{ worker_script_name: string }>(
    input.controlDatabaseName,
    `SELECT worker_script_name FROM control_desired_worker_inventory
      WHERE environment_id = ${sqlString(input.environmentId)} AND status = 'active'
      ORDER BY worker_script_name`
  );
  if (inventory.length === 0) throw new Error('control_bootstrap_worker_inventory_missing');
  const reconciledDeployments = new Set(
    (
      await query<{
        worker_script_name: string;
        patch_result_deployment_id: string;
        patch_result_version_id: string;
      }>(
        input.controlDatabaseName,
        `SELECT worker_script_name, patch_result_deployment_id, patch_result_version_id
           FROM control_worker_binding_reconciliations
          WHERE environment_id = ${sqlString(input.environmentId)}
            AND state = 'succeeded'
            AND patch_result_deployment_id IS NOT NULL
            AND patch_result_version_id IS NOT NULL`
      )
    ).map((row) =>
      workerDeploymentIdentity(
        row.worker_script_name,
        row.patch_result_deployment_id,
        row.patch_result_version_id
      )
    )
  );
  const deploymentByName = new Map<string, DeployResult>();
  for (const deployment of input.deployments) {
    if (!deployment.success && !deployment.trafficCommitted) continue;
    if (deploymentByName.has(deployment.workerName)) {
      throw new Error(`control_bootstrap_worker_deploy_result_duplicate:${deployment.workerName}`);
    }
    deploymentByName.set(deployment.workerName, deployment);
  }
  const evidence = [] as Array<{
    workerScriptName: string;
    deploymentId: string;
    versionId: string;
    settingsDigest: string;
  }>;
  const allowSecretAdvance = new Set(input.allowSecretTriggeredVersionAdvanceFor ?? []);
  for (const row of inventory) {
    const deployed = deploymentByName.get(row.worker_script_name);
    if (!deployed?.cloudflareVersionId) {
      throw new Error(`control_bootstrap_worker_deploy_result_missing:${row.worker_script_name}`);
    }
    const [settings, deployments] = await Promise.all([
      client.getWorkerSettings(row.worker_script_name),
      client.listWorkerDeployments(row.worker_script_name),
    ]);
    const active = activeWorkerDeployment(deployments);
    const isReconciledBindingDeployment = reconciledDeployments.has(
      workerDeploymentIdentity(row.worker_script_name, active.deploymentId, active.versionId)
    );
    if (
      active.versionId !== deployed.cloudflareVersionId &&
      !isReconciledBindingDeployment &&
      (!allowSecretAdvance.has(row.worker_script_name) ||
        !isSecretOnlyWorkerVersionAdvance({
          deployments,
          expectedVersionId: deployed.cloudflareVersionId,
          activeVersionId: active.versionId,
        }))
    ) {
      throw new Error(`control_bootstrap_worker_version_mismatch:${row.worker_script_name}`);
    }
    evidence.push({
      workerScriptName: row.worker_script_name,
      deploymentId: active.deploymentId,
      versionId: active.versionId,
      settingsDigest: await digestCloudflareWorkerSettings(settings),
    });
  }
  const control = evidence.find(
    (entry) => entry.workerScriptName === `${input.environmentId}-ar-control`
  );
  if (!control) throw new Error('control_bootstrap_control_worker_evidence_missing');

  const expectedValues = evidence
    .map(
      (entry) =>
        `(${sqlString(entry.workerScriptName)}, ${sqlString(entry.deploymentId)}, ` +
        `${sqlString(entry.versionId)}, ${sqlString(entry.settingsDigest)})`
    )
    .join(',\n');
  const statements = evidence
    .map(
      (entry) => `INSERT INTO control_bootstrap_worker_evidence (
         environment_id, worker_script_name, expected_deployment_id, expected_version_id,
         expected_settings_digest, state, updated_at
       ) VALUES (
         ${sqlString(input.environmentId)}, ${sqlString(entry.workerScriptName)},
         ${sqlString(entry.deploymentId)}, ${sqlString(entry.versionId)},
         ${sqlString(entry.settingsDigest)}, 'pending', ${now}
       )
       ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
         expected_deployment_id = excluded.expected_deployment_id,
         expected_version_id = excluded.expected_version_id,
         expected_settings_digest = excluded.expected_settings_digest,
         observed_settings_digest = NULL,
         state = 'pending',
         verification_error_code = NULL,
         observed_at = NULL,
         updated_at = excluded.updated_at
       WHERE EXISTS (
         SELECT 1 FROM control_bootstrap_handoffs handoff
          WHERE handoff.environment_id = excluded.environment_id
            AND (
              handoff.state IN ('creating', 'pending_verification') OR
               (handoff.state = 'blocked'
                AND (
                  handoff.verification_error_code GLOB 'control_bootstrap_worker_*'
                  OR handoff.verification_error_code =
                     'control_bootstrap_provider_capability_rejected'
                ))
            )
       );`
    )
    .join('\n');
  const execute = input.execute ?? executeD1Command;
  await execute(
    input.controlDatabaseName,
    `${statements}
     UPDATE control_bootstrap_handoffs
        SET state = 'pending_verification', observed_deployment_id = ${sqlString(control.deploymentId)},
            observed_version_id = ${sqlString(control.versionId)}, verification_error_code = NULL,
            verified_at = NULL, accepted_at = NULL, updated_at = ${now}
      WHERE environment_id = ${sqlString(input.environmentId)}
        AND (
          state = 'creating'
          OR state = 'pending_verification'
            OR (state = 'blocked'
            AND (
              verification_error_code GLOB 'control_bootstrap_worker_*'
              OR verification_error_code = 'control_bootstrap_provider_capability_rejected'
            ))
        );`
  );
  const [reflected] = await query<{
    state: string;
    observed_deployment_id: string | null;
    observed_version_id: string | null;
    verification_error_code: string | null;
    expected_count: number | string;
    exact_count: number | string;
    evidence_count: number | string;
  }>(
    input.controlDatabaseName,
    `WITH expected(
       worker_script_name, expected_deployment_id, expected_version_id, expected_settings_digest
     ) AS (VALUES ${expectedValues})
     SELECT handoff.state, handoff.observed_deployment_id, handoff.observed_version_id,
            handoff.verification_error_code,
            (SELECT COUNT(*) FROM control_desired_worker_inventory inventory
              WHERE inventory.environment_id = handoff.environment_id
                AND inventory.status = 'active') AS expected_count,
            (SELECT COUNT(*) FROM expected
              JOIN control_bootstrap_worker_evidence evidence
                ON evidence.environment_id = handoff.environment_id
               AND evidence.worker_script_name = expected.worker_script_name
               AND evidence.expected_deployment_id = expected.expected_deployment_id
               AND evidence.expected_version_id = expected.expected_version_id
               AND evidence.expected_settings_digest = expected.expected_settings_digest
               AND evidence.state IN ('pending', 'verified')) AS exact_count,
            (SELECT COUNT(*) FROM control_bootstrap_worker_evidence evidence
              WHERE evidence.environment_id = handoff.environment_id) AS evidence_count
       FROM control_bootstrap_handoffs handoff
      WHERE handoff.environment_id = ${sqlString(input.environmentId)}`
  );
  if (
    reflected?.state === 'blocked' &&
    typeof reflected.verification_error_code === 'string' &&
    /^control_bootstrap_[a-z0-9_]+$/u.test(reflected.verification_error_code)
  ) {
    throw new Error(reflected.verification_error_code);
  }
  if (
    !reflected ||
    !['pending_verification', 'accepted'].includes(reflected.state) ||
    reflected.observed_deployment_id !== control.deploymentId ||
    reflected.observed_version_id !== control.versionId ||
    Number(reflected.expected_count) !== evidence.length ||
    Number(reflected.exact_count) !== evidence.length ||
    Number(reflected.evidence_count) !== evidence.length
  ) {
    throw new Error('control_bootstrap_worker_evidence_reflection_mismatch');
  }
  return {
    workerCount: evidence.length,
    controlDeploymentId: control.deploymentId,
    controlVersionId: control.versionId,
  };
}

export async function isInitialBootstrapHandoffAccepted(input: {
  environmentId: string;
  controlDatabaseName: string;
  query?: typeof queryD1Rows;
}): Promise<boolean> {
  const query = input.query ?? queryD1Rows;
  const [row] = await query<{ state: string }>(
    input.controlDatabaseName,
    `SELECT state
       FROM control_bootstrap_handoffs
      WHERE environment_id = ${sqlString(input.environmentId)}`
  );
  return row?.state === 'accepted';
}

export async function requestInitialBootstrapAcceleration(input: {
  apiBaseUrl: string;
  environmentId: string;
  keysDir: string;
  activeSlot: 'A' | 'B';
  activeKeyId: string;
  fetch?: typeof fetch;
}): Promise<'accepted' | 'inactive'> {
  const privateJwk = JSON.parse(
    await readFile(
      join(
        input.keysDir,
        `smoke_rpc_signing_jwk_slot_${input.activeSlot.toLowerCase()}.private.jwk.json`
      ),
      'utf8'
    )
  ) as Record<string, unknown>;
  const proof = await signBootstrapAcceleratorProof({
    environmentId: input.environmentId,
    jti: `setup-${randomBytes(18).toString('base64url')}`,
    privateJwk,
    keyId: input.activeKeyId,
  });
  const response = await (input.fetch ?? fetchWithTimeout)(
    `${input.apiBaseUrl.replace(/\/+$/u, '')}/api/internal/control/bootstrap/advance`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${proof}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  );
  if (response.status === 202) return 'accepted';
  if (response.status === 404) return 'inactive';
  throw new Error(`control_bootstrap_accelerator_http_${response.status}`);
}

export async function waitForInitialBootstrapHandoff(input: {
  environmentId: string;
  controlDatabaseName: string;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  pollIntervalMs?: number;
  query?: typeof queryD1Rows;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onProgress?: (message: string) => void;
  advanceBindings?: () => Promise<unknown>;
  refreshEvidence?: () => Promise<unknown>;
  reconcile?: () => Promise<unknown>;
}): Promise<{ state: 'accepted'; acceptedAt: number }> {
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? 5 * 60_000, 30 * 60_000));
  const stallTimeoutMs = Math.max(1_000, Math.min(input.stallTimeoutMs ?? timeoutMs, timeoutMs));
  const pollIntervalMs = Math.max(250, Math.min(input.pollIntervalMs ?? 5_000, 30_000));
  const query = input.query ?? queryD1Rows;
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = input.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let stallDeadline = startedAt + stallTimeoutMs;
  let lastProgressIdentity = '';
  let completedBindingCountAwaitingConfirmation: number | null = null;
  while (now() <= deadline) {
    await input.advanceBindings?.();
    const [row] = await query<{
      state: string;
      verification_error_code: string | null;
      accepted_at: number | string | null;
      total_bindings: number | string;
      pending_bindings: number | string;
      failed_bindings: number | string;
      failed_binding_error_code: string | null;
      latest_binding_update: number | string | null;
    }>(
      input.controlDatabaseName,
      `SELECT handoff.state, handoff.verification_error_code, handoff.accepted_at,
              (SELECT COUNT(*) FROM control_worker_binding_reconciliations reconciliation
                WHERE reconciliation.environment_id = handoff.environment_id) AS total_bindings,
              (SELECT COUNT(*) FROM control_worker_binding_reconciliations reconciliation
                WHERE reconciliation.environment_id = handoff.environment_id
                  AND reconciliation.state NOT IN ('succeeded', 'blocked', 'rolled_back'))
                AS pending_bindings,
              (SELECT COUNT(*) FROM control_worker_binding_reconciliations reconciliation
                WHERE reconciliation.environment_id = handoff.environment_id
                  AND reconciliation.state IN ('blocked', 'rolled_back')) AS failed_bindings,
              (SELECT reconciliation.last_error_code
                 FROM control_worker_binding_reconciliations reconciliation
                WHERE reconciliation.environment_id = handoff.environment_id
                  AND reconciliation.state IN ('blocked', 'rolled_back')
                ORDER BY reconciliation.updated_at DESC LIMIT 1) AS failed_binding_error_code,
              (SELECT MAX(reconciliation.updated_at)
                 FROM control_worker_binding_reconciliations reconciliation
                WHERE reconciliation.environment_id = handoff.environment_id)
                AS latest_binding_update
         FROM control_bootstrap_handoffs handoff
        WHERE handoff.environment_id = ${sqlString(input.environmentId)}`
    );
    if (!row) throw new Error('control_bootstrap_handoff_missing');
    if (row.state === 'accepted') {
      const acceptedAt = Number(row.accepted_at);
      if (!Number.isSafeInteger(acceptedAt) || acceptedAt <= 0) {
        throw new Error('control_bootstrap_handoff_acceptance_invalid');
      }
      return { state: 'accepted', acceptedAt };
    }
    if (row.state === 'blocked') {
      throw new Error(
        `control_bootstrap_handoff_blocked:${row.verification_error_code ?? 'unknown'}`
      );
    }
    const failedBindings = Math.max(0, Number(row.failed_bindings) || 0);
    if (failedBindings > 0) {
      const safeError = /^control_[a-z0-9_]{1,128}$/u.test(row.failed_binding_error_code ?? '')
        ? row.failed_binding_error_code
        : 'control_worker_binding_reconciliation_failed';
      throw new Error(`control_bootstrap_binding_blocked:${safeError}`);
    }
    const pendingBindings = Math.max(0, Number(row.pending_bindings));
    const queriedTotalBindings = Number(row.total_bindings);
    const totalBindings =
      Number.isFinite(queriedTotalBindings) && queriedTotalBindings >= pendingBindings
        ? queriedTotalBindings
        : pendingBindings;
    const completedBindings = Math.max(0, totalBindings - pendingBindings);
    const progressIdentity = `${totalBindings}:${completedBindings}:${String(
      row.latest_binding_update ?? ''
    )}`;
    const progressChanged = progressIdentity !== lastProgressIdentity;
    if (progressChanged) {
      lastProgressIdentity = progressIdentity;
      stallDeadline = Math.min(deadline, now() + stallTimeoutMs);
      input.onProgress?.(
        pendingBindings === 0 && totalBindings > 0
          ? `Control verified ${totalBindings} Worker binding checks; confirming stable inventory...`
          : `Control is reconciling Worker bindings: ${completedBindings} complete, ${pendingBindings} pending (${totalBindings} discovered)`
      );
    }
    const bindingsAreQuiescent =
      pendingBindings === 0 &&
      totalBindings > 0 &&
      completedBindingCountAwaitingConfirmation === totalBindings;
    completedBindingCountAwaitingConfirmation =
      pendingBindings === 0 && totalBindings > 0 ? totalBindings : null;
    if (bindingsAreQuiescent) {
      await input.refreshEvidence?.();
      await input.reconcile?.();
    }
    await sleep(pollIntervalMs);
    if (now() > stallDeadline && now() <= deadline) {
      throw new Error('control_bootstrap_handoff_stalled');
    }
  }
  throw new Error('control_bootstrap_handoff_timeout');
}
