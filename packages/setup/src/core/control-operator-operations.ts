import {
  assertControlPlaneRecordIsSecretFree,
  managedPluginResourceName,
  pluginResourceHostBindingRef,
  type PluginProvisionedResourceKind,
} from '@authrim/ar-lib-core/control-plane';
import { queryD1Rows } from './cloudflare.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SAFE_BINDING = /^TDB_[A-Z0-9_]{1,123}$/u;
const DATA_ROLES = new Set(['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup']);

interface PendingOperatorOperationRow extends Record<string, unknown> {
  operation_id: string;
  environment_id: string;
  operation_kind: string;
  status: string;
  last_error_code: string | null;
  requested_by_type: string;
  attempt_count: number;
  retry_budget_started_at: number | null;
  created_at: number;
  updated_at: number;
  current_step: string | null;
  allocation_scope: 'shared_pool' | 'tenant_exclusive';
  owner_tenant_id: string | null;
  data_role: string;
  residency_policy_id: string;
  residency_partition: string;
  deterministic_name: string;
  desired_resource_id: string;
  ownership_fingerprint: string;
  shard_id: string;
  binding_ref: string;
  jurisdiction: 'eu' | 'fedramp' | null;
  location_hint: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc' | null;
  read_replication_mode: 'enabled' | 'disabled';
  provider_database_id: string | null;
  migration_stream_id: 'd1-core' | 'd1-pii' | 'd1-lookup' | null;
  release_id: string | null;
  manifest_digest: string | null;
  manifest_r2_object_key: string | null;
  migration_generation: number | null;
}

export interface PendingControlOperatorMigration {
  databaseId: string;
  streamId: 'd1-core' | 'd1-pii' | 'd1-lookup';
  releaseId: string;
  manifestDigest: string;
  manifestObjectKey: string;
  generation: number;
}

export interface PendingControlOperatorOperation {
  operationId: string;
  environmentId: string;
  operationKind: 'provision_shard';
  status: 'blocked' | 'waiting_retry' | 'running';
  lastErrorCode:
    | 'operator_action_required'
    | 'control_worker_settings_request_rejected'
    | 'control_worker_binding_reconciliation_failed'
    | null;
  requestedByType: 'setup' | 'admin' | 'scheduler' | 'reconciler';
  attemptCount: number;
  retryBudgetStartedAt: number;
  createdAt: number;
  updatedAt: number;
  currentStep:
    | 'create_d1'
    | 'apply_migrations'
    | 'reconcile_worker_bindings'
    | 'smoke_bindings'
    | 'stabilize_bindings'
    | null;
  scope: 'shared_pool' | 'tenant_exclusive';
  tenantId: string | null;
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii' | 'lookup';
  residencyPolicyId: string;
  residencyPartition: string;
  databaseName: string;
  desiredResourceId: string;
  ownershipFingerprint: string;
  shardId: string;
  bindingRef: string;
  jurisdiction: 'eu' | 'fedramp' | null;
  locationHint: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc' | null;
  readReplicationMode: 'enabled' | 'disabled';
  migration: PendingControlOperatorMigration | null;
}

export interface PendingTenantDisasterRecoveryBindingTarget {
  workerScriptName: string;
  shardId: string;
  bindingRef: string;
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residencyPartition: string;
  databaseId: string;
  migrationGeneration: number;
}

export interface PendingTenantDisasterRecoveryOperatorOperation {
  operationId: string;
  environmentId: string;
  operationKind: 'tenant_disaster_recovery';
  status: 'blocked';
  lastErrorCode: 'operator_action_required';
  requestedByType: 'admin';
  attemptCount: number;
  retryBudgetStartedAt: number;
  createdAt: number;
  updatedAt: number;
  currentStep: 'reconcile_worker_bindings';
  tenantId: string;
  bindingTargets: PendingTenantDisasterRecoveryBindingTarget[];
}

const STEP_KEYS = new Set([
  'create_d1',
  'apply_migrations',
  'reconcile_worker_bindings',
  'smoke_bindings',
  'stabilize_bindings',
]);

