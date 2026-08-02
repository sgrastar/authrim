import {
  CloudflareControlApiClient,
  RUNTIME_SMOKE_LOOKUP_METADATA_KEY,
  assertControlPlaneRecordIsSecretFree,
  ensureControlProvisioningD1,
  executeControlProvisioningEffect,
  planControlCapacity,
  type ControlCapacityProfileRequest,
  type ControlCapacityProvisioningPreview,
  type ControlCapacityProvisioningRequest,
  type ControlCapacityProvisioningResult,
  type ControlProvisioningOperationSummary,
  type ControlProvisioningAuthorityStatus,
  type ControlTenantShardCapacityResult,
  type ControlTenantShardCapacityRequest,
  type ControlTenantShardCapacityTarget,
  type ControlTenantDeletionFinalization,
  type ControlTenantDeletionInventory,
  type ControlTenantDeletionRequest,
  type ControlTenantPlacementPolicy,
  type ControlTenantPlacementPolicyActivationRequest,
  type ControlTenantPlacementPolicyRegistrationRequest,
  type ControlTenantRuntimeRouteObservation,
  type ControlTenantRegionShardPolicy,
  deriveControlRegionShardAllowedRegions,
} from '@authrim/ar-lib-core/control-plane';
import type { ControlRepository } from './repository';
import { ApiMigrationEngine, cloudflareMigrationExecutor } from './migration-engine';
import { MigrationReleaseArtifactReader, R2ReleaseArtifactStore } from './release-artifact';
import { createControlApiClients } from './control-api-clients';
import {
  type ControlEnv,
  type ControlOperationView,
  type PendingMigrationPlan,
  type ProvisionedD1DataRole,
  type TenantShardDataRole,
  type TenantShardPlan,
  type TenantShardRequest,
  type TenantShardRequestResult,
} from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const TENANT_DATA_ROLES = new Set<TenantShardDataRole>([
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
]);
const PROVISIONED_DATA_ROLES = new Set<ProvisionedD1DataRole>([...TENANT_DATA_ROLES, 'lookup']);
const MAX_RECONCILE_OPERATIONS = 5;
export interface ControlServiceDependencies {
  repository: ControlRepository;
  env: ControlEnv;
  now: () => number;
  createApiClient?: (
    env: ControlEnv
  ) => Pick<
    CloudflareControlApiClient,
    'listD1Databases' | 'getD1Database' | 'createD1Database' | 'updateD1Database'
  >;
  createMigrationEngine?: (env: ControlEnv) => Pick<ApiMigrationEngine, 'apply'>;
  writeMigrationMetadata?: (
    env: ControlEnv,
    plan: PendingMigrationPlan,
    result: {
      totalFiles: number;
      lastFilename: string;
    },
    now: number
  ) => Promise<void>;
}

function requiredSafeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requiredPartition(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_PARTITION.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function parseTenantDeletionRequest(input: unknown): ControlTenantDeletionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_tenant_deletion_request');
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => key !== 'tenantId' && key !== 'operationId')
  ) {
    throw new Error('invalid_tenant_deletion_request');
  }
  return {
    tenantId: requiredSafeId(value.tenantId, 'tenant_id'),
    operationId: requiredSafeId(value.operationId, 'operation_id'),
  };
}

function parseRequest(
  input: unknown,
  expectedEnvironmentId?: string,
  allowLookup = false
): TenantShardRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_tenant_shard_request');
  }
  const value = input as Record<string, unknown>;
  const environmentId = expectedEnvironmentId
    ? requiredSafeId(expectedEnvironmentId, 'environment_id')
    : requiredSafeId(value.environmentId, 'environment_id');
  if (
    expectedEnvironmentId &&
    value.environmentId !== undefined &&
    value.environmentId !== environmentId
  ) {
    throw new Error('invalid_environment_id');
  }
  const dataRole = value.dataRole;
  const allowedRoles = allowLookup ? PROVISIONED_DATA_ROLES : TENANT_DATA_ROLES;
  if (typeof dataRole !== 'string' || !allowedRoles.has(dataRole as ProvisionedD1DataRole)) {
    throw new Error('invalid_data_role');
  }
  const allocationScope = value.allocationScope ?? 'shared_pool';
  if (allocationScope !== 'shared_pool' && allocationScope !== 'tenant_exclusive') {
    throw new Error('invalid_tenant_shard_owner');
  }
  const tenantId =
    value.tenantId === undefined ? undefined : requiredSafeId(value.tenantId, 'tenant_id');
  const ownerTenantId =
    value.ownerTenantId === undefined || value.ownerTenantId === null
      ? null
      : requiredSafeId(value.ownerTenantId, 'owner_tenant_id');
  return {
    environmentId,
    tenantId,
    dataRole: dataRole as ProvisionedD1DataRole,
    residencyPolicyId: requiredSafeId(value.residencyPolicyId, 'residency_policy_id'),
    residencyPartition: requiredPartition(value.residencyPartition, 'residency_partition'),
    idempotencyKey: requiredSafeId(value.idempotencyKey, 'idempotency_key'),
    allocationScope,
    ownerTenantId,
    dryRun: value.dryRun === true,
  };
}

function parseCapacityRequest(
  input: unknown,
  environmentId: string
): ControlTenantShardCapacityRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_tenant_shard_request');
  }
  const value = input as Record<string, unknown>;
  const keys = [
    'tenantId',
    'dataRole',
    'residencyPolicyId',
    'residencyPartition',
    'idempotencyKey',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error('invalid_tenant_shard_request');
  }
  const parsed = parseRequest({ ...value, environmentId }, environmentId);
  if (parsed.dataRole === 'lookup') {
    throw new Error('invalid_data_role');
  }
  return {
    tenantId: requiredSafeId(value.tenantId, 'tenant_id'),
    dataRole: parsed.dataRole,
    residencyPolicyId: parsed.residencyPolicyId,
    residencyPartition: parsed.residencyPartition,
    idempotencyKey: parsed.idempotencyKey,
  };
}

function parseCapacityProfileRequest(input: unknown): ControlCapacityProfileRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('control_capacity_profile_request_invalid');
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    !Object.keys(value).every((key) => ['profile', 'scope', 'tenantId'].includes(key)) ||
    !['minimum', 'recommended', 'extra_headroom'].includes(String(value.profile)) ||
    !['shared_pool', 'tenant_exclusive'].includes(String(value.scope)) ||
    (value.scope === 'shared_pool' && value.tenantId !== null) ||
    (value.scope === 'tenant_exclusive' &&
      (typeof value.tenantId !== 'string' || !SAFE_ID.test(value.tenantId)))
  ) {
    throw new Error('control_capacity_profile_request_invalid');
  }
  return {
    profile: value.profile as ControlCapacityProfileRequest['profile'],
    scope: value.scope as ControlCapacityProfileRequest['scope'],
    tenantId: value.tenantId as string | null,
  };
}

