import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  assertControlPlaneRecordIsSecretFree,
  hasAdminPermission,
  type AdminAuthContext,
  type ControlCapacityProfileRequest,
  type ControlCapacityProvisioningRequest,
  type ControlProvisioningOperationCancelRequest,
  type ControlProvisioningOperationDetail,
  type ControlProvisioningOperationRestoreRequest,
  type ControlProvisioningOperationRetryRequest,
  type ControlProvisioningAuthorityStatus,
  type ControlShardCleanupApprovalRequest,
  type ControlShardCleanupRetryRequest,
  type ControlShardCleanupView,
  type ControlShardQuarantineRetryRequest,
  type ControlShardQuarantineRequest,
  type ControlTenantDisasterRecoveryView,
  type ControlLookupHmacKeyMetadata,
  type ControlLookupHmacRotationView,
  type ControlWorkerInventoryDriftFinding,
  type ControlWorkerInventoryDriftReviewRequest,
  type Env,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import {
  previewControlCapacityProvisioning,
  requestControlCapacityProvisioning,
} from '../../control-plane-capacity';
import {
  publishTenantRuntimeRegistryReactivation,
  publishTenantRuntimeRegistryRouteState,
} from '../../tenant-runtime-registry-route-state';
import { resolveActiveTenantRuntimeRouteObservation } from '../../admin-tenants';

type AdminContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000;
const OPERATION_KEYS = new Set([
  'operationId',
  'operationKind',
  'status',
  'attemptCount',
  'nextAttemptAt',
  'lastErrorCode',
  'createdAt',
  'updatedAt',
  'availableActions',
  'steps',
]);
const OPERATION_ACTIONS = new Set([
  'retry_create_d1',
  'retry_apply_migrations',
  'retry_reconcile_worker_bindings',
  'restore_previous_settings',
  'cancel',
]);
const OPERATION_STEP_KEYS = new Set([
  'stepKey',
  'displayOrder',
  'status',
  'attemptCount',
  'nextAttemptAt',
  'lastErrorCode',
  'observedResourceId',
  'progressCurrent',
  'progressTotal',
  'startedAt',
  'completedAt',
  'updatedAt',
]);
const FINDING_KEYS = new Set([
  'findingId',
  'environmentId',
  'workerScriptName',
  'findingKind',
  'severity',
  'reviewState',
  'notificationState',
  'firstObservedAt',
  'lastObservedAt',
  'resolvedAt',
  'notifiedAt',
]);
const LOOKUP_HMAC_ROTATION_KEYS = new Set([
  'operationId',
  'state',
  'source',
  'candidate',
  'checkpoint',
  'sourceRowCount',
  'currentRowCount',
  'verificationAttemptCount',
  'graceExpiresAt',
  'ownerId',
  'fencingToken',
  'leaseExpiresAt',
  'mutationStarted',
  'updatedAt',
]);
const LOOKUP_HMAC_METADATA_KEYS = new Set(['generation', 'keyId', 'slot', 'fingerprint']);
const LOOKUP_HMAC_STATES = new Set([
  'planned',
  'distributing',
  'activation_dual_write',
  'dual_read',
  'reindexing',
  'verifying',
  'grace',
  'complete',
  'blocked',
]);
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_D1_BINDING = /^(?:[A-Z][A-Z0-9_]*_)?TDB_[A-Z0-9_]{1,123}$/u;
const SAFE_DATABASE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const SHARD_CLEANUP_KEYS = new Set([
  'environmentId',
  'shardId',
  'dataRole',
  'residencyPartition',
  'bindingRef',
  'databaseId',
  'databaseName',
  'shardStatus',
  'quarantineOperationId',
  'quarantineState',
  'quarantineOperationState',
  'denyRegistryGeneration',
  'drainNotBefore',
  'registryVerifiedAt',
  'referencesVerifiedAt',
  'cleanupOperationId',
  'cleanupState',
  'exportMode',
  'deleteDatabase',
  'destructiveOperationsEnabled',
  'availableActions',
  'bindings',
  'lastErrorCode',
  'createdAt',
  'updatedAt',
]);
const SHARD_CLEANUP_BINDING_KEYS = new Set([
  'workerScriptName',
  'bindingRef',
  'state',
  'lastErrorCode',
  'updatedAt',
]);
const SHARD_CLEANUP_ACTIONS = new Set([
  'quarantine',
  'retry_quarantine',
  'approve_cleanup',
  'retry_cleanup',
]);
const SHARD_QUARANTINE_STATES = new Set(['draining', 'ready_for_cleanup', 'blocked', 'canceled']);
const SHARD_CLEANUP_STATES = new Set([
  'approved',
  'removing_bindings',
  'deleting_database',
  'verifying_absence',
  'succeeded',
  'blocked',
]);
const TENANT_DR_STATES = new Set([
  'publishing_deny',
  'draining',
  'operator_restore_required',
  'verifying_restore',
  'reprojecting_lookup',
  'smoke_verifying',
  'ready_for_reactivation',
  'reactivating',
  'succeeded',
  'blocked',
  'canceled',
]);
const TENANT_DR_KEYS = new Set([
  'operationId',
  'environmentId',
  'tenantId',
  'state',
  'pinnedRouteGeneration',
  'denyRuntimeGeneration',
  'denyRegistryGeneration',
  'denyObservedAt',
  'drainNotBefore',
  'restoreReferenceRecorded',
  'restoredAt',
  'migrationVerifiedAt',
  'lookupReprojectedAt',
  'lookupReprojection',
  'bindingSmokeVerifiedAt',
  'reactivatedRuntimeGeneration',
  'reactivatedAt',
  'lastErrorCode',
  'canCancel',
  'canConfirmRestore',
  'canVerify',
  'canReactivate',
  'targets',
  'createdAt',
  'updatedAt',
]);
const TENANT_DR_LOOKUP_PROGRESS_KEYS = new Set([
  'stage',
  'targetIndex',
  'afterCreatedAt',
  'afterId',
  'afterRowId',
  'projectedRows',
  'verifiedRows',
  'registryDigestPinned',
  'leaseActive',
]);
const TENANT_DR_LOOKUP_STAGES = new Set([
  'cleanup',
  'account_id',
  'email_exact',
  'external_core',
  'external_pii',
  'verify',
]);
const TENANT_DR_TARGET_KEYS = new Set([
  'shardId',
  'dataRole',
  'residencyPartition',
  'assignmentGeneration',
  'shardGeneration',
  'bindingRef',
  'providerDatabaseId',
  'migrationStreamId',
  'releaseId',
  'manifestDigest',
  'restoreConfirmedAt',
  'migrationVerifiedAt',
  'lookupReprojectedAt',
  'bindingSmokeVerifiedAt',
]);

interface LookupHmacVerificationStatus {
  phase: 'distribution' | 'generation';
  expected: number;
  succeeded: number;
  failed: number;
  pending: string[];
  complete: boolean;
}

export const controlPlaneOperationsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

controlPlaneOperationsRouter.use('*', adminAuthMiddleware());

function auth(c: AdminContext): AdminAuthContext {
  return c.get('adminAuth') as AdminAuthContext;
}

function hasPlatformAuthority(value: AdminAuthContext): boolean {
  return (
    hasAdminPermission(value.permissions ?? [], ADMIN_PERMISSIONS.ALL) ||
    value.roles.includes('super_admin') ||
    value.roles.includes('system_admin') ||
    value.tenantScope?.includes('*') === true
  );
}

function hasControlPlanePermission(
  value: AdminAuthContext,
  permission: 'read' | 'rotate' | 'provision'
): boolean {
  const permissions = value.permissions ?? [];
  const explicit =
    hasAdminPermission(permissions, `admin:control_plane:${permission}`) ||
    hasAdminPermission(permissions, 'admin:control_plane:*') ||
    hasAdminPermission(permissions, ADMIN_PERMISSIONS.ALL);
  if (value.actorType === 'machine' || value.authMethod === 'machine_access_token') {
    return explicit;
  }
  return explicit || hasPlatformAuthority(value);
}

function isSetupProvisioningMachine(value: AdminAuthContext): boolean {
  return (
    value.actorType === 'machine' &&
    value.authMethod === 'machine_access_token' &&
    value.principalType === 'setup_tool' &&
    value.clientId === 'authrim-setup' &&
    hasAdminPermission(value.permissions ?? [], 'admin:control_plane:provision')
  );
}

function error(c: AdminContext, status: 400 | 403 | 404 | 409 | 503, code: string): Response {
  return c.json({ error: code, error_description: code }, status);
}

function environmentId(env: Env): string {
  const value = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!value || !SAFE_ENVIRONMENT_ID.test(value)) {
    throw new Error('control_plane_environment_invalid');
  }
  return value;
}

function parseFinding(
  value: unknown,
  expectedEnvironmentId: string
): ControlWorkerInventoryDriftFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_drift_finding_invalid');
  }
  const finding = value as Record<string, unknown>;
  const keys = Object.keys(finding);
  if (
    keys.length !== FINDING_KEYS.size ||
    keys.some((key) => !FINDING_KEYS.has(key)) ||
    finding.environmentId !== expectedEnvironmentId ||
    typeof finding.workerScriptName !== 'string' ||
    !SAFE_SCRIPT_NAME.test(finding.workerScriptName) ||
    finding.findingId !==
      `drift:${expectedEnvironmentId}:actual_only:${finding.workerScriptName}` ||
    finding.findingKind !== 'actual_only' ||
    finding.severity !== 'warning' ||
    typeof finding.reviewState !== 'string' ||
    !['unreviewed', 'reviewed', 'dismissed'].includes(finding.reviewState) ||
    typeof finding.notificationState !== 'string' ||
    !['pending', 'acknowledged'].includes(finding.notificationState) ||
    !Number.isSafeInteger(finding.firstObservedAt) ||
    (finding.firstObservedAt as number) <= 0 ||
    (finding.firstObservedAt as number) > MAX_DATE_EPOCH_SECONDS ||
    !Number.isSafeInteger(finding.lastObservedAt) ||
    (finding.lastObservedAt as number) < (finding.firstObservedAt as number) ||
    (finding.lastObservedAt as number) > MAX_DATE_EPOCH_SECONDS ||
    finding.resolvedAt !== null ||
    (finding.notifiedAt !== null &&
      (!Number.isSafeInteger(finding.notifiedAt) ||
        (finding.notifiedAt as number) < (finding.firstObservedAt as number) ||
        (finding.notifiedAt as number) > MAX_DATE_EPOCH_SECONDS))
  ) {
    throw new Error('control_plane_drift_finding_invalid');
  }
  assertControlPlaneRecordIsSecretFree(finding);
  return finding as unknown as ControlWorkerInventoryDriftFinding;
}