function parseRow(row: PendingOperatorOperationRow): PendingControlOperatorOperation {
  const hasMigration = row.provider_database_id !== null;
  if (
    !SAFE_ID.test(row.operation_id) ||
    !SAFE_ID.test(row.environment_id) ||
    row.operation_kind !== 'provision_shard' ||
    !(
      (row.status === 'blocked' &&
        ['operator_action_required', 'control_worker_settings_request_rejected'].includes(
          String(row.last_error_code)
        )) ||
      (row.status === 'waiting_retry' &&
        row.last_error_code === 'control_worker_binding_reconciliation_failed') ||
      (row.status === 'running' && row.last_error_code === null)
    ) ||
    !['setup', 'admin', 'scheduler', 'reconciler'].includes(row.requested_by_type) ||
    !Number.isSafeInteger(row.attempt_count) ||
    row.attempt_count < 0 ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 1 ||
    (row.retry_budget_started_at !== null &&
      (!Number.isSafeInteger(row.retry_budget_started_at) || row.retry_budget_started_at < 1)) ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < 1 ||
    (row.current_step !== null && !STEP_KEYS.has(row.current_step)) ||
    !DATA_ROLES.has(row.data_role) ||
    !SAFE_ID.test(row.residency_policy_id) ||
    !SAFE_PARTITION.test(row.residency_partition) ||
    !SAFE_DATABASE_NAME.test(row.deterministic_name) ||
    !SAFE_ID.test(row.desired_resource_id) ||
    !/^[a-f0-9]{64}$/u.test(row.ownership_fingerprint) ||
    !SAFE_ID.test(row.shard_id) ||
    !SAFE_BINDING.test(row.binding_ref) ||
    (row.jurisdiction !== null && !['eu', 'fedramp'].includes(row.jurisdiction)) ||
    (row.location_hint !== null &&
      !['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'].includes(row.location_hint)) ||
    (row.read_replication_mode !== 'enabled' && row.read_replication_mode !== 'disabled') ||
    !['d1-core', 'd1-pii', 'd1-lookup'].includes(String(row.migration_stream_id)) ||
    (row.data_role === 'tenant_pii' && row.migration_stream_id !== 'd1-pii') ||
    (row.data_role === 'lookup' && row.migration_stream_id !== 'd1-lookup') ||
    (!['tenant_pii', 'lookup'].includes(row.data_role) && row.migration_stream_id !== 'd1-core') ||
    row.release_id === null ||
    !SAFE_ID.test(row.release_id) ||
    row.manifest_digest === null ||
    !/^[a-f0-9]{64}$/u.test(row.manifest_digest) ||
    row.manifest_r2_object_key !==
      `releases/${row.release_id}/${row.manifest_digest}/manifest.json` ||
    row.migration_generation === null ||
    !Number.isSafeInteger(row.migration_generation) ||
    row.migration_generation < 1 ||
    (hasMigration && !SAFE_ID.test(row.provider_database_id as string)) ||
    (row.current_step === 'apply_migrations' && !hasMigration) ||
    (row.allocation_scope === 'tenant_exclusive') !== (row.owner_tenant_id !== null) ||
    (row.owner_tenant_id !== null && !SAFE_ID.test(row.owner_tenant_id))
  ) {
    throw new Error('control_operator_operation_invalid');
  }
  const operation: PendingControlOperatorOperation = {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    operationKind: 'provision_shard',
    status: row.status as PendingControlOperatorOperation['status'],
    lastErrorCode: row.last_error_code as PendingControlOperatorOperation['lastErrorCode'],
    requestedByType: row.requested_by_type as PendingControlOperatorOperation['requestedByType'],
    attemptCount: row.attempt_count,
    retryBudgetStartedAt: row.retry_budget_started_at ?? row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentStep: row.current_step as PendingControlOperatorOperation['currentStep'],
    scope: row.allocation_scope,
    tenantId: row.owner_tenant_id,
    dataRole: row.data_role as PendingControlOperatorOperation['dataRole'],
    residencyPolicyId: row.residency_policy_id,
    residencyPartition: row.residency_partition,
    databaseName: row.deterministic_name,
    desiredResourceId: row.desired_resource_id,
    ownershipFingerprint: row.ownership_fingerprint,
    shardId: row.shard_id,
    bindingRef: row.binding_ref,
    jurisdiction: row.jurisdiction,
    locationHint: row.location_hint,
    readReplicationMode: row.read_replication_mode,
    migration: hasMigration
      ? {
          databaseId: row.provider_database_id as string,
          streamId: row.migration_stream_id as 'd1-core' | 'd1-pii' | 'd1-lookup',
          releaseId: row.release_id as string,
          manifestDigest: row.manifest_digest as string,
          manifestObjectKey: row.manifest_r2_object_key as string,
          generation: row.migration_generation as number,
        }
      : null,
  };
  assertControlPlaneRecordIsSecretFree(operation);
  return operation;
}