function parseCapacityProvisioningRequest(input: unknown): ControlCapacityProvisioningRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('control_capacity_provisioning_request_invalid');
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 5 ||
    !Object.keys(value).every((key) =>
      ['profile', 'scope', 'tenantId', 'requestedById', 'idempotencyKey'].includes(key)
    )
  ) {
    throw new Error('control_capacity_provisioning_request_invalid');
  }
  const profile = parseCapacityProfileRequest({
    profile: value.profile,
    scope: value.scope,
    tenantId: value.tenantId,
  });
  return {
    ...profile,
    requestedById: requiredSafeId(value.requestedById, 'requested_by_id'),
    idempotencyKey: requiredSafeId(value.idempotencyKey, 'idempotency_key'),
  };
}

async function capacityUnitIdempotencyKey(input: {
  scope: ControlCapacityProfileRequest['scope'];
  tenantId: string | null;
  unitKey: string;
  unitIndex: number;
}): Promise<string> {
  const unitDigest = (
    await sha256(
      JSON.stringify([input.scope, input.tenantId ?? 'shared', input.unitKey, input.unitIndex])
    )
  ).slice(0, 24);
  return `capacity:${input.scope}:${slug(input.tenantId ?? 'shared')}:${unitDigest}:${input.unitIndex}`;
}

function parsePlacementPolicyRegistration(
  input: unknown
): ControlTenantPlacementPolicyRegistrationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_tenant_placement_policy');
  }
  const value = input as Record<string, unknown>;
  const keys = ['tenantId', 'isolationPolicy', 'sourceOperationId', 'idempotencyKey'];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error('invalid_tenant_placement_policy');
  }
  const isolationPolicy = value.isolationPolicy;
  if (isolationPolicy !== 'shared_pool' && isolationPolicy !== 'tenant_exclusive') {
    throw new Error('invalid_tenant_placement_policy');
  }
  return {
    tenantId: requiredSafeId(value.tenantId, 'tenant_id'),
    isolationPolicy,
    sourceOperationId: requiredSafeId(value.sourceOperationId, 'source_operation_id'),
    idempotencyKey: requiredSafeId(value.idempotencyKey, 'idempotency_key'),
  };
}

function parsePlacementPolicyActivation(
  input: unknown
): ControlTenantPlacementPolicyActivationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_tenant_placement_policy_activation');
  }
  const value = input as Record<string, unknown>;
  const keys = ['tenantId', 'sourceOperationId', 'idempotencyKey', 'runtimeRoute'];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error('invalid_tenant_placement_policy_activation');
  }
  const route = value.runtimeRoute;
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error('invalid_tenant_placement_policy_activation');
  }
  const routeValue = route as Record<string, unknown>;
  const routeKeys = [
    'runtimeGeneration',
    'registryPublicationGeneration',
    'tenantLifecycleState',
    'routeStatus',
    'targets',
  ];
  if (
    Object.keys(routeValue).length !== routeKeys.length ||
    Object.keys(routeValue).some((key) => !routeKeys.includes(key)) ||
    !Number.isSafeInteger(routeValue.runtimeGeneration) ||
    Number(routeValue.runtimeGeneration) < 1 ||
    !Number.isSafeInteger(routeValue.registryPublicationGeneration) ||
    Number(routeValue.registryPublicationGeneration) < 1 ||
    routeValue.tenantLifecycleState !== 'active' ||
    routeValue.routeStatus !== 'active' ||
    !Array.isArray(routeValue.targets) ||
    routeValue.targets.length < 3 ||
    routeValue.targets.length > 4096
  ) {
    throw new Error('invalid_tenant_placement_policy_activation');
  }
  const seenRolesAndShards = new Set<string>();
  const seenBindings = new Set<string>();
  const targets = routeValue.targets.map(
    (target): ControlTenantRuntimeRouteObservation['targets'][number] => {
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new Error('invalid_tenant_placement_policy_activation');
      }
      const candidate = target as Record<string, unknown>;
      const targetKeys = ['dataRole', 'shardId', 'bindingRef', 'generation'];
      if (
        Object.keys(candidate).length !== targetKeys.length ||
        Object.keys(candidate).some((key) => !targetKeys.includes(key)) ||
        !['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(
          String(candidate.dataRole)
        ) ||
        !SAFE_ID.test(String(candidate.shardId)) ||
        !SAFE_BINDING.test(String(candidate.bindingRef)) ||
        !Number.isSafeInteger(candidate.generation) ||
        Number(candidate.generation) < 1
      ) {
        throw new Error('invalid_tenant_placement_policy_activation');
      }
      const roleAndShard = `${String(candidate.dataRole)}\0${String(candidate.shardId)}`;
      if (seenRolesAndShards.has(roleAndShard) || seenBindings.has(String(candidate.bindingRef))) {
        throw new Error('invalid_tenant_placement_policy_activation');
      }
      seenRolesAndShards.add(roleAndShard);
      seenBindings.add(String(candidate.bindingRef));
      return {
        dataRole:
          candidate.dataRole as ControlTenantRuntimeRouteObservation['targets'][number]['dataRole'],
        shardId: String(candidate.shardId),
        bindingRef: String(candidate.bindingRef),
        generation: Number(candidate.generation),
      };
    }
  );
  return {
    tenantId: requiredSafeId(value.tenantId, 'tenant_id'),
    sourceOperationId: requiredSafeId(value.sourceOperationId, 'source_operation_id'),
    idempotencyKey: requiredSafeId(value.idempotencyKey, 'idempotency_key'),
    runtimeRoute: {
      runtimeGeneration: Number(routeValue.runtimeGeneration),
      registryPublicationGeneration: Number(routeValue.registryPublicationGeneration),
      tenantLifecycleState: 'active',
      routeStatus: 'active',
      targets,
    },
  };
}

