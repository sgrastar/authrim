import type { D1Database } from '@cloudflare/workers-types';
import {
  assertControlPlaneRecordIsSecretFree,
  getTenantDatabaseResourcePrefix,
  type CloudflareD1Database,
  type ControlStorageTopology,
  type ControlStorageTopologyLookupShard,
  type ControlStorageTopologyOperation,
  type ControlStorageTopologyTenant,
  type ControlStorageTopologyTenantShard,
} from '@authrim/ar-lib-core/control-plane';

interface PolicyRow {
  environment_name: string;
  max_concurrent_provisioning: number;
  max_ready_spares: number;
  max_d1_resources: number;
  daily_d1_create_budget: number;
  target_account_count: number;
}

interface TenantRow {
  tenant_id: string;
  isolation_policy: ControlStorageTopologyTenant['isolationPolicy'];
  policy_state: ControlStorageTopologyTenant['policyState'];
  account_count: number;
  assigned_shard_count: number;
}

interface TenantShardRow {
  shard_id: string;
  desired_resource_id: string;
  database_name: string;
  provider_database_id: string | null;
  data_role: ControlStorageTopologyTenantShard['dataRole'];
  allocation_scope: ControlStorageTopologyTenantShard['allocationScope'];
  owner_tenant_id: string | null;
  residency_partition: string;
  status: ControlStorageTopologyTenantShard['status'];
  health_status: ControlStorageTopologyTenantShard['healthStatus'];
  allocation_status: ControlStorageTopologyTenantShard['allocationStatus'];
  target_account_count: number | null;
  allocated_account_count: number | null;
  observed_account_count: number | null;
  storage_bytes: number | null;
  active_assignment_count: number;
  created_at: number;
  updated_at: number;
}

interface LookupShardRow {
  lookup_shard_id: string;
  desired_resource_id: string;
  database_name: string;
  provider_database_id: string | null;
  residency_partition: string;
  status: ControlStorageTopologyLookupShard['status'];
  capacity_weight: number;
  active_bucket_count: number;
  created_at: number;
  updated_at: number;
}

interface OperationRow {
  operation_id: string;
  tenant_id: string | null;
  data_role: ControlStorageTopologyOperation['dataRole'];
  database_name: string;
  provider_database_id: string | null;
  provisioning_state: ControlStorageTopologyOperation['provisioningState'];
  status: ControlStorageTopologyOperation['status'];
  attempt_count: number;
  last_error_code: string | null;
  decided_at: number;
  create_started_at: number | null;
  ready_at: number | null;
  updated_at: number;
}

function integer(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`control_storage_topology_${field}_invalid`);
  }
  return value;
}

function nullableInteger(value: number | null, field: string): number | null {
  return value === null ? null : integer(value, field);
}