export async function listPendingControlOperatorOperations(input: {
  controlDatabaseName: string;
  operationId?: string;
  query?: typeof queryD1Rows;
}): Promise<PendingControlOperatorOperation[]> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (input.operationId !== undefined && !SAFE_ID.test(input.operationId)) {
    throw new Error('control_operator_operation_id_invalid');
  }
  const rows = await (input.query ?? queryD1Rows)<PendingOperatorOperationRow>(
    input.controlDatabaseName,
    `WITH shard_inventory AS (
       SELECT shard.environment_id, shard.d1_desired_resource_id,
              shard.allocation_scope, shard.owner_tenant_id, shard.data_role,
              shard.residency_policy_id, shard.residency_partition,
              shard.shard_id, shard.binding_ref, shard.jurisdiction, shard.location_hint,
              shard.read_replication_mode, shard.generation
         FROM control_tenant_shards shard
       UNION ALL
       SELECT lookup.environment_id, lookup.d1_desired_resource_id,
              'shared_pool' AS allocation_scope, NULL AS owner_tenant_id, 'lookup' AS data_role,
              json_extract(desired.desired_spec_json, '$.residency_policy_id') AS residency_policy_id,
              lookup.residency_partition, lookup.lookup_shard_id AS shard_id,
              lookup.binding_ref,
              json_extract(desired.desired_spec_json, '$.jurisdiction') AS jurisdiction,
              json_extract(desired.desired_spec_json, '$.location_hint') AS location_hint,
              json_extract(desired.desired_spec_json, '$.read_replication_mode') AS read_replication_mode,
              1 AS generation
         FROM control_lookup_physical_shards lookup
         JOIN control_desired_resources desired
           ON desired.desired_resource_id = lookup.d1_desired_resource_id
          AND desired.environment_id = lookup.environment_id
     )
     SELECT operation.operation_id, operation.environment_id, operation.operation_kind,
            operation.status, operation.last_error_code, operation.requested_by_type,
            operation.attempt_count, operation.retry_budget_started_at,
            operation.created_at, operation.updated_at,
            (SELECT step.step_key FROM control_operation_steps step
              WHERE step.operation_id = operation.operation_id
                AND step.status IN ('blocked', 'running')
              ORDER BY step.display_order, step.step_key LIMIT 1) AS current_step,
            shard.allocation_scope, shard.owner_tenant_id, shard.data_role,
            shard.residency_policy_id, shard.residency_partition,
            desired.deterministic_name, desired.desired_resource_id,
            desired.ownership_fingerprint, shard.shard_id, shard.binding_ref,
            shard.jurisdiction, shard.location_hint, shard.read_replication_mode,
            migration.provider_database_id, migration.stream_id AS migration_stream_id,
            migration.release_id, migration.manifest_digest,
            catalog.manifest_r2_object_key, shard.generation AS migration_generation
       FROM control_operations operation
       JOIN control_desired_resources desired
         ON desired.origin_operation_id = operation.operation_id
        AND desired.environment_id = operation.environment_id
      JOIN shard_inventory shard
         ON shard.d1_desired_resource_id = desired.desired_resource_id
        AND shard.environment_id = operation.environment_id
       LEFT JOIN control_tenant_database_migration_state migration
         ON migration.operation_id = operation.operation_id
        AND migration.desired_resource_id = desired.desired_resource_id
        AND migration.environment_id = operation.environment_id
       LEFT JOIN control_migration_release_catalog catalog
         ON catalog.environment_id = migration.environment_id
        AND catalog.stream_id = migration.stream_id
        AND catalog.release_id = migration.release_id
        AND catalog.manifest_digest = migration.manifest_digest
      WHERE operation.operation_kind = 'provision_shard'
        AND (
          (
            operation.status = 'blocked'
            AND (
              operation.last_error_code = 'operator_action_required'
              OR (
                operation.last_error_code = 'control_worker_settings_request_rejected'
                AND EXISTS (
                  SELECT 1 FROM control_worker_binding_reconciliations binding
                   WHERE binding.operation_id = operation.operation_id
                     AND binding.state = 'blocked'
                     AND binding.last_error_code = 'control_worker_settings_request_rejected'
                     AND binding.expected_source_version_id IS NOT NULL
                     AND binding.previous_restore_settings_json IS NOT NULL
                     AND binding.patch_result_version_id IS NULL
                     AND binding.patch_result_deployment_id IS NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM control_worker_binding_reconciliations conflicting
                   WHERE conflicting.operation_id = operation.operation_id
                     AND conflicting.state = 'blocked'
                     AND (
                       conflicting.last_error_code IS NOT 'control_worker_settings_request_rejected'
                       OR conflicting.patch_result_version_id IS NOT NULL
                       OR conflicting.patch_result_deployment_id IS NOT NULL
                     )
                )
              )
            )
          )
          OR (
            operation.status = 'waiting_retry'
            AND operation.last_error_code = 'control_worker_binding_reconciliation_failed'
            AND EXISTS (
              SELECT 1 FROM control_worker_binding_reconciliations binding
               WHERE binding.operation_id = operation.operation_id
                 AND binding.state = 'pending'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM control_worker_binding_reconciliations binding
                JOIN control_worker_deployment_leases lease
                  ON lease.environment_id = binding.environment_id
                 AND lease.worker_script_name = binding.worker_script_name
               WHERE binding.operation_id = operation.operation_id
                 AND binding.state = 'pending'
                 AND lease.owner_operation_id <> operation.operation_id
              )
            )
          OR (
            operation.status = 'running'
            AND operation.last_error_code IS NULL
            AND operation.lock_expires_at IS NOT NULL
            AND operation.lock_expires_at <= unixepoch()
            AND migration.state = 'ready'
            AND EXISTS (
              SELECT 1 FROM control_operation_steps migration_step
               WHERE migration_step.operation_id = operation.operation_id
                 AND migration_step.step_key = 'apply_migrations'
                 AND migration_step.status = 'running'
            )
          )
        )
      ORDER BY operation.updated_at, operation.operation_id
      LIMIT 100`
  );
  const selectedRows =
    input.operationId === undefined
      ? rows
      : rows.filter((row) => row.operation_id === input.operationId);
  const operations = selectedRows.map(parseRow);
  if (new Set(operations.map((operation) => operation.operationId)).size !== operations.length) {
    throw new Error('control_operator_operation_duplicate');
  }
  return operations;
}

interface PendingTenantDisasterRecoveryRow extends Record<string, unknown> {
  operation_id: string;
  environment_id: string;
  status: string;
  last_error_code: string;
  requested_by_type: string;
  attempt_count: number;
  retry_budget_started_at: number | null;
  created_at: number;
  updated_at: number;
  tenant_id: string;
  worker_script_name: string;
  shard_id: string;
  binding_ref: string;
  data_role: string;
  residency_partition: string;
  provider_database_id: string;
  migration_generation: number;
}

