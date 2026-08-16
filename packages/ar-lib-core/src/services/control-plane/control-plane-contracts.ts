export type ControlOperationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'succeeded'
  | 'blocked'
  | 'canceled';

export type ControlReleaseRolloutPhase =
  | 'idle'
  | 'database_rollout'
  | 'blocked'
  | 'awaiting_setup'
  | 'verifying'
  | 'completed';

export interface ControlReleaseRolloutStatus {
  operationId: string | null;
  sourceVersion: string | null;
  targetVersion: string | null;
  phase: ControlReleaseRolloutPhase;
  completedTargets: number;
  totalTargets: number;
  adminMutationMode: 'available' | 'read_only';
  lastErrorCode: string | null;
  updatedAt: number | null;
  blockedTargetCount: number;
  blockedTargets: ControlReleaseRolloutBlockedTarget[];
}

export interface ControlReleaseRolloutBlockedTarget {
  targetId: string;
  streamId: 'd1-core' | 'd1-pii' | 'd1-lookup';
  attemptCount: number;
  lastErrorCode: string;
  updatedAt: number;
}

export interface ControlReleaseRolloutRetryTargetRequest {
  operationId: string;
  targetId: string;
  requestedById: string;
  reasonCode: 'operator_retry_release_target';
  idempotencyKey: string;
}

export type LookupLifecycleState = 'pending' | 'active' | 'disabled';
export type AccountDirectoryPublicationState =
  | 'pending'
  | 'active_pending_directory'
  | 'active'
  | 'disabled';
export type D1ConsistencyClass = 'replica_eligible' | 'primary_required' | 'read_after_write';

export interface D1ConsistencyRequest {
  consistencyClass: D1ConsistencyClass;
  bookmark: string | null;
}

export interface DirectoryRewriteLeaseState {
  operationId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  mutationStarted: boolean;
}

export interface ControlWorkerInventoryDriftNotification {
  findingId: string;
  environmentId: string;
  workerScriptName: string;
  findingKind: 'actual_only';
  severity: 'warning';
  firstObservedAt: number;
  lastObservedAt: number;
}

export type ControlWorkerInventoryDriftReviewState =
  | 'unreviewed'
  | 'reviewed'
  | 'dismissed'
  | 'resolved';

export interface ControlWorkerInventoryDriftFinding extends ControlWorkerInventoryDriftNotification {
  reviewState: ControlWorkerInventoryDriftReviewState;
  notificationState: 'pending' | 'acknowledged' | 'resolved';
  resolvedAt: number | null;
  notifiedAt: number | null;
}

export interface ControlWorkerInventoryDriftReviewRequest {
  findingId: string;
  disposition: 'reviewed' | 'dismissed';
  reviewedBy: string;
  idempotencyKey: string;
}

export interface ControlCapacityProfileRequest {
  profile: 'minimum' | 'recommended' | 'extra_headroom';
  scope: 'shared_pool' | 'tenant_exclusive';
  tenantId: string | null;
}

export interface ControlCapacityProvisioningTargetPreview {
  unitKey: string;
  unitIndex: number;
  workerScripts: readonly string[];
  operationId: string;
  environmentId: string;
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii' | 'lookup';
  residencyPolicyId: string;
  residencyPartition: string;
  logicalShardId: string;
  databaseName: string;
  bindingRef: string;
  readReplicationMode: 'enabled' | 'disabled';
  migrationStreamId: 'd1-core' | 'd1-pii' | 'd1-lookup';
}

export interface ControlCapacityProvisioningPreview extends ControlCapacityProfileRequest {
  dryRun: true;
  available: boolean;
  reasonCode: 'capacity_profile_unavailable' | 'environment_d1_limit' | null;
  capacityUnitsAdded: number;
  d1DatabasesAdded: number;
  projectedEnvironmentD1Count: number;
  targets: readonly ControlCapacityProvisioningTargetPreview[];
}

export interface ControlCapacityProvisioningRequest extends ControlCapacityProfileRequest {
  requestedById: string;
  idempotencyKey: string;
}

export interface ControlCapacityProvisioningResult {
  preview: ControlCapacityProvisioningPreview;
  operations: readonly ControlProvisioningOperationSummary[];
}

export interface ControlProvisioningAuthorityStatus {
  automaticProvisioningEnabled: boolean;
  tokenOwnership: 'none' | 'user' | 'account';
  capabilityState: 'disabled' | 'pending' | 'ready' | 'blocked';
  automaticExecutionAvailable: boolean;
  activeExecutor: 'control' | 'setup_operator';
}

export type ControlTenantShardDataRole = 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
export type ControlTenantIsolationPolicy = 'shared_pool' | 'tenant_exclusive';
export type ControlTenantShardAllocationScope = 'shared_pool' | 'tenant_exclusive';