function parseFindings(
  value: unknown,
  expectedEnvironmentId: string
): ControlWorkerInventoryDriftFinding[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('control_plane_drift_finding_invalid');
  }
  const findings = value.map((finding) => parseFinding(finding, expectedEnvironmentId));
  if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length) {
    throw new Error('control_plane_drift_finding_invalid');
  }
  return findings;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function optionalSafeEpoch(value: unknown): boolean {
  return (
    value === null ||
    (Number.isSafeInteger(value) &&
      (value as number) > 0 &&
      (value as number) <= MAX_DATE_EPOCH_SECONDS)
  );
}

function optionalSafeCode(value: unknown): boolean {
  return value === null || (typeof value === 'string' && SAFE_ENVIRONMENT_ID.test(value));
}

function parseOperation(
  value: unknown,
  expectedOperationId: string
): ControlProvisioningOperationDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_operation_invalid');
  }
  const operation = value as Record<string, unknown>;
  if (
    !exactKeys(operation, OPERATION_KEYS) ||
    operation.operationId !== expectedOperationId ||
    typeof operation.operationKind !== 'string' ||
    !SAFE_ENVIRONMENT_ID.test(operation.operationKind) ||
    typeof operation.status !== 'string' ||
    !['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(
      operation.status
    ) ||
    !Number.isSafeInteger(operation.attemptCount) ||
    (operation.attemptCount as number) < 0 ||
    !optionalSafeEpoch(operation.nextAttemptAt) ||
    !optionalSafeCode(operation.lastErrorCode) ||
    !Number.isSafeInteger(operation.createdAt) ||
    (operation.createdAt as number) <= 0 ||
    (operation.createdAt as number) > MAX_DATE_EPOCH_SECONDS ||
    !Number.isSafeInteger(operation.updatedAt) ||
    (operation.updatedAt as number) < (operation.createdAt as number) ||
    (operation.updatedAt as number) > MAX_DATE_EPOCH_SECONDS ||
    !Array.isArray(operation.availableActions) ||
    operation.availableActions.length > OPERATION_ACTIONS.size ||
    operation.availableActions.some(
      (action) => typeof action !== 'string' || !OPERATION_ACTIONS.has(action)
    ) ||
    new Set(operation.availableActions).size !== operation.availableActions.length ||
    !Array.isArray(operation.steps) ||
    operation.steps.length > 64
  ) {
    throw new Error('control_plane_operation_invalid');
  }
  const steps = operation.steps.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('control_plane_operation_invalid');
    }
    const step = candidate as Record<string, unknown>;
    if (
      !exactKeys(step, OPERATION_STEP_KEYS) ||
      typeof step.stepKey !== 'string' ||
      !SAFE_ENVIRONMENT_ID.test(step.stepKey) ||
      !Number.isSafeInteger(step.displayOrder) ||
      (step.displayOrder as number) < 0 ||
      (step.displayOrder as number) > 10_000 ||
      typeof step.status !== 'string' ||
      ![
        'queued',
        'running',
        'waiting_retry',
        'succeeded',
        'blocked',
        'canceled',
        'skipped',
        'rolled_back',
      ].includes(step.status) ||
      !Number.isSafeInteger(step.attemptCount) ||
      (step.attemptCount as number) < 0 ||
      !optionalSafeEpoch(step.nextAttemptAt) ||
      !optionalSafeCode(step.lastErrorCode) ||
      (step.observedResourceId !== null &&
        (typeof step.observedResourceId !== 'string' ||
          !SAFE_IDEMPOTENCY_KEY.test(step.observedResourceId))) ||
      (step.progressCurrent !== null &&
        (!Number.isSafeInteger(step.progressCurrent) || (step.progressCurrent as number) < 0)) ||
      (step.progressTotal !== null &&
        (!Number.isSafeInteger(step.progressTotal) || (step.progressTotal as number) < 0)) ||
      (step.progressCurrent !== null &&
        step.progressTotal !== null &&
        (step.progressCurrent as number) > (step.progressTotal as number)) ||
      !optionalSafeEpoch(step.startedAt) ||
      !optionalSafeEpoch(step.completedAt) ||
      !Number.isSafeInteger(step.updatedAt) ||
      (step.updatedAt as number) <= 0 ||
      (step.updatedAt as number) > MAX_DATE_EPOCH_SECONDS
    ) {
      throw new Error('control_plane_operation_invalid');
    }
    return step;
  });
  if (
    new Set(steps.map((step) => step.stepKey)).size !== steps.length ||
    new Set(steps.map((step) => step.displayOrder)).size !== steps.length
  ) {
    throw new Error('control_plane_operation_invalid');
  }
  const actions = operation.availableActions as string[];
  if (
    (operation.status !== 'blocked' && actions.length > 0) ||
    (actions.includes('retry_create_d1') &&
      !steps.some((step) => step.stepKey === 'create_d1' && step.status === 'blocked')) ||
    (actions.includes('retry_apply_migrations') &&
      !steps.some((step) => step.stepKey === 'apply_migrations' && step.status === 'blocked')) ||
    (actions.includes('retry_reconcile_worker_bindings') &&
      !steps.some(
        (step) => step.stepKey === 'reconcile_worker_bindings' && step.status === 'blocked'
      )) ||
    (actions.includes('restore_previous_settings') &&
      !steps.some(
        (step) =>
          ['reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'].includes(
            step.stepKey as string
          ) && step.status === 'blocked'
      )) ||
    (actions.includes('cancel') && operation.operationKind !== 'provision_shard')
  ) {
    throw new Error('control_plane_operation_invalid');
  }
  assertControlPlaneRecordIsSecretFree(operation);
  return operation as unknown as ControlProvisioningOperationDetail;
}

function parseReviewBody(value: unknown): { disposition: 'reviewed' | 'dismissed' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, 'disposition') ||
    (body.disposition !== 'reviewed' && body.disposition !== 'dismissed')
  ) {
    return null;
  }
  return { disposition: body.disposition };
}

function parseLookupHmacMetadata(value: unknown): ControlLookupHmacKeyMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_lookup_hmac_metadata_invalid');
  }
  const metadata = value as Record<string, unknown>;
  if (
    !exactKeys(metadata, LOOKUP_HMAC_METADATA_KEYS) ||
    !Number.isSafeInteger(metadata.generation) ||
    (metadata.generation as number) < 1 ||
    typeof metadata.keyId !== 'string' ||
    !SAFE_ENVIRONMENT_ID.test(metadata.keyId) ||
    (metadata.slot !== 'A' && metadata.slot !== 'B') ||
    typeof metadata.fingerprint !== 'string' ||
    !HEX_DIGEST.test(metadata.fingerprint)
  ) {
    throw new Error('control_plane_lookup_hmac_metadata_invalid');
  }
  return metadata as unknown as ControlLookupHmacKeyMetadata;
}

function parseLookupHmacRotation(
  value: unknown,
  expectedOperationId?: string
): ControlLookupHmacRotationView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_lookup_hmac_rotation_invalid');
  }
  const rotation = value as Record<string, unknown>;
  if (
    !exactKeys(rotation, LOOKUP_HMAC_ROTATION_KEYS) ||
    typeof rotation.operationId !== 'string' ||
    !SAFE_ENVIRONMENT_ID.test(rotation.operationId) ||
    (expectedOperationId !== undefined && rotation.operationId !== expectedOperationId) ||
    typeof rotation.state !== 'string' ||
    !LOOKUP_HMAC_STATES.has(rotation.state) ||
    !rotation.checkpoint ||
    typeof rotation.checkpoint !== 'object' ||
    Array.isArray(rotation.checkpoint) ||
    JSON.stringify(rotation.checkpoint).length > 4096 ||
    (rotation.sourceRowCount !== null &&
      (!Number.isSafeInteger(rotation.sourceRowCount) ||
        (rotation.sourceRowCount as number) < 0)) ||
    (rotation.currentRowCount !== null &&
      (!Number.isSafeInteger(rotation.currentRowCount) ||
        (rotation.currentRowCount as number) < 0)) ||
    !Number.isSafeInteger(rotation.verificationAttemptCount) ||
    (rotation.verificationAttemptCount as number) < 0 ||
    !optionalSafeEpoch(rotation.graceExpiresAt) ||
    (rotation.ownerId !== null &&
      (typeof rotation.ownerId !== 'string' || !SAFE_ENVIRONMENT_ID.test(rotation.ownerId))) ||
    !Number.isSafeInteger(rotation.fencingToken) ||
    (rotation.fencingToken as number) < 1 ||
    !optionalSafeEpoch(rotation.leaseExpiresAt) ||
    typeof rotation.mutationStarted !== 'boolean' ||
    !Number.isSafeInteger(rotation.updatedAt) ||
    (rotation.updatedAt as number) < 1 ||
    (rotation.updatedAt as number) > MAX_DATE_EPOCH_SECONDS
  ) {
    throw new Error('control_plane_lookup_hmac_rotation_invalid');
  }
  const source = parseLookupHmacMetadata(rotation.source);
  const candidate = parseLookupHmacMetadata(rotation.candidate);
  if (
    candidate.generation !== source.generation + 1 ||
    candidate.slot === source.slot ||
    candidate.keyId === source.keyId ||
    candidate.fingerprint === source.fingerprint
  ) {
    throw new Error('control_plane_lookup_hmac_rotation_invalid');
  }
  assertControlPlaneRecordIsSecretFree(rotation);
  return rotation as unknown as ControlLookupHmacRotationView;
}

