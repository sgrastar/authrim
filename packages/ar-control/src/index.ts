import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  assertControlPlaneRecordIsSecretFree,
  ApiMigrationEngine,
  cloudflareMigrationExecutor,
  MigrationReleaseArtifactReader,
  R2ReleaseArtifactStore,
  type ControlCapacityProvisioningPreview,
  type ControlAccountDataRole,
  type ControlProvisioningOperationCancelRequest,
  type ControlProvisioningOperationRestoreRequest,
  type ControlProvisioningOperationRetryRequest,
  type ControlShardCleanupApprovalRequest,
  type ControlShardCleanupRetryRequest,
  type ControlShardQuarantineRequest,
  type ControlShardQuarantineRetryRequest,
  type ControlReadReplicationStartRequest,
  type ControlTenantDisasterRecoveryCancelRequest,
  type ControlTenantDisasterRecoveryDenyObservationRequest,
  type ControlTenantDisasterRecoveryLookupCheckpointRequest,
  type ControlTenantDisasterRecoveryLookupClaimRequest,
  type ControlTenantDisasterRecoveryLookupClaimNextRequest,
  type ControlTenantDisasterRecoveryLookupCompleteRequest,
  type ControlTenantDisasterRecoveryReactivationObservationRequest,
  type ControlTenantDisasterRecoveryReactivationRequest,
  type ControlTenantDisasterRecoveryRestoreConfirmationRequest,
  type ControlTenantDisasterRecoveryStartRequest,
  type ControlTenantDisasterRecoveryVerificationRequest,
  type ControlTenantPlacementMigrationMutationRequest,
  type ControlTenantPlacementMigrationStartRequest,
  type ControlWorkerInventoryDriftFinding,
  type ControlWorkerInventoryDriftNotification,
  type ControlWorkerInventoryDriftReviewRequest,
} from '@authrim/ar-lib-core/control-plane';
import { D1ControlRepository } from './repository';
import { ControlService } from './service';
import type { ControlEnv, ControlRpcProps } from './types';
import { WorkerInventoryReconciler } from './worker-inventory-reconciler';
import { createControlApiClients } from './control-api-clients';
import { D1WorkerBindingRepository } from './worker-binding-repository';
import { WorkerBindingReconciler } from './worker-binding-reconciler';
import {
  ControlAccountAllocationService,
  D1AccountAllocationRepository,
} from './account-allocation';
import { LookupRegistryPublisher } from './lookup-registry-publisher';
import { LookupHmacKeyStatePublisher } from './lookup-hmac-key-state-publisher';
import { LookupHmacKeyStateService, validateLookupHmacKeyMetadata } from './lookup-hmac-key-state';
import { PluginRunnerRegistryPublisher } from './plugin-runner-registry-publisher';
import { LookupBucketMigrationService } from './lookup-bucket-migration';
import { ReadReplicationService } from './read-replication';
import {
  runtimeRegistrySignerMetadata,
  signRuntimeRegistryPayload,
} from './runtime-registry-signer';
import { TenantDefaultAllocationService } from './tenant-default-allocation';
import {
  D1SigningKeyVerificationRepository,
  SigningKeyCandidateVerifier,
} from './signing-key-candidate-verifier';
import {
  D1LookupHmacCandidateVerificationRepository,
  LookupHmacCandidateVerifier,
} from './lookup-hmac-candidate-verifier';
import { BootstrapHandoffVerifier, D1BootstrapHandoffRepository } from './bootstrap-handoff';
import { TenantPlacementMigrationService } from './tenant-placement-migration';
import { TenantPlacementMigrationReconciler } from './tenant-placement-migration-reconciler';
import { D1ShardCleanupRepository } from './shard-cleanup-repository';
import { ShardCleanupService } from './shard-cleanup';
import { PluginDynamicWorkerDesiredStateService } from './plugin-dynamic-worker-desired-state';
import { PluginResourceReconciler } from './plugin-resource-reconciler';
import { PluginResourceMigrationReconciler } from './plugin-resource-migration-reconciler';
import { PluginResourceBindingReconciler } from './plugin-resource-binding-reconciler';
import { PluginResourceCleanupService } from './plugin-resource-cleanup';
import { handoffPluginResourceOperationsToSetup } from './plugin-resource-operator-handoff';
import { TenantDisasterRecoveryService } from './tenant-disaster-recovery';

function service(env: ControlEnv): ControlService {
  return new ControlService({
    repository: new D1ControlRepository(env.CONTROL_DB),
    env,
    now: () => Math.floor(Date.now() / 1000),
  });
}

const EXPOSED_RPC_ERROR =
  /^(invalid_[a-z0-9_]+|directory_rewrite_[a-z0-9_]+|lookup_hmac_[a-z0-9_]+|read_replication_[a-z0-9_]+|control_(rpc_caller_unauthorized|environment_not_found|residency_partition_not_found|resource_policy_not_found|d1_resource_limit|destructive_operations_disabled|capacity_[a-z0-9_]+|operation_idempotency_conflict|operation_retry_(conflict|not_retryable)|operation_cancel_(conflict|not_allowed)|operation_restore_(conflict|not_allowed)|account_allocation_idempotency_conflict|account_allocation_capacity_unavailable|worker_inventory_drift_review_conflict|tenant_dr_[a-z0-9_]+|tenant_default_allocation_[a-z0-9_]+|tenant_placement_policy_[a-z0-9_]+|tenant_runtime_route_observation_[a-z0-9_]+|tenant_placement_migration_[a-z0-9_]+|tenant_region_shard_[a-z0-9_]+|tenant_shard_assignment_[a-z0-9_]+|shard_(quarantine|cleanup)_[a-z0-9_]+|lookup_bucket_[a-z0-9_]+|plugin_[a-z0-9_]+))$/u;

async function rpcResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && EXPOSED_RPC_ERROR.test(error.message)) {
      throw new Error(error.message);
    }
    throw new Error('control_internal_error');
  }
}

function authorizedCaller(props: ControlRpcProps): ControlRpcProps {
  if (
    props?.caller !== 'ar-management' ||
    props.audience !== 'authrim-control-v1' ||
    typeof props.environmentId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(props.environmentId)
  ) {
    throw new Error('control_rpc_caller_unauthorized');
  }
  return props;
}

function findingIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw new Error('invalid_worker_inventory_drift_finding_ids');
  }
  const ids = input.map((value) => {
    if (
      typeof value !== 'string' ||
      value.length > 512 ||
      !/^drift:[a-zA-Z0-9._:-]+:actual_only:[a-zA-Z0-9._-]+$/u.test(value)
    ) {
      throw new Error('invalid_worker_inventory_drift_finding_ids');
    }
    return value;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error('invalid_worker_inventory_drift_finding_ids');
  }
  return ids;
}

function driftFinding(row: {
  finding_id: string;
  environment_id: string;
  worker_script_name: string;
  finding_kind: 'actual_only';
  severity: 'warning';
  review_state: 'unreviewed' | 'reviewed' | 'dismissed' | 'resolved';
  notification_state: 'pending' | 'acknowledged' | 'resolved';
  first_observed_at: number;
  last_observed_at: number;
  resolved_at: number | null;
  notified_at: number | null;
}): ControlWorkerInventoryDriftFinding {
  return {
    findingId: row.finding_id,
    environmentId: row.environment_id,
    workerScriptName: row.worker_script_name,
    findingKind: row.finding_kind,
    severity: row.severity,
    reviewState: row.review_state,
    notificationState: row.notification_state,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    resolvedAt: row.resolved_at,
    notifiedAt: row.notified_at,
  };
}

