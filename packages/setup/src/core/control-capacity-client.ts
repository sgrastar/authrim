import {
  assertControlPlaneRecordIsSecretFree,
  type ControlCapacityProfileRequest,
  type ControlCapacityProvisioningPreview,
  type ControlCapacityProvisioningResult,
  type ControlProvisioningOperationSummary,
} from '@authrim/ar-lib-core/control-plane';
import { randomBytes } from 'node:crypto';
import { requestAdminMachineAccessToken } from './admin-machine-access.js';
import { queryD1Rows } from './cloudflare.js';
import { fetchWithTimeout, readResponseJsonWithLimit } from './http-limits.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_UNIT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]{1,123}$/u;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function safeEpoch(value: unknown, nullable = false): boolean {
  return (
    (nullable && value === null) ||
    (Number.isSafeInteger(value) &&
      (value as number) > 0 &&
      (value as number) <= MAX_DATE_EPOCH_SECONDS)
  );
}

function validateRequest(request: ControlCapacityProfileRequest): void {
  if (
    !['minimum', 'recommended', 'extra_headroom'].includes(request.profile) ||
    !['shared_pool', 'tenant_exclusive'].includes(request.scope) ||
    (request.tenantId !== null && !SAFE_ID.test(request.tenantId)) ||
    (request.scope === 'shared_pool' && request.tenantId !== null) ||
    (request.scope === 'tenant_exclusive' && request.tenantId === null)
  ) {
    throw new Error('control_capacity_request_invalid');
  }
}

function parsePreview(
  value: unknown,
  request: ControlCapacityProfileRequest
): ControlCapacityProvisioningPreview {
  const preview = record(value, 'control_capacity_preview_invalid');
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
    preview.dryRun !== true ||
    preview.profile !== request.profile ||
    preview.scope !== request.scope ||
    preview.tenantId !== request.tenantId ||
    typeof preview.available !== 'boolean' ||
    ![null, 'capacity_profile_unavailable', 'environment_d1_limit'].includes(
      preview.reasonCode as string | null
    ) ||
    (preview.available === true) !== (preview.reasonCode === null) ||
    !Number.isSafeInteger(preview.capacityUnitsAdded) ||
    (preview.capacityUnitsAdded as number) < 0 ||
    !Number.isSafeInteger(preview.d1DatabasesAdded) ||
    (preview.d1DatabasesAdded as number) < 0 ||
    !Number.isSafeInteger(preview.projectedEnvironmentD1Count) ||
    (preview.projectedEnvironmentD1Count as number) < 0 ||
    !Array.isArray(preview.targets)
  ) {
    throw new Error('control_capacity_preview_invalid');
  }
  for (const candidate of preview.targets) {
    const target = record(candidate, 'control_capacity_preview_invalid');
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
      !Array.isArray(target.workerScripts) ||
      target.workerScripts.length < 1 ||
      target.workerScripts.some(
        (script) => typeof script !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(script)
      ) ||
      new Set(target.workerScripts).size !== target.workerScripts.length ||
      typeof target.operationId !== 'string' ||
      !SAFE_ID.test(target.operationId) ||
      typeof target.environmentId !== 'string' ||
      !SAFE_ID.test(target.environmentId) ||
      !['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'].includes(
        String(target.dataRole)
      ) ||
      typeof target.residencyPolicyId !== 'string' ||
      !SAFE_ID.test(target.residencyPolicyId) ||
      typeof target.residencyPartition !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(target.residencyPartition) ||
      typeof target.logicalShardId !== 'string' ||
      !SAFE_ID.test(target.logicalShardId) ||
      typeof target.databaseName !== 'string' ||
      !SAFE_DATABASE_NAME.test(target.databaseName) ||
      typeof target.bindingRef !== 'string' ||
      !SAFE_BINDING.test(target.bindingRef) ||
      !['enabled', 'disabled'].includes(String(target.readReplicationMode)) ||
      !['core-d1', 'pii-d1', 'lookup-d1'].includes(String(target.migrationStreamId)) ||
      (target.dataRole === 'tenant_pii' && target.migrationStreamId !== 'pii-d1') ||
      (target.dataRole === 'lookup' && target.migrationStreamId !== 'lookup-d1') ||
      (!['tenant_pii', 'lookup'].includes(String(target.dataRole)) &&
        target.migrationStreamId !== 'core-d1')
    ) {
      throw new Error('control_capacity_preview_invalid');
    }
  }
  if (
    preview.d1DatabasesAdded !== preview.targets.length ||
    new Set(
      preview.targets.map((target) => (target as Record<string, unknown>).operationId as string)
    ).size !== preview.targets.length
  ) {
    throw new Error('control_capacity_preview_invalid');
  }
  assertControlPlaneRecordIsSecretFree(preview);
  return preview as unknown as ControlCapacityProvisioningPreview;
}