export async function listPendingTenantDisasterRecoveryOperatorOperations(input: {
  controlDatabaseName: string;
  operationId?: string;
  query?: typeof queryD1Rows;
}): Promise<PendingTenantDisasterRecoveryOperatorOperation[]> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (input.operationId !== undefined && !SAFE_ID.test(input.operationId)) {
    throw new Error('control_operator_operation_id_invalid');
  }
  const rows = await (input.query ?? queryD1Rows)<PendingTenantDisasterRecoveryRow>(
    input.controlDatabaseName,
    `SELECT operation.operation_id, operation.environment_id, operation.status,
            operation.last_error_code, operation.requested_by_type, operation.attempt_count,
            operation.retry_budget_started_at, operation.created_at, operation.updated_at,
            recovery.tenant_id, binding.worker_script_name, binding.shard_id,
            binding.binding_ref, binding.data_role, binding.residency_partition,
            binding.provider_database_id, binding.migration_generation
       FROM control_operations operation
       JOIN control_tenant_disaster_recovery_operations recovery
         ON recovery.operation_id = operation.operation_id
        AND recovery.environment_id = operation.environment_id
       JOIN control_operation_steps step
         ON step.operation_id = operation.operation_id
        AND step.step_key = 'reconcile_worker_bindings'
       JOIN control_worker_binding_reconciliations binding
         ON binding.operation_id = operation.operation_id
        AND binding.environment_id = operation.environment_id
      WHERE operation.operation_kind = 'tenant_disaster_recovery'
        AND operation.status = 'blocked'
        AND operation.last_error_code = 'operator_action_required'
        AND recovery.recovery_state = 'smoke_verifying'
        AND step.status = 'blocked'
        AND step.last_error_code = 'operator_action_required'
        AND binding.state = 'pending'
      ORDER BY operation.updated_at, operation.operation_id,
               binding.worker_script_name, binding.binding_ref
      LIMIT 1000`
  );
  const grouped = new Map<string, PendingTenantDisasterRecoveryOperatorOperation>();
  for (const row of rows) {
    if (input.operationId !== undefined && row.operation_id !== input.operationId) continue;
    if (
      !SAFE_ID.test(row.operation_id) ||
      !SAFE_ID.test(row.environment_id) ||
      row.status !== 'blocked' ||
      row.last_error_code !== 'operator_action_required' ||
      row.requested_by_type !== 'admin' ||
      !Number.isSafeInteger(row.attempt_count) ||
      row.attempt_count < 0 ||
      !Number.isSafeInteger(row.created_at) ||
      row.created_at < 1 ||
      !Number.isSafeInteger(row.updated_at) ||
      row.updated_at < 1 ||
      !SAFE_ID.test(row.tenant_id) ||
      !SAFE_ID.test(row.worker_script_name) ||
      !SAFE_ID.test(row.shard_id) ||
      !SAFE_BINDING.test(row.binding_ref) ||
      !DATA_ROLES.has(row.data_role) ||
      !SAFE_PARTITION.test(row.residency_partition) ||
      !SAFE_ID.test(row.provider_database_id) ||
      !Number.isSafeInteger(row.migration_generation) ||
      row.migration_generation < 1
    ) {
      throw new Error('control_operator_tenant_dr_operation_invalid');
    }
    const existing = grouped.get(row.operation_id);
    const retryBudgetStartedAt = row.retry_budget_started_at ?? row.created_at;
    if (
      existing &&
      (existing.environmentId !== row.environment_id ||
        existing.tenantId !== row.tenant_id ||
        existing.updatedAt !== row.updated_at)
    ) {
      throw new Error('control_operator_tenant_dr_operation_invalid');
    }
    const operation =
      existing ??
      ({
        operationId: row.operation_id,
        environmentId: row.environment_id,
        operationKind: 'tenant_disaster_recovery',
        status: 'blocked',
        lastErrorCode: 'operator_action_required',
        requestedByType: 'admin',
        attemptCount: row.attempt_count,
        retryBudgetStartedAt,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        currentStep: 'reconcile_worker_bindings',
        tenantId: row.tenant_id,
        bindingTargets: [],
      } satisfies PendingTenantDisasterRecoveryOperatorOperation);
    if (
      operation.bindingTargets.some(
        (target) =>
          target.workerScriptName === row.worker_script_name &&
          target.bindingRef === row.binding_ref
      )
    ) {
      throw new Error('control_operator_tenant_dr_binding_duplicate');
    }
    operation.bindingTargets.push({
      workerScriptName: row.worker_script_name,
      shardId: row.shard_id,
      bindingRef: row.binding_ref,
      dataRole: row.data_role as PendingTenantDisasterRecoveryBindingTarget['dataRole'],
      residencyPartition: row.residency_partition,
      databaseId: row.provider_database_id,
      migrationGeneration: row.migration_generation,
    });
    grouped.set(row.operation_id, operation);
  }
  const operations = [...grouped.values()];
  for (const operation of operations) {
    if (operation.bindingTargets.length === 0 || operation.bindingTargets.length > 1000) {
      throw new Error('control_operator_tenant_dr_binding_targets_invalid');
    }
    assertControlPlaneRecordIsSecretFree(operation);
  }
  return operations;
}