function driftReviewRequest(input: unknown): ControlWorkerInventoryDriftReviewRequest {
  const value = exactInput(
    input,
    ['findingId', 'disposition', 'reviewedBy', 'idempotencyKey'],
    'invalid_worker_inventory_drift_review'
  );
  const findingId = findingIds([value.findingId])[0];
  if (
    (value.disposition !== 'reviewed' && value.disposition !== 'dismissed') ||
    typeof value.reviewedBy !== 'string' ||
    value.reviewedBy.length === 0 ||
    value.reviewedBy.length > 200 ||
    Array.from(value.reviewedBy).some((character) => character.charCodeAt(0) < 0x20) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(value.idempotencyKey)
  ) {
    throw new Error('invalid_worker_inventory_drift_review');
  }
  return {
    findingId,
    disposition: value.disposition,
    reviewedBy: value.reviewedBy,
    idempotencyKey: value.idempotencyKey,
  };
}

function provisioningOperationId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(input)) {
    throw new Error('invalid_operation_id');
  }
  return input;
}

function provisioningOperationRetry(input: unknown): ControlProvisioningOperationRetryRequest {
  const value = exactInput(
    input,
    ['operationId', 'stepKey', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_operation_retry_request'
  );
  if (
    (value.stepKey !== 'create_d1' &&
      value.stepKey !== 'apply_migrations' &&
      value.stepKey !== 'reconcile_worker_bindings') ||
    value.reasonCode !== 'operator_retry' ||
    typeof value.requestedById !== 'string' ||
    value.requestedById.length < 1 ||
    value.requestedById.length > 200 ||
    Array.from(value.requestedById).some((character) => character.charCodeAt(0) < 0x20) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(value.idempotencyKey)
  ) {
    throw new Error('invalid_operation_retry_request');
  }
  return {
    operationId: provisioningOperationId(value.operationId),
    stepKey: value.stepKey,
    requestedById: value.requestedById,
    reasonCode: value.reasonCode,
    idempotencyKey: value.idempotencyKey,
  };
}

function provisioningOperationCancel(input: unknown): ControlProvisioningOperationCancelRequest {
  const value = exactInput(
    input,
    ['operationId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_operation_cancel_request'
  );
  if (
    value.reasonCode !== 'operator_cancel' ||
    typeof value.requestedById !== 'string' ||
    value.requestedById.length < 1 ||
    value.requestedById.length > 200 ||
    Array.from(value.requestedById).some((character) => character.charCodeAt(0) < 0x20) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(value.idempotencyKey)
  ) {
    throw new Error('invalid_operation_cancel_request');
  }
  return {
    operationId: provisioningOperationId(value.operationId),
    requestedById: value.requestedById,
    reasonCode: value.reasonCode,
    idempotencyKey: value.idempotencyKey,
  };
}

function provisioningOperationRestore(input: unknown): ControlProvisioningOperationRestoreRequest {
  const value = exactInput(
    input,
    ['operationId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_operation_restore_request'
  );
  if (
    value.reasonCode !== 'operator_restore_previous_settings' ||
    typeof value.requestedById !== 'string' ||
    value.requestedById.length < 1 ||
    value.requestedById.length > 200 ||
    Array.from(value.requestedById).some((character) => character.charCodeAt(0) < 0x20) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(value.idempotencyKey)
  ) {
    throw new Error('invalid_operation_restore_request');
  }
  return {
    operationId: provisioningOperationId(value.operationId),
    requestedById: value.requestedById,
    reasonCode: value.reasonCode,
    idempotencyKey: value.idempotencyKey,
  };
}

function operatorText(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 0x20)
  ) {
    throw new Error(code);
  }
  return value;
}

function shardQuarantineRequest(input: unknown): ControlShardQuarantineRequest {
  const value = exactInput(
    input,
    ['shardId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_shard_quarantine_request'
  );
  if (value.reasonCode !== 'operator_quarantine') {
    throw new Error('invalid_shard_quarantine_request');
  }
  return {
    shardId: provisioningOperationId(value.shardId),
    requestedById: operatorText(value.requestedById, 'invalid_shard_quarantine_request'),
    reasonCode: value.reasonCode,
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
  };
}

function shardCleanupApprovalRequest(input: unknown): ControlShardCleanupApprovalRequest {
  const value = exactInput(
    input,
    [
      'quarantineOperationId',
      'requestedById',
      'reasonCode',
      'idempotencyKey',
      'confirmation',
      'exportMode',
      'exportEvidenceId',
      'deleteDatabase',
    ],
    'invalid_shard_cleanup_approval_request'
  );
  if (
    value.reasonCode !== 'operator_approve_cleanup' ||
    value.confirmation !== 'DELETE_RETIRED_TENANT_SHARD' ||
    (value.exportMode !== 'skipped' && value.exportMode !== 'manual_verified') ||
    (value.exportEvidenceId !== null &&
      (typeof value.exportEvidenceId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(value.exportEvidenceId))) ||
    value.deleteDatabase !== true
  ) {
    throw new Error('invalid_shard_cleanup_approval_request');
  }
  return {
    quarantineOperationId: provisioningOperationId(value.quarantineOperationId),
    requestedById: operatorText(value.requestedById, 'invalid_shard_cleanup_approval_request'),
    reasonCode: value.reasonCode,
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
    confirmation: value.confirmation,
    exportMode: value.exportMode,
    exportEvidenceId: value.exportEvidenceId,
    deleteDatabase: true,
  };
}

function shardCleanupRetryRequest(input: unknown): ControlShardCleanupRetryRequest {
  const value = exactInput(
    input,
    ['cleanupOperationId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_shard_cleanup_retry_request'
  );
  if (value.reasonCode !== 'operator_retry_cleanup') {
    throw new Error('invalid_shard_cleanup_retry_request');
  }
  return {
    cleanupOperationId: provisioningOperationId(value.cleanupOperationId),
    requestedById: operatorText(value.requestedById, 'invalid_shard_cleanup_retry_request'),
    reasonCode: value.reasonCode,
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
  };
}

function shardQuarantineRetryRequest(input: unknown): ControlShardQuarantineRetryRequest {
  const value = exactInput(
    input,
    ['quarantineOperationId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_shard_quarantine_retry_request'
  );
  if (value.reasonCode !== 'operator_retry_quarantine') {
    throw new Error('invalid_shard_quarantine_retry_request');
  }
  return {
    quarantineOperationId: provisioningOperationId(value.quarantineOperationId),
    requestedById: operatorText(value.requestedById, 'invalid_shard_quarantine_retry_request'),
    reasonCode: value.reasonCode,
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
  };
}

function accountDirectorySourcePage(input: unknown): {
  afterShardId: string | null;
  limit: number;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_account_directory_source_page');
  }
  const value = input as Record<string, unknown>;
  const afterShardId = value.afterShardId;
  if (
    afterShardId !== null &&
    (typeof afterShardId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(afterShardId))
  ) {
    throw new Error('invalid_account_directory_source_page');
  }
  if (
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100
  ) {
    throw new Error('invalid_account_directory_source_page');
  }
  return { afterShardId, limit: value.limit as number };
}

function accountRouteSourcePage(input: unknown): {
  dataRole: ControlAccountDataRole;
  afterShardId: string | null;
  limit: number;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_account_route_source_page');
  }
  const value = input as Record<string, unknown>;
  if (value.dataRole !== 'tenant_core/users' && value.dataRole !== 'tenant_pii') {
    throw new Error('invalid_account_route_source_page');
  }
  const page = accountDirectorySourcePage({
    afterShardId: value.afterShardId,
    limit: value.limit,
  });
  if (
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['dataRole', 'afterShardId', 'limit'].includes(key))
  ) {
    throw new Error('invalid_account_route_source_page');
  }
  return { dataRole: value.dataRole, ...page };
}

function exactInput(
  input: unknown,
  keys: readonly string[],
  code: string
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(code);
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error(code);
  }
  return value;
}