export async function getControlStorageTopology(input: {
  database: D1Database;
  environmentId: string;
  generatedAt: number;
  providerDatabases?: readonly CloudflareD1Database[] | null;
}): Promise<ControlStorageTopology> {
  const [policyResult, tenantResult, tenantShardResult, lookupShardResult, operationResult] =
    await input.database.batch([
      input.database
        .prepare(
          `SELECT environment.environment_name, policy.max_concurrent_provisioning,
                  policy.max_ready_spares, policy.max_d1_resources,
                  policy.daily_d1_create_budget, policy.target_account_count
             FROM control_environments environment
             JOIN control_environment_resource_policies policy
               ON policy.environment_id = environment.environment_id
            WHERE environment.environment_id = ?`
        )
        .bind(input.environmentId),
      input.database
        .prepare(
          `SELECT placement.tenant_id, placement.isolation_policy, placement.policy_state,
                  (SELECT COUNT(*)
                     FROM control_tenant_shard_allocations allocation
                    WHERE allocation.environment_id = placement.environment_id
                      AND allocation.tenant_id = placement.tenant_id
                      AND allocation.data_role = 'tenant_core/users'
                      AND allocation.reservation_state = 'committed') AS account_count,
                  (SELECT COUNT(*)
                     FROM control_tenant_shard_assignments assignment
                    WHERE assignment.environment_id = placement.environment_id
                      AND assignment.tenant_id = placement.tenant_id
                      AND assignment.assignment_state = 'active') AS assigned_shard_count
             FROM control_tenant_placement_policies placement
            WHERE placement.environment_id = ?
            ORDER BY placement.tenant_id`
        )
        .bind(input.environmentId),
      input.database
        .prepare(
          `SELECT shard.shard_id, desired.desired_resource_id,
                  desired.deterministic_name AS database_name,
                  observed.provider_resource_id AS provider_database_id,
                  shard.data_role, shard.allocation_scope, shard.owner_tenant_id,
                  shard.residency_partition, shard.status,
                  capacity.health_status, capacity.allocation_status,
                  capacity.target_account_count, capacity.allocated_account_count,
                  capacity.observed_account_count, capacity.storage_bytes,
                  (SELECT COUNT(*)
                     FROM control_tenant_shard_assignments assignment
                    WHERE assignment.environment_id = shard.environment_id
                      AND assignment.shard_id = shard.shard_id
                      AND assignment.assignment_state = 'active') AS active_assignment_count,
                  shard.created_at, shard.updated_at
             FROM control_tenant_shards shard
             JOIN control_desired_resources desired
               ON desired.environment_id = shard.environment_id
              AND desired.desired_resource_id = shard.d1_desired_resource_id
             LEFT JOIN control_observed_resources observed
               ON observed.environment_id = desired.environment_id
              AND observed.observed_resource_id = desired.observed_resource_id
             LEFT JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
            WHERE shard.environment_id = ?
            ORDER BY shard.allocation_scope, shard.owner_tenant_id, shard.data_role,
                     shard.created_at, shard.shard_id`
        )
        .bind(input.environmentId),
      input.database
        .prepare(
          `SELECT lookup.lookup_shard_id, desired.desired_resource_id,
                  desired.deterministic_name AS database_name,
                  observed.provider_resource_id AS provider_database_id,
                  lookup.residency_partition, lookup.status, lookup.capacity_weight,
                  (SELECT COUNT(*)
                     FROM control_lookup_bucket_assignments assignment
                    WHERE assignment.environment_id = lookup.environment_id
                      AND assignment.lookup_shard_id = lookup.lookup_shard_id
                      AND assignment.state = 'active') AS active_bucket_count,
                  lookup.created_at, lookup.updated_at
             FROM control_lookup_physical_shards lookup
             JOIN control_desired_resources desired
               ON desired.environment_id = lookup.environment_id
              AND desired.desired_resource_id = lookup.d1_desired_resource_id
             LEFT JOIN control_observed_resources observed
               ON observed.environment_id = desired.environment_id
              AND observed.observed_resource_id = desired.observed_resource_id
            WHERE lookup.environment_id = ?
            ORDER BY lookup.created_at, lookup.lookup_shard_id`
        )
        .bind(input.environmentId),
      input.database
        .prepare(
          `SELECT operation.operation_id, desired.tenant_id,
                  CASE WHEN lookup.lookup_shard_id IS NOT NULL THEN 'lookup'
                       ELSE shard.data_role END AS data_role,
                  desired.deterministic_name AS database_name,
                  observed.provider_resource_id AS provider_database_id,
                  desired.provisioning_state, operation.status, operation.attempt_count,
                  operation.last_error_code, operation.created_at AS decided_at,
                  desired.create_started_at,
                  CASE WHEN operation.status = 'succeeded' THEN operation.completed_at
                       ELSE NULL END AS ready_at,
                  operation.updated_at
             FROM control_operations operation
             JOIN control_desired_resources desired
               ON desired.environment_id = operation.environment_id
              AND desired.origin_operation_id = operation.operation_id
              AND desired.resource_kind = 'd1'
             LEFT JOIN control_tenant_shards shard
               ON shard.environment_id = desired.environment_id
              AND shard.d1_desired_resource_id = desired.desired_resource_id
             LEFT JOIN control_lookup_physical_shards lookup
               ON lookup.environment_id = desired.environment_id
              AND lookup.d1_desired_resource_id = desired.desired_resource_id
             LEFT JOIN control_observed_resources observed
               ON observed.environment_id = desired.environment_id
              AND observed.observed_resource_id = desired.observed_resource_id
            WHERE operation.environment_id = ? AND operation.operation_kind = 'provision_shard'
            ORDER BY operation.created_at DESC, operation.operation_id DESC
            LIMIT 100`
        )
        .bind(input.environmentId),
    ]);

  const policy = (policyResult.results ?? [])[0] as PolicyRow | undefined;
  if (!policy) throw new Error('control_storage_topology_policy_missing');

  const tenants = ((tenantResult.results ?? []) as TenantRow[]).map((row) => ({
    tenantId: row.tenant_id,
    isolationPolicy: row.isolation_policy,
    policyState: row.policy_state,
    accountCount: integer(row.account_count, 'account_count'),
    assignedShardCount: integer(row.assigned_shard_count, 'assigned_shard_count'),
  }));
  const tenantShards = ((tenantShardResult.results ?? []) as TenantShardRow[]).map((row) => ({
    shardId: row.shard_id,
    desiredResourceId: row.desired_resource_id,
    databaseName: row.database_name,
    providerDatabaseId: row.provider_database_id,
    dataRole: row.data_role,
    allocationScope: row.allocation_scope,
    ownerTenantId: row.owner_tenant_id,
    residencyPartition: row.residency_partition,
    status: row.status,
    healthStatus: row.health_status,
    allocationStatus: row.allocation_status,
    targetAccountCount: nullableInteger(row.target_account_count, 'target_account_count'),
    allocatedAccountCount: nullableInteger(row.allocated_account_count, 'allocated_account_count'),
    observedAccountCount: nullableInteger(row.observed_account_count, 'observed_account_count'),
    storageBytes: nullableInteger(row.storage_bytes, 'storage_bytes'),
    activeAssignmentCount: integer(row.active_assignment_count, 'active_assignment_count'),
    createdAt: integer(row.created_at, 'shard_created_at'),
    updatedAt: integer(row.updated_at, 'shard_updated_at'),
  }));
  const lookupShards = ((lookupShardResult.results ?? []) as LookupShardRow[]).map((row) => ({
    lookupShardId: row.lookup_shard_id,
    desiredResourceId: row.desired_resource_id,
    databaseName: row.database_name,
    providerDatabaseId: row.provider_database_id,
    residencyPartition: row.residency_partition,
    status: row.status,
    capacityWeight: row.capacity_weight,
    activeBucketCount: integer(row.active_bucket_count, 'active_bucket_count'),
    createdAt: integer(row.created_at, 'lookup_created_at'),
    updatedAt: integer(row.updated_at, 'lookup_updated_at'),
  }));
  const operations = ((operationResult.results ?? []) as OperationRow[]).map((row) => ({
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    dataRole: row.data_role,
    databaseName: row.database_name,
    providerDatabaseId: row.provider_database_id,
    provisioningState: row.provisioning_state,
    status: row.status,
    attemptCount: integer(row.attempt_count, 'operation_attempt_count'),
    lastErrorCode: row.last_error_code,
    decidedAt: integer(row.decided_at, 'operation_decided_at'),
    createStartedAt: nullableInteger(row.create_started_at, 'operation_create_started_at'),
    readyAt: nullableInteger(row.ready_at, 'operation_ready_at'),
    updatedAt: integer(row.updated_at, 'operation_updated_at'),
  }));

  const managedProviderIds = new Set(
    [...tenantShards, ...lookupShards].flatMap((shard) =>
      shard.providerDatabaseId ? [shard.providerDatabaseId] : []
    )
  );
  const providerPrefix = `${getTenantDatabaseResourcePrefix(policy.environment_name)}-`;
  const providerDatabases = (input.providerDatabases ?? [])
    .filter((database) => database.name.startsWith(providerPrefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((database) => ({
      databaseId: database.uuid,
      databaseName: database.name,
      createdAt: database.created_at ?? null,
      fileSizeBytes:
        database.file_size === undefined ? null : integer(database.file_size, 'provider_file_size'),
      managedByControl: managedProviderIds.has(database.uuid),
    }));
  const activeOperationStatuses = new Set(['queued', 'running', 'waiting_retry']);
  const activeProvisioningStates = new Set(['requested', 'creating']);
  const summary = {
    providerInventoryAvailable:
      input.providerDatabases !== undefined && input.providerDatabases !== null,
    providerD1Count:
      input.providerDatabases === undefined || input.providerDatabases === null
        ? null
        : providerDatabases.length,
    controlManagedD1Count:
      tenantShards.filter((shard) => shard.status !== 'deleted').length +
      lookupShards.filter((shard) => shard.status !== 'retired').length,
    tenantShardCount: tenantShards.filter((shard) => shard.status !== 'deleted').length,
    lookupShardCount: lookupShards.filter((shard) => shard.status !== 'retired').length,
    activeTenantShardCount: tenantShards.filter((shard) => shard.status === 'active').length,
    readySpareCount: tenantShards.filter(
      (shard) =>
        shard.allocationScope === 'shared_pool' &&
        shard.status === 'ready' &&
        shard.activeAssignmentCount === 0
    ).length,
    provisioningD1Count: operations.filter(
      (operation) =>
        activeOperationStatuses.has(operation.status) ||
        activeProvisioningStates.has(operation.provisioningState)
    ).length,
    failedD1Count:
      tenantShards.filter((shard) => shard.status === 'failed').length +
      lookupShards.filter((shard) => shard.status === 'failed').length,
    accountCount: tenants.reduce((total, tenant) => total + tenant.accountCount, 0),
    inFlightOperationCount: operations.filter((operation) =>
      activeOperationStatuses.has(operation.status)
    ).length,
    blockedOperationCount: operations.filter((operation) => operation.status === 'blocked').length,
  };
  const topology: ControlStorageTopology = {
    environmentId: input.environmentId,
    generatedAt: input.generatedAt,
    policy: {
      maxConcurrentProvisioning: integer(
        policy.max_concurrent_provisioning,
        'max_concurrent_provisioning'
      ),
      maxReadySpares: integer(policy.max_ready_spares, 'max_ready_spares'),
      maxD1Resources: integer(policy.max_d1_resources, 'max_d1_resources'),
      dailyD1CreateBudget: integer(policy.daily_d1_create_budget, 'daily_d1_create_budget'),
      targetAccountCount: integer(policy.target_account_count, 'target_account_count'),
    },
    summary,
    tenants,
    tenantShards,
    lookupShards,
    operations,
    providerDatabases,
  };
  assertControlPlaneRecordIsSecretFree(topology);
  return topology;
}