interface PendingPluginOperatorRow extends Record<string, unknown> {
  operation_id: string;
  environment_id: string;
  status: string;
  last_error_code: string;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  plugin_resource_id: string;
  plugin_installation_id: string;
  tenant_id: string;
  resource_kind: PluginProvisionedResourceKind;
  logical_resource_id: string;
  binding_name: string;
  lifecycle_mode: 'managed' | 'existing';
  provider_resource_id: string | null;
  provider_name: string | null;
  desired_spec_json: string;
  resource_status: string;
  migration_stream_id: string | null;
  release_id: string | null;
  manifest_digest: string | null;
  manifest_r2_object_key: string | null;
  migration_state: string | null;
  migration_provider_database_id: string | null;
}

export interface PendingPluginControlOperatorResource {
  pluginResourceId: string;
  kind: PluginProvisionedResourceKind;
  logicalResourceId: string;
  binding: string;
  access: 'read_only' | 'read_write';
  lifecycleMode: 'managed' | 'existing';
  providerResourceId: string | null;
  providerName: string | null;
  ownershipFingerprint: string;
  deterministicName: string;
  hostBindingRef: string;
  status: 'pending' | 'provisioning' | 'ready' | 'failed';
  migration: {
    streamId: string;
    releaseId: string;
    manifestDigest: string;
    manifestObjectKey: string;
    state: 'requested' | 'applying' | 'waiting_retry' | 'ready' | 'blocked';
    providerDatabaseId: string | null;
  } | null;
}

export interface PendingPluginControlOperatorOperation {
  operationId: string;
  environmentId: string;
  operationKind: 'provision_plugin_resources';
  status: 'blocked';
  lastErrorCode: 'operator_action_required';
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  pluginInstallationId: string;
  tenantId: string;
  pluginId: string;
  capabilityManifestDigest: string;
  currentStep: 'provider' | 'migration' | 'binding';
  resources: PendingPluginControlOperatorResource[];
}

function parsePluginDesiredSpec(row: PendingPluginOperatorRow): {
  pluginId: string;
  access: 'read_only' | 'read_write';
  ownershipFingerprint: string;
  capabilityManifestDigest: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.desired_spec_json);
  } catch {
    throw new Error('control_plugin_operator_operation_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('control_plugin_operator_operation_invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.pluginId !== 'string' ||
    !SAFE_ID.test(value.pluginId) ||
    value.binding !== row.binding_name ||
    value.kind !== row.resource_kind ||
    !['read_only', 'read_write'].includes(String(value.access)) ||
    typeof value.ownershipFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.ownershipFingerprint) ||
    typeof value.capabilityManifestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.capabilityManifestDigest) ||
    (row.lifecycle_mode === 'managed') !== (value.ownership === 'authrim_managed') ||
    (row.lifecycle_mode === 'managed') !== (value.deleteProviderResource === true)
  ) {
    throw new Error('control_plugin_operator_operation_invalid');
  }
  return {
    pluginId: value.pluginId,
    access: value.access as 'read_only' | 'read_write',
    ownershipFingerprint: value.ownershipFingerprint,
    capabilityManifestDigest: value.capabilityManifestDigest,
  };
}

function parsePluginResource(row: PendingPluginOperatorRow): {
  pluginId: string;
  resource: PendingPluginControlOperatorResource;
} {
  const spec = parsePluginDesiredSpec(row);
  if (
    !SAFE_ID.test(row.plugin_resource_id) ||
    !SAFE_ID.test(row.plugin_installation_id) ||
    !SAFE_ID.test(row.tenant_id) ||
    !['d1', 'kv_namespace', 'r2_bucket'].includes(row.resource_kind) ||
    !SAFE_ID.test(row.logical_resource_id) ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(row.binding_name) ||
    !['managed', 'existing'].includes(row.lifecycle_mode) ||
    !['pending', 'provisioning', 'ready', 'failed'].includes(row.resource_status) ||
    (row.lifecycle_mode === 'existing' &&
      (!row.provider_resource_id ||
        !SAFE_ID.test(row.provider_resource_id) ||
        !row.provider_name ||
        !SAFE_ID.test(row.provider_name))) ||
    (row.provider_resource_id !== null && !SAFE_ID.test(row.provider_resource_id)) ||
    (row.provider_name !== null && !SAFE_ID.test(row.provider_name))
  ) {
    throw new Error('control_plugin_operator_operation_invalid');
  }
  const hasMigration = row.migration_stream_id !== null;
  if (
    (row.resource_kind === 'd1') !== hasMigration ||
    (hasMigration &&
      (!row.release_id ||
        !SAFE_ID.test(row.release_id) ||
        !row.manifest_digest ||
        !/^[a-f0-9]{64}$/u.test(row.manifest_digest) ||
        row.manifest_r2_object_key !==
          `releases/${row.release_id}/${row.manifest_digest}/manifest.json` ||
        !['requested', 'applying', 'waiting_retry', 'ready', 'blocked'].includes(
          String(row.migration_state)
        ) ||
        (row.migration_provider_database_id !== null &&
          !SAFE_ID.test(row.migration_provider_database_id))))
  ) {
    throw new Error('control_plugin_operator_operation_invalid');
  }
  return {
    pluginId: spec.pluginId,
    resource: {
      pluginResourceId: row.plugin_resource_id,
      kind: row.resource_kind,
      logicalResourceId: row.logical_resource_id,
      binding: row.binding_name,
      access: spec.access,
      lifecycleMode: row.lifecycle_mode,
      providerResourceId: row.provider_resource_id,
      providerName: row.provider_name,
      ownershipFingerprint: spec.ownershipFingerprint,
      deterministicName: managedPluginResourceName(
        row.environment_id,
        spec.ownershipFingerprint,
        row.resource_kind
      ),
      hostBindingRef: pluginResourceHostBindingRef(row.resource_kind, spec.ownershipFingerprint),
      status: row.resource_status as PendingPluginControlOperatorResource['status'],
      migration: hasMigration
        ? {
            streamId: row.migration_stream_id as string,
            releaseId: row.release_id as string,
            manifestDigest: row.manifest_digest as string,
            manifestObjectKey: row.manifest_r2_object_key as string,
            state: row.migration_state as NonNullable<
              PendingPluginControlOperatorResource['migration']
            >['state'],
            providerDatabaseId: row.migration_provider_database_id,
          }
        : null,
    },
  };
}