function tenantDrStart(input: unknown): ControlTenantDisasterRecoveryStartRequest {
  const value = exactInput(
    input,
    ['tenantId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_tenant_disaster_recovery_request'
  );
  if (value.reasonCode !== 'operator_disaster_recovery') {
    throw new Error('invalid_tenant_disaster_recovery_request');
  }
  return {
    tenantId: provisioningOperationId(value.tenantId),
    requestedById: operatorText(value.requestedById, 'invalid_tenant_disaster_recovery_request'),
    reasonCode: value.reasonCode,
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
  };
}

function tenantDrDeny(input: unknown): ControlTenantDisasterRecoveryDenyObservationRequest {
  const value = exactInput(
    input,
    ['operationId', 'runtimeGeneration', 'denyRegistryGeneration'],
    'invalid_tenant_disaster_recovery_request'
  );
  return {
    operationId: provisioningOperationId(value.operationId),
    runtimeGeneration: value.runtimeGeneration as number,
    denyRegistryGeneration: value.denyRegistryGeneration as number,
  };
}

function tenantDrRestore(input: unknown): ControlTenantDisasterRecoveryRestoreConfirmationRequest {
  const value = exactInput(
    input,
    ['operationId', 'restoreReferenceDigest', 'restoredAt', 'requestedById', 'idempotencyKey'],
    'invalid_tenant_disaster_recovery_request'
  );
  return {
    operationId: provisioningOperationId(value.operationId),
    restoreReferenceDigest: value.restoreReferenceDigest as string,
    restoredAt: value.restoredAt as number,
    requestedById: operatorText(value.requestedById, 'invalid_tenant_disaster_recovery_request'),
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
  };
}

function tenantDrVerification(input: unknown): ControlTenantDisasterRecoveryVerificationRequest {
  const value = exactInput(
    input,
    ['operationId', 'stage', 'pinnedRouteGeneration', 'targets'],
    'invalid_tenant_disaster_recovery_request'
  );
  if (
    (value.stage !== 'migration' &&
      value.stage !== 'lookup_reprojection' &&
      value.stage !== 'binding_smoke') ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > 100
  ) {
    throw new Error('invalid_tenant_disaster_recovery_request');
  }
  const targets = value.targets.map((target) => {
    const item = exactInput(
      target,
      [
        'shardId',
        'providerDatabaseId',
        'shardGeneration',
        'bindingRef',
        'releaseId',
        'manifestDigest',
      ],
      'invalid_tenant_disaster_recovery_request'
    );
    return {
      shardId: provisioningOperationId(item.shardId),
      providerDatabaseId: provisioningOperationId(item.providerDatabaseId),
      shardGeneration: item.shardGeneration as number,
      bindingRef: item.bindingRef as string,
      releaseId: provisioningOperationId(item.releaseId),
      manifestDigest: item.manifestDigest as string,
    };
  });
  if (new Set(targets.map((target) => target.shardId)).size !== targets.length) {
    throw new Error('invalid_tenant_disaster_recovery_request');
  }
  return {
    operationId: provisioningOperationId(value.operationId),
    stage: value.stage,
    pinnedRouteGeneration: value.pinnedRouteGeneration as number,
    targets,
  };
}

function tenantDrLookupClaim(input: unknown): ControlTenantDisasterRecoveryLookupClaimRequest {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'registryDigest', 'lookupShardCount'],
    'invalid_tenant_disaster_recovery_request'
  );
  return {
    operationId: provisioningOperationId(value.operationId),
    ownerId: provisioningOperationId(value.ownerId),
    registryDigest: value.registryDigest as string,
    lookupShardCount: value.lookupShardCount as number,
  };
}

function tenantDrLookupClaimNext(
  input: unknown
): ControlTenantDisasterRecoveryLookupClaimNextRequest {
  const value = exactInput(
    input,
    ['ownerId', 'registryDigest', 'lookupShardCount'],
    'invalid_tenant_disaster_recovery_request'
  );
  return {
    ownerId: provisioningOperationId(value.ownerId),
    registryDigest: value.registryDigest as string,
    lookupShardCount: value.lookupShardCount as number,
  };
}

function tenantDrLookupCheckpoint(
  input: unknown
): ControlTenantDisasterRecoveryLookupCheckpointRequest {
  const value = exactInput(
    input,
    [
      'operationId',
      'ownerId',
      'fencingToken',
      'registryDigest',
      'lookupShardCount',
      'stage',
      'nextStage',
      'targetIndex',
      'afterCreatedAt',
      'afterId',
      'afterRowId',
      'projectedRowsDelta',
      'verifiedRowsDelta',
    ],
    'invalid_tenant_disaster_recovery_request'
  );
  return value as unknown as ControlTenantDisasterRecoveryLookupCheckpointRequest;
}

function tenantDrLookupComplete(
  input: unknown
): ControlTenantDisasterRecoveryLookupCompleteRequest {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'fencingToken', 'registryDigest'],
    'invalid_tenant_disaster_recovery_request'
  );
  return {
    operationId: provisioningOperationId(value.operationId),
    ownerId: provisioningOperationId(value.ownerId),
    fencingToken: value.fencingToken as number,
    registryDigest: value.registryDigest as string,
  };
}

function tenantDrReactivation(input: unknown): ControlTenantDisasterRecoveryReactivationRequest {
  const value = exactInput(
    input,
    ['operationId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_tenant_disaster_recovery_request'
  );
  if (value.reasonCode !== 'operator_reactivate_recovered_tenant') {
    throw new Error('invalid_tenant_disaster_recovery_request');
  }
  return {
    operationId: provisioningOperationId(value.operationId),
    requestedById: operatorText(value.requestedById, 'invalid_tenant_disaster_recovery_request'),
    reasonCode: value.reasonCode,
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
  };
}

function tenantDrReactivationObservation(
  input: unknown
): ControlTenantDisasterRecoveryReactivationObservationRequest {
  const value = exactInput(
    input,
    ['operationId', 'runtimeGeneration', 'pinnedRouteGeneration'],
    'invalid_tenant_disaster_recovery_request'
  );
  return {
    operationId: provisioningOperationId(value.operationId),
    runtimeGeneration: value.runtimeGeneration as number,
    pinnedRouteGeneration: value.pinnedRouteGeneration as number,
  };
}

function tenantDrCancel(input: unknown): ControlTenantDisasterRecoveryCancelRequest {
  const value = exactInput(
    input,
    ['operationId', 'requestedById', 'reasonCode', 'idempotencyKey'],
    'invalid_tenant_disaster_recovery_request'
  );
  if (value.reasonCode !== 'operator_cancel_before_deny') {
    throw new Error('invalid_tenant_disaster_recovery_request');
  }
  return {
    operationId: provisioningOperationId(value.operationId),
    requestedById: operatorText(value.requestedById, 'invalid_tenant_disaster_recovery_request'),
    reasonCode: value.reasonCode,
    idempotencyKey: provisioningOperationId(value.idempotencyKey),
  };
}

function initialLookupHmacKeyState(input: unknown) {
  const value = exactInput(input, ['current'], 'invalid_lookup_hmac_key_state_initialization');
  return { current: validateLookupHmacKeyMetadata(value.current) };
}

function lookupHmacRotationStart(input: unknown) {
  const value = exactInput(
    input,
    ['candidate', 'idempotencyKey', 'ownerId'],
    'invalid_lookup_hmac_rotation_start'
  );
  return {
    candidate: validateLookupHmacKeyMetadata(value.candidate),
    idempotencyKey: value.idempotencyKey as string,
    ownerId: value.ownerId as string,
  };
}

function lookupHmacRotationMutation(input: unknown) {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'fencingToken'],
    'invalid_lookup_hmac_rotation_mutation'
  );
  return {
    operationId: value.operationId as string,
    ownerId: value.ownerId as string,
    fencingToken: value.fencingToken as number,
  };
}