function parseOperation(value: unknown): ControlProvisioningOperationSummary {
  const operation = record(value, 'control_capacity_result_invalid');
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
    !['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(
      String(operation.status)
    ) ||
    !Number.isSafeInteger(operation.attemptCount) ||
    (operation.attemptCount as number) < 0 ||
    !safeEpoch(operation.nextAttemptAt, true) ||
    (operation.lastErrorCode !== null &&
      (typeof operation.lastErrorCode !== 'string' || !SAFE_ID.test(operation.lastErrorCode))) ||
    !safeEpoch(operation.createdAt) ||
    !safeEpoch(operation.updatedAt) ||
    (operation.updatedAt as number) < (operation.createdAt as number)
  ) {
    throw new Error('control_capacity_result_invalid');
  }
  return operation as unknown as ControlProvisioningOperationSummary;
}

function parseMutation(
  value: unknown,
  request: ControlCapacityProfileRequest
): { result: ControlCapacityProvisioningResult; auditId: string } {
  const response = record(value, 'control_capacity_result_invalid');
  const result = record(response.result, 'control_capacity_result_invalid');
  if (
    !exactKeys(response, ['result', 'auditId']) ||
    typeof response.auditId !== 'string' ||
    !SAFE_ID.test(response.auditId) ||
    !exactKeys(result, ['preview', 'operations']) ||
    !Array.isArray(result.operations)
  ) {
    throw new Error('control_capacity_result_invalid');
  }
  const preview = parsePreview(result.preview, request);
  const operations = result.operations.map(parseOperation);
  const targetIds = new Set(preview.targets.map((target) => target.operationId));
  if (
    operations.length !== targetIds.size ||
    new Set(operations.map((operation) => operation.operationId)).size !== operations.length ||
    operations.some((operation) => !targetIds.has(operation.operationId))
  ) {
    throw new Error('control_capacity_result_invalid');
  }
  assertControlPlaneRecordIsSecretFree(response);
  return { result: { preview, operations }, auditId: response.auditId };
}

async function callCapacityApi(input: {
  apiBaseUrl: string;
  keysDir: string;
  request: ControlCapacityProfileRequest;
  action: 'preview' | 'request';
  fetch?: typeof fetch;
}): Promise<unknown> {
  validateRequest(input.request);
  const token = await requestAdminMachineAccessToken({
    apiBaseUrl: input.apiBaseUrl,
    keysDir: input.keysDir,
    scopes: [
      input.action === 'preview' ? 'admin:control_plane:read' : 'admin:control_plane:provision',
    ],
  });
  const baseUrl = input.apiBaseUrl.replace(/\/+$/u, '');
  const response = await (input.fetch ?? fetchWithTimeout)(
    `${baseUrl}/api/admin/platform/control-plane/capacity/${
      input.action === 'preview' ? 'preview' : 'requests'
    }`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
        ...(input.action === 'request'
          ? { 'Idempotency-Key': `setup-capacity-${randomBytes(18).toString('base64url')}` }
          : {}),
      },
      body: JSON.stringify(input.request),
    }
  );
  const body = await readResponseJsonWithLimit<Record<string, unknown>>(response);
  if (!response.ok) {
    const code =
      typeof body.error === 'string' && SAFE_ID.test(body.error)
        ? body.error
        : 'control_capacity_request_failed';
    throw new Error(code);
  }
  return body;
}