export async function listPendingPluginControlOperatorOperations(input: {
  controlDatabaseName: string;
  operationId?: string;
  query?: typeof queryD1Rows;
}): Promise<PendingPluginControlOperatorOperation[]> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (input.operationId !== undefined && !SAFE_ID.test(input.operationId)) {
    throw new Error('control_operator_operation_id_invalid');
  }
  const rows = await (input.query ?? queryD1Rows)<PendingPluginOperatorRow>(
    input.controlDatabaseName,
    `SELECT operation.operation_id, operation.environment_id, operation.status,
            operation.last_error_code, operation.attempt_count,
            operation.created_at, operation.updated_at,
            resource.plugin_resource_id, resource.plugin_installation_id, resource.tenant_id,
            resource.resource_kind, resource.logical_resource_id, resource.binding_name,
            resource.lifecycle_mode, resource.provider_resource_id, resource.provider_name,
            resource.desired_spec_json, resource.status AS resource_status,
            migration.stream_id AS migration_stream_id, migration.release_id,
            migration.manifest_digest, catalog.manifest_r2_object_key,
            migration.state AS migration_state,
            migration.provider_database_id AS migration_provider_database_id
       FROM control_operations operation
       JOIN control_plugin_desired_resources resource
         ON resource.operation_id = operation.operation_id
        AND resource.environment_id = operation.environment_id
       LEFT JOIN control_plugin_resource_migration_state migration
         ON migration.plugin_resource_id = resource.plugin_resource_id
        AND migration.operation_id = operation.operation_id
        AND migration.environment_id = operation.environment_id
       LEFT JOIN control_migration_release_catalog catalog
         ON catalog.environment_id = migration.environment_id
        AND catalog.stream_id = migration.stream_id
        AND catalog.release_id = migration.release_id
        AND catalog.manifest_digest = migration.manifest_digest
      WHERE operation.operation_kind = 'provision_plugin_resources'
        AND operation.status = 'blocked'
        AND operation.last_error_code = 'operator_action_required'
      ORDER BY operation.updated_at, operation.operation_id, resource.logical_resource_id
      LIMIT 1600`
  );
  const grouped = new Map<string, PendingPluginOperatorRow[]>();
  for (const row of rows) {
    if (input.operationId !== undefined && row.operation_id !== input.operationId) continue;
    const existing = grouped.get(row.operation_id) ?? [];
    existing.push(row);
    grouped.set(row.operation_id, existing);
  }
  const operations = [...grouped.values()].map((group) => {
    const first = group[0];
    if (
      !first ||
      !SAFE_ID.test(first.operation_id) ||
      !SAFE_ID.test(first.environment_id) ||
      first.status !== 'blocked' ||
      first.last_error_code !== 'operator_action_required' ||
      !Number.isSafeInteger(first.attempt_count) ||
      first.attempt_count < 0 ||
      !Number.isSafeInteger(first.created_at) ||
      first.created_at < 1 ||
      !Number.isSafeInteger(first.updated_at) ||
      first.updated_at < first.created_at ||
      group.length > 16 ||
      group.some(
        (row) =>
          row.environment_id !== first.environment_id ||
          row.plugin_installation_id !== first.plugin_installation_id ||
          row.tenant_id !== first.tenant_id
      )
    ) {
      throw new Error('control_plugin_operator_operation_invalid');
    }
    const parsed = group.map(parsePluginResource);
    if (
      new Set(parsed.map(({ resource }) => resource.logicalResourceId)).size !== parsed.length ||
      new Set(parsed.map(({ resource }) => resource.hostBindingRef)).size !== parsed.length ||
      new Set(parsed.map(({ pluginId }) => pluginId)).size !== 1 ||
      new Set(group.map((row) => parsePluginDesiredSpec(row).capabilityManifestDigest)).size !== 1
    ) {
      throw new Error('control_plugin_operator_operation_invalid');
    }
    const resources = parsed.map(({ resource }) => resource);
    const currentStep = resources.some((resource) => resource.status !== 'ready')
      ? 'provider'
      : resources.some((resource) => resource.migration && resource.migration.state !== 'ready')
        ? 'migration'
        : 'binding';
    const operation: PendingPluginControlOperatorOperation = {
      operationId: first.operation_id,
      environmentId: first.environment_id,
      operationKind: 'provision_plugin_resources',
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
      attemptCount: first.attempt_count,
      createdAt: first.created_at,
      updatedAt: first.updated_at,
      pluginInstallationId: first.plugin_installation_id,
      tenantId: first.tenant_id,
      pluginId: parsed[0]!.pluginId,
      capabilityManifestDigest: parsePluginDesiredSpec(first).capabilityManifestDigest,
      currentStep,
      resources,
    };
    assertControlPlaneRecordIsSecretFree(operation);
    return operation;
  });
  if (operations.length > 100) throw new Error('control_plugin_operator_operation_limit');
  return operations;
}