function lookupHmacRotationCheckpoint(input: unknown) {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'fencingToken', 'checkpoint', 'sourceRowCount'],
    'invalid_lookup_hmac_rotation_checkpoint'
  );
  return {
    ...lookupHmacRotationMutation({
      operationId: value.operationId,
      ownerId: value.ownerId,
      fencingToken: value.fencingToken,
    }),
    checkpoint: value.checkpoint as Record<string, unknown>,
    sourceRowCount: value.sourceRowCount as number,
  };
}

function lookupHmacRotationSourceCheckpoint(input: unknown) {
  const value = exactInput(
    input,
    [
      'operationId',
      'ownerId',
      'fencingToken',
      'sourceKind',
      'shardId',
      'cursor',
      'sourceRowCount',
      'complete',
    ],
    'invalid_lookup_hmac_source_checkpoint'
  );
  return {
    ...lookupHmacRotationMutation({
      operationId: value.operationId,
      ownerId: value.ownerId,
      fencingToken: value.fencingToken,
    }),
    sourceKind: value.sourceKind as 'account_id' | 'email_exact' | 'external_subject',
    shardId: value.shardId as string,
    cursor: value.cursor as Record<string, unknown>,
    sourceRowCount: value.sourceRowCount as number,
    complete: value.complete as boolean,
  };
}

function lookupHmacRotationVerification(input: unknown) {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'fencingToken', 'currentRowCount', 'result'],
    'invalid_lookup_hmac_verification'
  );
  return {
    ...lookupHmacRotationMutation({
      operationId: value.operationId,
      ownerId: value.ownerId,
      fencingToken: value.fencingToken,
    }),
    currentRowCount: value.currentRowCount as number,
    result: value.result as {
      sourceShardsComplete: boolean;
      currentRowsValid: boolean;
      reservationsValid: boolean;
      routeReferencesValid: boolean;
    },
  };
}

function lookupHmacRotationVerificationShardCheckpoint(input: unknown) {
  const value = exactInput(
    input,
    [
      'operationId',
      'ownerId',
      'fencingToken',
      'lookupShardId',
      'cursor',
      'currentRowCount',
      'result',
      'complete',
    ],
    'invalid_lookup_hmac_verification_checkpoint'
  );
  return {
    ...lookupHmacRotationMutation({
      operationId: value.operationId,
      ownerId: value.ownerId,
      fencingToken: value.fencingToken,
    }),
    lookupShardId: value.lookupShardId as string,
    cursor: value.cursor as Record<string, unknown>,
    currentRowCount: value.currentRowCount as number,
    result: value.result as {
      currentRowsValid: boolean;
      reservationsValid: boolean;
      routeReferencesValid: boolean;
    },
    complete: value.complete as boolean,
  };
}

function lookupBucketMigrationStart(input: unknown) {
  const value = exactInput(
    input,
    ['virtualBucket', 'targetLookupShardId', 'idempotencyKey', 'ownerId'],
    'invalid_lookup_bucket_migration_start'
  );
  return {
    virtualBucket: value.virtualBucket as number,
    targetLookupShardId: value.targetLookupShardId as string,
    idempotencyKey: value.idempotencyKey as string,
    ownerId: value.ownerId as string,
  };
}

function lookupBucketMigrationClaim(input: unknown) {
  const value = exactInput(
    input,
    ['operationId', 'ownerId'],
    'invalid_lookup_bucket_migration_claim'
  );
  return { operationId: value.operationId as string, ownerId: value.ownerId as string };
}

function lookupBucketMigrationCheckpoint(input: unknown) {
  const value = exactInput(
    input,
    [
      'operationId',
      'ownerId',
      'fencingToken',
      'expectedState',
      'nextState',
      'backfillCursor',
      'sourceRowCount',
      'targetRowCount',
      'verificationDigest',
    ],
    'invalid_lookup_bucket_migration_checkpoint'
  );
  return value as unknown as Parameters<LookupBucketMigrationService['checkpoint']>[1];
}

function lookupBucketMigrationCutover(input: unknown) {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'fencingToken'],
    'invalid_lookup_bucket_migration_cutover'
  );
  return value as unknown as Parameters<LookupBucketMigrationService['prepareCutover']>[1];
}

function lookupBucketMigrationComplete(input: unknown) {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'fencingToken', 'oldRowsQuarantined'],
    'invalid_lookup_bucket_migration_complete'
  );
  return value as unknown as Parameters<LookupBucketMigrationService['complete']>[1];
}

function lookupBucketMigrationBlock(input: unknown) {
  const value = exactInput(
    input,
    ['operationId', 'ownerId', 'fencingToken', 'errorCode'],
    'invalid_lookup_bucket_migration_block'
  );
  return value as unknown as Parameters<LookupBucketMigrationService['block']>[1];
}

function lookupBucketLoadSnapshot(input: unknown) {
  const value = exactInput(
    input,
    ['ownerId', 'observedAt', 'buckets'],
    'invalid_lookup_bucket_load_snapshot'
  );
  if (!Array.isArray(value.buckets)) throw new Error('invalid_lookup_bucket_load_snapshot');
  return {
    ownerId: value.ownerId as string,
    observedAt: value.observedAt as number,
    buckets: value.buckets.map((candidate) =>
      exactInput(
        candidate,
        [
          'virtualBucket',
          'lookupShardId',
          'assignmentGeneration',
          'activeIdentifierCount',
          'counterUpdatedAt',
        ],
        'invalid_lookup_bucket_load_observation'
      )
    ),
  } as unknown as Parameters<LookupBucketMigrationService['planNextAutomaticMigration']>[1];
}

function lookupBucket(input: unknown): number {
  const value = exactInput(input, ['virtualBucket'], 'invalid_lookup_bucket_route_request');
  if (
    !Number.isSafeInteger(value.virtualBucket) ||
    (value.virtualBucket as number) < 0 ||
    (value.virtualBucket as number) > 4095
  ) {
    throw new Error('invalid_lookup_bucket_route_request');
  }
  return value.virtualBucket as number;
}

function lookupBucketVersion(input: unknown): {
  virtualBucket: number;
  assignmentGeneration: number;
} {
  const value = exactInput(
    input,
    ['virtualBucket', 'assignmentGeneration'],
    'invalid_lookup_bucket_route_version_request'
  );
  const virtualBucket = lookupBucket({ virtualBucket: value.virtualBucket });
  if (
    !Number.isSafeInteger(value.assignmentGeneration) ||
    (value.assignmentGeneration as number) < 1
  ) {
    throw new Error('invalid_lookup_bucket_route_version_request');
  }
  return { virtualBucket, assignmentGeneration: value.assignmentGeneration as number };
}

function readReplicationStart(input: unknown): ControlReadReplicationStartRequest {
  const value = exactInput(
    input,
    ['desiredMode', 'idempotencyKey', 'requestedById'],
    'invalid_read_replication_rollout_request'
  );
  return {
    desiredMode: value.desiredMode as ControlReadReplicationStartRequest['desiredMode'],
    idempotencyKey: value.idempotencyKey as string,
    requestedById: value.requestedById as string,
  };
}

function tenantPlacementMigrationStart(
  input: unknown
): ControlTenantPlacementMigrationStartRequest {
  const value = exactInput(
    input,
    ['tenantId', 'targetIsolationPolicy', 'idempotencyKey', 'requestedById'],
    'invalid_tenant_placement_migration_request'
  );
  if (value.targetIsolationPolicy !== 'tenant_exclusive') {
    throw new Error('invalid_tenant_placement_migration_request');
  }
  return {
    tenantId: value.tenantId as string,
    targetIsolationPolicy: 'tenant_exclusive',
    idempotencyKey: value.idempotencyKey as string,
    requestedById: value.requestedById as string,
  };
}

function tenantPlacementMigrationMutation(
  input: unknown
): ControlTenantPlacementMigrationMutationRequest {
  const value = exactInput(
    input,
    ['operationId', 'requestedById', 'idempotencyKey'],
    'invalid_tenant_placement_migration_request'
  );
  return {
    operationId: value.operationId as string,
    requestedById: value.requestedById as string,
    idempotencyKey: value.idempotencyKey as string,
  };
}