function lookupHmacOwner(actor: AdminAuthContext): string {
  const value = `admin:${actor.userId}`;
  if (!SAFE_ENVIRONMENT_ID.test(value)) {
    throw new Error('control_plane_lookup_hmac_actor_invalid');
  }
  return value;
}

function parseLookupHmacStartBody(value: unknown): { candidate: ControlLookupHmacKeyMetadata } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_lookup_hmac_request_invalid');
  }
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, new Set(['candidate']))) {
    throw new Error('control_plane_lookup_hmac_request_invalid');
  }
  return { candidate: parseLookupHmacMetadata(body.candidate) };
}

function parseLookupHmacMutationBody(value: unknown): { fencingToken: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_lookup_hmac_request_invalid');
  }
  const body = value as Record<string, unknown>;
  if (
    !exactKeys(body, new Set(['fencingToken'])) ||
    !Number.isSafeInteger(body.fencingToken) ||
    (body.fencingToken as number) < 1
  ) {
    throw new Error('control_plane_lookup_hmac_request_invalid');
  }
  return { fencingToken: body.fencingToken as number };
}

function parseLookupHmacVerificationStatus(
  value: unknown,
  expectedPhase: 'distribution' | 'generation'
): LookupHmacVerificationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_lookup_hmac_verification_invalid');
  }
  const status = value as Record<string, unknown>;
  if (
    !exactKeys(
      status,
      new Set(['phase', 'expected', 'succeeded', 'failed', 'pending', 'complete'])
    ) ||
    status.phase !== expectedPhase ||
    !Number.isSafeInteger(status.expected) ||
    (status.expected as number) < 1 ||
    !Number.isSafeInteger(status.succeeded) ||
    (status.succeeded as number) < 0 ||
    !Number.isSafeInteger(status.failed) ||
    (status.failed as number) < 0 ||
    (status.succeeded as number) + (status.failed as number) > (status.expected as number) ||
    !Array.isArray(status.pending) ||
    status.pending.length > (status.expected as number) ||
    status.pending.some((worker) => typeof worker !== 'string' || !SAFE_SCRIPT_NAME.test(worker)) ||
    new Set(status.pending).size !== status.pending.length ||
    typeof status.complete !== 'boolean' ||
    status.complete !== ((status.succeeded as number) === (status.expected as number))
  ) {
    throw new Error('control_plane_lookup_hmac_verification_invalid');
  }
  assertControlPlaneRecordIsSecretFree(status);
  return status as unknown as LookupHmacVerificationStatus;
}

function lookupHmacControlError(c: AdminContext, value: unknown): Response {
  const code = value instanceof Error ? value.message : '';
  if (code === 'lookup_hmac_rotation_not_found') {
    return error(c, 404, 'CONTROL_PLANE_LOOKUP_HMAC_ROTATION_NOT_FOUND');
  }
  if (
    code.startsWith('lookup_hmac_') ||
    code.startsWith('directory_rewrite_') ||
    code.startsWith('invalid_lookup_hmac_')
  ) {
    return error(c, 409, 'CONTROL_PLANE_LOOKUP_HMAC_ROTATION_CONFLICT');
  }
  return error(c, 503, 'CONTROL_PLANE_LOOKUP_HMAC_UNAVAILABLE');
}

function parseRetryBody(
  value: unknown
): Pick<ControlProvisioningOperationRetryRequest, 'stepKey'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, 'stepKey') ||
    (body.stepKey !== 'create_d1' &&
      body.stepKey !== 'apply_migrations' &&
      body.stepKey !== 'reconcile_worker_bindings')
  ) {
    return null;
  }
  return { stepKey: body.stepKey };
}

function parseCapacityProfileBody(value: unknown): ControlCapacityProfileRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    !exactKeys(body, new Set(['profile', 'scope', 'tenantId'])) ||
    !['minimum', 'recommended', 'extra_headroom'].includes(String(body.profile)) ||
    !['shared_pool', 'tenant_exclusive'].includes(String(body.scope)) ||
    (body.tenantId !== null &&
      (typeof body.tenantId !== 'string' || !SAFE_ENVIRONMENT_ID.test(body.tenantId))) ||
    (body.scope === 'shared_pool' && body.tenantId !== null) ||
    (body.scope === 'tenant_exclusive' && body.tenantId === null)
  ) {
    return null;
  }
  return body as unknown as ControlCapacityProfileRequest;
}

function capacityError(c: AdminContext, caught: unknown): Response {
  const code = caught instanceof Error ? caught.message : '';
  if (code === 'environment_d1_limit' || code === 'capacity_profile_unavailable') {
    return error(c, 409, 'CONTROL_PLANE_CAPACITY_UNAVAILABLE');
  }
  if (
    code.includes('tenant_placement_policy') ||
    code.includes('allocation_scope') ||
    code.includes('owner_tenant')
  ) {
    return error(c, 409, 'CONTROL_PLANE_CAPACITY_POLICY_CONFLICT');
  }
  return error(c, 503, 'CONTROL_PLANE_CAPACITY_UNAVAILABLE');
}

function parseProvisioningAuthorityStatus(value: unknown): ControlProvisioningAuthorityStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_provisioning_authority_invalid');
  }
  const status = value as Record<string, unknown>;
  if (
    !exactKeys(
      status,
      new Set([
        'automaticProvisioningEnabled',
        'tokenOwnership',
        'capabilityState',
        'automaticExecutionAvailable',
        'activeExecutor',
      ])
    ) ||
    typeof status.automaticProvisioningEnabled !== 'boolean' ||
    !['none', 'user', 'account'].includes(String(status.tokenOwnership)) ||
    !['disabled', 'pending', 'ready', 'blocked'].includes(String(status.capabilityState)) ||
    typeof status.automaticExecutionAvailable !== 'boolean' ||
    !['control', 'setup_operator'].includes(String(status.activeExecutor)) ||
    status.automaticExecutionAvailable !== (status.activeExecutor === 'control') ||
    (status.automaticProvisioningEnabled === false &&
      (status.tokenOwnership !== 'none' || status.capabilityState !== 'disabled'))
  ) {
    throw new Error('control_plane_provisioning_authority_invalid');
  }
  assertControlPlaneRecordIsSecretFree(status);
  return status as unknown as ControlProvisioningAuthorityStatus;
}

function parseShardCleanup(
  value: unknown,
  expectedEnvironmentId: string,
  expectedShardId?: string
): ControlShardCleanupView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_shard_cleanup_invalid');
  }
  const item = value as Record<string, unknown>;
  if (
    !exactKeys(item, SHARD_CLEANUP_KEYS) ||
    item.environmentId !== expectedEnvironmentId ||
    typeof item.shardId !== 'string' ||
    !SAFE_ENVIRONMENT_ID.test(item.shardId) ||
    (expectedShardId !== undefined && item.shardId !== expectedShardId) ||
    !['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(String(item.dataRole)) ||
    typeof item.residencyPartition !== 'string' ||
    !SAFE_ENVIRONMENT_ID.test(item.residencyPartition) ||
    typeof item.bindingRef !== 'string' ||
    !SAFE_D1_BINDING.test(item.bindingRef) ||
    typeof item.databaseId !== 'string' ||
    !SAFE_IDEMPOTENCY_KEY.test(item.databaseId) ||
    typeof item.databaseName !== 'string' ||
    !SAFE_DATABASE_NAME.test(item.databaseName) ||
    typeof item.shardStatus !== 'string' ||
    !['failed', 'retired', 'deleting', 'deleted'].includes(item.shardStatus) ||
    typeof item.quarantineState !== 'string' ||
    !['none', 'quarantining', 'quarantined'].includes(item.quarantineState) ||
    (item.quarantineOperationId !== null &&
      (typeof item.quarantineOperationId !== 'string' ||
        !SAFE_IDEMPOTENCY_KEY.test(item.quarantineOperationId))) ||
    (item.quarantineOperationState !== null &&
      (typeof item.quarantineOperationState !== 'string' ||
        !SHARD_QUARANTINE_STATES.has(item.quarantineOperationState))) ||
    (item.denyRegistryGeneration !== null &&
      (!Number.isSafeInteger(item.denyRegistryGeneration) ||
        (item.denyRegistryGeneration as number) < 0)) ||
    !optionalSafeEpoch(item.drainNotBefore) ||
    !optionalSafeEpoch(item.registryVerifiedAt) ||
    !optionalSafeEpoch(item.referencesVerifiedAt) ||
    (item.cleanupOperationId !== null &&
      (typeof item.cleanupOperationId !== 'string' ||
        !SAFE_IDEMPOTENCY_KEY.test(item.cleanupOperationId))) ||
    (item.cleanupState !== null &&
      (typeof item.cleanupState !== 'string' ||
        SHARD_CLEANUP_STATES.has(item.cleanupState) === false)) ||
    (item.exportMode !== null &&
      (typeof item.exportMode !== 'string' ||
        !['skipped', 'manual_verified'].includes(item.exportMode))) ||
    (item.deleteDatabase !== null && typeof item.deleteDatabase !== 'boolean') ||
    typeof item.destructiveOperationsEnabled !== 'boolean' ||
    !Array.isArray(item.availableActions) ||
    item.availableActions.length > SHARD_CLEANUP_ACTIONS.size ||
    item.availableActions.some(
      (action) => typeof action !== 'string' || !SHARD_CLEANUP_ACTIONS.has(action)
    ) ||
    new Set(item.availableActions).size !== item.availableActions.length ||
    !Array.isArray(item.bindings) ||
    item.bindings.length > 64 ||
    !optionalSafeCode(item.lastErrorCode) ||
    !Number.isSafeInteger(item.createdAt) ||
    (item.createdAt as number) < 1 ||
    (item.createdAt as number) > MAX_DATE_EPOCH_SECONDS ||
    !Number.isSafeInteger(item.updatedAt) ||
    (item.updatedAt as number) < (item.createdAt as number) ||
    (item.updatedAt as number) > MAX_DATE_EPOCH_SECONDS
  ) {
    throw new Error('control_plane_shard_cleanup_invalid');
  }

  const bindings = item.bindings.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('control_plane_shard_cleanup_invalid');
    }
    const binding = candidate as Record<string, unknown>;
    if (
      !exactKeys(binding, SHARD_CLEANUP_BINDING_KEYS) ||
      typeof binding.workerScriptName !== 'string' ||
      !SAFE_SCRIPT_NAME.test(binding.workerScriptName) ||
      binding.bindingRef !== item.bindingRef ||
      !['pending', 'removing', 'removed', 'blocked'].includes(String(binding.state)) ||
      !optionalSafeCode(binding.lastErrorCode) ||
      !Number.isSafeInteger(binding.updatedAt) ||
      (binding.updatedAt as number) < 1 ||
      (binding.updatedAt as number) > MAX_DATE_EPOCH_SECONDS
    ) {
      throw new Error('control_plane_shard_cleanup_invalid');
    }
    return binding;
  });
  if (new Set(bindings.map((binding) => binding.workerScriptName)).size !== bindings.length) {
    throw new Error('control_plane_shard_cleanup_invalid');
  }

  const actions = item.availableActions as string[];
  if (
    (item.quarantineState === 'none' &&
      (item.quarantineOperationId !== null ||
        item.quarantineOperationState !== null ||
        item.denyRegistryGeneration !== null ||
        item.drainNotBefore !== null)) ||
    (item.quarantineState !== 'none' &&
      (item.quarantineOperationId === null || item.quarantineOperationState === null)) ||
    (item.cleanupOperationId === null) !== (item.cleanupState === null) ||
    (item.cleanupOperationId === null &&
      (item.exportMode !== null || item.deleteDatabase !== null || bindings.length > 0)) ||
    (item.shardStatus === 'deleted' && item.cleanupState !== 'succeeded') ||
    (actions.includes('quarantine') && item.quarantineState !== 'none') ||
    (actions.includes('retry_quarantine') && item.quarantineOperationState !== 'blocked') ||
    (actions.includes('approve_cleanup') &&
      item.quarantineOperationState !== 'ready_for_cleanup') ||
    (actions.includes('retry_cleanup') && item.cleanupState !== 'blocked')
  ) {
    throw new Error('control_plane_shard_cleanup_invalid');
  }
  assertControlPlaneRecordIsSecretFree(item);
  return { ...(item as unknown as ControlShardCleanupView), bindings: bindings as never };
}

