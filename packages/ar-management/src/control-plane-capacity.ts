import {
  assertControlPlaneRecordIsSecretFree,
  type ControlCapacityProfileRequest,
  type ControlCapacityProvisioningRequest,
  type ControlCapacityProvisioningPreview,
  type ControlCapacityProvisioningResult,
  type ControlProvisioningOperationSummary,
  type ControlServiceBinding,
  type Env,
} from '@authrim/ar-lib-core';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_UNIT_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const DATA_ROLES = new Set(['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup']);
const OPERATION_STATUSES = new Set([
  'queued',
  'running',
  'waiting_retry',
  'succeeded',
  'blocked',
  'canceled',
]);
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validatePreview(
  value: unknown,
  expectedEnvironmentId: string,
  request: ControlCapacityProfileRequest
): ControlCapacityProvisioningPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_capacity_preview_invalid');
  }
  const preview = value as Record<string, unknown>;
  const targets = preview.targets;
  if (
    !exactKeys(preview, [
      'dryRun',
      'profile',
      'scope',
      'tenantId',
      'available',
      'reasonCode',
      'capacityUnitsAdded',
      'd1DatabasesAdded',
      'projectedEnvironmentD1Count',
      'targets',
    ]) ||
    !Array.isArray(targets)
  ) {
    throw new Error('control_capacity_preview_invalid');
  }
  if (
    preview.dryRun !== true ||
    preview.profile !== request.profile ||
    preview.scope !== request.scope ||
    preview.tenantId !== request.tenantId ||
    typeof preview.available !== 'boolean' ||
    ![null, 'capacity_profile_unavailable', 'environment_d1_limit'].includes(
      preview.reasonCode as string | null
    ) ||
    !Number.isSafeInteger(preview.capacityUnitsAdded) ||
    (preview.capacityUnitsAdded as number) < 0 ||
    !Number.isSafeInteger(preview.d1DatabasesAdded) ||
    (preview.d1DatabasesAdded as number) < 0 ||
    !Number.isSafeInteger(preview.projectedEnvironmentD1Count) ||
    (preview.projectedEnvironmentD1Count as number) < 0 ||
    (preview.available === true && preview.reasonCode !== null) ||
    (preview.available === false && preview.reasonCode === null)
  ) {
    throw new Error('control_capacity_preview_invalid');
  }
  for (const candidate of targets) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('control_capacity_preview_invalid');
    }
    const target = candidate as Record<string, unknown>;
    const dataRole = target.dataRole;
    const migrationStreamId = target.migrationStreamId;
    const workerScripts = target.workerScripts;
    if (
      !exactKeys(target, [
        'unitKey',
        'unitIndex',
        'workerScripts',
        'operationId',
        'environmentId',
        'dataRole',
        'residencyPolicyId',
        'residencyPartition',
        'lookupCapacityDomainId',
        'logicalShardId',
        'databaseName',
        'bindingRef',
        'readReplicationMode',
        'migrationStreamId',
      ]) ||
      typeof target.unitKey !== 'string' ||
      !SAFE_UNIT_KEY.test(target.unitKey) ||
      !Number.isSafeInteger(target.unitIndex) ||
      (target.unitIndex as number) < 1 ||
      !Array.isArray(workerScripts) ||
      workerScripts.length < 1 ||
      workerScripts.some(
        (script) => typeof script !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(script)
      ) ||
      new Set(workerScripts).size !== workerScripts.length ||
      typeof target.operationId !== 'string' ||
      !SAFE_ID.test(target.operationId) ||
      target.environmentId !== expectedEnvironmentId ||
      typeof dataRole !== 'string' ||
      !DATA_ROLES.has(dataRole) ||
      typeof target.residencyPolicyId !== 'string' ||
      !SAFE_ID.test(target.residencyPolicyId) ||
      typeof target.residencyPartition !== 'string' ||
      !SAFE_PARTITION.test(target.residencyPartition) ||
      (dataRole === 'lookup'
        ? typeof target.lookupCapacityDomainId !== 'string' ||
          !SAFE_ID.test(target.lookupCapacityDomainId)
        : target.lookupCapacityDomainId !== null) ||
      typeof target.logicalShardId !== 'string' ||
      !SAFE_ID.test(target.logicalShardId) ||
      typeof target.databaseName !== 'string' ||
      !SAFE_DATABASE_NAME.test(target.databaseName) ||
      typeof target.bindingRef !== 'string' ||
      !SAFE_BINDING.test(target.bindingRef) ||
      (target.readReplicationMode !== 'enabled' && target.readReplicationMode !== 'disabled') ||
      !['d1-core', 'd1-pii', 'd1-lookup'].includes(String(migrationStreamId)) ||
      (dataRole === 'tenant_pii' && migrationStreamId !== 'd1-pii') ||
      (dataRole === 'lookup' && migrationStreamId !== 'd1-lookup') ||
      (!['tenant_pii', 'lookup'].includes(dataRole) && migrationStreamId !== 'd1-core')
    ) {
      throw new Error('control_capacity_preview_invalid');
    }
  }
  if (
    (preview.capacityUnitsAdded as number) !== targets.length ||
    (preview.d1DatabasesAdded as number) !== targets.length ||
    new Set((targets as Record<string, unknown>[]).map((target) => target.operationId as string))
      .size !== targets.length
  ) {
    throw new Error('control_capacity_preview_invalid');
  }
  assertControlPlaneRecordIsSecretFree(preview);
  return preview as unknown as ControlCapacityProvisioningPreview;
}