export async function previewSetupControlCapacity(input: {
  apiBaseUrl: string;
  keysDir: string;
  request: ControlCapacityProfileRequest;
  fetch?: typeof fetch;
}): Promise<ControlCapacityProvisioningPreview> {
  const body = record(await callCapacityApi({ ...input, action: 'preview' }), 'invalid_response');
  if (!exactKeys(body, ['preview'])) throw new Error('control_capacity_preview_invalid');
  return parsePreview(body.preview, input.request);
}

export async function requestSetupControlCapacity(input: {
  apiBaseUrl: string;
  keysDir: string;
  request: ControlCapacityProfileRequest;
  fetch?: typeof fetch;
}): Promise<{ result: ControlCapacityProvisioningResult; auditId: string }> {
  return parseMutation(await callCapacityApi({ ...input, action: 'request' }), input.request);
}

export async function retrySetupControlOperationStep(input: {
  apiBaseUrl: string;
  keysDir: string;
  operationId: string;
  stepKey: 'create_d1' | 'apply_migrations' | 'reconcile_worker_bindings';
  fetch?: typeof fetch;
}): Promise<void> {
  if (!SAFE_ID.test(input.operationId)) throw new Error('control_operation_retry_invalid');
  const token = await requestAdminMachineAccessToken({
    apiBaseUrl: input.apiBaseUrl,
    keysDir: input.keysDir,
    scopes: ['admin:control_plane:provision'],
  });
  const response = await (input.fetch ?? fetchWithTimeout)(
    `${input.apiBaseUrl.replace(/\/+$/u, '')}/api/admin/platform/control-plane/operations/${encodeURIComponent(input.operationId)}/retry-step`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `setup-retry-${randomBytes(18).toString('base64url')}`,
      },
      body: JSON.stringify({ stepKey: input.stepKey }),
    }
  );
  const body = await readResponseJsonWithLimit<Record<string, unknown>>(response);
  if (!response.ok) {
    const code =
      typeof body.error === 'string' && SAFE_ID.test(body.error)
        ? body.error
        : 'control_operation_retry_failed';
    throw new Error(code);
  }
  const operation = record(body.operation, 'control_operation_retry_invalid_response');
  if (
    !exactKeys(body, ['operation', 'auditId']) ||
    operation.operationId !== input.operationId ||
    operation.status !== 'running' ||
    typeof body.auditId !== 'string' ||
    !SAFE_ID.test(body.auditId)
  ) {
    throw new Error('control_operation_retry_invalid_response');
  }
  assertControlPlaneRecordIsSecretFree(body);
}

export async function listSetupExclusiveCapacityTenants(input: {
  controlDatabaseName: string;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<string[]> {
  if (!input.controlDatabaseName.trim() || !SAFE_ID.test(input.environmentId)) {
    throw new Error('control_capacity_tenant_list_invalid');
  }
  const rows = await (input.query ?? queryD1Rows)<{ tenant_id: string }>(
    input.controlDatabaseName,
    `SELECT tenant_id
       FROM control_tenant_placement_policies
      WHERE environment_id = '${input.environmentId}'
        AND isolation_policy = 'tenant_exclusive'
        AND state = 'active'
      ORDER BY tenant_id
      LIMIT 1000`
  );
  const tenants = rows.map((row) => row.tenant_id);
  if (
    tenants.some((tenantId) => !SAFE_ID.test(tenantId)) ||
    new Set(tenants).size !== tenants.length
  ) {
    throw new Error('control_capacity_tenant_list_invalid');
  }
  assertControlPlaneRecordIsSecretFree(tenants);
  return tenants;
}