function parseShardCleanupList(
  value: unknown,
  expectedEnvironmentId: string
): ControlShardCleanupView[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('control_plane_shard_cleanup_invalid');
  }
  const items = value.map((item) => parseShardCleanup(item, expectedEnvironmentId));
  if (new Set(items.map((item) => item.shardId)).size !== items.length) {
    throw new Error('control_plane_shard_cleanup_invalid');
  }
  return items;
}

function parseTenantDisasterRecovery(
  value: unknown,
  expectedEnvironmentId: string,
  expectedOperationId?: string
): ControlTenantDisasterRecoveryView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_tenant_dr_invalid');
  }
  const recovery = value as Record<string, unknown>;
  const lookupProgress = recovery.lookupReprojection as Record<string, unknown> | undefined;
  if (
    !exactKeys(recovery, TENANT_DR_KEYS) ||
    recovery.environmentId !== expectedEnvironmentId ||
    (expectedOperationId !== undefined && recovery.operationId !== expectedOperationId) ||
    typeof recovery.operationId !== 'string' ||
    !SAFE_IDEMPOTENCY_KEY.test(recovery.operationId) ||
    typeof recovery.tenantId !== 'string' ||
    !SAFE_IDEMPOTENCY_KEY.test(recovery.tenantId) ||
    typeof recovery.state !== 'string' ||
    !TENANT_DR_STATES.has(recovery.state) ||
    !Number.isSafeInteger(recovery.pinnedRouteGeneration) ||
    (recovery.pinnedRouteGeneration as number) < 1 ||
    !optionalSafeEpoch(recovery.denyRuntimeGeneration) ||
    !optionalSafeEpoch(recovery.denyRegistryGeneration) ||
    !optionalSafeEpoch(recovery.denyObservedAt) ||
    !optionalSafeEpoch(recovery.drainNotBefore) ||
    typeof recovery.restoreReferenceRecorded !== 'boolean' ||
    !optionalSafeEpoch(recovery.restoredAt) ||
    !optionalSafeEpoch(recovery.migrationVerifiedAt) ||
    !optionalSafeEpoch(recovery.lookupReprojectedAt) ||
    !lookupProgress ||
    Array.isArray(lookupProgress) ||
    !exactKeys(lookupProgress, TENANT_DR_LOOKUP_PROGRESS_KEYS) ||
    typeof lookupProgress.stage !== 'string' ||
    !TENANT_DR_LOOKUP_STAGES.has(lookupProgress.stage) ||
    !Number.isSafeInteger(lookupProgress.targetIndex) ||
    (lookupProgress.targetIndex as number) < 0 ||
    (lookupProgress.targetIndex as number) > 4096 ||
    !Number.isSafeInteger(lookupProgress.afterCreatedAt) ||
    (lookupProgress.afterCreatedAt as number) < 0 ||
    typeof lookupProgress.afterId !== 'string' ||
    (lookupProgress.afterId !== '' && !SAFE_IDEMPOTENCY_KEY.test(lookupProgress.afterId)) ||
    !Number.isSafeInteger(lookupProgress.afterRowId) ||
    (lookupProgress.afterRowId as number) < 0 ||
    !Number.isSafeInteger(lookupProgress.projectedRows) ||
    (lookupProgress.projectedRows as number) < 0 ||
    !Number.isSafeInteger(lookupProgress.verifiedRows) ||
    (lookupProgress.verifiedRows as number) < 0 ||
    typeof lookupProgress.registryDigestPinned !== 'boolean' ||
    typeof lookupProgress.leaseActive !== 'boolean' ||
    !optionalSafeEpoch(recovery.bindingSmokeVerifiedAt) ||
    !optionalSafeEpoch(recovery.reactivatedRuntimeGeneration) ||
    !optionalSafeEpoch(recovery.reactivatedAt) ||
    !optionalSafeCode(recovery.lastErrorCode) ||
    typeof recovery.canCancel !== 'boolean' ||
    typeof recovery.canConfirmRestore !== 'boolean' ||
    typeof recovery.canVerify !== 'boolean' ||
    typeof recovery.canReactivate !== 'boolean' ||
    !Number.isSafeInteger(recovery.createdAt) ||
    !Number.isSafeInteger(recovery.updatedAt) ||
    !Array.isArray(recovery.targets) ||
    recovery.targets.length < 1 ||
    recovery.targets.length > 100
  ) {
    throw new Error('control_plane_tenant_dr_invalid');
  }
  const targets = recovery.targets.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('control_plane_tenant_dr_invalid');
    }
    const target = value as Record<string, unknown>;
    if (
      !exactKeys(target, TENANT_DR_TARGET_KEYS) ||
      typeof target.shardId !== 'string' ||
      !SAFE_IDEMPOTENCY_KEY.test(target.shardId) ||
      (target.dataRole !== 'tenant_core/default' &&
        target.dataRole !== 'tenant_core/users' &&
        target.dataRole !== 'tenant_pii') ||
      typeof target.residencyPartition !== 'string' ||
      !SAFE_ENVIRONMENT_ID.test(target.residencyPartition) ||
      !Number.isSafeInteger(target.assignmentGeneration) ||
      (target.assignmentGeneration as number) < 1 ||
      !Number.isSafeInteger(target.shardGeneration) ||
      (target.shardGeneration as number) < 1 ||
      typeof target.bindingRef !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(target.bindingRef) ||
      typeof target.providerDatabaseId !== 'string' ||
      !SAFE_IDEMPOTENCY_KEY.test(target.providerDatabaseId) ||
      (target.migrationStreamId !== 'd1-core' && target.migrationStreamId !== 'd1-pii') ||
      typeof target.releaseId !== 'string' ||
      !SAFE_IDEMPOTENCY_KEY.test(target.releaseId) ||
      typeof target.manifestDigest !== 'string' ||
      !HEX_DIGEST.test(target.manifestDigest) ||
      !optionalSafeEpoch(target.restoreConfirmedAt) ||
      !optionalSafeEpoch(target.migrationVerifiedAt) ||
      !optionalSafeEpoch(target.lookupReprojectedAt) ||
      !optionalSafeEpoch(target.bindingSmokeVerifiedAt)
    ) {
      throw new Error('control_plane_tenant_dr_invalid');
    }
    return target;
  });
  if (new Set(targets.map((target) => target.shardId)).size !== targets.length) {
    throw new Error('control_plane_tenant_dr_invalid');
  }
  assertControlPlaneRecordIsSecretFree(recovery);
  return {
    ...(recovery as unknown as ControlTenantDisasterRecoveryView),
    targets: targets as never,
  };
}

function tenantDrEvidence(recovery: ControlTenantDisasterRecoveryView) {
  return recovery.targets.map((target) => ({
    shardId: target.shardId,
    providerDatabaseId: target.providerDatabaseId,
    shardGeneration: target.shardGeneration,
    bindingRef: target.bindingRef,
    releaseId: target.releaseId,
    manifestDigest: target.manifestDigest,
  }));
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseExactEmptyBody(value: unknown): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw new Error('control_plane_shard_cleanup_request_invalid');
  }
}

function parseOperationReferenceBody(
  value: unknown,
  key: 'quarantineOperationId' | 'cleanupOperationId'
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_shard_cleanup_request_invalid');
  }
  const body = value as Record<string, unknown>;
  if (
    !exactKeys(body, new Set([key])) ||
    typeof body[key] !== 'string' ||
    !SAFE_IDEMPOTENCY_KEY.test(body[key])
  ) {
    throw new Error('control_plane_shard_cleanup_request_invalid');
  }
  return body[key];
}