export default class ControlWorker extends WorkerEntrypoint<ControlEnv, ControlRpcProps> {
  async fetch(): Promise<Response> {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  previewCapacityProvisioning(input: unknown): Promise<ControlCapacityProvisioningPreview> {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const preview = await service(this.env).previewCapacityProvisioning(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(preview);
      return preview;
    });
  }

  requestCapacityProvisioning(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      return service(this.env).requestCapacityProvisioning(input, caller.environmentId);
    });
  }

  getProvisioningAuthorityStatus() {
    return rpcResult(() => {
      const caller = authorizedCaller(this.ctx.props);
      return service(this.env).getProvisioningAuthorityStatus(caller.environmentId);
    });
  }

  ensureTenantShardCapacity(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).ensureTenantShardCapacity(input, caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantRuntimeRouteTargets(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).getTenantRuntimeRouteTargets(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantProvisioningRouteTargets(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).getTenantProvisioningRouteTargets(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantRegionShardPolicy(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).getTenantRegionShardPolicy(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantProvisioningRegionShardPolicy(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).getTenantProvisioningRegionShardPolicy(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  validatePluginDynamicWorkerDesiredState(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new PluginDynamicWorkerDesiredStateService(this.env.CONTROL_DB).plan(
        caller.environmentId,
        input
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  preparePluginDynamicWorkerResources(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new PluginDynamicWorkerDesiredStateService(this.env.CONTROL_DB).prepare(
        caller.environmentId,
        input
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getPluginDynamicWorkerResourcePreparation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new PluginDynamicWorkerDesiredStateService(
        this.env.CONTROL_DB
      ).getPreparation(caller.environmentId, input);
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  syncPluginDynamicWorkerObservedState(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new PluginDynamicWorkerDesiredStateService(this.env.CONTROL_DB).sync(
        caller.environmentId,
        input
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  requestPluginResourceCleanup(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await new PluginResourceCleanupService(
        this.env.CONTROL_DB,
        clients,
        () => Math.floor(Date.now() / 1000),
        this.env.CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED === 'true'
      ).request(caller.environmentId, input);
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getPluginResourceCleanup(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await new PluginResourceCleanupService(
        this.env.CONTROL_DB,
        clients,
        () => Math.floor(Date.now() / 1000),
        this.env.CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED === 'true'
      ).get(caller.environmentId, input);
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantDeletionInventory(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).getTenantDeletionInventory(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  finalizeTenantDeletionControlState(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).finalizeTenantDeletionControlState(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  registerTenantPlacementPolicy(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).registerTenantPlacementPolicy(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  activateTenantPlacementPolicy(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).activateTenantPlacementPolicy(
        input,
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantPlacementPolicy(tenantId: string) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await service(this.env).getTenantPlacementPolicy(
        tenantId,
        caller.environmentId
      );
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  startTenantPlacementMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const apiClients = createControlApiClients(this.env);
      const migration = new TenantPlacementMigrationService(
        this.env.CONTROL_DB,
        () => Math.floor(Date.now() / 1000),
        { sourceD1: apiClients.d1 }
      );
      const result = await migration.start(
        caller.environmentId,
        tenantPlacementMigrationStart(input)
      );
      this.ctx.waitUntil(
        new TenantPlacementMigrationReconciler(
          this.env.CONTROL_DB,
          service(this.env),
          apiClients.d1,
          () => Math.floor(Date.now() / 1000)
        ).reconcile()
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantPlacementMigration(operationId: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantPlacementMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).get(caller.environmentId, provisioningOperationId(operationId));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  cancelTenantPlacementMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantPlacementMigrationService(
        this.env.CONTROL_DB,
        () => Math.floor(Date.now() / 1000),
        { sourceD1: createControlApiClients(this.env).d1 }
      ).cancel(caller.environmentId, tenantPlacementMigrationMutation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  beginTenantPlacementRouteCutover(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantPlacementMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).beginRouteCutover(caller.environmentId, tenantPlacementMigrationMutation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  commitTenantPlacementMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantPlacementMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).commitCutover(caller.environmentId, tenantPlacementMigrationMutation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  finalizeTenantPlacementMigrationCutover(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantPlacementMigrationService(
        this.env.CONTROL_DB,
        () => Math.floor(Date.now() / 1000),
        { sourceD1: createControlApiClients(this.env).d1 }
      ).finalizeCutover(caller.environmentId, tenantPlacementMigrationMutation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  approveTenantPlacementMigrationPurge(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantPlacementMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).approvePurge(caller.environmentId, tenantPlacementMigrationMutation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getProvisioningOperation(operationId: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new D1ControlRepository(this.env.CONTROL_DB).getProvisioningOperation(
        provisioningOperationId(operationId),
        caller.environmentId
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  retryProvisioningOperationStep(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const request = provisioningOperationRetry(input);
      const result = await new D1ControlRepository(
        this.env.CONTROL_DB
      ).retryProvisioningOperationStep(
        request,
        caller.environmentId,
        Math.floor(Date.now() / 1000)
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  cancelProvisioningOperation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const request = provisioningOperationCancel(input);
      const result = await new D1ControlRepository(this.env.CONTROL_DB).cancelProvisioningOperation(
        request,
        caller.environmentId,
        Math.floor(Date.now() / 1000)
      );
      if (result.operationKind === 'provision_plugin_resources') {
        await new PluginResourceCleanupService(
          this.env.CONTROL_DB,
          createControlApiClients(this.env),
          () => Math.floor(Date.now() / 1000),
          this.env.CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED === 'true'
        ).requestCanceledProvisioning(caller.environmentId, {
          sourceOperationId: request.operationId,
          requestedById: request.requestedById,
          idempotencyKey: request.idempotencyKey,
        });
      }
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  restoreProvisioningOperationPreviousSettings(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const request = provisioningOperationRestore(input);
      const result = await new D1ControlRepository(
        this.env.CONTROL_DB
      ).restoreProvisioningOperationPreviousSettings(
        request,
        caller.environmentId,
        Math.floor(Date.now() / 1000)
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  startTenantDisasterRecovery(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(this.env.CONTROL_DB).start(
        caller.environmentId,
        tenantDrStart(input)
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getTenantDisasterRecovery(operationId: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(this.env.CONTROL_DB).get(
        caller.environmentId,
        provisioningOperationId(operationId)
      );
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  observeTenantDisasterRecoveryDeny(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(this.env.CONTROL_DB).observeDeny(
        caller.environmentId,
        tenantDrDeny(input)
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  confirmTenantDisasterRecoveryRestore(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(this.env.CONTROL_DB).confirmRestore(
        caller.environmentId,
        tenantDrRestore(input)
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  recordTenantDisasterRecoveryVerification(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const request = tenantDrVerification(input);
      const recovery = await new TenantDisasterRecoveryService(this.env.CONTROL_DB).get(
        caller.environmentId,
        request.operationId
      );
      if (!recovery) throw new Error('control_tenant_dr_operation_not_found');
      if (request.stage === 'migration') {
        const engine = new ApiMigrationEngine(
          new MigrationReleaseArtifactReader(
            new R2ReleaseArtifactStore(this.env.MIGRATION_RELEASES)
          ),
          cloudflareMigrationExecutor(createControlApiClients(this.env).d1),
          () => Date.now()
        );
        for (const target of recovery.targets) {
          await engine.apply({
            databaseId: target.providerDatabaseId,
            pin: {
              environmentId: recovery.environmentId,
              streamId: target.migrationStreamId,
              releaseId: target.releaseId,
              manifestDigest: target.manifestDigest,
              manifestObjectKey: `releases/${target.releaseId}/${target.manifestDigest}/manifest.json`,
            },
          });
        }
      }
      const result = await new TenantDisasterRecoveryService(
        this.env.CONTROL_DB
      ).recordVerification(caller.environmentId, request);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  claimTenantDisasterRecoveryLookupReprojection(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(
        this.env.CONTROL_DB
      ).claimLookupReprojection(caller.environmentId, tenantDrLookupClaim(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  claimNextTenantDisasterRecoveryLookupReprojection(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(
        this.env.CONTROL_DB
      ).claimNextLookupReprojection(caller.environmentId, tenantDrLookupClaimNext(input));
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  checkpointTenantDisasterRecoveryLookupReprojection(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(
        this.env.CONTROL_DB
      ).checkpointLookupReprojection(caller.environmentId, tenantDrLookupCheckpoint(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  completeTenantDisasterRecoveryLookupReprojection(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(
        this.env.CONTROL_DB
      ).completeLookupReprojection(caller.environmentId, tenantDrLookupComplete(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  requestTenantDisasterRecoveryReactivation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(
        this.env.CONTROL_DB
      ).requestReactivation(caller.environmentId, tenantDrReactivation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  completeTenantDisasterRecoveryReactivation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(
        this.env.CONTROL_DB
      ).completeReactivation(caller.environmentId, tenantDrReactivationObservation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  cancelTenantDisasterRecovery(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new TenantDisasterRecoveryService(this.env.CONTROL_DB).cancel(
        caller.environmentId,
        tenantDrCancel(input)
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  listShardCleanupCandidates() {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await ShardCleanupService.fromEnv(
        this.env,
        new D1ShardCleanupRepository(this.env.CONTROL_DB),
        clients.d1,
        clients.workers,
        () => Math.floor(Date.now() / 1000)
      ).list(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getShardCleanupCandidate(shardId: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await ShardCleanupService.fromEnv(
        this.env,
        new D1ShardCleanupRepository(this.env.CONTROL_DB),
        clients.d1,
        clients.workers,
        () => Math.floor(Date.now() / 1000)
      ).get(caller.environmentId, provisioningOperationId(shardId));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  quarantineShard(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await ShardCleanupService.fromEnv(
        this.env,
        new D1ShardCleanupRepository(this.env.CONTROL_DB),
        clients.d1,
        clients.workers,
        () => Math.floor(Date.now() / 1000)
      ).quarantine(caller.environmentId, shardQuarantineRequest(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  retryShardQuarantine(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await ShardCleanupService.fromEnv(
        this.env,
        new D1ShardCleanupRepository(this.env.CONTROL_DB),
        clients.d1,
        clients.workers,
        () => Math.floor(Date.now() / 1000)
      ).retryQuarantine(caller.environmentId, shardQuarantineRetryRequest(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  approveShardCleanup(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await ShardCleanupService.fromEnv(
        this.env,
        new D1ShardCleanupRepository(this.env.CONTROL_DB),
        clients.d1,
        clients.workers,
        () => Math.floor(Date.now() / 1000)
      ).approveCleanup(caller.environmentId, shardCleanupApprovalRequest(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  retryShardCleanup(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const clients = createControlApiClients(this.env);
      const result = await ShardCleanupService.fromEnv(
        this.env,
        new D1ShardCleanupRepository(this.env.CONTROL_DB),
        clients.d1,
        clients.workers,
        () => Math.floor(Date.now() / 1000)
      ).retryCleanup(caller.environmentId, shardCleanupRetryRequest(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getRuntimeRegistrySignerMetadata() {
    return rpcResult(() => {
      authorizedCaller(this.ctx.props);
      return Promise.resolve(runtimeRegistrySignerMetadata(this.env));
    });
  }

  signRuntimeRegistryPayload(input: unknown) {
    return rpcResult(async () => {
      authorizedCaller(this.ctx.props);
      const result = await signRuntimeRegistryPayload(this.env, input);
      assertControlPlaneRecordIsSecretFree({
        keyId: result.keyId,
        algorithm: result.algorithm,
        type: result.type,
      });
      return result;
    });
  }

  reserveTenantDefaultRoute(input: unknown) {
    return rpcResult(() => {
      const caller = authorizedCaller(this.ctx.props);
      return new TenantDefaultAllocationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).reserve(input, caller.environmentId);
    });
  }

  commitTenantDefaultRoute(input: unknown) {
    return rpcResult(() => {
      const caller = authorizedCaller(this.ctx.props);
      return new TenantDefaultAllocationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).mutate(input, caller.environmentId, 'commit');
    });
  }

  releaseTenantDefaultRoute(input: unknown) {
    return rpcResult(() => {
      const caller = authorizedCaller(this.ctx.props);
      return new TenantDefaultAllocationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).mutate(input, caller.environmentId, 'release');
    });
  }

  allocateAccountRoute(input: unknown) {
    return rpcResult(() => {
      const caller = authorizedCaller(this.ctx.props);
      return new ControlAccountAllocationService(
        new D1AccountAllocationRepository(this.env.CONTROL_DB),
        () => Math.floor(Date.now() / 1000)
      ).allocate(input, caller.environmentId);
    });
  }

  listAccountDirectorySourceShards(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const page = accountDirectorySourcePage(input);
      const result = await new D1ControlRepository(
        this.env.CONTROL_DB
      ).listAccountDirectorySourceShards(caller.environmentId, page.afterShardId, page.limit);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  listAccountRouteSourceShards(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const page = accountRouteSourcePage(input);
      const result = await new D1ControlRepository(
        this.env.CONTROL_DB
      ).listAccountRouteSourceShards(
        caller.environmentId,
        page.dataRole,
        page.afterShardId,
        page.limit
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  startLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).start(caller.environmentId, lookupBucketMigrationStart(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  claimLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).claim(caller.environmentId, lookupBucketMigrationClaim(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  claimNextLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const value = exactInput(input, ['ownerId'], 'invalid_lookup_bucket_migration_claim_next');
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).claimNext(caller.environmentId, value.ownerId as string);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  checkpointLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).checkpoint(caller.environmentId, lookupBucketMigrationCheckpoint(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  cutoverLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const request = lookupBucketMigrationCutover(input);
      const service = new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      );
      await service.prepareCutover(caller.environmentId, request);
      const publication = await new LookupRegistryPublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      const result = await service.confirmCutover(
        caller.environmentId,
        request,
        publication.generation
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  completeLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).complete(caller.environmentId, lookupBucketMigrationComplete(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  blockLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).block(caller.environmentId, lookupBucketMigrationBlock(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  planNextLookupBucketMigration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).planNextAutomaticMigration(caller.environmentId, lookupBucketLoadSnapshot(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getLookupBucketWriteRoute(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).writeRoute(caller.environmentId, lookupBucket(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  resolveLookupBucketRouteVersion(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const request = lookupBucketVersion(input);
      const result = await new LookupBucketMigrationService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).resolveRouteVersion(
        caller.environmentId,
        request.virtualBucket,
        request.assignmentGeneration
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getReadReplicationStatus() {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new ReadReplicationService(
        this.env.CONTROL_DB,
        createControlApiClients(this.env).d1
      ).getStatus(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  startReadReplicationRollout(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const readReplication = new ReadReplicationService(
        this.env.CONTROL_DB,
        createControlApiClients(this.env).d1
      );
      const result = await readReplication.start(caller.environmentId, readReplicationStart(input));
      if (result.operationId && result.aggregateStatus === 'updating') {
        this.ctx.waitUntil(readReplication.reconcile(10, result.operationId));
      }
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  initializeLookupHmacKeyState(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const service = new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      );
      const result = await service.initialize(
        caller.environmentId,
        initialLookupHmacKeyState(input)
      );
      await new LookupHmacKeyStatePublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  startLookupHmacRotation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).start(caller.environmentId, lookupHmacRotationStart(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getLookupHmacRotation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const value = exactInput(input, ['operationId'], 'invalid_lookup_hmac_rotation_get');
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).getRotation(caller.environmentId, value.operationId as string);
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getLookupHmacVerificationStatus(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const value = exactInput(
        input,
        ['operationId', 'phase'],
        'invalid_lookup_hmac_verification_status'
      );
      if (value.phase !== 'distribution' && value.phase !== 'generation') {
        throw new Error('invalid_lookup_hmac_verification_status');
      }
      const result = await new D1LookupHmacCandidateVerificationRepository(
        this.env.CONTROL_DB
      ).status(caller.environmentId, value.operationId as string, value.phase);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  activateLookupHmacRotation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).activate(caller.environmentId, lookupHmacRotationMutation(input));
      await new LookupHmacKeyStatePublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  observeLookupHmacRotationGeneration(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).observeGeneration(caller.environmentId, lookupHmacRotationMutation(input));
      await new LookupHmacKeyStatePublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  claimNextLookupHmacRotation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const value = exactInput(input, ['ownerId'], 'invalid_lookup_hmac_rotation_claim');
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).claimNext(caller.environmentId, value.ownerId as string);
      if (result) {
        await new LookupHmacKeyStatePublisher(this.env, () =>
          Math.floor(Date.now() / 1000)
        ).publishEnvironment(caller.environmentId);
        assertControlPlaneRecordIsSecretFree(result);
      }
      return result;
    });
  }

  checkpointLookupHmacRotation(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).checkpoint(caller.environmentId, lookupHmacRotationCheckpoint(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getNextLookupHmacRotationSource(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).getNextSource(caller.environmentId, lookupHmacRotationMutation(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  checkpointLookupHmacRotationSource(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).checkpointSource(caller.environmentId, lookupHmacRotationSourceCheckpoint(input));
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  beginLookupHmacRotationVerification(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).beginVerification(caller.environmentId, lookupHmacRotationMutation(input));
      await new LookupHmacKeyStatePublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getNextLookupHmacRotationVerificationShard(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).getNextVerificationShard(caller.environmentId, lookupHmacRotationMutation(input));
      if (result) assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  checkpointLookupHmacRotationVerificationShard(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).checkpointVerificationShard(
        caller.environmentId,
        lookupHmacRotationVerificationShardCheckpoint(input)
      );
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  finalizeLookupHmacRotationVerification(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).finalizeVerification(caller.environmentId, lookupHmacRotationMutation(input));
      await new LookupHmacKeyStatePublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  recordLookupHmacRotationVerification(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).recordVerification(caller.environmentId, lookupHmacRotationVerification(input));
      await new LookupHmacKeyStatePublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  completeLookupHmacRotationGrace(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const result = await new LookupHmacKeyStateService(this.env.CONTROL_DB, () =>
        Math.floor(Date.now() / 1000)
      ).completeGrace(caller.environmentId, lookupHmacRotationMutation(input));
      await new LookupHmacKeyStatePublisher(this.env, () =>
        Math.floor(Date.now() / 1000)
      ).publishEnvironment(caller.environmentId);
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    });
  }

  getOperationStatus(operationId: unknown) {
    return rpcResult(() => {
      const caller = authorizedCaller(this.ctx.props);
      return service(this.env).getOperation(operationId, caller.environmentId);
    });
  }

  reconcilePending() {
    return rpcResult(() => {
      authorizedCaller(this.ctx.props);
      return service(this.env).reconcilePending();
    });
  }

  replenishLowWatermark() {
    return rpcResult(() => {
      authorizedCaller(this.ctx.props);
      return service(this.env).replenishLowWatermark();
    });
  }

  listPendingWorkerInventoryDriftFindings() {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const rows = await new D1ControlRepository(
        this.env.CONTROL_DB
      ).listPendingWorkerInventoryDriftFindings(caller.environmentId, 100);
      const findings: ControlWorkerInventoryDriftNotification[] = rows.map((row) => ({
        findingId: row.finding_id,
        environmentId: row.environment_id,
        workerScriptName: row.worker_script_name,
        findingKind: row.finding_kind,
        severity: row.severity,
        firstObservedAt: row.first_observed_at,
        lastObservedAt: row.last_observed_at,
      }));
      assertControlPlaneRecordIsSecretFree(findings);
      return findings;
    });
  }

  listWorkerInventoryDriftFindings() {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const rows = await new D1ControlRepository(
        this.env.CONTROL_DB
      ).listWorkerInventoryDriftFindings(caller.environmentId, 100);
      const findings = rows.map(driftFinding);
      assertControlPlaneRecordIsSecretFree(findings);
      return findings;
    });
  }

  reviewWorkerInventoryDriftFinding(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      const request = driftReviewRequest(input);
      if (!request.findingId.startsWith(`drift:${caller.environmentId}:actual_only:`)) {
        throw new Error('invalid_worker_inventory_drift_review');
      }
      const row = await new D1ControlRepository(
        this.env.CONTROL_DB
      ).reviewWorkerInventoryDriftFinding(
        caller.environmentId,
        request,
        Math.floor(Date.now() / 1000)
      );
      const finding = driftFinding(row);
      assertControlPlaneRecordIsSecretFree(finding);
      return finding;
    });
  }

  acknowledgeWorkerInventoryDriftNotifications(input: unknown) {
    return rpcResult(async () => {
      const caller = authorizedCaller(this.ctx.props);
      await new D1ControlRepository(
        this.env.CONTROL_DB
      ).acknowledgeWorkerInventoryDriftNotifications(
        caller.environmentId,
        findingIds(input),
        Math.floor(Date.now() / 1000)
      );
    });
  }

  async scheduled(): Promise<void> {
    const scheduledTask = (name: string, operation: Promise<unknown>): Promise<unknown> =>
      operation.catch(() => {
        throw new Error(`control_scheduled_${name}_failed`);
      });
    const repository = new D1ControlRepository(this.env.CONTROL_DB);
    const control = new ControlService({
      repository,
      env: this.env,
      now: () => Math.floor(Date.now() / 1000),
    });
    const tasks: Promise<unknown>[] = [
      scheduledTask(
        'signing_key_candidate_verification',
        new SigningKeyCandidateVerifier(
          new D1SigningKeyVerificationRepository(this.env.CONTROL_DB),
          this.env,
          () => Math.floor(Date.now() / 1000)
        ).reconcile()
      ),
      scheduledTask(
        'lookup_hmac_candidate_verification',
        new LookupHmacCandidateVerifier(
          new D1LookupHmacCandidateVerificationRepository(this.env.CONTROL_DB),
          this.env,
          () => Math.floor(Date.now() / 1000)
        ).reconcile()
      ),
      scheduledTask(
        'tenant_disaster_recovery_drain',
        new TenantDisasterRecoveryService(this.env.CONTROL_DB).reconcileDrain()
      ),
    ];
    const d1Token = this.env.CLOUDFLARE_D1_API_TOKEN?.trim();
    const workersToken = this.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim();
    const automaticProvisioningReady =
      this.env.AUTHRIM_AUTOMATIC_PROVISIONING === 'true' &&
      Boolean(d1Token) &&
      Boolean(workersToken) &&
      d1Token !== workersToken &&
      (await repository.hasReadyAutomaticProvisioning());
    // Always reconcile existing operations. When automatic execution is unavailable the service
    // atomically hands them to setup instead of leaving a partially provisioned shard stranded.
    tasks.push(scheduledTask('pending_operation_handoff', control.reconcilePending()));
    if (automaticProvisioningReady) {
      const unavailablePluginResourceKinds = [
        ...(this.env.CLOUDFLARE_KV_API_TOKEN?.trim() ? [] : (['kv_namespace'] as const)),
        ...(this.env.CLOUDFLARE_R2_API_TOKEN?.trim() ? [] : (['r2_bucket'] as const)),
      ];
      if (unavailablePluginResourceKinds.length > 0) {
        await handoffPluginResourceOperationsToSetup(
          this.env.CONTROL_DB,
          Math.floor(Date.now() / 1000),
          { resourceKinds: unavailablePluginResourceKinds }
        );
      }
    }
    const apiClients = createControlApiClients(this.env);
    const workerBindingReconciler = new WorkerBindingReconciler(
      new D1WorkerBindingRepository(this.env.CONTROL_DB),
      repository,
      apiClients.workers,
      this.env,
      () => Math.floor(Date.now() / 1000),
      automaticProvisioningReady
    );
    tasks.push(
      scheduledTask(
        'worker_binding_reconciliation',
        (async () => {
          await workerBindingReconciler.reconcile();
          await new TenantDisasterRecoveryService(this.env.CONTROL_DB).reconcileBindingSmoke();
        })()
      ),
      scheduledTask(
        'plugin_binding_reconciliation',
        new PluginResourceBindingReconciler(
          this.env.CONTROL_DB,
          apiClients.workers,
          this.env,
          () => Math.floor(Date.now() / 1000),
          automaticProvisioningReady
        ).reconcile()
      )
    );
    if (automaticProvisioningReady) {
      const workerInventory = new WorkerInventoryReconciler(repository, apiClients.workers, () =>
        Math.floor(Date.now() / 1000)
      );
      tasks.push(
        scheduledTask('low_watermark_replenishment', control.replenishLowWatermark()),
        scheduledTask('worker_inventory_reconciliation', workerInventory.reconcile()),
        scheduledTask(
          'read_replication_reconciliation',
          new ReadReplicationService(this.env.CONTROL_DB, apiClients.d1).reconcile()
        ),
        scheduledTask(
          'read_replication_drift',
          new ReadReplicationService(this.env.CONTROL_DB, apiClients.d1).reconcileDrift()
        ),
        scheduledTask(
          'bootstrap_handoff_verification',
          new BootstrapHandoffVerifier(
            new D1BootstrapHandoffRepository(this.env.CONTROL_DB),
            {
              getD1Database: (databaseId) => apiClients.d1.getD1Database(databaseId),
              queryD1Batch: (databaseId, queries) =>
                apiClients.d1.queryD1Batch(databaseId, queries),
              getWorkerSettings: (scriptName) => apiClients.workers.getWorkerSettings(scriptName),
              listWorkerDeployments: (scriptName) =>
                apiClients.workers.listWorkerDeployments(scriptName),
            },
            () => Math.floor(Date.now() / 1000)
          ).reconcile()
        ),
        scheduledTask(
          'tenant_placement_migration',
          new TenantPlacementMigrationReconciler(this.env.CONTROL_DB, control, apiClients.d1, () =>
            Math.floor(Date.now() / 1000)
          ).reconcile()
        ),
        scheduledTask(
          'plugin_resource_reconciliation',
          new PluginResourceReconciler(this.env.CONTROL_DB, apiClients, () =>
            Math.floor(Date.now() / 1000)
          ).reconcile()
        ),
        scheduledTask(
          'plugin_resource_migration',
          new PluginResourceMigrationReconciler(
            this.env.CONTROL_DB,
            this.env.MIGRATION_RELEASES,
            apiClients.d1,
            () => Math.floor(Date.now() / 1000)
          ).reconcile()
        ),
        scheduledTask(
          'plugin_resource_cleanup',
          new PluginResourceCleanupService(
            this.env.CONTROL_DB,
            apiClients,
            () => Math.floor(Date.now() / 1000),
            this.env.CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED === 'true'
          ).reconcile()
        ),
        scheduledTask(
          'shard_cleanup',
          ShardCleanupService.fromEnv(
            this.env,
            new D1ShardCleanupRepository(this.env.CONTROL_DB),
            apiClients.d1,
            apiClients.workers,
            () => Math.floor(Date.now() / 1000)
          ).reconcile()
        )
      );
    } else {
      tasks.push(
        scheduledTask(
          'plugin_resource_operator_handoff',
          handoffPluginResourceOperationsToSetup(this.env.CONTROL_DB, Math.floor(Date.now() / 1000))
        ),
        scheduledTask(
          'tenant_disaster_recovery_binding_handoff',
          new TenantDisasterRecoveryService(this.env.CONTROL_DB).handoffBindingSmokeToSetup()
        )
      );
    }
    if (this.env.TENANT_RUNTIME_REGISTRY) {
      tasks.push(
        scheduledTask(
          'lookup_registry_publication',
          new LookupRegistryPublisher(this.env, () => Math.floor(Date.now() / 1000)).reconcile()
        ),
        scheduledTask(
          'lookup_hmac_key_state_publication',
          new LookupHmacKeyStatePublisher(this.env, () => Math.floor(Date.now() / 1000)).reconcile()
        ),
        scheduledTask(
          'plugin_runner_registry_publication',
          new PluginRunnerRegistryPublisher(this.env, () =>
            Math.floor(Date.now() / 1000)
          ).reconcile()
        )
      );
    }
    const results = await Promise.allSettled(tasks);
    const failures = results.flatMap((result) => {
      if (result.status !== 'rejected') return [];
      const message = result.reason instanceof Error ? result.reason.message : '';
      return /^control_scheduled_[a-z0-9_]+_failed$/u.test(message)
        ? [message]
        : ['control_scheduled_task_failed'];
    });
    if (failures.length > 0) {
      throw new Error(
        `control_scheduled_reconciliation_failed:${[...new Set(failures)].sort().join(',')}`
      );
    }
  }
}

export { ControlService } from './service';
export { D1ControlRepository } from './repository';
export { GuardedWorkerControlClient } from './worker-mutation-guard';
export { WorkerInventoryReconciler } from './worker-inventory-reconciler';
export { WorkerBindingReconciler } from './worker-binding-reconciler';
export { D1WorkerBindingRepository } from './worker-binding-repository';
export { D1ShardCleanupRepository } from './shard-cleanup-repository';
export { ShardCleanupService } from './shard-cleanup';
export { ApiMigrationEngine } from './migration-engine';
export { PluginResourceReconciler } from './plugin-resource-reconciler';
export { PluginResourceMigrationReconciler } from './plugin-resource-migration-reconciler';
export { PluginResourceBindingReconciler } from './plugin-resource-binding-reconciler';
export { PluginResourceCleanupService } from './plugin-resource-cleanup';
export { handoffPluginResourceOperationsToSetup } from './plugin-resource-operator-handoff';
export { createControlApiClients } from './control-api-clients';
export { splitMigrationSql } from './migration-sql';
export { MigrationReleaseArtifactReader, R2ReleaseArtifactStore } from './release-artifact';
export {
  ControlAccountAllocationService,
  D1AccountAllocationRepository,
} from './account-allocation';
export { LookupRegistryPublisher } from './lookup-registry-publisher';
export { LookupHmacKeyStatePublisher } from './lookup-hmac-key-state-publisher';
export { LookupHmacKeyStateService } from './lookup-hmac-key-state';
export { PluginRunnerRegistryPublisher } from './plugin-runner-registry-publisher';
export { PluginDynamicWorkerDesiredStateService } from './plugin-dynamic-worker-desired-state';
export { LookupBucketMigrationService } from './lookup-bucket-migration';
export { ReadReplicationService } from './read-replication';
export {
  D1SigningKeyVerificationRepository,
  SigningKeyCandidateVerifier,
  SIGNING_KEY_VERIFICATION_TARGETS,
} from './signing-key-candidate-verifier';
export {
  D1LookupHmacCandidateVerificationRepository,
  LookupHmacCandidateVerifier,
  LOOKUP_HMAC_VERIFICATION_BINDINGS,
  LOOKUP_HMAC_VERIFICATION_COMPONENTS,
} from './lookup-hmac-candidate-verifier';
export { BootstrapHandoffVerifier, D1BootstrapHandoffRepository } from './bootstrap-handoff';
export type * from './types';