function operationSummary(operation: ControlOperationView): ControlProvisioningOperationSummary {
  const status = operation.status;
  if (
    !['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(status)
  ) {
    throw new Error('control_operation_status_invalid');
  }
  return {
    operationId: operation.operationId,
    status: status as ControlProvisioningOperationSummary['status'],
    attemptCount: operation.attemptCount,
    nextAttemptAt: operation.nextAttemptAt,
    lastErrorCode: operation.lastErrorCode,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function slug(value: string): string {
  const lower = value.toLowerCase();
  let result = '';
  let needsSeparator = false;
  for (const character of lower) {
    const isLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (isLetter || isDigit) {
      if (needsSeparator && result.length > 0) result += '-';
      result += character;
      needsSeparator = false;
    } else if (character === '-') {
      if (result.length > 0) result += '-';
      needsSeparator = false;
    } else if (result.length > 0) {
      needsSeparator = true;
    }
    if (result.length >= 24) break;
  }
  while (result.endsWith('-')) result = result.slice(0, -1);
  return result.slice(0, 24);
}

export async function writeMigrationMetadata(
  env: ControlEnv,
  plan: PendingMigrationPlan,
  result: { totalFiles: number; lastFilename: string },
  now: number,
  d1: Pick<CloudflareControlApiClient, 'queryD1Batch'> = createControlApiClients(env).d1
): Promise<void> {
  const metadata = {
    binding_ref: plan.bindingRef,
    data_role: plan.dataRole,
    residency_partition: plan.residencyPartition,
    migration_generation: plan.migrationGeneration,
    release_id: plan.releaseId,
    manifest_digest: plan.manifestDigest,
    expected_file_count: result.totalFiles,
    last_filename: result.lastFilename,
  };
  const response = await d1.queryD1Batch(
    plan.databaseId,
    plan.dataRole === 'lookup'
      ? [
          {
            sql: `INSERT INTO lookup_schema_metadata (metadata_key, metadata_value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(metadata_key) DO UPDATE SET
              metadata_value = excluded.metadata_value,
              updated_at = excluded.updated_at`,
            params: [RUNTIME_SMOKE_LOOKUP_METADATA_KEY, JSON.stringify(metadata), now],
          },
          {
            sql: `SELECT metadata_value
              FROM lookup_schema_metadata
             WHERE metadata_key = ?`,
            params: [RUNTIME_SMOKE_LOOKUP_METADATA_KEY],
          },
        ]
      : [
          {
            sql: `INSERT INTO authrim_control_plane_shard_metadata (
                singleton_id, binding_ref, data_role, residency_partition, migration_generation,
                release_id, manifest_digest, expected_file_count, last_filename, updated_at
              ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(singleton_id) DO UPDATE SET
                binding_ref = excluded.binding_ref,
                data_role = excluded.data_role,
                residency_partition = excluded.residency_partition,
                migration_generation = excluded.migration_generation,
                release_id = excluded.release_id,
                manifest_digest = excluded.manifest_digest,
                expected_file_count = excluded.expected_file_count,
                last_filename = excluded.last_filename,
                updated_at = excluded.updated_at`,
            params: [
              plan.bindingRef,
              plan.dataRole,
              plan.residencyPartition,
              plan.migrationGeneration,
              plan.releaseId,
              plan.manifestDigest,
              result.totalFiles,
              result.lastFilename,
              now,
            ],
          },
          {
            sql: `SELECT binding_ref, data_role, residency_partition, migration_generation,
                     release_id, manifest_digest, expected_file_count, last_filename
                FROM authrim_control_plane_shard_metadata
               WHERE singleton_id = 1`,
          },
        ]
  );
  const reflectedRow = response[1]?.results?.[0] as Record<string, unknown> | undefined;
  let reflected = reflectedRow;
  if (plan.dataRole === 'lookup') {
    try {
      reflected =
        typeof reflectedRow?.metadata_value === 'string'
          ? (JSON.parse(reflectedRow.metadata_value) as Record<string, unknown>)
          : undefined;
    } catch {
      reflected = undefined;
    }
  }
  if (
    response.length !== 2 ||
    response[0]?.success !== true ||
    response[1]?.success !== true ||
    !reflected ||
    Object.keys(reflected).length !== Object.keys(metadata).length ||
    Object.keys(reflected).some((key) => !(key in metadata)) ||
    reflected.binding_ref !== plan.bindingRef ||
    reflected.data_role !== plan.dataRole ||
    reflected.residency_partition !== plan.residencyPartition ||
    reflected.migration_generation !== plan.migrationGeneration ||
    reflected.release_id !== plan.releaseId ||
    reflected.manifest_digest !== plan.manifestDigest ||
    reflected.expected_file_count !== result.totalFiles ||
    reflected.last_filename !== result.lastFilename
  ) {
    throw new Error('control_migration_metadata_write_failed');
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function buildPlan(
  request: TenantShardRequest,
  environmentName: string,
  partition: {
    jurisdiction: 'eu' | 'fedramp' | null;
    location_hint: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc' | null;
  },
  readReplicationMode: 'enabled' | 'disabled'
): Promise<TenantShardPlan> {
  const digest = await sha256(
    [
      request.environmentId,
      request.allocationScope ?? 'shared_pool',
      request.ownerTenantId ?? '',
      request.dataRole,
      request.residencyPolicyId,
      request.residencyPartition,
      request.idempotencyKey,
    ].join('\0')
  );
  const role = request.dataRole.replace('tenant_', '').replace('/', '-');
  const ownerSegment = request.ownerTenantId ? `:${request.ownerTenantId}` : '';
  const logicalShardId = `${role}:${request.residencyPartition}${ownerSegment}:${digest.slice(0, 12)}`;
  const bindingRole = request.dataRole
    .replace('tenant_core/', '')
    .replace('tenant_', '')
    .replace('/', '_')
    .toUpperCase();
  const bindingSuffix =
    request.dataRole === 'tenant_pii' ? 'PII' : request.dataRole === 'lookup' ? 'LOOKUP' : 'CORE';
  const plan: TenantShardPlan = {
    operationId: `op_${digest.slice(0, 32)}`,
    desiredResourceId: `d1_${digest.slice(0, 32)}`,
    shardId: `${request.dataRole === 'lookup' ? 'lookup' : 'shard'}_${digest.slice(0, 32)}`,
    environmentId: request.environmentId,
    environmentName,
    dataRole: request.dataRole,
    residencyPolicyId: request.residencyPolicyId,
    residencyPartition: request.residencyPartition,
    logicalShardId,
    databaseName: `authrim-${slug(environmentName)}-${slug(role)}-${slug(request.residencyPartition)}${request.ownerTenantId ? `-${slug(request.ownerTenantId)}` : ''}-${digest.slice(0, 8)}`,
    bindingRef: `TDB_${bindingRole}_${digest.slice(0, 8).toUpperCase()}_${bindingSuffix}`,
    ownershipFingerprint: digest,
    allocationScope: request.allocationScope ?? 'shared_pool',
    ownerTenantId: request.ownerTenantId ?? null,
    jurisdiction: partition.jurisdiction ?? undefined,
    locationHint: partition.location_hint ?? undefined,
    readReplicationMode,
    migrationStreamId:
      request.dataRole === 'tenant_pii'
        ? 'd1-pii'
        : request.dataRole === 'lookup'
          ? 'd1-lookup'
          : 'd1-core',
    idempotencyKey: request.idempotencyKey,
  };
  assertControlPlaneRecordIsSecretFree(plan);
  return plan;
}

export class ControlService {
  constructor(private readonly dependencies: ControlServiceDependencies) {}

  private async automaticProvisioningReady(environmentId: string): Promise<boolean> {
    if (!this.dependencies.repository.getProvisioningAuthority) return true;
    const authority = await this.dependencies.repository.getProvisioningAuthority(environmentId);
    const d1Token = this.dependencies.env.CLOUDFLARE_D1_API_TOKEN?.trim();
    const workersToken = this.dependencies.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim();
    return (
      authority?.automaticProvisioningEnabled === true &&
      authority.capabilityState === 'ready' &&
      authority.tokenOwnership !== 'none' &&
      this.dependencies.env.AUTHRIM_AUTOMATIC_PROVISIONING === 'true' &&
      Boolean(d1Token) &&
      Boolean(workersToken) &&
      d1Token !== workersToken
    );
  }

  async getProvisioningAuthorityStatus(
    expectedEnvironmentId: string
  ): Promise<ControlProvisioningAuthorityStatus> {
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const authority = this.dependencies.repository.getProvisioningAuthority
      ? await this.dependencies.repository.getProvisioningAuthority(environmentId)
      : null;
    if (!authority) throw new Error('control_provisioning_authority_missing');
    const automaticExecutionAvailable = await this.automaticProvisioningReady(environmentId);
    const capabilityState = automaticExecutionAvailable
      ? 'ready'
      : !authority.automaticProvisioningEnabled
        ? 'disabled'
        : authority.capabilityState === 'pending'
          ? 'pending'
          : 'blocked';
    const status: ControlProvisioningAuthorityStatus = {
      automaticProvisioningEnabled: authority.automaticProvisioningEnabled,
      tokenOwnership: authority.tokenOwnership,
      capabilityState,
      automaticExecutionAvailable,
      activeExecutor: automaticExecutionAvailable ? 'control' : 'setup_operator',
    };
    assertControlPlaneRecordIsSecretFree(status);
    return status;
  }

  async getTenantRuntimeRouteTargets(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantShardCapacityTarget[]> {
    return this.getTenantRouteTargets(input, expectedEnvironmentId, ['active']);
  }

  async getTenantProvisioningRouteTargets(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantShardCapacityTarget[]> {
    return this.getTenantRouteTargets(input, expectedEnvironmentId, ['provisioning', 'active']);
  }

  private async getTenantRouteTargets(
    input: unknown,
    expectedEnvironmentId: string,
    allowedPolicyStates: readonly ControlTenantPlacementPolicy['state'][]
  ): Promise<ControlTenantShardCapacityTarget[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid_tenant_runtime_route_request');
    }
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).length !== 3 ||
      Object.keys(value).some(
        (key) => !['tenantId', 'residencyPolicyId', 'residencyPartition'].includes(key)
      )
    ) {
      throw new Error('invalid_tenant_runtime_route_request');
    }
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const tenantId = requiredSafeId(value.tenantId, 'tenant_id');
    const residencyPolicyId = requiredSafeId(value.residencyPolicyId, 'residency_policy_id');
    const residencyPartition = requiredPartition(value.residencyPartition, 'residency_partition');
    const policy = await this.dependencies.repository.getTenantPlacementPolicy(
      environmentId,
      tenantId
    );
    if (!policy || !allowedPolicyStates.includes(policy.state)) {
      throw new Error('control_tenant_shard_assignment_policy_missing');
    }
    const targets = await this.dependencies.repository.listActiveTenantShardTargets({
      environmentId,
      tenantId,
      residencyPolicyId,
      residencyPartition,
    });
    const requiredRoles = new Set<TenantShardDataRole>(TENANT_DATA_ROLES);
    if (
      targets.length !== requiredRoles.size ||
      targets.some((target) => !requiredRoles.delete(target.dataRole)) ||
      requiredRoles.size !== 0
    ) {
      throw new Error('control_tenant_shard_assignment_incomplete');
    }
    for (const target of targets) {
      if (
        target.residencyPolicyId !== residencyPolicyId ||
        target.residencyPartition !== residencyPartition ||
        target.allocationScope !== policy.isolationPolicy ||
        (policy.isolationPolicy === 'tenant_exclusive' && target.ownerTenantId !== tenantId) ||
        (policy.isolationPolicy === 'shared_pool' && target.ownerTenantId !== null)
      ) {
        throw new Error('control_tenant_shard_assignment_owner_mismatch');
      }
    }
    assertControlPlaneRecordIsSecretFree(targets);
    return targets;
  }

  async getTenantRegionShardPolicy(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantRegionShardPolicy> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid_tenant_region_shard_policy_request');
    }
    const value = input as Record<string, unknown>;
    if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'tenantId')) {
      throw new Error('invalid_tenant_region_shard_policy_request');
    }
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const tenantId = requiredSafeId(value.tenantId, 'tenant_id');
    if (!this.dependencies.repository.listTenantActiveResidencies) {
      throw new Error('control_tenant_region_shard_repository_unavailable');
    }
    const residencies = await this.dependencies.repository.listTenantActiveResidencies(
      environmentId,
      tenantId
    );
    if (residencies.length !== 1) {
      throw new Error('control_tenant_region_shard_residency_missing');
    }
    const residency = residencies[0];
    await this.getTenantRuntimeRouteTargets(
      {
        tenantId,
        residencyPolicyId: residency.residency_policy_id,
        residencyPartition: residency.residency_partition,
      },
      environmentId
    );
    const allowedRegions = deriveControlRegionShardAllowedRegions({
      jurisdiction: residency.jurisdiction,
      locationHint: residency.location_hint,
    });
    const policy: ControlTenantRegionShardPolicy = {
      tenantId,
      residencyPolicyId: residency.residency_policy_id,
      residencyPartition: residency.residency_partition,
      policyGeneration: residency.policy_generation,
      allowedRegions,
      jurisdiction: residency.jurisdiction,
      locationHint: residency.location_hint,
    };
    assertControlPlaneRecordIsSecretFree(policy);
    return policy;
  }

  async getTenantProvisioningRegionShardPolicy(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantRegionShardPolicy> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid_tenant_region_shard_policy_request');
    }
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).length !== 3 ||
      Object.keys(value).some(
        (key) => !['tenantId', 'residencyPolicyId', 'residencyPartition'].includes(key)
      )
    ) {
      throw new Error('invalid_tenant_region_shard_policy_request');
    }
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const tenantId = requiredSafeId(value.tenantId, 'tenant_id');
    const residencyPolicyId = requiredSafeId(value.residencyPolicyId, 'residency_policy_id');
    const residencyPartition = requiredPartition(value.residencyPartition, 'residency_partition');
    await this.getTenantProvisioningRouteTargets(
      { tenantId, residencyPolicyId, residencyPartition },
      environmentId
    );
    const placementPolicy = await this.dependencies.repository.getTenantPlacementPolicy(
      environmentId,
      tenantId
    );
    if (
      !placementPolicy ||
      (placementPolicy.state !== 'provisioning' && placementPolicy.state !== 'active')
    ) {
      throw new Error('control_tenant_region_shard_residency_missing');
    }
    const residency = await this.dependencies.repository.getResidencyPartition(
      environmentId,
      residencyPolicyId,
      residencyPartition
    );
    if (!residency) {
      throw new Error('control_tenant_region_shard_residency_missing');
    }
    const policy: ControlTenantRegionShardPolicy = {
      tenantId,
      residencyPolicyId,
      residencyPartition,
      policyGeneration: placementPolicy.policyGeneration,
      allowedRegions: deriveControlRegionShardAllowedRegions({
        jurisdiction: residency.jurisdiction,
        locationHint: residency.location_hint,
      }),
      jurisdiction: residency.jurisdiction,
      locationHint: residency.location_hint,
    };
    assertControlPlaneRecordIsSecretFree(policy);
    return policy;
  }

  async getTenantDeletionInventory(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantDeletionInventory> {
    const request = parseTenantDeletionRequest(input);
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const finalized = await this.dependencies.repository.getTenantDeletionFinalization({
      environmentId,
      ...request,
    });
    if (finalized) {
      const result: ControlTenantDeletionInventory = {
        environmentId,
        ...request,
        state: 'finalized',
        lookupShards: [],
        tenantShards: [],
      };
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    }

    const policy = await this.dependencies.repository.getTenantPlacementPolicy(
      environmentId,
      request.tenantId
    );
    if (!policy || (policy.state !== 'active' && policy.state !== 'migrating')) {
      throw new Error('control_tenant_deletion_policy_unavailable');
    }
    const [lookupShards, tenantShards] = await Promise.all([
      this.dependencies.repository.listTenantDeletionLookupShards(environmentId),
      this.dependencies.repository.listTenantDeletionShards({
        environmentId,
        tenantId: request.tenantId,
      }),
    ]);
    const requiredRoles = new Set<TenantShardDataRole>(TENANT_DATA_ROLES);
    const shardIds = new Set<string>();
    const shardBindings = new Set<string>();
    for (const target of tenantShards) {
      requiredRoles.delete(target.dataRole);
      if (
        !SAFE_ID.test(target.shardId) ||
        !SAFE_ID.test(target.residencyPolicyId) ||
        !SAFE_PARTITION.test(target.residencyPartition) ||
        !SAFE_BINDING.test(target.bindingRef) ||
        (target.status !== 'ready' && target.status !== 'active' && target.status !== 'degraded') ||
        shardIds.has(target.shardId) ||
        shardBindings.has(target.bindingRef) ||
        target.allocationScope !== policy.isolationPolicy ||
        (policy.isolationPolicy === 'tenant_exclusive' &&
          target.ownerTenantId !== request.tenantId) ||
        (policy.isolationPolicy === 'shared_pool' && target.ownerTenantId !== null)
      ) {
        throw new Error('control_tenant_deletion_inventory_invalid');
      }
      shardIds.add(target.shardId);
      shardBindings.add(target.bindingRef);
    }
    const lookupIds = new Set<string>();
    const lookupBindings = new Set<string>();
    for (const target of lookupShards) {
      if (
        !SAFE_ID.test(target.lookupShardId) ||
        !SAFE_BINDING.test(target.bindingRef) ||
        (target.status !== 'ready' && target.status !== 'active' && target.status !== 'draining') ||
        lookupIds.has(target.lookupShardId) ||
        lookupBindings.has(target.bindingRef) ||
        shardBindings.has(target.bindingRef)
      ) {
        throw new Error('control_tenant_deletion_inventory_invalid');
      }
      lookupIds.add(target.lookupShardId);
      lookupBindings.add(target.bindingRef);
    }
    if (lookupShards.length === 0 || tenantShards.length === 0 || requiredRoles.size !== 0) {
      throw new Error('control_tenant_deletion_inventory_incomplete');
    }
    const result: ControlTenantDeletionInventory = {
      environmentId,
      ...request,
      state: 'ready',
      lookupShards,
      tenantShards,
    };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }

  async finalizeTenantDeletionControlState(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantDeletionFinalization> {
    const request = parseTenantDeletionRequest(input);
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const existing = await this.dependencies.repository.getTenantDeletionFinalization({
      environmentId,
      ...request,
    });
    if (existing) return existing;
    const inventory = await this.getTenantDeletionInventory(request, environmentId);
    if (inventory.state !== 'ready') {
      throw new Error('control_tenant_deletion_inventory_unavailable');
    }
    const result = await this.dependencies.repository.finalizeTenantDeletionControlState(
      { environmentId, ...request },
      this.dependencies.now()
    );
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }

  requestTenantShard(
    input: unknown,
    expectedEnvironmentId?: string
  ): Promise<TenantShardRequestResult> {
    return this.requestTenantShardAs(input, 'admin', expectedEnvironmentId);
  }

  async registerTenantPlacementPolicy(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantPlacementPolicy> {
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const request = parsePlacementPolicyRegistration(input);
    const policy = await this.dependencies.repository.registerTenantPlacementPolicy(
      { ...request, environmentId },
      this.dependencies.now()
    );
    assertControlPlaneRecordIsSecretFree(policy);
    return policy;
  }

  async activateTenantPlacementPolicy(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantPlacementPolicy> {
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const request = parsePlacementPolicyActivation(input);
    const policy = await this.dependencies.repository.activateTenantPlacementPolicy(
      { ...request, environmentId },
      this.dependencies.now()
    );
    assertControlPlaneRecordIsSecretFree(policy);
    return policy;
  }

  async getTenantPlacementPolicy(
    tenantId: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantPlacementPolicy | null> {
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const policy = await this.dependencies.repository.getTenantPlacementPolicy(
      environmentId,
      requiredSafeId(tenantId, 'tenant_id')
    );
    if (policy) assertControlPlaneRecordIsSecretFree(policy);
    return policy;
  }

  async ensureTenantShardCapacity(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlTenantShardCapacityResult> {
    const capacityRequest = parseCapacityRequest(input, expectedEnvironmentId);
    const policy = await this.dependencies.repository.getTenantPlacementPolicy(
      expectedEnvironmentId,
      capacityRequest.tenantId
    );
    if (!policy || policy.state === 'retired') {
      throw new Error('control_tenant_placement_policy_missing');
    }
    const allocationScope = policy.isolationPolicy;
    const ownerTenantId = allocationScope === 'tenant_exclusive' ? policy.tenantId : null;
    const request = {
      environmentId: expectedEnvironmentId,
      tenantId: capacityRequest.tenantId,
      dataRole: capacityRequest.dataRole,
      residencyPolicyId: capacityRequest.residencyPolicyId,
      residencyPartition: capacityRequest.residencyPartition,
      idempotencyKey: capacityRequest.idempotencyKey,
      allocationScope,
      ownerTenantId,
    } satisfies TenantShardRequest;
    const scope = {
      environmentId: request.environmentId,
      tenantId: capacityRequest.tenantId,
      dataRole: request.dataRole,
      residencyPolicyId: request.residencyPolicyId,
      residencyPartition: request.residencyPartition,
      allocationScope,
      ownerTenantId,
    };
    const eligible = await this.dependencies.repository.findEligibleTenantShard(scope);
    if (eligible) {
      const result: ControlTenantShardCapacityResult = {
        state: 'ready',
        target: eligible,
        operation: null,
      };
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    }

    if (
      capacityRequest.dataRole === 'tenant_core/default' &&
      (await this.dependencies.repository.hasTenantShardAssignment(scope))
    ) {
      const result: ControlTenantShardCapacityResult = {
        state: 'blocked',
        target: null,
        operation: null,
        reasonCode: 'control_tenant_default_assignment_unavailable',
      };
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    }

    const assignable = await this.dependencies.repository.findAssignableTenantShard(scope);
    if (assignable) {
      const target = await this.dependencies.repository.assignTenantShard(
        {
          environmentId: scope.environmentId,
          tenantId: scope.tenantId,
          dataRole: scope.dataRole,
          residencyPolicyId: scope.residencyPolicyId,
          residencyPartition: scope.residencyPartition,
          shardId: assignable.shardId,
          sourceOperationId: capacityRequest.idempotencyKey,
        },
        this.dependencies.now()
      );
      const result: ControlTenantShardCapacityResult = {
        state: 'ready',
        target,
        operation: null,
      };
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    }

    const inFlight = await this.dependencies.repository.findCapacityProvisioningOperation(scope);
    const operation =
      inFlight ??
      (await this.requestTenantShardAs(request, 'admin', expectedEnvironmentId)).operation;
    if (!operation) throw new Error('control_capacity_operation_missing');

    if (operation.status === 'succeeded') {
      const provisioned = await this.dependencies.repository.findAssignableTenantShard(scope);
      if (!provisioned) throw new Error('control_capacity_reflection_failed');
      const reflected = await this.dependencies.repository.assignTenantShard(
        {
          environmentId: scope.environmentId,
          tenantId: scope.tenantId,
          dataRole: scope.dataRole,
          residencyPolicyId: scope.residencyPolicyId,
          residencyPartition: scope.residencyPartition,
          shardId: provisioned.shardId,
          sourceOperationId: operation.operationId,
        },
        this.dependencies.now()
      );
      const result: ControlTenantShardCapacityResult = {
        state: 'ready',
        target: reflected,
        operation: operationSummary(operation),
      };
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    }

    const result: ControlTenantShardCapacityResult =
      operation.status === 'blocked'
        ? {
            state: 'blocked',
            target: null,
            operation: operationSummary(operation),
            reasonCode: operation.lastErrorCode ?? 'control_capacity_blocked',
          }
        : {
            state: 'provisioning',
            target: null,
            operation: operationSummary(operation),
          };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }

  private async requestTenantShardAs(
    input: unknown,
    requestedByType: 'admin' | 'scheduler',
    expectedEnvironmentId?: string,
    allowLookup = false
  ): Promise<TenantShardRequestResult> {
    const request = parseRequest(input, expectedEnvironmentId, allowLookup);
    const allocationScope = request.allocationScope ?? 'shared_pool';
    const ownerTenantId = request.ownerTenantId ?? null;
    if (
      (request.dataRole === 'lookup' &&
        (allocationScope !== 'shared_pool' || request.tenantId !== undefined || ownerTenantId)) ||
      (allocationScope === 'shared_pool' && ownerTenantId !== null) ||
      (allocationScope === 'tenant_exclusive' &&
        (!request.tenantId || ownerTenantId !== request.tenantId))
    ) {
      throw new Error('invalid_tenant_shard_owner');
    }
    if (allocationScope === 'tenant_exclusive') {
      if (!ownerTenantId) throw new Error('invalid_tenant_shard_owner');
      const tenantPolicy = await this.dependencies.repository.getTenantPlacementPolicy(
        request.environmentId,
        ownerTenantId
      );
      if (
        !tenantPolicy ||
        tenantPolicy.isolationPolicy !== 'tenant_exclusive' ||
        tenantPolicy.state === 'retired'
      ) {
        throw new Error('control_tenant_placement_policy_missing');
      }
    }
    const [environment, partition, policy, replicationPolicy] = await Promise.all([
      this.dependencies.repository.getEnvironment(request.environmentId),
      this.dependencies.repository.getResidencyPartition(
        request.environmentId,
        request.residencyPolicyId,
        request.residencyPartition
      ),
      this.dependencies.repository.getResourcePolicy(request.environmentId),
      this.dependencies.repository.getReadReplicationPolicy(
        request.environmentId,
        request.dataRole,
        request.residencyPartition
      ),
    ]);
    if (!environment) throw new Error('control_environment_not_found');
    if (!partition) throw new Error('control_residency_partition_not_found');
    if (!policy) throw new Error('control_resource_policy_not_found');
    const plan = await buildPlan(
      request,
      environment.environment_name,
      partition,
      replicationPolicy?.desired_mode ?? 'disabled'
    );
    if (request.dryRun) return { dryRun: true, plan, operation: null };

    let operation: ControlOperationView;
    try {
      operation = await this.dependencies.repository.createShardPlan(
        plan,
        this.dependencies.now(),
        requestedByType
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('control_d1_resource_limit')) {
        throw new Error('control_d1_resource_limit');
      }
      if (error instanceof Error && error.message === 'control_operation_idempotency_conflict') {
        throw error;
      }
      throw new Error('control_persistence_failed');
    }
    if (
      (operation.status === 'queued' || operation.status === 'waiting_retry') &&
      !(await this.automaticProvisioningReady(request.environmentId))
    ) {
      if (!this.dependencies.repository.markOperationAwaitingOperator) {
        throw new Error('control_operator_executor_handoff_unavailable');
      }
      operation = await this.dependencies.repository.markOperationAwaitingOperator(
        operation.operationId,
        this.dependencies.now()
      );
      return { dryRun: false, plan, operation };
    }
    if (operation.status === 'queued' || operation.status === 'running') {
      return {
        dryRun: false,
        plan,
        operation: await this.provisionPlan(plan),
      };
    }
    return { dryRun: false, plan, operation };
  }

  getOperation(
    operationId: unknown,
    expectedEnvironmentId?: string
  ): Promise<ControlOperationView | null> {
    return this.dependencies.repository.getOperation(
      requiredSafeId(operationId, 'operation_id'),
      expectedEnvironmentId ? requiredSafeId(expectedEnvironmentId, 'environment_id') : undefined
    );
  }

  async previewCapacityProvisioning(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlCapacityProvisioningPreview> {
    const environmentId = requiredSafeId(expectedEnvironmentId, 'environment_id');
    const request = parseCapacityProfileRequest(input);
    const plannerInput = await this.dependencies.repository.getCapacityPlannerInput(
      environmentId,
      request.scope,
      request.tenantId
    );
    const environment = await this.dependencies.repository.getEnvironment(environmentId);
    if (!environment) throw new Error('control_environment_not_found');
    const plan = planControlCapacity({ ...plannerInput, profile: request.profile });
    const targets: ControlCapacityProvisioningPreview['targets'][number][] = [];
    for (const target of plan.targets) {
      for (let offset = 1; offset <= target.addUnits; offset += 1) {
        const unitIndex = target.readyUnits + target.inFlightUnits + offset;
        for (const resource of target.resources) {
          const [partition, replication] = await Promise.all([
            this.dependencies.repository.getResidencyPartition(
              environmentId,
              resource.residencyPolicyId,
              resource.residencyPartition
            ),
            this.dependencies.repository.getReadReplicationPolicy(
              environmentId,
              resource.dataRole,
              resource.residencyPartition
            ),
          ]);
          if (!partition) throw new Error('control_residency_partition_missing');
          const shardPlan = await buildPlan(
            {
              environmentId,
              tenantId: request.tenantId ?? undefined,
              dataRole: resource.dataRole,
              residencyPolicyId: resource.residencyPolicyId,
              residencyPartition: resource.residencyPartition,
              allocationScope: request.scope,
              ownerTenantId: request.scope === 'tenant_exclusive' ? request.tenantId : null,
              idempotencyKey: await capacityUnitIdempotencyKey({
                scope: request.scope,
                tenantId: request.tenantId,
                unitKey: target.unitKey,
                unitIndex,
              }),
              dryRun: true,
            },
            environment.environment_name,
            partition,
            replication?.desired_mode ?? 'disabled'
          );
          targets.push({
            unitKey: target.unitKey,
            unitIndex,
            workerScripts: resource.workerScripts,
            operationId: shardPlan.operationId,
            environmentId,
            dataRole: shardPlan.dataRole,
            residencyPolicyId: shardPlan.residencyPolicyId,
            residencyPartition: shardPlan.residencyPartition,
            logicalShardId: shardPlan.logicalShardId,
            databaseName: shardPlan.databaseName,
            bindingRef: shardPlan.bindingRef,
            readReplicationMode: shardPlan.readReplicationMode,
            migrationStreamId: shardPlan.migrationStreamId,
          });
        }
      }
    }
    const preview: ControlCapacityProvisioningPreview = {
      dryRun: true,
      profile: plan.profile,
      scope: plan.scope,
      tenantId: plan.tenantId,
      available: plan.available,
      reasonCode: plan.reasonCode,
      capacityUnitsAdded: plan.capacityUnitsAdded,
      d1DatabasesAdded: plan.d1DatabasesAdded,
      projectedEnvironmentD1Count: plan.projectedEnvironmentD1Count,
      targets,
    };
    assertControlPlaneRecordIsSecretFree(preview);
    return preview;
  }

  async requestCapacityProvisioning(
    input: unknown,
    expectedEnvironmentId: string
  ): Promise<ControlCapacityProvisioningResult> {
    const request = parseCapacityProvisioningRequest(input);
    const preview = await this.previewCapacityProvisioning(
      { profile: request.profile, scope: request.scope, tenantId: request.tenantId },
      expectedEnvironmentId
    );
    if (!preview.available) {
      throw new Error(preview.reasonCode ?? 'control_capacity_profile_unavailable');
    }
    const operations: ControlProvisioningOperationSummary[] = [];
    for (const target of preview.targets) {
      const result = await this.requestTenantShardAs(
        {
          environmentId: expectedEnvironmentId,
          tenantId: request.tenantId ?? undefined,
          dataRole: target.dataRole,
          residencyPolicyId: target.residencyPolicyId,
          residencyPartition: target.residencyPartition,
          allocationScope: request.scope,
          ownerTenantId: request.scope === 'tenant_exclusive' ? request.tenantId : null,
          idempotencyKey: await capacityUnitIdempotencyKey({
            scope: request.scope,
            tenantId: request.tenantId,
            unitKey: target.unitKey,
            unitIndex: target.unitIndex,
          }),
        },
        'admin',
        expectedEnvironmentId,
        target.dataRole === 'lookup'
      );
      if (result.plan.operationId !== target.operationId || !result.operation) {
        throw new Error('control_capacity_operation_reflection_failed');
      }
      operations.push(operationSummary(result.operation));
    }
    const result: ControlCapacityProvisioningResult = { preview, operations };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }

  async reconcilePending(): Promise<{ attempted: number; succeeded: number; failed: number }> {
    const [plans, migrationPlans] = await Promise.all([
      this.dependencies.repository.listPendingShardPlans(MAX_RECONCILE_OPERATIONS),
      this.dependencies.repository.listPendingMigrationPlans(MAX_RECONCILE_OPERATIONS),
    ]);
    let succeeded = 0;
    let failed = 0;
    for (const plan of plans) {
      try {
        if (!(await this.automaticProvisioningReady(plan.environmentId))) {
          if (this.dependencies.repository.markOperationAwaitingOperator) {
            await this.dependencies.repository.markOperationAwaitingOperator(
              plan.operationId,
              this.dependencies.now()
            );
          }
          failed += 1;
          continue;
        }
        const operation = await this.provisionPlan(plan);
        if (operation.status === 'blocked' || operation.lastErrorCode) failed += 1;
        else succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    for (const plan of migrationPlans.slice(
      0,
      Math.max(0, MAX_RECONCILE_OPERATIONS - plans.length)
    )) {
      try {
        if (!(await this.automaticProvisioningReady(plan.environmentId))) {
          if (this.dependencies.repository.markOperationAwaitingOperator) {
            await this.dependencies.repository.markOperationAwaitingOperator(
              plan.operationId,
              this.dependencies.now()
            );
          }
          failed += 1;
          continue;
        }
        const operation = await this.migratePlan(plan);
        if (operation.status === 'blocked' || operation.lastErrorCode) failed += 1;
        else succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      attempted:
        plans.length + Math.min(migrationPlans.length, MAX_RECONCILE_OPERATIONS - plans.length),
      succeeded,
      failed,
    };
  }

  async replenishLowWatermark(): Promise<{ planned: number; failed: number }> {
    const requests =
      await this.dependencies.repository.listLowWatermarkRequests(MAX_RECONCILE_OPERATIONS);
    let planned = 0;
    let failed = 0;
    for (const request of requests) {
      try {
        await this.requestTenantShardAs(
          {
            ...request,
            idempotencyKey: `low-water:${slug(request.dataRole)}:${request.residencyPartition}:${request.supplyCount}`,
          },
          'scheduler'
        );
        planned += 1;
      } catch {
        failed += 1;
      }
    }
    return { planned, failed };
  }

  private async provisionPlan(plan: TenantShardPlan): Promise<ControlOperationView> {
    const now = this.dependencies.now();
    const ownerId = `reconciler:${crypto.randomUUID()}`;
    const lease = await this.dependencies.repository.tryStartProvisioning(
      plan.operationId,
      ownerId,
      now
    );
    if (!lease) {
      await this.dependencies.repository.markOperationDeferredIfRunnable(
        plan.operationId,
        'control_concurrency_limited',
        now + 30,
        now
      );
      const deferred = await this.dependencies.repository.getOperation(plan.operationId);
      if (!deferred) throw new Error('control_operation_missing_after_defer');
      return deferred;
    }
    const api =
      this.dependencies.createApiClient?.(this.dependencies.env) ??
      createControlApiClients(this.dependencies.env).d1;
    return executeControlProvisioningEffect({
      executor: 'control',
      effect: 'create_d1',
      operation: lease.operation,
      execute: () =>
        ensureControlProvisioningD1({
          plan,
          provider: api,
          reserveCreate: () => this.dependencies.repository.reserveD1CreateBudget(lease, now),
        }),
      onSuccess: (databaseId) =>
        this.dependencies.repository.markDatabaseCreated(
          lease,
          plan,
          databaseId,
          plan.readReplicationMode,
          this.dependencies.now()
        ),
      onRetry: async (decision) => {
        if (decision.nextAttemptAt === null) {
          throw new Error('control_provisioning_retry_time_missing');
        }
        await this.dependencies.repository.markOperationRetry(
          lease,
          decision.code,
          decision.nextAttemptAt,
          this.dependencies.now()
        );
        return this.operationAfterFailure(plan.operationId, 'provider');
      },
      onBlocked: async (decision) => {
        await this.dependencies.repository.markOperationBlocked(
          lease,
          decision.code,
          this.dependencies.now()
        );
        return this.operationAfterFailure(plan.operationId, 'provider');
      },
      now: this.dependencies.now,
    });
  }

  private async migratePlan(plan: PendingMigrationPlan): Promise<ControlOperationView> {
    const now = this.dependencies.now();
    const ownerId = `migration-reconciler:${crypto.randomUUID()}`;
    const lease = await this.dependencies.repository.tryStartMigration(
      plan.operationId,
      ownerId,
      now
    );
    if (!lease) {
      await this.dependencies.repository.markOperationDeferredIfRunnable(
        plan.operationId,
        'control_concurrency_limited',
        now + 30,
        now
      );
      const deferred = await this.dependencies.repository.getOperation(plan.operationId);
      if (!deferred) throw new Error('control_operation_missing_after_migration_defer');
      return deferred;
    }
    const engine =
      this.dependencies.createMigrationEngine?.(this.dependencies.env) ??
      new ApiMigrationEngine(
        new MigrationReleaseArtifactReader(
          new R2ReleaseArtifactStore(this.dependencies.env.MIGRATION_RELEASES)
        ),
        cloudflareMigrationExecutor(createControlApiClients(this.dependencies.env).d1),
        () => this.dependencies.now() * 1000
      );
    return executeControlProvisioningEffect({
      executor: 'control',
      effect: 'apply_migrations',
      operation: lease.operation,
      execute: async () => {
        const result = await engine.apply({
          databaseId: plan.databaseId,
          pin: {
            environmentId: plan.environmentId,
            streamId: plan.streamId,
            releaseId: plan.releaseId,
            manifestDigest: plan.manifestDigest,
            manifestObjectKey: plan.manifestObjectKey,
          },
        });
        await (this.dependencies.writeMigrationMetadata ?? writeMigrationMetadata)(
          this.dependencies.env,
          plan,
          result,
          this.dependencies.now()
        );
        return result;
      },
      onSuccess: (result) =>
        this.dependencies.repository.markMigrationReady(
          lease,
          plan,
          result,
          this.dependencies.now()
        ),
      onRetry: async (decision) => {
        if (decision.nextAttemptAt === null) {
          throw new Error('control_provisioning_retry_time_missing');
        }
        await this.dependencies.repository.markMigrationRetry(
          lease,
          decision.code,
          decision.nextAttemptAt,
          this.dependencies.now()
        );
        return this.operationAfterFailure(plan.operationId, 'migration');
      },
      onBlocked: async (decision) => {
        await this.dependencies.repository.markMigrationBlocked(
          lease,
          decision.code,
          this.dependencies.now()
        );
        return this.operationAfterFailure(plan.operationId, 'migration');
      },
      now: this.dependencies.now,
    });
  }

  private async operationAfterFailure(
    operationId: string,
    effect: 'provider' | 'migration'
  ): Promise<ControlOperationView> {
    const operation = await this.dependencies.repository.getOperation(operationId);
    if (!operation) {
      throw new Error(
        effect === 'provider'
          ? 'control_operation_missing_after_provider_failure'
          : 'control_operation_missing_after_migration_failure'
      );
    }
    return operation;
  }
}