function parseCleanupApprovalBody(
  value: unknown
): Pick<
  ControlShardCleanupApprovalRequest,
  'quarantineOperationId' | 'confirmation' | 'exportMode' | 'exportEvidenceId' | 'deleteDatabase'
> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_plane_shard_cleanup_request_invalid');
  }
  const body = value as Record<string, unknown>;
  if (
    !exactKeys(
      body,
      new Set([
        'quarantineOperationId',
        'confirmation',
        'exportMode',
        'exportEvidenceId',
        'deleteDatabase',
      ])
    ) ||
    typeof body.quarantineOperationId !== 'string' ||
    !SAFE_IDEMPOTENCY_KEY.test(body.quarantineOperationId) ||
    body.confirmation !== 'DELETE_RETIRED_TENANT_SHARD' ||
    !['skipped', 'manual_verified'].includes(String(body.exportMode)) ||
    (body.exportEvidenceId !== null &&
      (typeof body.exportEvidenceId !== 'string' ||
        !SAFE_IDEMPOTENCY_KEY.test(body.exportEvidenceId))) ||
    (body.exportMode === 'manual_verified' && body.exportEvidenceId === null) ||
    (body.exportMode === 'skipped' && body.exportEvidenceId !== null) ||
    typeof body.deleteDatabase !== 'boolean'
  ) {
    throw new Error('control_plane_shard_cleanup_request_invalid');
  }
  return body as unknown as Pick<
    ControlShardCleanupApprovalRequest,
    'quarantineOperationId' | 'confirmation' | 'exportMode' | 'exportEvidenceId' | 'deleteDatabase'
  >;
}

function shardCleanupControlError(c: AdminContext, value: unknown): Response {
  const code = value instanceof Error ? value.message : '';
  if (code.endsWith('_not_found')) {
    return error(c, 404, 'CONTROL_PLANE_SHARD_CLEANUP_NOT_FOUND');
  }
  if (
    code.includes('_conflict') ||
    code.includes('_not_allowed') ||
    code.includes('_not_ready') ||
    code.includes('_incomplete') ||
    code.includes('_disabled') ||
    code.includes('_still_') ||
    code.includes('_mismatch') ||
    code.includes('_stale')
  ) {
    return error(c, 409, 'CONTROL_PLANE_SHARD_CLEANUP_CONFLICT');
  }
  return error(c, 503, 'CONTROL_PLANE_SHARD_CLEANUP_UNAVAILABLE');
}

function tenantDrControlError(c: AdminContext, value: unknown): Response {
  const code = value instanceof Error ? value.message : '';
  if (code.endsWith('_not_found')) return error(c, 404, 'CONTROL_PLANE_TENANT_DR_NOT_FOUND');
  if (
    code.includes('_conflict') ||
    code.includes('_not_allowed') ||
    code.includes('_mismatch') ||
    code.includes('_stale') ||
    code.includes('_missing')
  ) {
    return error(c, 409, 'CONTROL_PLANE_TENANT_DR_CONFLICT');
  }
  return error(c, 503, 'CONTROL_PLANE_TENANT_DR_UNAVAILABLE');
}