interface PendingPluginCleanupOperatorRow extends Record<string, unknown> {
  operation_id: string;
  environment_id: string;
  status: string;
  last_error_code: string;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  plugin_installation_id: string;
  tenant_id: string;
  plugin_id: string;
  source_operation_id: string;
  lifecycle_generation: number;
  reason: string;
  cleanup_state: string;
  worker_script_name: string | null;
  binding_names_json: string;
  binding_presence_required: number;
  drain_not_before: number | null;
  plugin_resource_id: string | null;
  resource_kind: string | null;
  lifecycle_mode: string | null;
  provider_resource_id: string | null;
  provider_name: string | null;
  ownership_fingerprint: string | null;
  delete_provider_resource: number | null;
  item_state: string | null;
}

export interface PendingPluginControlCleanupItem {
  pluginResourceId: string;
  kind: PluginProvisionedResourceKind;
  lifecycleMode: 'managed' | 'existing';
  providerResourceId: string;
  providerName: string;
  ownershipFingerprint: string;
  deleteProviderResource: boolean;
  state: 'pending' | 'quarantined' | 'deleting' | 'deleted' | 'detached' | 'blocked';
}

export interface PendingPluginControlCleanupOperation {
  operationId: string;
  environmentId: string;
  operationKind: 'cleanup_plugin_resources';
  status: 'blocked';
  lastErrorCode: 'operator_action_required' | 'control_destructive_operations_disabled';
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  pluginInstallationId: string;
  tenantId: string;
  pluginId: string;
  sourceOperationId: string;
  lifecycleGeneration: number;
  reason: 'uninstall' | 'canceled_pre_activation';
  state:
    | 'requested'
    | 'removing_bindings'
    | 'quarantined'
    | 'deleting_resources'
    | 'verifying_absence'
    | 'blocked';
  workerScriptName: string | null;
  bindingNames: string[];
  bindingPresenceRequired: boolean;
  drainNotBefore: number | null;
  currentStep: 'binding' | 'quarantine' | 'delete';
  resources: PendingPluginControlCleanupItem[];
}

function parseCleanupBindingNames(serialized: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('control_plugin_cleanup_operator_operation_invalid');
  }
  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new Error('control_plugin_cleanup_operator_operation_invalid');
  }
  const names = parsed.map((value) => {
    if (typeof value !== 'string' || !/^PRES_(?:D1|KV|R2)_[A-F0-9]{24}$/u.test(value)) {
      throw new Error('control_plugin_cleanup_operator_operation_invalid');
    }
    return value;
  });
  if (new Set(names).size !== names.length) {
    throw new Error('control_plugin_cleanup_operator_operation_invalid');
  }
  return names.sort();
}

function parseCleanupItem(
  row: PendingPluginCleanupOperatorRow
): PendingPluginControlCleanupItem | null {
  if (row.plugin_resource_id === null) return null;
  if (
    !SAFE_ID.test(row.plugin_resource_id) ||
    !row.resource_kind ||
    !['d1', 'kv_namespace', 'r2_bucket'].includes(row.resource_kind) ||
    !row.lifecycle_mode ||
    !['managed', 'existing'].includes(row.lifecycle_mode) ||
    !row.provider_resource_id ||
    !SAFE_ID.test(row.provider_resource_id) ||
    !row.provider_name ||
    !SAFE_ID.test(row.provider_name) ||
    !row.ownership_fingerprint ||
    !/^[a-f0-9]{64}$/u.test(row.ownership_fingerprint) ||
    !row.item_state ||
    !['pending', 'quarantined', 'deleting', 'deleted', 'detached', 'blocked'].includes(
      row.item_state
    ) ||
    ![0, 1].includes(Number(row.delete_provider_resource)) ||
    (row.lifecycle_mode === 'managed') !== (row.delete_provider_resource === 1)
  ) {
    throw new Error('control_plugin_cleanup_operator_operation_invalid');
  }
  return {
    pluginResourceId: row.plugin_resource_id,
    kind: row.resource_kind as PluginProvisionedResourceKind,
    lifecycleMode: row.lifecycle_mode as 'managed' | 'existing',
    providerResourceId: row.provider_resource_id,
    providerName: row.provider_name,
    ownershipFingerprint: row.ownership_fingerprint,
    deleteProviderResource: row.delete_provider_resource === 1,
    state: row.item_state as PendingPluginControlCleanupItem['state'],
  };
}