function validateOperationSummary(value: unknown): ControlProvisioningOperationSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_capacity_result_invalid');
  }
  const operation = value as Record<string, unknown>;
  if (
    !exactKeys(operation, [
      'operationId',
      'status',
      'attemptCount',
      'nextAttemptAt',
      'lastErrorCode',
      'createdAt',
      'updatedAt',
    ]) ||
    typeof operation.operationId !== 'string' ||
    !SAFE_ID.test(operation.operationId) ||
    typeof operation.status !== 'string' ||
    !OPERATION_STATUSES.has(operation.status) ||
    !Number.isSafeInteger(operation.attemptCount) ||
    (operation.attemptCount as number) < 0 ||
    (operation.nextAttemptAt !== null &&
      (!Number.isSafeInteger(operation.nextAttemptAt) ||
        (operation.nextAttemptAt as number) <= 0 ||
        (operation.nextAttemptAt as number) > MAX_DATE_EPOCH_SECONDS)) ||
    (operation.lastErrorCode !== null &&
      (typeof operation.lastErrorCode !== 'string' || !SAFE_ID.test(operation.lastErrorCode))) ||
    !Number.isSafeInteger(operation.createdAt) ||
    (operation.createdAt as number) <= 0 ||
    (operation.createdAt as number) > MAX_DATE_EPOCH_SECONDS ||
    !Number.isSafeInteger(operation.updatedAt) ||
    (operation.updatedAt as number) < (operation.createdAt as number) ||
    (operation.updatedAt as number) > MAX_DATE_EPOCH_SECONDS
  ) {
    throw new Error('control_capacity_result_invalid');
  }
  return operation as unknown as ControlProvisioningOperationSummary;
}

function validateResult(
  value: unknown,
  expectedEnvironmentId: string,
  request: ControlCapacityProvisioningRequest
): ControlCapacityProvisioningResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_capacity_result_invalid');
  }
  const result = value as Record<string, unknown>;
  if (!exactKeys(result, ['preview', 'operations']) || !Array.isArray(result.operations)) {
    throw new Error('control_capacity_result_invalid');
  }
  const preview = validatePreview(result.preview, expectedEnvironmentId, request);
  const operations = result.operations.map(validateOperationSummary);
  const expectedOperationIds = preview.targets.map((target) => target.operationId);
  if (
    operations.length !== expectedOperationIds.length ||
    new Set(operations.map((operation) => operation.operationId)).size !== operations.length ||
    operations.some((operation) => !expectedOperationIds.includes(operation.operationId))
  ) {
    throw new Error('control_capacity_result_invalid');
  }
  assertControlPlaneRecordIsSecretFree(result);
  return { preview, operations };
}

export async function previewControlCapacityProvisioning(
  env: Env,
  request: ControlCapacityProfileRequest,
  options: { control?: ControlServiceBinding } = {}
): Promise<ControlCapacityProvisioningPreview> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_ID.test(environmentId)) {
    throw new Error('control_capacity_environment_invalid');
  }
  const control = options.control ?? env.CONTROL;
  if (!control) throw new Error('control_service_unavailable');
  return validatePreview(
    await control.previewCapacityProvisioning(request),
    environmentId,
    request
  );
}

export async function requestControlCapacityProvisioning(
  env: Env,
  request: ControlCapacityProvisioningRequest,
  options: { control?: ControlServiceBinding } = {}
): Promise<ControlCapacityProvisioningResult> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_ID.test(environmentId)) {
    throw new Error('control_capacity_environment_invalid');
  }
  const control = options.control ?? env.CONTROL;
  if (!control?.requestCapacityProvisioning) {
    throw new Error('control_service_unavailable');
  }
  return validateResult(await control.requestCapacityProvisioning(request), environmentId, request);
}