controlPlaneOperationsRouter.post('/lookup-hmac/rotations', async (c) => {
  const actor = auth(c);
  if (!hasControlPlanePermission(actor, 'rotate')) {
    return error(c, 403, 'CONTROL_PLANE_ROTATE_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.startLookupHmacRotation) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const idempotencyKey = c.req.header('Idempotency-Key');
  let body: ReturnType<typeof parseLookupHmacStartBody>;
  try {
    environmentId(c.env);
    if (!idempotencyKey || !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error();
    body = parseLookupHmacStartBody(await c.req.json());
  } catch {
    return error(c, 400, 'CONTROL_PLANE_LOOKUP_HMAC_INVALID_REQUEST');
  }
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.lookup_hmac.rotation_start_requested',
      resourceType: 'lookup_hmac_key',
      resourceId: body.candidate.keyId,
      result: 'success',
      after: {
        generation: body.candidate.generation,
        slot: body.candidate.slot,
        fingerprint: body.candidate.fingerprint,
      },
      metadata: { execution: 'control_service_binding', idempotencyKey },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    const rotation = parseLookupHmacRotation(
      await control.startLookupHmacRotation({
        candidate: body.candidate,
        idempotencyKey,
        ownerId: lookupHmacOwner(actor),
      })
    );
    return c.json({ rotation, auditId }, 202);
  } catch (cause) {
    return lookupHmacControlError(c, cause);
  }
});

controlPlaneOperationsRouter.get('/lookup-hmac/rotations/:operationId', async (c) => {
  const actor = auth(c);
  if (!hasControlPlanePermission(actor, 'read')) {
    return error(c, 403, 'CONTROL_PLANE_READ_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  const lookupControl = control as
    | (NonNullable<Env['CONTROL']> & {
        getLookupHmacRotation?: (input: {
          operationId: string;
        }) => Promise<ControlLookupHmacRotationView | null>;
      })
    | undefined;
  if (!lookupControl?.getLookupHmacRotation) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const operationId = c.req.param('operationId');
  if (!SAFE_ENVIRONMENT_ID.test(operationId)) {
    return error(c, 400, 'CONTROL_PLANE_LOOKUP_HMAC_INVALID_REQUEST');
  }
  try {
    environmentId(c.env);
    const value = await lookupControl.getLookupHmacRotation({ operationId });
    if (!value) return error(c, 404, 'CONTROL_PLANE_LOOKUP_HMAC_ROTATION_NOT_FOUND');
    return c.json({ rotation: parseLookupHmacRotation(value, operationId) });
  } catch (cause) {
    return lookupHmacControlError(c, cause);
  }
});

controlPlaneOperationsRouter.get(
  '/lookup-hmac/rotations/:operationId/verifications/:phase',
  async (c) => {
    const actor = auth(c);
    if (!hasControlPlanePermission(actor, 'read')) {
      return error(c, 403, 'CONTROL_PLANE_READ_AUTHORITY_REQUIRED');
    }
    const phase = c.req.param('phase');
    const operationId = c.req.param('operationId');
    if (
      (phase !== 'distribution' && phase !== 'generation') ||
      !SAFE_ENVIRONMENT_ID.test(operationId)
    ) {
      return error(c, 400, 'CONTROL_PLANE_LOOKUP_HMAC_INVALID_REQUEST');
    }
    const control = c.env.CONTROL as
      | (NonNullable<Env['CONTROL']> & {
          getLookupHmacVerificationStatus?: (input: {
            operationId: string;
            phase: 'distribution' | 'generation';
          }) => Promise<LookupHmacVerificationStatus>;
        })
      | undefined;
    if (!control?.getLookupHmacVerificationStatus) {
      return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
    }
    try {
      environmentId(c.env);
      const status = parseLookupHmacVerificationStatus(
        await control.getLookupHmacVerificationStatus({ operationId, phase }),
        phase
      );
      return c.json({ status });
    } catch (cause) {
      return lookupHmacControlError(c, cause);
    }
  }
);

controlPlaneOperationsRouter.post('/lookup-hmac/rotations/:operationId/activate', async (c) => {
  const actor = auth(c);
  if (!hasControlPlanePermission(actor, 'rotate')) {
    return error(c, 403, 'CONTROL_PLANE_ROTATE_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.activateLookupHmacRotation) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const operationId = c.req.param('operationId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  let body: ReturnType<typeof parseLookupHmacMutationBody>;
  try {
    environmentId(c.env);
    if (
      !SAFE_ENVIRONMENT_ID.test(operationId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    body = parseLookupHmacMutationBody(await c.req.json());
  } catch {
    return error(c, 400, 'CONTROL_PLANE_LOOKUP_HMAC_INVALID_REQUEST');
  }
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.lookup_hmac.rotation_activation_requested',
      resourceType: 'lookup_hmac_rotation',
      resourceId: operationId,
      result: 'success',
      before: { state: 'distributing' },
      after: { state: 'activation_dual_write' },
      metadata: { execution: 'control_service_binding', idempotencyKey },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    const rotation = parseLookupHmacRotation(
      await control.activateLookupHmacRotation({
        operationId,
        ownerId: lookupHmacOwner(actor),
        fencingToken: body.fencingToken,
      }),
      operationId
    );
    return c.json({ rotation, auditId });
  } catch (cause) {
    return lookupHmacControlError(c, cause);
  }
});

controlPlaneOperationsRouter.post(
  '/lookup-hmac/rotations/:operationId/observe-generation',
  async (c) => {
    const actor = auth(c);
    if (!hasControlPlanePermission(actor, 'rotate')) {
      return error(c, 403, 'CONTROL_PLANE_ROTATE_AUTHORITY_REQUIRED');
    }
    const control = c.env.CONTROL;
    if (!control?.observeLookupHmacRotationGeneration) {
      return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
    }
    const operationId = c.req.param('operationId');
    const idempotencyKey = c.req.header('Idempotency-Key');
    let body: ReturnType<typeof parseLookupHmacMutationBody>;
    try {
      environmentId(c.env);
      if (
        !SAFE_ENVIRONMENT_ID.test(operationId) ||
        !idempotencyKey ||
        !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
      ) {
        throw new Error();
      }
      body = parseLookupHmacMutationBody(await c.req.json());
    } catch {
      return error(c, 400, 'CONTROL_PLANE_LOOKUP_HMAC_INVALID_REQUEST');
    }
    let auditId: string | null;
    try {
      auditId = await writeAdminAuditLog(c, {
        action: 'control_plane.lookup_hmac.rotation_generation_observed',
        resourceType: 'lookup_hmac_rotation',
        resourceId: operationId,
        result: 'success',
        before: { state: 'activation_dual_write' },
        after: { state: 'dual_read' },
        metadata: { execution: 'control_service_binding', idempotencyKey },
      });
    } catch {
      auditId = null;
    }
    if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
    try {
      const rotation = parseLookupHmacRotation(
        await control.observeLookupHmacRotationGeneration({
          operationId,
          ownerId: lookupHmacOwner(actor),
          fencingToken: body.fencingToken,
        }),
        operationId
      );
      return c.json({ rotation, auditId });
    } catch (cause) {
      return lookupHmacControlError(c, cause);
    }
  }
);

controlPlaneOperationsRouter.post('/tenant-recovery', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (
    !control?.startTenantDisasterRecovery ||
    !control.observeTenantDisasterRecoveryDeny ||
    !control.getTenantPlacementPolicy ||
    !control.activateTenantPlacementPolicy
  ) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const idempotencyKey = c.req.header('Idempotency-Key');
  let tenantId: string;
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const body = value as Record<string, unknown>;
    if (
      !exactKeys(body, new Set(['tenantId', 'confirmation'])) ||
      typeof body.tenantId !== 'string' ||
      !SAFE_IDEMPOTENCY_KEY.test(body.tenantId) ||
      body.confirmation !== `START_TENANT_RECOVERY:${body.tenantId}` ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    tenantId = body.tenantId;
  } catch {
    return error(c, 400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
  }
  const expectedEnvironmentId = environmentId(c.env);
  try {
    const policy = await control.getTenantPlacementPolicy(tenantId);
    if (!policy || policy.tenantId !== tenantId || policy.state !== 'active') {
      return error(c, 409, 'CONTROL_PLANE_TENANT_DR_ACTIVE_ROUTE_REQUIRED');
    }
    const runtimeRoute = await resolveActiveTenantRuntimeRouteObservation(c.env, tenantId);
    await control.activateTenantPlacementPolicy({
      tenantId,
      sourceOperationId: policy.sourceOperationId,
      idempotencyKey: `tenant-dr-route-observation:${tenantId}:${runtimeRoute.runtimeGeneration}`,
      runtimeRoute,
    });
  } catch (cause) {
    return tenantDrControlError(c, cause);
  }
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.tenant_recovery.requested',
      resourceType: 'tenant',
      resourceId: tenantId,
      result: 'success',
      before: { routeStatus: 'active' },
      after: { routeStatus: 'quarantining' },
      metadata: { execution: 'control_service_binding', manualRestore: true },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    let recovery = parseTenantDisasterRecovery(
      await control.startTenantDisasterRecovery({
        tenantId,
        requestedById: actor.userId,
        reasonCode: 'operator_disaster_recovery',
        idempotencyKey,
      }),
      expectedEnvironmentId
    );
    if (recovery.state === 'publishing_deny') {
      const deny = await publishTenantRuntimeRegistryRouteState(c.env, {
        tenantId,
        routeStatus: 'quarantining',
        operationId: recovery.operationId,
        actorId: actor.userId,
      });
      recovery = parseTenantDisasterRecovery(
        await control.observeTenantDisasterRecoveryDeny({
          operationId: recovery.operationId,
          runtimeGeneration: deny.runtimeGeneration,
          denyRegistryGeneration: deny.quarantineDenyGeneration,
        }),
        expectedEnvironmentId,
        recovery.operationId
      );
    }
    return c.json({ recovery, auditId }, 202);
  } catch (cause) {
    return tenantDrControlError(c, cause);
  }
});

controlPlaneOperationsRouter.get('/tenant-recovery/:operationId', async (c) => {
  if (!hasPlatformAuthority(auth(c))) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  const operationId = c.req.param('operationId');
  if (!control?.getTenantDisasterRecovery) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  if (!SAFE_IDEMPOTENCY_KEY.test(operationId)) {
    return error(c, 400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
  }
  try {
    const value = await control.getTenantDisasterRecovery(operationId);
    if (!value) return error(c, 404, 'CONTROL_PLANE_TENANT_DR_NOT_FOUND');
    return c.json({
      recovery: parseTenantDisasterRecovery(value, environmentId(c.env), operationId),
    });
  } catch (cause) {
    return tenantDrControlError(c, cause);
  }
});

controlPlaneOperationsRouter.post('/tenant-recovery/:operationId/confirm-restore', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  const operationId = c.req.param('operationId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!control?.getTenantDisasterRecovery || !control.confirmTenantDisasterRecoveryRestore) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  let restoreReference: string;
  let restoredAt: number;
  let confirmation: string;
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const body = value as Record<string, unknown>;
    if (
      !exactKeys(body, new Set(['restoreReference', 'restoredAt', 'confirmation'])) ||
      typeof body.restoreReference !== 'string' ||
      body.restoreReference.length < 1 ||
      body.restoreReference.length > 512 ||
      Array.from(body.restoreReference).some((character) => character.charCodeAt(0) < 0x20) ||
      !Number.isSafeInteger(body.restoredAt) ||
      typeof body.confirmation !== 'string' ||
      !SAFE_IDEMPOTENCY_KEY.test(operationId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    restoreReference = body.restoreReference;
    restoredAt = body.restoredAt as number;
    confirmation = body.confirmation;
  } catch {
    return error(c, 400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
  }
  try {
    const expectedEnvironmentId = environmentId(c.env);
    const currentValue = await control.getTenantDisasterRecovery(operationId);
    if (!currentValue) return error(c, 404, 'CONTROL_PLANE_TENANT_DR_NOT_FOUND');
    const current = parseTenantDisasterRecovery(currentValue, expectedEnvironmentId, operationId);
    if (confirmation !== `RESTORE_COMPLETED:${current.tenantId}`) {
      return error(c, 400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
    }
    const restoreReferenceDigest = await sha256Text(restoreReference);
    let auditId: string | null;
    try {
      auditId = await writeAdminAuditLog(c, {
        action: 'control_plane.tenant_recovery.restore_confirmed',
        resourceType: 'tenant',
        resourceId: current.tenantId,
        result: 'success',
        before: { state: current.state },
        after: { state: 'verifying_restore' },
        metadata: { restoreReferenceRecorded: true, restoredAt },
      });
    } catch {
      auditId = null;
    }
    if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
    const recovery = parseTenantDisasterRecovery(
      await control.confirmTenantDisasterRecoveryRestore({
        operationId,
        restoreReferenceDigest,
        restoredAt,
        requestedById: actor.userId,
        idempotencyKey,
      }),
      expectedEnvironmentId,
      operationId
    );
    return c.json({ recovery, auditId }, 202);
  } catch (cause) {
    return tenantDrControlError(c, cause);
  }
});

controlPlaneOperationsRouter.post('/tenant-recovery/:operationId/verify', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  const operationId = c.req.param('operationId');
  if (!control?.getTenantDisasterRecovery || !control.recordTenantDisasterRecoveryVerification) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  let stage: 'migration' | 'lookup_reprojection' | 'binding_smoke';
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const body = value as Record<string, unknown>;
    if (
      !exactKeys(body, new Set(['stage'])) ||
      body.stage !== 'migration' ||
      !SAFE_IDEMPOTENCY_KEY.test(operationId)
    ) {
      throw new Error();
    }
    stage = body.stage;
  } catch {
    return error(c, 400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
  }
  try {
    const expectedEnvironmentId = environmentId(c.env);
    const currentValue = await control.getTenantDisasterRecovery(operationId);
    if (!currentValue) return error(c, 404, 'CONTROL_PLANE_TENANT_DR_NOT_FOUND');
    const current = parseTenantDisasterRecovery(currentValue, expectedEnvironmentId, operationId);
    let auditId: string | null;
    try {
      auditId = await writeAdminAuditLog(c, {
        action: 'control_plane.tenant_recovery.migration_verification_requested',
        resourceType: 'tenant',
        resourceId: current.tenantId,
        result: 'success',
        before: { state: current.state },
        after: { state: 'reprojecting_lookup' },
        metadata: {
          operationId,
          pinnedRouteGeneration: current.pinnedRouteGeneration,
          targetCount: current.targets.length,
        },
      });
    } catch {
      auditId = null;
    }
    if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
    const recovery = parseTenantDisasterRecovery(
      await control.recordTenantDisasterRecoveryVerification({
        operationId,
        stage,
        pinnedRouteGeneration: current.pinnedRouteGeneration,
        targets: tenantDrEvidence(current),
      }),
      expectedEnvironmentId,
      operationId
    );
    return c.json({ recovery, auditId }, 202);
  } catch (cause) {
    return tenantDrControlError(c, cause);
  }
});

controlPlaneOperationsRouter.post('/tenant-recovery/:operationId/reactivate', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  const operationId = c.req.param('operationId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (
    !control?.getTenantDisasterRecovery ||
    !control.requestTenantDisasterRecoveryReactivation ||
    !control.completeTenantDisasterRecoveryReactivation
  ) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  let confirmation: string;
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const body = value as Record<string, unknown>;
    if (
      !exactKeys(body, new Set(['confirmation'])) ||
      typeof body.confirmation !== 'string' ||
      !SAFE_IDEMPOTENCY_KEY.test(operationId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    confirmation = body.confirmation;
  } catch {
    return error(c, 400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
  }
  try {
    const expectedEnvironmentId = environmentId(c.env);
    const currentValue = await control.getTenantDisasterRecovery(operationId);
    if (!currentValue) return error(c, 404, 'CONTROL_PLANE_TENANT_DR_NOT_FOUND');
    const current = parseTenantDisasterRecovery(currentValue, expectedEnvironmentId, operationId);
    if (confirmation !== `REACTIVATE_RECOVERED_TENANT:${current.tenantId}`) {
      return error(c, 400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
    }
    let auditId: string | null;
    try {
      auditId = await writeAdminAuditLog(c, {
        action: 'control_plane.tenant_recovery.reactivation_requested',
        resourceType: 'tenant',
        resourceId: current.tenantId,
        result: 'success',
        before: { state: current.state },
        after: { state: 'reactivating' },
        metadata: {
          operationId,
          pinnedRouteGeneration: current.pinnedRouteGeneration,
        },
      });
    } catch {
      auditId = null;
    }
    if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
    const pending = parseTenantDisasterRecovery(
      await control.requestTenantDisasterRecoveryReactivation({
        operationId,
        requestedById: actor.userId,
        reasonCode: 'operator_reactivate_recovered_tenant',
        idempotencyKey,
      }),
      expectedEnvironmentId,
      operationId
    );
    if (pending.denyRegistryGeneration === null) {
      throw new Error('control_tenant_dr_deny_generation_missing');
    }
    const publication = await publishTenantRuntimeRegistryReactivation(c.env, {
      tenantId: pending.tenantId,
      operationId,
      actorId: actor.userId,
      expectedQuarantineDenyGeneration: pending.denyRegistryGeneration,
    });
    const recovery = parseTenantDisasterRecovery(
      await control.completeTenantDisasterRecoveryReactivation({
        operationId,
        runtimeGeneration: publication.runtimeGeneration,
        pinnedRouteGeneration: pending.pinnedRouteGeneration,
      }),
      expectedEnvironmentId,
      operationId
    );
    return c.json({ recovery, auditId });
  } catch (cause) {
    return tenantDrControlError(c, cause);
  }
});

controlPlaneOperationsRouter.get('/shard-cleanup', async (c) => {
  if (!hasPlatformAuthority(auth(c))) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.listShardCleanupCandidates) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  try {
    const expectedEnvironmentId = environmentId(c.env);
    const items = parseShardCleanupList(
      await control.listShardCleanupCandidates(),
      expectedEnvironmentId
    );
    return c.json({ items, count: items.length });
  } catch {
    return error(c, 503, 'CONTROL_PLANE_SHARD_CLEANUP_STATUS_UNAVAILABLE');
  }
});

controlPlaneOperationsRouter.get('/shard-cleanup/:shardId', async (c) => {
  if (!hasPlatformAuthority(auth(c))) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.getShardCleanupCandidate) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const shardId = c.req.param('shardId');
  if (!SAFE_ENVIRONMENT_ID.test(shardId)) {
    return error(c, 400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
  }
  try {
    const expectedEnvironmentId = environmentId(c.env);
    const value = await control.getShardCleanupCandidate(shardId);
    if (value === null) return error(c, 404, 'CONTROL_PLANE_SHARD_CLEANUP_NOT_FOUND');
    return c.json({ candidate: parseShardCleanup(value, expectedEnvironmentId, shardId) });
  } catch {
    return error(c, 503, 'CONTROL_PLANE_SHARD_CLEANUP_STATUS_UNAVAILABLE');
  }
});

controlPlaneOperationsRouter.post('/shard-cleanup/:shardId/quarantine', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.quarantineShard) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const shardId = c.req.param('shardId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  let expectedEnvironmentId: string;
  try {
    expectedEnvironmentId = environmentId(c.env);
    if (
      !SAFE_ENVIRONMENT_ID.test(shardId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    parseExactEmptyBody(await c.req.json());
  } catch {
    return error(c, 400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
  }
  const request: ControlShardQuarantineRequest = {
    shardId,
    requestedById: actor.userId,
    reasonCode: 'operator_quarantine',
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.shard.quarantine_requested',
      resourceType: 'assignment_shard',
      resourceId: shardId,
      result: 'success',
      before: { quarantineState: 'none' },
      after: { quarantineState: 'quarantining' },
      metadata: { execution: 'control_service_binding', reasonCode: request.reasonCode },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    const candidate = parseShardCleanup(
      await control.quarantineShard(request),
      expectedEnvironmentId,
      shardId
    );
    return c.json({ candidate, auditId }, 202);
  } catch (cause) {
    return shardCleanupControlError(c, cause);
  }
});

controlPlaneOperationsRouter.post('/shard-cleanup/:shardId/retry-quarantine', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.retryShardQuarantine) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const shardId = c.req.param('shardId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  let expectedEnvironmentId: string;
  let quarantineOperationId: string;
  try {
    expectedEnvironmentId = environmentId(c.env);
    if (
      !SAFE_ENVIRONMENT_ID.test(shardId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    quarantineOperationId = parseOperationReferenceBody(
      await c.req.json(),
      'quarantineOperationId'
    );
  } catch {
    return error(c, 400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
  }
  const request: ControlShardQuarantineRetryRequest = {
    quarantineOperationId,
    requestedById: actor.userId,
    reasonCode: 'operator_retry_quarantine',
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.shard.quarantine_retry_requested',
      resourceType: 'assignment_shard',
      resourceId: shardId,
      result: 'success',
      before: { quarantineState: 'blocked' },
      after: { quarantineState: 'quarantining' },
      metadata: {
        execution: 'control_service_binding',
        quarantineOperationId,
        reasonCode: request.reasonCode,
      },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    const candidate = parseShardCleanup(
      await control.retryShardQuarantine(request),
      expectedEnvironmentId,
      shardId
    );
    return c.json({ candidate, auditId }, 202);
  } catch (cause) {
    return shardCleanupControlError(c, cause);
  }
});

controlPlaneOperationsRouter.post('/shard-cleanup/:shardId/approve', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.approveShardCleanup) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const shardId = c.req.param('shardId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  let expectedEnvironmentId: string;
  let body: ReturnType<typeof parseCleanupApprovalBody>;
  try {
    expectedEnvironmentId = environmentId(c.env);
    if (
      !SAFE_ENVIRONMENT_ID.test(shardId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    body = parseCleanupApprovalBody(await c.req.json());
  } catch {
    return error(c, 400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
  }
  const request: ControlShardCleanupApprovalRequest = {
    ...body,
    requestedById: actor.userId,
    reasonCode: 'operator_approve_cleanup',
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.shard.cleanup_approved',
      resourceType: 'assignment_shard',
      resourceId: shardId,
      result: 'success',
      before: { cleanupState: null, quarantineState: 'ready_for_cleanup' },
      after: { cleanupState: 'approved', deleteDatabase: body.deleteDatabase },
      metadata: {
        execution: 'control_service_binding',
        exportMode: body.exportMode,
        exportEvidencePresent: body.exportEvidenceId !== null,
        reasonCode: request.reasonCode,
      },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    const candidate = parseShardCleanup(
      await control.approveShardCleanup(request),
      expectedEnvironmentId,
      shardId
    );
    return c.json({ candidate, auditId }, 202);
  } catch (cause) {
    return shardCleanupControlError(c, cause);
  }
});

controlPlaneOperationsRouter.post('/shard-cleanup/:shardId/retry-cleanup', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.retryShardCleanup) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const shardId = c.req.param('shardId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  let expectedEnvironmentId: string;
  let cleanupOperationId: string;
  try {
    expectedEnvironmentId = environmentId(c.env);
    if (
      !SAFE_ENVIRONMENT_ID.test(shardId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      throw new Error();
    }
    cleanupOperationId = parseOperationReferenceBody(await c.req.json(), 'cleanupOperationId');
  } catch {
    return error(c, 400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
  }
  const request: ControlShardCleanupRetryRequest = {
    cleanupOperationId,
    requestedById: actor.userId,
    reasonCode: 'operator_retry_cleanup',
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.shard.cleanup_retry_requested',
      resourceType: 'assignment_shard',
      resourceId: shardId,
      result: 'success',
      before: { cleanupState: 'blocked' },
      after: { cleanupState: 'approved' },
      metadata: {
        execution: 'control_service_binding',
        cleanupOperationId,
        reasonCode: request.reasonCode,
      },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    const candidate = parseShardCleanup(
      await control.retryShardCleanup(request),
      expectedEnvironmentId,
      shardId
    );
    return c.json({ candidate, auditId }, 202);
  } catch (cause) {
    return shardCleanupControlError(c, cause);
  }
});

controlPlaneOperationsRouter.get('/drift-findings', async (c) => {
  if (!hasPlatformAuthority(auth(c))) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.listWorkerInventoryDriftFindings) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  try {
    const expectedEnvironmentId = environmentId(c.env);
    const items = parseFindings(
      await control.listWorkerInventoryDriftFindings(),
      expectedEnvironmentId
    );
    return c.json({ items, count: items.length });
  } catch {
    return error(c, 503, 'CONTROL_PLANE_DRIFT_STATUS_UNAVAILABLE');
  }
});

controlPlaneOperationsRouter.get('/provisioning-authority', async (c) => {
  if (!hasPlatformAuthority(auth(c))) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.getProvisioningAuthorityStatus) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  try {
    environmentId(c.env);
    return c.json({
      authority: parseProvisioningAuthorityStatus(await control.getProvisioningAuthorityStatus()),
    });
  } catch {
    return error(c, 503, 'CONTROL_PLANE_PROVISIONING_AUTHORITY_UNAVAILABLE');
  }
});

controlPlaneOperationsRouter.post('/capacity/preview', async (c) => {
  if (!hasControlPlanePermission(auth(c), 'read')) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  let request: ControlCapacityProfileRequest | null;
  try {
    request = parseCapacityProfileBody(await c.req.json());
  } catch {
    request = null;
  }
  if (!request) return error(c, 400, 'CONTROL_PLANE_CAPACITY_INVALID_REQUEST');
  try {
    return c.json({ preview: await previewControlCapacityProvisioning(c.env, request) });
  } catch (caught) {
    return capacityError(c, caught);
  }
});

controlPlaneOperationsRouter.post('/capacity/requests', async (c) => {
  const actor = auth(c);
  const setupMachine = isSetupProvisioningMachine(actor);
  if (!setupMachine && !hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (!setupMachine && actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  let profile: ControlCapacityProfileRequest | null;
  try {
    profile = parseCapacityProfileBody(await c.req.json());
  } catch {
    profile = null;
  }
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!profile || !idempotencyKey || !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return error(c, 400, 'CONTROL_PLANE_CAPACITY_INVALID_REQUEST');
  }
  const request: ControlCapacityProvisioningRequest = {
    ...profile,
    requestedById: actor.userId,
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.capacity.requested',
      resourceType: 'control_plane_capacity',
      resourceId:
        profile.scope === 'tenant_exclusive'
          ? `tenant:${profile.tenantId}`
          : `environment:${environmentId(c.env)}`,
      result: 'success',
      after: {
        profile: profile.profile,
        scope: profile.scope,
        tenantId: profile.tenantId,
      },
      metadata: { execution: 'control_service_binding', idempotencyKey },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');
  try {
    const result = await requestControlCapacityProvisioning(c.env, request);
    return c.json({ result, auditId }, 202);
  } catch (caught) {
    return capacityError(c, caught);
  }
});

controlPlaneOperationsRouter.get('/operations/:operationId', async (c) => {
  if (!hasPlatformAuthority(auth(c))) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.getProvisioningOperation) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const operationId = c.req.param('operationId');
  if (!SAFE_ENVIRONMENT_ID.test(operationId)) {
    return error(c, 400, 'CONTROL_PLANE_OPERATION_INVALID_REQUEST');
  }
  try {
    environmentId(c.env);
    const value = await control.getProvisioningOperation(operationId);
    if (value === null) return error(c, 404, 'CONTROL_PLANE_OPERATION_NOT_FOUND');
    return c.json({ operation: parseOperation(value, operationId) });
  } catch {
    return error(c, 503, 'CONTROL_PLANE_OPERATION_STATUS_UNAVAILABLE');
  }
});

controlPlaneOperationsRouter.post('/operations/:operationId/retry-step', async (c) => {
  const actor = auth(c);
  const setupMachine = isSetupProvisioningMachine(actor);
  if (!setupMachine && !hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (!setupMachine && actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.retryProvisioningOperationStep) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }

  let body: ReturnType<typeof parseRetryBody>;
  try {
    body = parseRetryBody(await c.req.json());
  } catch {
    body = null;
  }
  const operationId = c.req.param('operationId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  try {
    environmentId(c.env);
  } catch {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  if (
    !body ||
    !SAFE_ENVIRONMENT_ID.test(operationId) ||
    !idempotencyKey ||
    !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
  ) {
    return error(c, 400, 'CONTROL_PLANE_OPERATION_RETRY_INVALID_REQUEST');
  }

  const request: ControlProvisioningOperationRetryRequest = {
    operationId,
    stepKey: body.stepKey,
    requestedById: actor.userId,
    reasonCode: 'operator_retry',
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.operation.retry_step_requested',
      resourceType: 'control_plane_operation',
      resourceId: operationId,
      result: 'success',
      before: { status: 'blocked', stepStatus: 'blocked' },
      after: { status: 'running', stepStatus: 'running' },
      metadata: {
        execution: 'control_service_binding',
        stepKey: body.stepKey,
        reasonCode: 'operator_retry',
      },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');

  try {
    const operation = parseOperation(
      await control.retryProvisioningOperationStep(request),
      operationId
    );
    return c.json({ operation, auditId });
  } catch (caught) {
    if (caught instanceof Error && caught.message === 'control_operation_retry_conflict') {
      return error(c, 409, 'CONTROL_PLANE_OPERATION_RETRY_CONFLICT');
    }
    if (caught instanceof Error && caught.message === 'control_operation_retry_not_retryable') {
      return error(c, 409, 'CONTROL_PLANE_OPERATION_RETRY_NOT_ALLOWED');
    }
    return error(c, 503, 'CONTROL_PLANE_OPERATION_RETRY_UNAVAILABLE');
  }
});

controlPlaneOperationsRouter.post('/operations/:operationId/cancel', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.cancelProvisioningOperation) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }

  const operationId = c.req.param('operationId');
  const idempotencyKey = c.req.header('Idempotency-Key');
  try {
    environmentId(c.env);
  } catch {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  if (
    !SAFE_ENVIRONMENT_ID.test(operationId) ||
    !idempotencyKey ||
    !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
  ) {
    return error(c, 400, 'CONTROL_PLANE_OPERATION_CANCEL_INVALID_REQUEST');
  }

  const request: ControlProvisioningOperationCancelRequest = {
    operationId,
    requestedById: actor.userId,
    reasonCode: 'operator_cancel',
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.operation.cancel_requested',
      resourceType: 'control_plane_operation',
      resourceId: operationId,
      result: 'success',
      before: { status: 'blocked' },
      after: { status: 'canceled' },
      metadata: {
        execution: 'control_service_binding',
        reasonCode: 'operator_cancel',
        retainedResources: true,
      },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');

  try {
    const operation = parseOperation(
      await control.cancelProvisioningOperation(request),
      operationId
    );
    return c.json({ operation, auditId });
  } catch (caught) {
    if (caught instanceof Error && caught.message === 'control_operation_cancel_conflict') {
      return error(c, 409, 'CONTROL_PLANE_OPERATION_CANCEL_CONFLICT');
    }
    if (caught instanceof Error && caught.message === 'control_operation_cancel_not_allowed') {
      return error(c, 409, 'CONTROL_PLANE_OPERATION_CANCEL_NOT_ALLOWED');
    }
    return error(c, 503, 'CONTROL_PLANE_OPERATION_CANCEL_UNAVAILABLE');
  }
});

controlPlaneOperationsRouter.post(
  '/operations/:operationId/restore-previous-settings',
  async (c) => {
    const actor = auth(c);
    if (!hasPlatformAuthority(actor)) {
      return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
    }
    if (actor.actorType && actor.actorType !== 'human') {
      return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
    }
    const control = c.env.CONTROL;
    if (!control?.restoreProvisioningOperationPreviousSettings) {
      return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
    }

    const operationId = c.req.param('operationId');
    const idempotencyKey = c.req.header('Idempotency-Key');
    try {
      environmentId(c.env);
    } catch {
      return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
    }
    if (
      !SAFE_ENVIRONMENT_ID.test(operationId) ||
      !idempotencyKey ||
      !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      return error(c, 400, 'CONTROL_PLANE_OPERATION_RESTORE_INVALID_REQUEST');
    }

    const request: ControlProvisioningOperationRestoreRequest = {
      operationId,
      requestedById: actor.userId,
      reasonCode: 'operator_restore_previous_settings',
      idempotencyKey,
    };
    let auditId: string | null;
    try {
      auditId = await writeAdminAuditLog(c, {
        action: 'control_plane.operation.restore_previous_settings_requested',
        resourceType: 'control_plane_operation',
        resourceId: operationId,
        result: 'success',
        before: { status: 'blocked', bindingState: 'blocked' },
        after: { status: 'running', bindingState: 'rollback_required' },
        metadata: {
          execution: 'control_service_binding_reconciler',
          reasonCode: 'operator_restore_previous_settings',
          settingsSnapshotExposed: false,
        },
      });
    } catch {
      auditId = null;
    }
    if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');

    try {
      const operation = parseOperation(
        await control.restoreProvisioningOperationPreviousSettings(request),
        operationId
      );
      return c.json({ operation, auditId });
    } catch (caught) {
      if (caught instanceof Error && caught.message === 'control_operation_restore_conflict') {
        return error(c, 409, 'CONTROL_PLANE_OPERATION_RESTORE_CONFLICT');
      }
      if (caught instanceof Error && caught.message === 'control_operation_restore_not_allowed') {
        return error(c, 409, 'CONTROL_PLANE_OPERATION_RESTORE_NOT_ALLOWED');
      }
      return error(c, 503, 'CONTROL_PLANE_OPERATION_RESTORE_UNAVAILABLE');
    }
  }
);

controlPlaneOperationsRouter.post('/drift-findings/:findingId/review', async (c) => {
  const actor = auth(c);
  if (!hasPlatformAuthority(actor)) {
    return error(c, 403, 'CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
  }
  if (actor.actorType && actor.actorType !== 'human') {
    return error(c, 403, 'CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  }
  const control = c.env.CONTROL;
  if (!control?.reviewWorkerInventoryDriftFinding) {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }

  let body: ReturnType<typeof parseReviewBody>;
  try {
    body = parseReviewBody(await c.req.json());
  } catch {
    body = null;
  }
  const idempotencyKey = c.req.header('Idempotency-Key');
  let expectedEnvironmentId: string;
  try {
    expectedEnvironmentId = environmentId(c.env);
  } catch {
    return error(c, 503, 'CONTROL_PLANE_CONTROL_UNAVAILABLE');
  }
  const findingId = c.req.param('findingId');
  if (
    !body ||
    !idempotencyKey ||
    !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey) ||
    !/^drift:[a-zA-Z0-9._:-]+:actual_only:[a-zA-Z0-9._-]+$/u.test(findingId) ||
    !findingId.startsWith(`drift:${expectedEnvironmentId}:actual_only:`)
  ) {
    return error(c, 400, 'CONTROL_PLANE_DRIFT_REVIEW_INVALID_REQUEST');
  }

  const request: ControlWorkerInventoryDriftReviewRequest = {
    findingId,
    disposition: body.disposition,
    reviewedBy: actor.userId,
    idempotencyKey,
  };
  let auditId: string | null;
  try {
    auditId = await writeAdminAuditLog(c, {
      action: 'control_plane.worker_inventory.review_requested',
      resourceType: 'worker_inventory_drift_finding',
      resourceId: findingId,
      result: 'success',
      after: { disposition: body.disposition },
      metadata: { execution: 'control_service_binding' },
    });
  } catch {
    auditId = null;
  }
  if (!auditId) return error(c, 503, 'CONTROL_PLANE_AUDIT_UNAVAILABLE');

  try {
    const finding = parseFinding(
      await control.reviewWorkerInventoryDriftFinding(request),
      expectedEnvironmentId
    );
    return c.json({ finding, auditId });
  } catch (caught) {
    if (
      caught instanceof Error &&
      caught.message === 'control_worker_inventory_drift_review_conflict'
    ) {
      return error(c, 409, 'CONTROL_PLANE_DRIFT_REVIEW_CONFLICT');
    }
    return error(c, 503, 'CONTROL_PLANE_DRIFT_REVIEW_UNAVAILABLE');
  }
});