export interface ControlTenantPlacementPolicy {
  tenantId: string;
  isolationPolicy: ControlTenantIsolationPolicy;
  policyGeneration: number;
  state: 'provisioning' | 'active' | 'migrating' | 'retired';
  pendingIsolationPolicy: 'tenant_exclusive' | null;
  pendingPolicyGeneration: number | null;
  migrationOperationId: string | null;
  sourceOperationId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ControlTenantPlacementPolicyRegistrationRequest {
  tenantId: string;
  isolationPolicy: ControlTenantIsolationPolicy;
  sourceOperationId: string;
  idempotencyKey: string;
}

export interface ControlTenantPlacementPolicyActivationRequest {
  tenantId: string;
  sourceOperationId: string;
  idempotencyKey: string;
  runtimeRoute: ControlTenantRuntimeRouteObservation;
}

export interface ControlTenantRuntimeRouteObservationTarget {
  dataRole: ControlTenantShardDataRole;
  shardId: string;
  bindingRef: string;
  generation: number;
}

export interface ControlTenantRuntimeRouteObservation {
  runtimeGeneration: number;
  registryPublicationGeneration: number;
  tenantLifecycleState: 'active';
  routeStatus: 'active';
  targets: readonly ControlTenantRuntimeRouteObservationTarget[];
}

export type ControlRegionShardRegion =
  | 'apac'
  | 'weur'
  | 'eeur'
  | 'enam'
  | 'wnam'
  | 'oc'
  | 'afr'
  | 'me';

export type ControlRegionShardJurisdiction = 'eu' | 'fedramp' | null;

export type ControlRegionShardLocationHint =
  | 'wnam'
  | 'enam'
  | 'weur'
  | 'eeur'
  | 'apac'
  | 'oc'
  | null;

const GLOBAL_CONTROL_REGION_SHARD_REGIONS: readonly ControlRegionShardRegion[] = [
  'apac',
  'weur',
  'eeur',
  'enam',
  'wnam',
  'oc',
  'afr',
  'me',
];

export function deriveControlRegionShardAllowedRegions(input: {
  jurisdiction: ControlRegionShardJurisdiction;
  locationHint: ControlRegionShardLocationHint;
}): ControlRegionShardRegion[] {
  if (input.jurisdiction !== null && input.locationHint !== null) {
    throw new Error('control_tenant_region_shard_placement_ambiguous');
  }
  if (input.locationHint) return [input.locationHint];
  if (input.jurisdiction === 'eu') return ['weur', 'eeur'];
  if (input.jurisdiction === 'fedramp') return ['enam', 'wnam'];
  if (input.jurisdiction !== null) {
    throw new Error('control_tenant_region_shard_jurisdiction_invalid');
  }
  return [...GLOBAL_CONTROL_REGION_SHARD_REGIONS];
}

export interface ControlTenantRegionShardPolicy {
  tenantId: string;
  residencyPolicyId: string;
  residencyPartition: string;
  policyGeneration: number;
  allowedRegions: ControlRegionShardRegion[];
  jurisdiction: ControlRegionShardJurisdiction;
  locationHint: ControlRegionShardLocationHint;
}

export type ControlTenantPlacementMigrationState =
  | 'planning'
  | 'targets_provisioning'
  | 'inventory_verifying'
  | 'capture_installing'
  | 'backfilling'
  | 'catching_up'
  | 'verifying'
  | 'write_fencing'
  | 'cutover_ready'
  | 'cutover_committed'
  | 'source_quarantined'
  | 'purge_pending'
  | 'complete'
  | 'canceled'
  | 'blocked';

export interface ControlTenantPlacementMigrationStartRequest {
  tenantId: string;
  targetIsolationPolicy: 'tenant_exclusive';
  idempotencyKey: string;
  requestedById: string;
}

export interface ControlTenantPlacementMigrationMutationRequest {
  operationId: string;
  requestedById: string;
  idempotencyKey: string;
}

export interface ControlTenantPlacementMigrationShardView {
  dataRole: ControlTenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  sourceShardId: string;
  sourceAssignmentGeneration: number;
  targetShardId: string | null;
  target: {
    shardId: string;
    assignmentGeneration: number;
    routeGeneration: number;
    bindingRef: string;
    databaseId: string | null;
    databaseName: string;
  } | null;
  state:
    | 'target_pending'
    | 'inventory_pending'
    | 'capture_pending'
    | 'backfilling'
    | 'catching_up'
    | 'verifying'
    | 'verified'
    | 'write_fenced'
    | 'cutover_committed'
    | 'quarantined'
    | 'purged'
    | 'blocked';
  inventoryTableCount: number | null;
  sourceRowCount: number | null;
  targetRowCount: number | null;
  lastObservedSourceSequence: number;
  lastAppliedSourceSequence: number;
  lastErrorCode: string | null;
  updatedAt: number;
}

export interface ControlTenantPlacementMigrationView {
  operationId: string;
  tenantId: string;
  state: ControlTenantPlacementMigrationState;
  sourceIsolationPolicy: 'shared_pool';
  targetIsolationPolicy: 'tenant_exclusive';
  sourcePolicyGeneration: number;
  targetPolicyGeneration: number;
  writeFenceState: 'inactive' | 'requested' | 'active' | 'released';
  routeCutoverStarted: boolean;
  canCancel: boolean;
  canApprovePurge: boolean;
  sourceRetentionExpiresAt: number | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  shards: ControlTenantPlacementMigrationShardView[];
}

export interface ControlTenantShardCapacityRequest {
  tenantId: string;
  dataRole: ControlTenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
}

export interface ControlTenantShardCapacityTarget {
  shardId: string;
  dataRole: ControlTenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  routeGeneration: number;
  bindingRef: string;
  databaseId: string;
  databaseName: string;
  allocationScope: ControlTenantShardAllocationScope;
  ownerTenantId: string | null;
  assignmentGeneration: number;
}

export interface ControlTenantDeletionLookupShardTarget {
  lookupShardId: string;
  bindingRef: string;
  status: 'ready' | 'active' | 'draining';
}

export interface ControlTenantDeletionShardTarget {
  shardId: string;
  dataRole: ControlTenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  bindingRef: string;
  status: 'ready' | 'active' | 'degraded';
  allocationScope: ControlTenantShardAllocationScope;
  ownerTenantId: string | null;
}

export interface ControlTenantDeletionInventory {
  environmentId: string;
  tenantId: string;
  operationId: string;
  state: 'ready' | 'finalized';
  lookupShards: ControlTenantDeletionLookupShardTarget[];
  tenantShards: ControlTenantDeletionShardTarget[];
}

export interface ControlTenantDeletionRequest {
  tenantId: string;
  operationId: string;
}

export interface ControlTenantDeletionFinalization {
  environmentId: string;
  tenantId: string;
  operationId: string;
  state: 'finalized';
  finalizedAt: number;
}

export interface ControlProvisioningOperationSummary {
  operationId: string;
  status: ControlOperationStatus;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ControlProvisioningOperationStepSummary {
  stepKey: string;
  displayOrder: number;
  status:
    | 'queued'
    | 'running'
    | 'waiting_retry'
    | 'succeeded'
    | 'blocked'
    | 'canceled'
    | 'skipped'
    | 'rolled_back';
  attemptCount: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  observedResourceId: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface ControlProvisioningOperationDetail extends ControlProvisioningOperationSummary {
  operationKind: string;
  availableActions: ControlProvisioningOperationAction[];
  steps: ControlProvisioningOperationStepSummary[];
}

export type ControlProvisioningOperationAction =
  | 'retry_create_d1'
  | 'retry_apply_migrations'
  | 'retry_reconcile_worker_bindings'
  | 'restore_previous_settings'
  | 'cancel';

export interface ControlProvisioningOperationRetryRequest {
  operationId: string;
  stepKey: 'create_d1' | 'apply_migrations' | 'reconcile_worker_bindings';
  requestedById: string;
  reasonCode: 'operator_retry';
  idempotencyKey: string;
}

export interface ControlProvisioningOperationCancelRequest {
  operationId: string;
  requestedById: string;
  reasonCode: 'operator_cancel';
  idempotencyKey: string;
}

export interface ControlProvisioningOperationRestoreRequest {
  operationId: string;
  requestedById: string;
  reasonCode: 'operator_restore_previous_settings';
  idempotencyKey: string;
}

export type ControlTenantDisasterRecoveryState =
  | 'publishing_deny'
  | 'draining'
  | 'operator_restore_required'
  | 'verifying_restore'
  | 'reprojecting_lookup'
  | 'smoke_verifying'
  | 'ready_for_reactivation'
  | 'reactivating'
  | 'succeeded'
  | 'blocked'
  | 'canceled';

export interface ControlTenantDisasterRecoveryTarget {
  shardId: string;
  dataRole: ControlTenantShardDataRole;
  residencyPartition: string;
  assignmentGeneration: number;
  shardGeneration: number;
  bindingRef: string;
  providerDatabaseId: string;
  migrationStreamId: 'd1-core' | 'd1-pii';
  releaseId: string;
  manifestDigest: string;
  restoreConfirmedAt: number | null;
  migrationVerifiedAt: number | null;
  lookupReprojectedAt: number | null;
  bindingSmokeVerifiedAt: number | null;
}

export type ControlTenantDisasterRecoveryLookupStage =
  | 'cleanup'
  | 'account_id'
  | 'email_exact'
  | 'external_core'
  | 'external_pii'
  | 'verify';

export interface ControlTenantDisasterRecoveryLookupProgress {
  stage: ControlTenantDisasterRecoveryLookupStage;
  targetIndex: number;
  afterCreatedAt: number;
  afterId: string;
  afterRowId: number;
  projectedRows: number;
  verifiedRows: number;
  registryDigestPinned: boolean;
  leaseActive: boolean;
}

export interface ControlTenantDisasterRecoveryView {
  operationId: string;
  environmentId: string;
  tenantId: string;
  state: ControlTenantDisasterRecoveryState;
  pinnedRouteGeneration: number;
  denyRuntimeGeneration: number | null;
  denyRegistryGeneration: number | null;
  denyObservedAt: number | null;
  drainNotBefore: number | null;
  restoreReferenceRecorded: boolean;
  restoredAt: number | null;
  migrationVerifiedAt: number | null;
  lookupReprojectedAt: number | null;
  lookupReprojection: ControlTenantDisasterRecoveryLookupProgress;
  bindingSmokeVerifiedAt: number | null;
  reactivatedRuntimeGeneration: number | null;
  reactivatedAt: number | null;
  lastErrorCode: string | null;
  canCancel: boolean;
  canConfirmRestore: boolean;
  canVerify: boolean;
  canReactivate: boolean;
  targets: ControlTenantDisasterRecoveryTarget[];
  createdAt: number;
  updatedAt: number;
}

export interface ControlTenantDisasterRecoveryStartRequest {
  tenantId: string;
  requestedById: string;
  reasonCode: 'operator_disaster_recovery';
  idempotencyKey: string;
}

export interface ControlTenantDisasterRecoveryDenyObservationRequest {
  operationId: string;
  runtimeGeneration: number;
  denyRegistryGeneration: number;
}

export interface ControlTenantDisasterRecoveryRestoreConfirmationRequest {
  operationId: string;
  restoreReferenceDigest: string;
  restoredAt: number;
  requestedById: string;
  idempotencyKey: string;
}

export interface ControlTenantDisasterRecoveryVerificationRequest {
  operationId: string;
  stage: 'migration' | 'lookup_reprojection' | 'binding_smoke';
  pinnedRouteGeneration: number;
  targets: Array<{
    shardId: string;
    providerDatabaseId: string;
    shardGeneration: number;
    bindingRef: string;
    releaseId: string;
    manifestDigest: string;
  }>;
}

export interface ControlTenantDisasterRecoveryLookupClaimRequest {
  operationId: string;
  ownerId: string;
  registryDigest: string;
  lookupShardCount: number;
}

export type ControlTenantDisasterRecoveryLookupClaimNextRequest = Omit<
  ControlTenantDisasterRecoveryLookupClaimRequest,
  'operationId'
>;

export interface ControlTenantDisasterRecoveryLookupCheckpointRequest {
  operationId: string;
  ownerId: string;
  fencingToken: number;
  registryDigest: string;
  lookupShardCount: number;
  stage: ControlTenantDisasterRecoveryLookupStage;
  nextStage: ControlTenantDisasterRecoveryLookupStage;
  targetIndex: number;
  afterCreatedAt: number;
  afterId: string;
  afterRowId: number;
  projectedRowsDelta: number;
  verifiedRowsDelta: number;
}

export interface ControlTenantDisasterRecoveryLookupWork {
  operationId: string;
  environmentId: string;
  tenantId: string;
  pinnedRouteGeneration: number;
  registryDigest: string;
  lookupShardCount: number;
  ownerId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  progress: Omit<ControlTenantDisasterRecoveryLookupProgress, 'leaseActive'>;
  targets: ControlTenantDisasterRecoveryTarget[];
}

export interface ControlTenantDisasterRecoveryLookupCompleteRequest {
  operationId: string;
  ownerId: string;
  fencingToken: number;
  registryDigest: string;
}

export interface ControlTenantDisasterRecoveryReactivationRequest {
  operationId: string;
  requestedById: string;
  reasonCode: 'operator_reactivate_recovered_tenant';
  idempotencyKey: string;
}

export interface ControlTenantDisasterRecoveryReactivationObservationRequest {
  operationId: string;
  runtimeGeneration: number;
  pinnedRouteGeneration: number;
}

export interface ControlTenantDisasterRecoveryCancelRequest {
  operationId: string;
  requestedById: string;
  reasonCode: 'operator_cancel_before_deny';
  idempotencyKey: string;
}

export type ControlShardQuarantineState = 'draining' | 'ready_for_cleanup' | 'blocked' | 'canceled';

export type ControlShardCleanupState =
  | 'approved'
  | 'removing_bindings'
  | 'deleting_database'
  | 'verifying_absence'
  | 'succeeded'
  | 'blocked';

export interface ControlShardCleanupBindingView {
  workerScriptName: string;
  bindingRef: string;
  state: 'pending' | 'removing' | 'removed' | 'blocked';
  lastErrorCode: string | null;
  updatedAt: number;
}

export interface ControlShardCleanupView {
  environmentId: string;
  shardId: string;
  dataRole: ControlTenantShardDataRole;
  residencyPartition: string;
  bindingRef: string;
  databaseId: string;
  databaseName: string;
  shardStatus: 'failed' | 'retired' | 'deleting' | 'deleted';
  quarantineOperationId: string | null;
  quarantineState: 'none' | 'quarantining' | 'quarantined';
  quarantineOperationState: ControlShardQuarantineState | null;
  denyRegistryGeneration: number | null;
  drainNotBefore: number | null;
  registryVerifiedAt: number | null;
  referencesVerifiedAt: number | null;
  cleanupOperationId: string | null;
  cleanupState: ControlShardCleanupState | null;
  exportMode: 'skipped' | 'manual_verified' | null;
  deleteDatabase: boolean | null;
  destructiveOperationsEnabled: boolean;
  availableActions: Array<'quarantine' | 'retry_quarantine' | 'approve_cleanup' | 'retry_cleanup'>;
  bindings: ControlShardCleanupBindingView[];
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ControlShardQuarantineRequest {
  shardId: string;
  requestedById: string;
  reasonCode: 'operator_quarantine';
  idempotencyKey: string;
}

export interface ControlShardCleanupApprovalRequest {
  quarantineOperationId: string;
  requestedById: string;
  reasonCode: 'operator_approve_cleanup';
  idempotencyKey: string;
  confirmation: 'DELETE_RETIRED_TENANT_SHARD';
  exportMode: 'skipped' | 'manual_verified';
  exportEvidenceId: string | null;
  deleteDatabase: boolean;
}

export interface ControlShardQuarantineRetryRequest {
  quarantineOperationId: string;
  requestedById: string;
  reasonCode: 'operator_retry_quarantine';
  idempotencyKey: string;
}

export interface ControlShardCleanupRetryRequest {
  cleanupOperationId: string;
  requestedById: string;
  reasonCode: 'operator_retry_cleanup';
  idempotencyKey: string;
}

export type ControlTenantShardCapacityResult =
  | {
      state: 'ready';
      target: ControlTenantShardCapacityTarget;
      operation: ControlProvisioningOperationSummary | null;
    }
  | {
      state: 'provisioning';
      target: null;
      operation: ControlProvisioningOperationSummary;
    }
  | {
      state: 'blocked';
      target: null;
      operation: ControlProvisioningOperationSummary | null;
      reasonCode: string;
    };

export interface ControlTenantDefaultRouteReservationRequest {
  tenantId: string;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
}

export interface ControlTenantDefaultRouteMutationRequest {
  allocationId: string;
}

export interface ControlTenantDefaultRouteAllocation {
  allocationId: string;
  tenantId: string;
  state: 'reserved' | 'committed' | 'released';
  target: ControlTenantShardCapacityTarget & { dataRole: 'tenant_core/default' };
}

export type ControlAccountDataRole = 'tenant_core/users' | 'tenant_pii';

export interface ControlAccountRouteAllocationRequest {
  tenantId: string;
  accountIdBlindDigest: string;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
  dataRoles: ControlAccountDataRole[];
}

export interface ControlAccountRouteAllocationTarget {
  allocationId: string;
  dataRole: ControlAccountDataRole;
  residencyPartition: string;
  shardId: string;
  bindingRef: string;
  routeGeneration: number;
}

export interface ControlAccountRouteAllocationResult {
  tenantId: string;
  residencyPolicyId: string;
  targets: ControlAccountRouteAllocationTarget[];
}

export interface ControlAccountDirectorySourceShard {
  shardId: string;
  bindingRef: string;
  residencyPartition: string;
  routeGeneration: number;
}

export interface ControlAccountRouteSourceShard extends ControlAccountDirectorySourceShard {
  dataRole: ControlAccountDataRole;
}

export type ControlLookupBucketMigrationState =
  | 'dual_write'
  | 'backfilling'
  | 'verifying'
  | 'cutover_pending'
  | 'grace'
  | 'complete'
  | 'blocked';

export interface ControlLookupBucketRouteTarget {
  lookupShardId: string;
  bindingRef: string;
  assignmentGeneration: number;
}

export interface ControlLookupBucketWriteRoute {
  virtualBucket: number;
  primary: ControlLookupBucketRouteTarget;
  mirrors: ControlLookupBucketRouteTarget[];
  migration: {
    operationId: string;
    state: ControlLookupBucketMigrationState;
  } | null;
}

export interface ControlLookupBucketMigrationView {
  operationId: string;
  virtualBucket: number;
  source: ControlLookupBucketRouteTarget;
  target: ControlLookupBucketRouteTarget;
  state: ControlLookupBucketMigrationState;
  fencingToken: number;
  leaseExpiresAt: number;
  backfillCursor: string;
  sourceRowCount: number | null;
  targetRowCount: number | null;
  verificationDigest: string | null;
  verificationAttemptCount: number;
  graceExpiresAt: number | null;
}

export interface ControlLookupBucketMigrationStartRequest {
  virtualBucket: number;
  targetLookupShardId: string;
  idempotencyKey: string;
  ownerId: string;
}

export interface ControlLookupBucketMigrationClaimRequest {
  operationId: string;
  ownerId: string;
}

export interface ControlLookupBucketMigrationCheckpointRequest {
  operationId: string;
  ownerId: string;
  fencingToken: number;
  expectedState: ControlLookupBucketMigrationState;
  nextState: 'backfilling' | 'verifying' | 'cutover_pending';
  backfillCursor: string;
  sourceRowCount: number | null;
  targetRowCount: number | null;
  verificationDigest: string | null;
}

export interface ControlLookupBucketMigrationCutoverRequest {
  operationId: string;
  ownerId: string;
  fencingToken: number;
}

export interface ControlLookupBucketMigrationCompleteRequest extends ControlLookupBucketMigrationCutoverRequest {
  oldRowsQuarantined: true;
}

export interface ControlLookupBucketMigrationBlockRequest extends ControlLookupBucketMigrationCutoverRequest {
  errorCode: string;
}

export interface ControlLookupBucketLoadObservation {
  virtualBucket: number;
  lookupShardId: string;
  assignmentGeneration: number;
  activeIdentifierCount: number;
  counterUpdatedAt: number;
}

export interface ControlLookupBucketLoadSnapshotRequest {
  ownerId: string;
  observedAt: number;
  buckets: ControlLookupBucketLoadObservation[];
}

export interface ControlLookupHmacKeyMetadata {
  generation: number;
  keyId: string;
  slot: 'A' | 'B';
  fingerprint: string;
}

export interface ControlLookupHmacKeyStateView {
  stateRevision: number;
  rotationState:
    | 'stable'
    | 'activation_dual_write'
    | 'dual_read'
    | 'reindexing'
    | 'verifying'
    | 'grace'
    | 'blocked';
  writeMode: 'current_only' | 'dual_write';
  current: ControlLookupHmacKeyMetadata;
  previous: ControlLookupHmacKeyMetadata | null;
  operationId: string | null;
  updatedAt: number;
}

export interface ControlLookupHmacKeyStateInitializeRequest {
  current: ControlLookupHmacKeyMetadata;
}

export type ControlLookupHmacRotationState =
  | 'planned'
  | 'distributing'
  | 'activation_dual_write'
  | 'dual_read'
  | 'reindexing'
  | 'verifying'
  | 'grace'
  | 'complete'
  | 'blocked';

export interface ControlLookupHmacRotationView {
  operationId: string;
  state: ControlLookupHmacRotationState;
  source: ControlLookupHmacKeyMetadata;
  candidate: ControlLookupHmacKeyMetadata;
  checkpoint: Record<string, unknown>;
  sourceRowCount: number | null;
  currentRowCount: number | null;
  verificationAttemptCount: number;
  graceExpiresAt: number | null;
  ownerId: string | null;
  fencingToken: number;
  leaseExpiresAt: number | null;
  mutationStarted: boolean;
  updatedAt: number;
}

export interface ControlLookupHmacRotationStartRequest {
  candidate: ControlLookupHmacKeyMetadata;
  idempotencyKey: string;
  ownerId: string;
}

export interface ControlLookupHmacRotationMutationRequest {
  operationId: string;
  ownerId: string;
  fencingToken: number;
}

export interface ControlLookupHmacVerificationStatus {
  phase: 'distribution' | 'generation';
  expected: number;
  succeeded: number;
  failed: number;
  pending: string[];
  complete: boolean;
}

export interface ControlLookupHmacRotationCheckpointRequest extends ControlLookupHmacRotationMutationRequest {
  checkpoint: Record<string, unknown>;
  sourceRowCount: number;
}

export type ControlLookupHmacRotationSourceKind = 'account_id' | 'email_exact' | 'external_subject';

export interface ControlLookupHmacRotationSourceShardView {
  operationId: string;
  sourceKind: ControlLookupHmacRotationSourceKind;
  dataRole: 'tenant_core/users' | 'tenant_pii';
  shardId: string;
  bindingRef: string;
  routeGeneration: number;
  cutoffAt: number;
  state: 'pending' | 'processing' | 'complete' | 'blocked';
  cursor: Record<string, unknown>;
  sourceRowCount: number;
  completedAt: number | null;
  updatedAt: number;
}

export interface ControlLookupHmacRotationSourceCheckpointRequest extends ControlLookupHmacRotationMutationRequest {
  sourceKind: ControlLookupHmacRotationSourceKind;
  shardId: string;
  cursor: Record<string, unknown>;
  sourceRowCount: number;
  complete: boolean;
}

export interface ControlLookupHmacRotationVerificationShardView {
  operationId: string;
  lookupShardId: string;
  bindingRef: string;
  state: 'pending' | 'processing' | 'complete' | 'blocked';
  cursor: Record<string, unknown>;
  currentRowCount: number;
  currentRowsValid: boolean;
  reservationsValid: boolean;
  routeReferencesValid: boolean;
  completedAt: number | null;
  updatedAt: number;
}

export interface ControlLookupHmacRotationVerificationShardCheckpointRequest extends ControlLookupHmacRotationMutationRequest {
  lookupShardId: string;
  cursor: Record<string, unknown>;
  currentRowCount: number;
  result: {
    currentRowsValid: boolean;
    reservationsValid: boolean;
    routeReferencesValid: boolean;
  };
  complete: boolean;
}

export interface ControlLookupHmacRotationVerificationRequest extends ControlLookupHmacRotationMutationRequest {
  currentRowCount: number;
  result: {
    sourceShardsComplete: boolean;
    currentRowsValid: boolean;
    reservationsValid: boolean;
    routeReferencesValid: boolean;
  };
}

export type ControlReadReplicationDesiredMode = 'disabled' | 'enabled';
export type ControlReadReplicationAggregateStatus =
  | 'off'
  | 'on'
  | 'updating'
  | 'attention_required';

export interface ControlReadReplicationStatusView {
  environmentId: string;
  desiredMode: ControlReadReplicationDesiredMode;
  aggregateStatus: ControlReadReplicationAggregateStatus;
  operationId: string | null;
  operationStatus:
    | 'queued'
    | 'applying'
    | 'verifying'
    | 'attention_required'
    | 'succeeded'
    | 'blocked'
    | null;
  eligiblePolicyCount: number;
  convergedPolicyCount: number;
  failedPolicyCount: number;
  targetCount: number;
  convergedTargetCount: number;
  pendingTargetCount: number;
  failedTargetCount: number;
  updatedAt: number;
}

export interface ControlReadReplicationStartRequest {
  desiredMode: ControlReadReplicationDesiredMode;
  idempotencyKey: string;
  requestedById: string;
}

export interface ControlRuntimeRegistrySignerMetadata {
  keyId: string;
  algorithm: 'EdDSA';
  type: 'authrim-runtime-registry+jws';
}

export interface ControlRuntimeRegistrySignature extends ControlRuntimeRegistrySignerMetadata {
  compactJws: string;
}

export interface ControlPluginDynamicWorkerDesiredStateRequest {
  tenantId: string;
  pluginId: string;
  enabled: boolean;
  resourceSelections?: readonly ControlPluginResourceSelection[];
}

export type ControlPluginResourceKind = 'd1' | 'kv_namespace' | 'r2_bucket';

export interface ControlPluginResourceSelection {
  logicalResourceId: string;
  mode: 'existing';
  providerResourceId: string;
  providerName: string;
}

export interface ControlPluginResourceView {
  schemaVersion: 1;
  logicalResourceId: string;
  binding: string;
  kind: ControlPluginResourceKind;
  scope: 'tenant';
  access: 'read_only' | 'read_write';
  lifecycleMode: 'managed' | 'existing';
  allowExisting: boolean;
  migrationStream: string | null;
  providerResourceId: string | null;
  providerName: string | null;
}

export interface ControlPluginDynamicWorkerBindingView {
  name: string;
  interface: import('../plugin-host-interface-contract.js').PluginHostInterfaceId;
  scope: 'tenant';
}

export interface ControlPluginDynamicWorkerDesiredStatePlan {
  environmentId: string;
  tenantId: string;
  pluginId: string;
  installationId: string;
  capabilityManifestDigest: string;
  enabled: boolean;
  bindings: readonly ControlPluginDynamicWorkerBindingView[];
  resources: readonly ControlPluginResourceView[];
}

export type ControlPluginResourceReadiness = 'not_required' | 'pending' | 'ready' | 'blocked';

export interface ControlPluginDynamicWorkerResourcePreparation extends ControlPluginDynamicWorkerDesiredStatePlan {
  operationId: string | null;
  readiness: ControlPluginResourceReadiness;
}

export interface ControlPluginDynamicWorkerObservedStateRequest {
  installationId: string;
  tenantId: string;
  pluginId: string;
  state: 'enabled' | 'disabled';
  configVersion: number;
  pinnedVersionDigest: string | null;
  resourceSelections: readonly ControlPluginResourceSelection[];
}

export interface ControlPluginDynamicWorkerStateView extends ControlPluginDynamicWorkerDesiredStatePlan {
  operationId: string;
  state: 'enabled' | 'disabled';
  configVersion: number;
  pinnedVersionDigest: string | null;
  bindingStatus: 'active' | 'deleted';
}

export interface ControlPluginResourceCleanupRequest {
  tenantId: string;
  pluginId: string;
  reason: 'uninstall' | 'canceled_pre_activation';
  sourceOperationId?: string;
  requestedById: string;
  idempotencyKey: string;
}

export interface ControlPluginResourceCleanupView {
  operationId: string;
  environmentId: string;
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
    | 'succeeded'
    | 'blocked';
  drainNotBefore: number | null;
  managedResourceCount: number;
  detachedResourceCount: number;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ControlServiceBinding {
  getReleaseMigrationRolloutStatus?(): Promise<ControlReleaseRolloutStatus>;
  retryReleaseMigrationRolloutTarget?(
    request: ControlReleaseRolloutRetryTargetRequest
  ): Promise<ControlReleaseRolloutStatus>;
  getProvisioningAuthorityStatus?(): Promise<ControlProvisioningAuthorityStatus>;
  previewCapacityProvisioning(
    request: ControlCapacityProfileRequest
  ): Promise<ControlCapacityProvisioningPreview>;
  requestCapacityProvisioning?(
    request: ControlCapacityProvisioningRequest
  ): Promise<ControlCapacityProvisioningResult>;
  ensureTenantShardCapacity?(
    request: ControlTenantShardCapacityRequest
  ): Promise<ControlTenantShardCapacityResult>;
  getTenantRuntimeRouteTargets?(input: {
    tenantId: string;
    residencyPolicyId: string;
    residencyPartition: string;
  }): Promise<ControlTenantShardCapacityTarget[]>;
  getTenantProvisioningRouteTargets?(input: {
    tenantId: string;
    residencyPolicyId: string;
    residencyPartition: string;
  }): Promise<ControlTenantShardCapacityTarget[]>;
  getTenantRegionShardPolicy?(input: { tenantId: string }): Promise<ControlTenantRegionShardPolicy>;
  getTenantProvisioningRegionShardPolicy?(input: {
    tenantId: string;
    residencyPolicyId: string;
    residencyPartition: string;
  }): Promise<ControlTenantRegionShardPolicy>;
  validatePluginDynamicWorkerDesiredState?(
    request: ControlPluginDynamicWorkerDesiredStateRequest
  ): Promise<ControlPluginDynamicWorkerDesiredStatePlan>;
  preparePluginDynamicWorkerResources?(
    request: ControlPluginDynamicWorkerDesiredStateRequest
  ): Promise<ControlPluginDynamicWorkerResourcePreparation>;
  getPluginDynamicWorkerResourcePreparation?(
    request: ControlPluginDynamicWorkerDesiredStateRequest
  ): Promise<ControlPluginDynamicWorkerResourcePreparation | null>;
  syncPluginDynamicWorkerObservedState?(
    request: ControlPluginDynamicWorkerObservedStateRequest
  ): Promise<ControlPluginDynamicWorkerStateView>;
  requestPluginResourceCleanup?(
    request: ControlPluginResourceCleanupRequest
  ): Promise<ControlPluginResourceCleanupView | null>;
  getPluginResourceCleanup?(input: {
    tenantId: string;
    pluginId: string;
  }): Promise<ControlPluginResourceCleanupView | null>;
  getTenantDeletionInventory?(
    request: ControlTenantDeletionRequest
  ): Promise<ControlTenantDeletionInventory>;
  finalizeTenantDeletionControlState?(
    request: ControlTenantDeletionRequest
  ): Promise<ControlTenantDeletionFinalization>;
  registerTenantPlacementPolicy?(
    request: ControlTenantPlacementPolicyRegistrationRequest
  ): Promise<ControlTenantPlacementPolicy>;
  activateTenantPlacementPolicy?(
    request: ControlTenantPlacementPolicyActivationRequest
  ): Promise<ControlTenantPlacementPolicy>;
  getTenantPlacementPolicy?(tenantId: string): Promise<ControlTenantPlacementPolicy | null>;
  startTenantPlacementMigration?(
    request: ControlTenantPlacementMigrationStartRequest
  ): Promise<ControlTenantPlacementMigrationView>;
  getTenantPlacementMigration?(
    operationId: string
  ): Promise<ControlTenantPlacementMigrationView | null>;
  cancelTenantPlacementMigration?(
    request: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView>;
  beginTenantPlacementRouteCutover?(
    request: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView>;
  commitTenantPlacementMigration?(
    request: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView>;
  finalizeTenantPlacementMigrationCutover?(
    request: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView>;
  approveTenantPlacementMigrationPurge?(
    request: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView>;
  getProvisioningOperation?(
    operationId: string
  ): Promise<ControlProvisioningOperationDetail | null>;
  retryProvisioningOperationStep?(
    request: ControlProvisioningOperationRetryRequest
  ): Promise<ControlProvisioningOperationDetail>;
  cancelProvisioningOperation?(
    request: ControlProvisioningOperationCancelRequest
  ): Promise<ControlProvisioningOperationDetail>;
  restoreProvisioningOperationPreviousSettings?(
    request: ControlProvisioningOperationRestoreRequest
  ): Promise<ControlProvisioningOperationDetail>;
  startTenantDisasterRecovery?(
    request: ControlTenantDisasterRecoveryStartRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  getTenantDisasterRecovery?(
    operationId: string
  ): Promise<ControlTenantDisasterRecoveryView | null>;
  observeTenantDisasterRecoveryDeny?(
    request: ControlTenantDisasterRecoveryDenyObservationRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  confirmTenantDisasterRecoveryRestore?(
    request: ControlTenantDisasterRecoveryRestoreConfirmationRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  recordTenantDisasterRecoveryVerification?(
    request: ControlTenantDisasterRecoveryVerificationRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  claimTenantDisasterRecoveryLookupReprojection?(
    request: ControlTenantDisasterRecoveryLookupClaimRequest
  ): Promise<ControlTenantDisasterRecoveryLookupWork>;
  claimNextTenantDisasterRecoveryLookupReprojection?(
    request: ControlTenantDisasterRecoveryLookupClaimNextRequest
  ): Promise<ControlTenantDisasterRecoveryLookupWork | null>;
  checkpointTenantDisasterRecoveryLookupReprojection?(
    request: ControlTenantDisasterRecoveryLookupCheckpointRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  completeTenantDisasterRecoveryLookupReprojection?(
    request: ControlTenantDisasterRecoveryLookupCompleteRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  requestTenantDisasterRecoveryReactivation?(
    request: ControlTenantDisasterRecoveryReactivationRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  completeTenantDisasterRecoveryReactivation?(
    request: ControlTenantDisasterRecoveryReactivationObservationRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  cancelTenantDisasterRecovery?(
    request: ControlTenantDisasterRecoveryCancelRequest
  ): Promise<ControlTenantDisasterRecoveryView>;
  listShardCleanupCandidates?(): Promise<ControlShardCleanupView[]>;
  getShardCleanupCandidate?(shardId: string): Promise<ControlShardCleanupView | null>;
  quarantineShard?(request: ControlShardQuarantineRequest): Promise<ControlShardCleanupView>;
  retryShardQuarantine?(
    request: ControlShardQuarantineRetryRequest
  ): Promise<ControlShardCleanupView>;
  approveShardCleanup?(
    request: ControlShardCleanupApprovalRequest
  ): Promise<ControlShardCleanupView>;
  retryShardCleanup?(request: ControlShardCleanupRetryRequest): Promise<ControlShardCleanupView>;
  getRuntimeRegistrySignerMetadata?(): Promise<ControlRuntimeRegistrySignerMetadata>;
  signRuntimeRegistryPayload?(input: {
    payload: Uint8Array;
  }): Promise<ControlRuntimeRegistrySignature>;
  reserveTenantDefaultRoute?(
    request: ControlTenantDefaultRouteReservationRequest
  ): Promise<ControlTenantDefaultRouteAllocation>;
  commitTenantDefaultRoute?(
    request: ControlTenantDefaultRouteMutationRequest
  ): Promise<ControlTenantDefaultRouteAllocation>;
  releaseTenantDefaultRoute?(
    request: ControlTenantDefaultRouteMutationRequest
  ): Promise<ControlTenantDefaultRouteAllocation>;
  allocateAccountRoute(
    request: ControlAccountRouteAllocationRequest
  ): Promise<ControlAccountRouteAllocationResult>;
  listAccountDirectorySourceShards(input: {
    afterShardId: string | null;
    limit: number;
  }): Promise<ControlAccountDirectorySourceShard[]>;
  listAccountRouteSourceShards(input: {
    dataRole: ControlAccountDataRole;
    afterShardId: string | null;
    limit: number;
  }): Promise<ControlAccountRouteSourceShard[]>;
  startLookupBucketMigration?(
    input: ControlLookupBucketMigrationStartRequest
  ): Promise<ControlLookupBucketMigrationView>;
  claimLookupBucketMigration?(
    input: ControlLookupBucketMigrationClaimRequest
  ): Promise<ControlLookupBucketMigrationView>;
  claimNextLookupBucketMigration?(input: {
    ownerId: string;
  }): Promise<ControlLookupBucketMigrationView | null>;
  checkpointLookupBucketMigration?(
    input: ControlLookupBucketMigrationCheckpointRequest
  ): Promise<ControlLookupBucketMigrationView>;
  cutoverLookupBucketMigration?(
    input: ControlLookupBucketMigrationCutoverRequest
  ): Promise<ControlLookupBucketMigrationView>;
  completeLookupBucketMigration?(
    input: ControlLookupBucketMigrationCompleteRequest
  ): Promise<ControlLookupBucketMigrationView>;
  blockLookupBucketMigration?(
    input: ControlLookupBucketMigrationBlockRequest
  ): Promise<ControlLookupBucketMigrationView>;
  planNextLookupBucketMigration?(
    input: ControlLookupBucketLoadSnapshotRequest
  ): Promise<ControlLookupBucketMigrationView | null>;
  getLookupBucketWriteRoute?(input: {
    virtualBucket: number;
  }): Promise<ControlLookupBucketWriteRoute>;
  resolveLookupBucketRouteVersion?(input: {
    virtualBucket: number;
    assignmentGeneration: number;
  }): Promise<ControlLookupBucketRouteTarget>;
  initializeLookupHmacKeyState?(
    input: ControlLookupHmacKeyStateInitializeRequest
  ): Promise<ControlLookupHmacKeyStateView>;
  startLookupHmacRotation?(
    input: ControlLookupHmacRotationStartRequest
  ): Promise<ControlLookupHmacRotationView>;
  getLookupHmacRotation?(input: {
    operationId: string;
  }): Promise<ControlLookupHmacRotationView | null>;
  getLookupHmacVerificationStatus?(input: {
    operationId: string;
    phase: 'distribution' | 'generation';
  }): Promise<ControlLookupHmacVerificationStatus>;
  activateLookupHmacRotation?(
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView>;
  observeLookupHmacRotationGeneration?(
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView>;
  claimNextLookupHmacRotation?(input: {
    ownerId: string;
  }): Promise<ControlLookupHmacRotationView | null>;
  checkpointLookupHmacRotation?(
    input: ControlLookupHmacRotationCheckpointRequest
  ): Promise<ControlLookupHmacRotationView>;
  getNextLookupHmacRotationSource?(
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationSourceShardView | null>;
  checkpointLookupHmacRotationSource?(
    input: ControlLookupHmacRotationSourceCheckpointRequest
  ): Promise<ControlLookupHmacRotationSourceShardView>;
  beginLookupHmacRotationVerification?(
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView>;
  getNextLookupHmacRotationVerificationShard?(
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationVerificationShardView | null>;
  checkpointLookupHmacRotationVerificationShard?(
    input: ControlLookupHmacRotationVerificationShardCheckpointRequest
  ): Promise<ControlLookupHmacRotationVerificationShardView>;
  finalizeLookupHmacRotationVerification?(
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView>;
  recordLookupHmacRotationVerification?(
    input: ControlLookupHmacRotationVerificationRequest
  ): Promise<ControlLookupHmacRotationView>;
  completeLookupHmacRotationGrace?(
    input: ControlLookupHmacRotationMutationRequest
  ): Promise<ControlLookupHmacRotationView>;
  getReadReplicationStatus?(): Promise<ControlReadReplicationStatusView>;
  startReadReplicationRollout?(
    input: ControlReadReplicationStartRequest
  ): Promise<ControlReadReplicationStatusView>;
  listPendingWorkerInventoryDriftFindings(): Promise<ControlWorkerInventoryDriftNotification[]>;
  acknowledgeWorkerInventoryDriftNotifications(findingIds: string[]): Promise<void>;
  listWorkerInventoryDriftFindings?(): Promise<ControlWorkerInventoryDriftFinding[]>;
  reviewWorkerInventoryDriftFinding?(
    input: ControlWorkerInventoryDriftReviewRequest
  ): Promise<ControlWorkerInventoryDriftFinding>;
}

export type TenantRouteDataRole = 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';

export interface TenantRouteTarget {
  dataRole: TenantRouteDataRole;
  residencyPartition: string;
  shardId: string;
  bindingRef: string;
  requiredBindingRouteGeneration: number;
}

export interface AccountRouteProjection {
  schemaVersion: number;
  accountRouteGeneration: number;
  residencyPolicyId: string;
  targets: TenantRouteTarget[];
}

export interface TenantAliasRouteProjection {
  schemaVersion: number;
  tenantRouteGeneration: number;
  residencyPolicyId: string;
  target: TenantRouteTarget & { dataRole: 'tenant_core/default' };
}

export interface ThreeStateActivationGate {
  targetGeneration: number;
  tenant: {
    state: 'creating' | 'active' | 'quarantining' | 'quarantined' | 'disabled';
    generation: number;
  };
  runtimeRegistry: {
    state: 'pending' | 'active' | 'quarantining' | 'disabled';
    generation: number;
  };
  lookup: { state: LookupLifecycleState; generation: number };
}

export interface AccountDirectoryPublishRequest {
  operationId: string;
  tenantId: string;
  accountId: string;
  routeProjection: AccountRouteProjection;
  idempotencyKey: string;
}

export type AccountDirectoryPublishResult =
  | { status: 201; accountId: string; operationId: string }
  | { status: 202; accountId: string; operationId: string };

export interface CrossShardAccountCursor {
  schemaVersion: 1;
  tenantId: string;
  shardSetGeneration: number;
  queryHash: string;
  issuedAt: number;
  expiresAt: number;
  shardCursors: Array<{ shardId: string; cursor: string | null }>;
}

const OPERATION_TRANSITIONS: Readonly<
  Record<ControlOperationStatus, readonly ControlOperationStatus[]>
> = {
  queued: ['running', 'blocked', 'canceled'],
  running: ['waiting_retry', 'succeeded', 'blocked'],
  waiting_retry: ['running', 'blocked', 'canceled'],
  succeeded: [],
  blocked: ['running', 'canceled'],
  canceled: [],
};

const LOOKUP_TRANSITIONS: Readonly<Record<LookupLifecycleState, readonly LookupLifecycleState[]>> =
  {
    pending: ['active', 'disabled'],
    active: ['disabled'],
    disabled: [],
  };

const DIRECTORY_PUBLICATION_TRANSITIONS: Readonly<
  Record<AccountDirectoryPublicationState, readonly AccountDirectoryPublicationState[]>
> = {
  pending: ['active_pending_directory', 'disabled'],
  active_pending_directory: ['active', 'disabled'],
  active: ['disabled'],
  disabled: [],
};

const SENSITIVE_CONTROL_KEY_PATTERN =
  /(^|_)(api_token|authorization|cloudflare_token|credential_value|hmac_key_body|private_jwk|private_key|raw_email|secret_value)(_|$)/i;
const PRIVATE_JWK_MEMBERS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_D1_BINDING = /^[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]{1,123}$/u;
const ROUTE_DATA_ROLES = new Set<TenantRouteDataRole>([
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
]);

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

function assertSafeString(value: string, path: string): void {
  if (/-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/u.test(value) || /^Bearer\s+\S+/iu.test(value)) {
    throw new Error(`control_plane_sensitive_value_forbidden:${path}`);
  }
}

export function assertPublicVerificationJwk(value: unknown, path = '$'): void {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error(`control_plane_public_jwk_invalid:${path}`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`control_plane_public_jwk_invalid:${path}`);
  }
  const jwk = parsed as Record<string, unknown>;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new Error(`control_plane_public_jwk_ed25519_required:${path}`);
  }
  if (typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)) {
    throw new Error(`control_plane_public_jwk_invalid:${path}.x`);
  }
  if (jwk.alg !== undefined && jwk.alg !== 'EdDSA') {
    throw new Error(`control_plane_public_jwk_alg_invalid:${path}.alg`);
  }
  for (const member of PRIVATE_JWK_MEMBERS) {
    if (jwk[member] !== undefined) {
      throw new Error(`control_plane_private_jwk_member_forbidden:${path}.${member}`);
    }
  }
  if (
    jwk.key_ops !== undefined &&
    (!Array.isArray(jwk.key_ops) || jwk.key_ops.some((operation) => operation !== 'verify'))
  ) {
    throw new Error(`control_plane_public_jwk_key_ops_invalid:${path}.key_ops`);
  }
}

export function assertControlPlaneRecordIsSecretFree(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    assertSafeString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertControlPlaneRecordIsSecretFree(entry, `${path}[${index}]`)
    );
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    const normalized = normalizedKey(key);
    if (SENSITIVE_CONTROL_KEY_PATTERN.test(normalized)) {
      throw new Error(`control_plane_sensitive_key_forbidden:${childPath}`);
    }
    if (normalized.includes('public_jwk')) {
      assertPublicVerificationJwk(entryValue, childPath);
    }
    assertControlPlaneRecordIsSecretFree(entryValue, childPath);
  }
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requiredGeneration(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`invalid_${field}`);
  }
  return value as number;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  code: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new Error(code);
  }
  return record;
}

export function validateControlAccountRouteAllocationResult(
  value: unknown,
  expected: {
    tenantId: string;
    residencyPolicyId: string;
    residencyPartition: string;
    dataRoles: readonly ControlAccountDataRole[];
  }
): ControlAccountRouteAllocationResult {
  requiredIdentifier(expected.tenantId, 'tenant_id');
  requiredIdentifier(expected.residencyPolicyId, 'residency_policy_id');
  if (!SAFE_PARTITION.test(expected.residencyPartition)) {
    throw new Error('invalid_residency_partition');
  }
  if (
    expected.dataRoles.length < 1 ||
    expected.dataRoles.length > 2 ||
    new Set(expected.dataRoles).size !== expected.dataRoles.length ||
    expected.dataRoles.some((role) => role !== 'tenant_core/users' && role !== 'tenant_pii')
  ) {
    throw new Error('invalid_account_route_data_roles');
  }

  const result = exactObject(
    value,
    ['tenantId', 'residencyPolicyId', 'targets'],
    'account_directory_allocation_invalid'
  );
  if (
    result.tenantId !== expected.tenantId ||
    result.residencyPolicyId !== expected.residencyPolicyId ||
    !Array.isArray(result.targets) ||
    result.targets.length !== expected.dataRoles.length
  ) {
    throw new Error('account_directory_allocation_invalid');
  }

  const expectedRoles = new Set(expected.dataRoles);
  const seenRoles = new Set<ControlAccountDataRole>();
  const seenAllocations = new Set<string>();
  const seenShards = new Set<string>();
  const seenBindings = new Set<string>();
  const targets = result.targets.map((candidate): ControlAccountRouteAllocationTarget => {
    const target = exactObject(
      candidate,
      [
        'allocationId',
        'dataRole',
        'residencyPartition',
        'shardId',
        'bindingRef',
        'routeGeneration',
      ],
      'account_directory_allocation_target_invalid'
    );
    const allocationId = requiredIdentifier(target.allocationId, 'allocation_id');
    const dataRole = target.dataRole;
    if (dataRole !== 'tenant_core/users' && dataRole !== 'tenant_pii') {
      throw new Error('account_directory_allocation_role_invalid');
    }
    if (!expectedRoles.has(dataRole) || seenRoles.has(dataRole)) {
      throw new Error('account_directory_allocation_role_invalid');
    }
    if (target.residencyPartition !== expected.residencyPartition) {
      throw new Error('account_directory_allocation_residency_mismatch');
    }
    const shardId = requiredIdentifier(target.shardId, 'route_shard_id');
    if (typeof target.bindingRef !== 'string' || !SAFE_D1_BINDING.test(target.bindingRef)) {
      throw new Error('account_directory_allocation_binding_invalid');
    }
    const bindingRef = target.bindingRef;
    const routeGeneration = requiredGeneration(
      target.routeGeneration,
      'required_binding_route_generation'
    );
    if (
      seenAllocations.has(allocationId) ||
      seenShards.has(shardId) ||
      seenBindings.has(bindingRef)
    ) {
      throw new Error('account_directory_allocation_target_reused');
    }
    seenRoles.add(dataRole);
    seenAllocations.add(allocationId);
    seenShards.add(shardId);
    seenBindings.add(bindingRef);
    return {
      allocationId,
      dataRole,
      residencyPartition: expected.residencyPartition,
      shardId,
      bindingRef,
      routeGeneration,
    };
  });
  if (seenRoles.size !== expectedRoles.size) {
    throw new Error('account_directory_allocation_role_invalid');
  }
  const validated = {
    tenantId: expected.tenantId,
    residencyPolicyId: expected.residencyPolicyId,
    targets,
  } satisfies ControlAccountRouteAllocationResult;
  assertControlPlaneRecordIsSecretFree(validated);
  return validated;
}

export function validateAccountRouteProjection(
  value: AccountRouteProjection
): AccountRouteProjection {
  exactObject(
    value,
    ['schemaVersion', 'accountRouteGeneration', 'residencyPolicyId', 'targets'],
    'invalid_route_projection_shape'
  );
  requiredGeneration(value.schemaVersion, 'route_schema_version');
  requiredGeneration(value.accountRouteGeneration, 'account_route_generation');
  requiredIdentifier(value.residencyPolicyId, 'residency_policy_id');
  if (!Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > 32) {
    throw new Error('invalid_route_targets');
  }
  const seen = new Set<string>();
  for (const target of value.targets) {
    exactObject(
      target,
      ['dataRole', 'residencyPartition', 'shardId', 'bindingRef', 'requiredBindingRouteGeneration'],
      'invalid_route_target_shape'
    );
    if (!ROUTE_DATA_ROLES.has(target.dataRole)) throw new Error('invalid_route_data_role');
    if (!SAFE_PARTITION.test(target.residencyPartition)) {
      throw new Error('invalid_residency_partition');
    }
    requiredIdentifier(target.shardId, 'route_shard_id');
    requiredIdentifier(target.bindingRef, 'route_binding_ref');
    requiredGeneration(target.requiredBindingRouteGeneration, 'required_binding_route_generation');
    const key = `${target.dataRole}\0${target.residencyPartition}`;
    if (seen.has(key)) throw new Error('duplicate_route_target');
    seen.add(key);
  }
  return value;
}

export function validateTenantAliasRouteProjection(
  value: TenantAliasRouteProjection
): TenantAliasRouteProjection {
  exactObject(
    value,
    ['schemaVersion', 'tenantRouteGeneration', 'residencyPolicyId', 'target'],
    'invalid_tenant_alias_route_projection_shape'
  );
  requiredGeneration(value.schemaVersion, 'route_schema_version');
  requiredGeneration(value.tenantRouteGeneration, 'tenant_route_generation');
  requiredIdentifier(value.residencyPolicyId, 'residency_policy_id');
  const target = exactObject(
    value.target,
    ['dataRole', 'residencyPartition', 'shardId', 'bindingRef', 'requiredBindingRouteGeneration'],
    'invalid_tenant_alias_route_target_shape'
  );
  if (target.dataRole !== 'tenant_core/default') {
    throw new Error('invalid_tenant_alias_route_data_role');
  }
  if (
    typeof target.residencyPartition !== 'string' ||
    !SAFE_PARTITION.test(target.residencyPartition)
  ) {
    throw new Error('invalid_residency_partition');
  }
  requiredIdentifier(target.shardId, 'route_shard_id');
  if (typeof target.bindingRef !== 'string' || !SAFE_D1_BINDING.test(target.bindingRef)) {
    throw new Error('invalid_tenant_alias_route_binding_ref');
  }
  const requiredBindingRouteGeneration = requiredGeneration(
    target.requiredBindingRouteGeneration,
    'required_binding_route_generation'
  );
  if (requiredBindingRouteGeneration !== value.tenantRouteGeneration) {
    throw new Error('tenant_alias_route_generation_mismatch');
  }
  assertControlPlaneRecordIsSecretFree(value);
  return value;
}

export function assertThreeStateActivationGate(gate: ThreeStateActivationGate): void {
  const targetGeneration = requiredGeneration(gate.targetGeneration, 'target_generation');
  if (
    gate.tenant.state !== 'active' ||
    gate.runtimeRegistry.state !== 'active' ||
    gate.lookup.state !== 'active' ||
    gate.tenant.generation !== targetGeneration ||
    gate.runtimeRegistry.generation !== targetGeneration ||
    gate.lookup.generation !== targetGeneration
  ) {
    throw new Error('tenant_route_three_state_activation_gate_not_satisfied');
  }
}

export function validateAccountDirectoryPublishRequest(
  value: AccountDirectoryPublishRequest
): AccountDirectoryPublishRequest {
  exactObject(
    value,
    ['operationId', 'tenantId', 'accountId', 'routeProjection', 'idempotencyKey'],
    'invalid_account_directory_request_shape'
  );
  requiredIdentifier(value.operationId, 'operation_id');
  requiredIdentifier(value.tenantId, 'tenant_id');
  requiredIdentifier(value.accountId, 'account_id');
  requiredIdentifier(value.idempotencyKey, 'idempotency_key');
  validateAccountRouteProjection(value.routeProjection);
  assertControlPlaneRecordIsSecretFree(value);
  return value;
}

export function validateCrossShardAccountCursor(
  value: CrossShardAccountCursor,
  expected: { tenantId: string; shardSetGeneration: number; queryHash: string; now: number }
): CrossShardAccountCursor {
  if (value.schemaVersion !== 1) throw new Error('unsupported_cross_shard_cursor_version');
  if (value.tenantId !== expected.tenantId) throw new Error('cross_shard_cursor_tenant_mismatch');
  if (value.shardSetGeneration !== expected.shardSetGeneration) {
    throw new Error('cursor_stale');
  }
  if (!/^[a-f0-9]{64}$/u.test(value.queryHash) || value.queryHash !== expected.queryHash) {
    throw new Error('cross_shard_cursor_query_mismatch');
  }
  if (!Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)) {
    throw new Error('invalid_cross_shard_cursor_time');
  }
  if (value.issuedAt > expected.now || value.expiresAt <= expected.now) {
    throw new Error('cross_shard_cursor_expired');
  }
  if (!Array.isArray(value.shardCursors) || value.shardCursors.length > 32) {
    throw new Error('invalid_cross_shard_cursor_count');
  }
  const seen = new Set<string>();
  for (const shard of value.shardCursors) {
    requiredIdentifier(shard.shardId, 'cursor_shard_id');
    if (shard.cursor !== null && (typeof shard.cursor !== 'string' || shard.cursor.length > 4096)) {
      throw new Error('invalid_shard_cursor');
    }
    if (seen.has(shard.shardId)) throw new Error('duplicate_cursor_shard');
    seen.add(shard.shardId);
  }
  return value;
}

export function assertControlOperationTransition(
  from: ControlOperationStatus,
  to: ControlOperationStatus
): void {
  if (!OPERATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid_control_operation_transition:${from}:${to}`);
  }
}

export function assertLookupLifecycleTransition(
  from: LookupLifecycleState,
  to: LookupLifecycleState,
  gate: { tenantActive: boolean; runtimeRouteActive: boolean }
): void {
  if (!LOOKUP_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid_lookup_lifecycle_transition:${from}:${to}`);
  }
  if (to === 'active' && (!gate.tenantActive || !gate.runtimeRouteActive)) {
    throw new Error('lookup_activation_gate_not_satisfied');
  }
}

export function assertAccountDirectoryPublicationTransition(
  from: AccountDirectoryPublicationState,
  to: AccountDirectoryPublicationState
): void {
  if (!DIRECTORY_PUBLICATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid_account_directory_transition:${from}:${to}`);
  }
}

export function createD1ConsistencyRequest(
  consistencyClass: D1ConsistencyClass,
  bookmark?: string | null
): D1ConsistencyRequest {
  const normalizedBookmark = bookmark?.trim() || null;
  if (consistencyClass === 'read_after_write' && !normalizedBookmark) {
    throw new Error('d1_read_after_write_bookmark_required');
  }
  if (consistencyClass !== 'read_after_write' && normalizedBookmark) {
    throw new Error(`d1_bookmark_not_allowed_for:${consistencyClass}`);
  }
  return { consistencyClass, bookmark: normalizedBookmark };
}

export function assertTenantShardWriteOwnership(
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii',
  entityKind: 'tenant_metadata' | 'account' | 'identifier' | 'credential' | 'pii_profile'
): void {
  if (entityKind === 'tenant_metadata' && dataRole !== 'tenant_core/default') {
    throw new Error(`tenant_metadata_write_forbidden_for:${dataRole}`);
  }
  if (
    dataRole === 'tenant_core/default' &&
    ['account', 'identifier', 'credential', 'pii_profile'].includes(entityKind)
  ) {
    throw new Error(`account_data_write_forbidden_for:${dataRole}`);
  }
  if (dataRole === 'tenant_core/users' && entityKind === 'pii_profile') {
    throw new Error(`pii_write_forbidden_for:${dataRole}`);
  }
  if (dataRole === 'tenant_pii' && entityKind !== 'pii_profile') {
    throw new Error(`non_pii_write_forbidden_for:${dataRole}`);
  }
}

export function nextDirectoryRewriteFencingToken(input: {
  current: DirectoryRewriteLeaseState | null;
  nextOperationId: string;
  now: number;
}): number {
  const nextOperationId = input.nextOperationId.trim();
  if (!nextOperationId) throw new Error('directory_rewrite_operation_id_required');
  if (!input.current) return 1;
  if (input.current.leaseExpiresAt > input.now) {
    throw new Error('directory_rewrite_lease_active');
  }
  if (input.current.operationId !== nextOperationId && input.current.mutationStarted) {
    throw new Error('directory_rewrite_cross_operation_takeover_forbidden_after_mutation');
  }
  return input.current.fencingToken + 1;
}