export async function listPendingPluginControlCleanupOperations(input: {
  controlDatabaseName: string;
  operationId?: string;
  query?: typeof queryD1Rows;
}): Promise<PendingPluginControlCleanupOperation[]> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (input.operationId !== undefined && !SAFE_ID.test(input.operationId)) {
    throw new Error('control_operator_operation_id_invalid');
  }
  const result = await (input.query ?? queryD1Rows)<PendingPluginCleanupOperatorRow>(
    input.controlDatabaseName,
    `SELECT operation.operation_id, operation.environment_id, operation.status,
            operation.last_error_code, operation.attempt_count, operation.created_at,
            operation.updated_at, cleanup.plugin_installation_id, cleanup.tenant_id,
            cleanup.plugin_id, cleanup.source_operation_id, cleanup.lifecycle_generation,
            cleanup.reason, cleanup.state AS cleanup_state, cleanup.worker_script_name,
            cleanup.binding_names_json, cleanup.binding_presence_required,
            cleanup.drain_not_before, item.plugin_resource_id, item.resource_kind,
            item.lifecycle_mode, item.provider_resource_id, item.provider_name,
            item.ownership_fingerprint, item.delete_provider_resource,
            item.state AS item_state
       FROM control_operations operation
       JOIN control_plugin_resource_cleanup_operations cleanup
         ON cleanup.operation_id = operation.operation_id
        AND cleanup.environment_id = operation.environment_id
       LEFT JOIN control_plugin_resource_cleanup_items item
         ON item.operation_id = cleanup.operation_id
      WHERE operation.operation_kind = 'cleanup_plugin_resources'
        AND operation.status = 'blocked'
        AND operation.last_error_code IN (
          'operator_action_required', 'control_destructive_operations_disabled'
        )
      ORDER BY operation.updated_at, operation.operation_id, item.plugin_resource_id
      LIMIT 1700`
  );
  const grouped = new Map<string, PendingPluginCleanupOperatorRow[]>();
  for (const row of result) {
    if (input.operationId !== undefined && row.operation_id !== input.operationId) continue;
    const group = grouped.get(row.operation_id) ?? [];
    group.push(row);
    grouped.set(row.operation_id, group);
  }
  const operations = [...grouped.values()].map((group) => {
    const first = group[0];
    if (
      !first ||
      !SAFE_ID.test(first.operation_id) ||
      !SAFE_ID.test(first.environment_id) ||
      first.status !== 'blocked' ||
      (first.last_error_code !== 'operator_action_required' &&
        first.last_error_code !== 'control_destructive_operations_disabled') ||
      !Number.isSafeInteger(first.attempt_count) ||
      first.attempt_count < 0 ||
      !Number.isSafeInteger(first.created_at) ||
      !Number.isSafeInteger(first.updated_at) ||
      !SAFE_ID.test(first.plugin_installation_id) ||
      !SAFE_ID.test(first.tenant_id) ||
      !SAFE_ID.test(first.plugin_id) ||
      !SAFE_ID.test(first.source_operation_id) ||
      !Number.isSafeInteger(first.lifecycle_generation) ||
      first.lifecycle_generation < 1 ||
      !['uninstall', 'canceled_pre_activation'].includes(first.reason) ||
      ![
        'requested',
        'removing_bindings',
        'quarantined',
        'deleting_resources',
        'verifying_absence',
        'blocked',
      ].includes(first.cleanup_state) ||
      (first.worker_script_name !== null && !SAFE_ID.test(first.worker_script_name)) ||
      ![0, 1].includes(Number(first.binding_presence_required)) ||
      (first.binding_presence_required === 1 && first.worker_script_name === null) ||
      (first.drain_not_before !== null && !Number.isSafeInteger(first.drain_not_before)) ||
      group.length > 16 ||
      group.some(
        (row) =>
          row.environment_id !== first.environment_id ||
          row.plugin_installation_id !== first.plugin_installation_id ||
          row.tenant_id !== first.tenant_id ||
          row.lifecycle_generation !== first.lifecycle_generation
      )
    ) {
      throw new Error('control_plugin_cleanup_operator_operation_invalid');
    }
    const resources = group
      .map(parseCleanupItem)
      .filter((item): item is PendingPluginControlCleanupItem => item !== null);
    if (new Set(resources.map((item) => item.pluginResourceId)).size !== resources.length) {
      throw new Error('control_plugin_cleanup_operator_operation_invalid');
    }
    const currentStep =
      ['requested', 'removing_bindings'].includes(first.cleanup_state) ||
      (first.cleanup_state === 'blocked' && first.drain_not_before === null)
        ? 'binding'
        : first.cleanup_state === 'quarantined' || first.cleanup_state === 'blocked'
          ? 'quarantine'
          : 'delete';
    const operation: PendingPluginControlCleanupOperation = {
      operationId: first.operation_id,
      environmentId: first.environment_id,
      operationKind: 'cleanup_plugin_resources',
      status: 'blocked',
      lastErrorCode: first.last_error_code,
      attemptCount: first.attempt_count,
      createdAt: first.created_at,
      updatedAt: first.updated_at,
      pluginInstallationId: first.plugin_installation_id,
      tenantId: first.tenant_id,
      pluginId: first.plugin_id,
      sourceOperationId: first.source_operation_id,
      lifecycleGeneration: first.lifecycle_generation,
      reason: first.reason as PendingPluginControlCleanupOperation['reason'],
      state: first.cleanup_state as PendingPluginControlCleanupOperation['state'],
      workerScriptName: first.worker_script_name,
      bindingNames: parseCleanupBindingNames(first.binding_names_json),
      bindingPresenceRequired: first.binding_presence_required === 1,
      drainNotBefore: first.drain_not_before,
      currentStep,
      resources,
    };
    assertControlPlaneRecordIsSecretFree(operation);
    return operation;
  });
  if (operations.length > 100) {
    throw new Error('control_plugin_cleanup_operator_operation_limit');
  }
  return operations;
}
