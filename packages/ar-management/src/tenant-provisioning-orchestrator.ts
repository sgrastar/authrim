import {
  assertControlPlaneRecordIsSecretFree,
  type ControlTenantDefaultRouteAllocation,
  type ControlTenantPlacementPolicy,
  type ControlTenantShardCapacityResult,
  type ControlTenantShardDataRole,
  type ControlTenantRuntimeRouteObservation,
  type Env,
} from '@authrim/ar-lib-core';
import {
  TenantProvisioningOperationRepository,
  type TenantProvisioningLease,
  type TenantProvisioningOperationView,
  type TenantProvisioningStep,
} from './tenant-provisioning-operation';

const CAPACITY_ROLES = [
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
] as const satisfies readonly ControlTenantShardDataRole[];
const RETRY_SECONDS = 15;
const OPERATOR_HANDOFF_RETRY_SECONDS = 60;
const RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_ERROR_CODE =
  /^(?:(?:cloudflare|control|runtime_smoke|tenant_provisioning|tenant_alias|tenant_runtime_registry)_[a-z0-9_]+|operator_action_required)$/u;

export interface TenantProvisioningSagaDependencies {
  validatePlatformDraft(operation: TenantProvisioningOperationView): Promise<void>;
  seedTenant(
    operation: TenantProvisioningOperationView,
    route: ControlTenantDefaultRouteAllocation
  ): Promise<void>;
  publishRegistry(
    operation: TenantProvisioningOperationView,
    route: ControlTenantDefaultRouteAllocation
  ): Promise<void>;
  smokeTenant(
    operation: TenantProvisioningOperationView,
    route: ControlTenantDefaultRouteAllocation
  ): Promise<void>;
  prepareTenant(
    operation: TenantProvisioningOperationView,
    route: ControlTenantDefaultRouteAllocation
  ): Promise<Record<string, unknown> | null>;
  activateLookup(
    operation: TenantProvisioningOperationView,
    route: ControlTenantDefaultRouteAllocation
  ): Promise<void>;
  activateTenant(
    operation: TenantProvisioningOperationView,
    route: ControlTenantDefaultRouteAllocation
  ): Promise<ControlTenantRuntimeRouteObservation>;
}

function control(env: Env) {
  const binding = env.CONTROL;
  if (
    !binding?.ensureTenantShardCapacity ||
    !binding.registerTenantPlacementPolicy ||
    !binding.activateTenantPlacementPolicy ||
    !binding.reserveTenantDefaultRoute ||
    !binding.commitTenantDefaultRoute ||
    !binding.releaseTenantDefaultRoute
  ) {
    throw new Error('tenant_provisioning_control_unavailable');
  }
  return binding as Required<
    Pick<
      NonNullable<Env['CONTROL']>,
      | 'ensureTenantShardCapacity'
      | 'registerTenantPlacementPolicy'
      | 'activateTenantPlacementPolicy'
      | 'reserveTenantDefaultRoute'
      | 'commitTenantDefaultRoute'
      | 'releaseTenantDefaultRoute'
    >
  >;
}

function validatePlacementPolicy(
  value: unknown,
  operation: TenantProvisioningOperationView
): ControlTenantPlacementPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tenant_provisioning_placement_response_invalid');
  }
  const policy = value as Record<string, unknown>;
  if (
    !hasExactKeys(policy, [
      'tenantId',
      'isolationPolicy',
      'policyGeneration',
      'state',
      'pendingIsolationPolicy',
      'pendingPolicyGeneration',
      'migrationOperationId',
      'sourceOperationId',
      'createdAt',
      'updatedAt',
    ]) ||
    policy.tenantId !== operation.tenantId ||
    policy.isolationPolicy !== operation.isolationPolicy ||
    !Number.isSafeInteger(policy.policyGeneration) ||
    Number(policy.policyGeneration) < 1 ||
    !['provisioning', 'active'].includes(String(policy.state)) ||
    policy.pendingIsolationPolicy !== null ||
    policy.pendingPolicyGeneration !== null ||
    policy.migrationOperationId !== null ||
    policy.sourceOperationId !== operation.operationId ||
    !Number.isSafeInteger(policy.createdAt) ||
    !Number.isSafeInteger(policy.updatedAt)
  ) {
    throw new Error('tenant_provisioning_placement_response_invalid');
  }
  assertControlPlaneRecordIsSecretFree(policy);
  return policy as unknown as ControlTenantPlacementPolicy;
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code.length <= 128 && SAFE_ERROR_CODE.test(code)) {
    return code;
  }
  return 'tenant_provisioning_step_failed';
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isSafeIntegerOrNull(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function validateOperationSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return (
    hasExactKeys(summary, [
      'operationId',
      'status',
      'attemptCount',
      'nextAttemptAt',
      'lastErrorCode',
      'createdAt',
      'updatedAt',
    ]) &&
    typeof summary.operationId === 'string' &&
    SAFE_ID.test(summary.operationId) &&
    typeof summary.status === 'string' &&
    ['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(
      summary.status
    ) &&
    Number.isSafeInteger(summary.attemptCount) &&
    Number(summary.attemptCount) >= 0 &&
    isSafeIntegerOrNull(summary.nextAttemptAt) &&
    (summary.lastErrorCode === null ||
      (typeof summary.lastErrorCode === 'string' &&
        summary.lastErrorCode.length <= 128 &&
        SAFE_ERROR_CODE.test(summary.lastErrorCode))) &&
    Number.isSafeInteger(summary.createdAt) &&
    Number(summary.createdAt) >= 0 &&
    Number.isSafeInteger(summary.updatedAt) &&
    Number(summary.updatedAt) >= 0
  );
}

function validateCapacityResult(
  value: unknown,
  dataRole: ControlTenantShardDataRole,
  operation: TenantProvisioningOperationView
): ControlTenantShardCapacityResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tenant_provisioning_capacity_response_invalid');
  }
  const result = value as Record<string, unknown>;
  assertControlPlaneRecordIsSecretFree(result);
  if (result.state === 'ready') {
    if (!hasExactKeys(result, ['state', 'target', 'operation'])) {
      throw new Error('tenant_provisioning_capacity_response_invalid');
    }
    if (!result.target || typeof result.target !== 'object' || Array.isArray(result.target)) {
      throw new Error('tenant_provisioning_capacity_response_invalid');
    }
    const target = result.target as Record<string, unknown>;
    if (
      !hasExactKeys(target, [
        'shardId',
        'dataRole',
        'residencyPolicyId',
        'residencyPartition',
        'routeGeneration',
        'bindingRef',
        'databaseId',
        'databaseName',
        'allocationScope',
        'ownerTenantId',
        'assignmentGeneration',
      ]) ||
      typeof target.shardId !== 'string' ||
      !SAFE_ID.test(target.shardId) ||
      target.dataRole !== dataRole ||
      target.residencyPolicyId !== operation.residencyPolicyId ||
      target.residencyPartition !== operation.residencyPartition ||
      !Number.isSafeInteger(target.routeGeneration) ||
      Number(target.routeGeneration) < 1 ||
      typeof target.bindingRef !== 'string' ||
      !SAFE_BINDING.test(target.bindingRef) ||
      typeof target.databaseId !== 'string' ||
      !SAFE_ID.test(target.databaseId) ||
      typeof target.databaseName !== 'string' ||
      !SAFE_ID.test(target.databaseName) ||
      target.allocationScope !== operation.isolationPolicy ||
      target.ownerTenantId !==
        (operation.isolationPolicy === 'tenant_exclusive' ? operation.tenantId : null) ||
      !Number.isSafeInteger(target.assignmentGeneration) ||
      Number(target.assignmentGeneration) < 1 ||
      (result.operation !== null && !validateOperationSummary(result.operation))
    ) {
      throw new Error('tenant_provisioning_capacity_response_invalid');
    }
    return result as unknown as ControlTenantShardCapacityResult;
  }
  if (result.state === 'blocked') {
    if (
      !hasExactKeys(result, ['state', 'target', 'operation', 'reasonCode']) ||
      result.target !== null ||
      (result.operation !== null && !validateOperationSummary(result.operation)) ||
      typeof result.reasonCode !== 'string' ||
      !SAFE_ERROR_CODE.test(result.reasonCode)
    ) {
      throw new Error('tenant_provisioning_capacity_response_invalid');
    }
    return result as unknown as ControlTenantShardCapacityResult;
  }
  if (
    !hasExactKeys(result, ['state', 'target', 'operation']) ||
    result.state !== 'provisioning' ||
    result.target !== null ||
    !validateOperationSummary(result.operation)
  ) {
    throw new Error('tenant_provisioning_capacity_response_invalid');
  }
  const summary = result.operation as Record<string, unknown>;
  if (!['queued', 'running', 'waiting_retry'].includes(String(summary.status))) {
    throw new Error('tenant_provisioning_capacity_response_invalid');
  }
  return result as unknown as ControlTenantShardCapacityResult;
}

export function decodeTenantProvisioningRoute(
  value: unknown,
  operation: TenantProvisioningOperationView
): ControlTenantDefaultRouteAllocation | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tenant_provisioning_default_route_invalid');
  }
  const record = value as Record<string, unknown>;
  const target = record.target;
  if (
    !hasExactKeys(record, ['allocationId', 'tenantId', 'state', 'target']) ||
    typeof record.allocationId !== 'string' ||
    !SAFE_ID.test(record.allocationId) ||
    record.tenantId !== operation.tenantId ||
    (record.state !== 'reserved' && record.state !== 'committed' && record.state !== 'released') ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target)
  ) {
    throw new Error('tenant_provisioning_default_route_invalid');
  }
  const routeTarget = target as Record<string, unknown>;
  if (
    !hasExactKeys(routeTarget, [
      'shardId',
      'dataRole',
      'residencyPolicyId',
      'residencyPartition',
      'routeGeneration',
      'bindingRef',
      'databaseId',
      'databaseName',
      'allocationScope',
      'ownerTenantId',
      'assignmentGeneration',
    ])
  ) {
    throw new Error('tenant_provisioning_default_route_invalid');
  }
  const route = record as unknown as ControlTenantDefaultRouteAllocation;
  if (
    route.target.dataRole !== 'tenant_core/default' ||
    !SAFE_ID.test(route.target.shardId) ||
    route.target.residencyPolicyId !== operation.residencyPolicyId ||
    route.target.residencyPartition !== operation.residencyPartition ||
    !SAFE_BINDING.test(route.target.bindingRef) ||
    !SAFE_ID.test(route.target.databaseId) ||
    !SAFE_ID.test(route.target.databaseName) ||
    route.target.allocationScope !== operation.isolationPolicy ||
    route.target.ownerTenantId !==
      (operation.isolationPolicy === 'tenant_exclusive' ? operation.tenantId : null) ||
    !Number.isSafeInteger(route.target.assignmentGeneration) ||
    route.target.assignmentGeneration < 1 ||
    !Number.isSafeInteger(route.target.routeGeneration) ||
    route.target.routeGeneration < 1
  ) {
    throw new Error('tenant_provisioning_default_route_invalid');
  }
  assertControlPlaneRecordIsSecretFree(route);
  return route;
}

function sameRouteTarget(
  reserved: ControlTenantDefaultRouteAllocation,
  committed: ControlTenantDefaultRouteAllocation
): boolean {
  return (
    reserved.allocationId === committed.allocationId &&
    reserved.tenantId === committed.tenantId &&
    reserved.target.shardId === committed.target.shardId &&
    reserved.target.dataRole === committed.target.dataRole &&
    reserved.target.residencyPolicyId === committed.target.residencyPolicyId &&
    reserved.target.residencyPartition === committed.target.residencyPartition &&
    reserved.target.routeGeneration === committed.target.routeGeneration &&
    reserved.target.bindingRef === committed.target.bindingRef &&
    reserved.target.databaseId === committed.target.databaseId &&
    reserved.target.databaseName === committed.target.databaseName &&
    reserved.target.allocationScope === committed.target.allocationScope &&
    reserved.target.ownerTenantId === committed.target.ownerTenantId &&
    reserved.target.assignmentGeneration === committed.target.assignmentGeneration
  );
}

async function checkpointSucceeded(
  repository: TenantProvisioningOperationRepository,
  lease: TenantProvisioningLease,
  step: TenantProvisioningStep,
  nextStep: TenantProvisioningStep,
  now: number,
  extra: {
    capacityOperationIds?: Record<string, string>;
    defaultRouteAllocation?: Record<string, unknown>;
    preparationResult?: Record<string, unknown>;
    observedResourceId?: string;
  } = {}
): Promise<void> {
  await repository.checkpoint(lease, {
    step,
    nextStep,
    stepStatus: 'succeeded',
    operationStatus: 'running',
    now,
    ...extra,
  });
}

async function ensureCapacity(
  env: Env,
  operation: TenantProvisioningOperationView
): Promise<{
  results: Record<ControlTenantShardDataRole, ControlTenantShardCapacityResult>;
  operationIds: Record<string, string>;
}> {
  const api = control(env);
  const entries = await Promise.all(
    CAPACITY_ROLES.map(async (dataRole) => {
      const result = validateCapacityResult(
        await api.ensureTenantShardCapacity({
          tenantId: operation.tenantId,
          dataRole,
          residencyPolicyId: operation.residencyPolicyId,
          residencyPartition: operation.residencyPartition,
          idempotencyKey: `${operation.operationId}:${dataRole.replaceAll('/', '-')}`,
        }),
        dataRole,
        operation
      );
      return [dataRole, result] as const;
    })
  );
  const results = Object.fromEntries(entries) as Record<
    ControlTenantShardDataRole,
    ControlTenantShardCapacityResult
  >;
  return {
    results,
    operationIds: Object.fromEntries(
      entries.flatMap(([role, result]) =>
        result.operation ? [[role, result.operation.operationId] as const] : []
      )
    ),
  };
}

export async function runTenantProvisioningSaga(input: {
  env: Env;
  repository: TenantProvisioningOperationRepository;
  lease: TenantProvisioningLease;
  dependencies: TenantProvisioningSagaDependencies;
  now: () => number;
}): Promise<void> {
  let operation = input.lease.operation;
  let route: ControlTenantDefaultRouteAllocation | null = null;
  let currentStep = operation.currentStep;
  try {
    route = decodeTenantProvisioningRoute(operation.defaultRouteAllocation, operation);
    if (route?.state === 'released') {
      throw new Error('tenant_provisioning_default_route_released');
    }
    if (currentStep === 'request_accepted' || currentStep === 'capacity_check') {
      currentStep = 'capacity_check';
      validatePlacementPolicy(
        await control(input.env).registerTenantPlacementPolicy({
          tenantId: operation.tenantId,
          isolationPolicy: operation.isolationPolicy,
          sourceOperationId: operation.operationId,
          idempotencyKey: `${operation.operationId}:placement-policy`,
        }),
        operation
      );
      await input.dependencies.validatePlatformDraft(operation);
      const capacity = await ensureCapacity(input.env, operation);
      const capacityOperationIds = {
        ...operation.capacityOperationIds,
        ...capacity.operationIds,
      };
      const blocked = Object.values(capacity.results).find((result) => result.state === 'blocked');
      if (blocked?.state === 'blocked') {
        const errorCode = safeErrorCode(new Error(blocked.reasonCode));
        const operatorHandoffPending = errorCode === 'operator_action_required';
        const now = input.now();
        await input.repository.checkpoint(input.lease, {
          step: 'capacity_check',
          stepStatus: operatorHandoffPending ? 'waiting_retry' : 'blocked',
          operationStatus: operatorHandoffPending ? 'waiting_retry' : 'blocked',
          now,
          ...(operatorHandoffPending
            ? { nextAttemptAt: now + OPERATOR_HANDOFF_RETRY_SECONDS }
            : {}),
          errorCode,
          capacityOperationIds,
        });
        return;
      }
      if (Object.values(capacity.results).some((result) => result.state === 'provisioning')) {
        const now = input.now();
        await input.repository.checkpoint(input.lease, {
          step: 'capacity_check',
          stepStatus: 'waiting_retry',
          operationStatus: 'waiting_retry',
          now,
          nextAttemptAt: now + RETRY_SECONDS,
          capacityOperationIds,
        });
        return;
      }
      await checkpointSucceeded(
        input.repository,
        input.lease,
        'capacity_check',
        'reserve_default_route',
        input.now(),
        { capacityOperationIds }
      );
      currentStep = 'reserve_default_route';
    }

    if (currentStep === 'reserve_default_route') {
      route = decodeTenantProvisioningRoute(
        await control(input.env).reserveTenantDefaultRoute({
          tenantId: operation.tenantId,
          residencyPolicyId: operation.residencyPolicyId,
          residencyPartition: operation.residencyPartition,
          idempotencyKey: `${operation.operationId}:default-route`,
        }),
        operation
      );
      if (!route) throw new Error('tenant_provisioning_default_route_invalid');
      if (route.state === 'released') throw new Error('tenant_provisioning_default_route_released');
      await checkpointSucceeded(
        input.repository,
        input.lease,
        'reserve_default_route',
        'tenant_seed',
        input.now(),
        {
          defaultRouteAllocation: route as unknown as Record<string, unknown>,
          observedResourceId: route.target.databaseId,
        }
      );
      currentStep = 'tenant_seed';
    }
    if (!route) throw new Error('tenant_provisioning_default_route_invalid');

    if (currentStep === 'tenant_seed') {
      await input.dependencies.seedTenant(operation, route);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        'tenant_seed',
        'registry_publish',
        input.now()
      );
      currentStep = 'registry_publish';
    }
    if (currentStep === 'registry_publish') {
      await input.dependencies.publishRegistry(operation, route);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        'registry_publish',
        'tenant_smoke',
        input.now()
      );
      currentStep = 'tenant_smoke';
    }
    if (currentStep === 'tenant_smoke') {
      await input.dependencies.smokeTenant(operation, route);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        'tenant_smoke',
        'tenant_prepare',
        input.now()
      );
      currentStep = 'tenant_prepare';
    }
    if (currentStep === 'tenant_prepare') {
      const preparationResult = await input.dependencies.prepareTenant(operation, route);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        'tenant_prepare',
        'lookup_activate',
        input.now(),
        preparationResult ? { preparationResult } : {}
      );
      if (preparationResult) {
        operation = { ...operation, preparationResult };
      }
      currentStep = 'lookup_activate';
    }
    if (currentStep === 'lookup_activate') {
      await input.dependencies.activateLookup(operation, route);
      await checkpointSucceeded(
        input.repository,
        input.lease,
        'lookup_activate',
        'tenant_active',
        input.now()
      );
      currentStep = 'tenant_active';
    }
    if (currentStep === 'tenant_active') {
      const committed = decodeTenantProvisioningRoute(
        await control(input.env).commitTenantDefaultRoute({
          allocationId: route.allocationId,
        }),
        operation
      );
      if (!committed) throw new Error('tenant_provisioning_default_route_invalid');
      if (committed.state !== 'committed')
        throw new Error('tenant_provisioning_route_commit_failed');
      if (!sameRouteTarget(route, committed)) {
        throw new Error('tenant_provisioning_route_commit_conflict');
      }
      const runtimeRoute = await input.dependencies.activateTenant(operation, committed);
      validatePlacementPolicy(
        await control(input.env).activateTenantPlacementPolicy({
          tenantId: operation.tenantId,
          sourceOperationId: operation.operationId,
          idempotencyKey: `${operation.operationId}:placement-activation`,
          runtimeRoute,
        }),
        operation
      );
      await input.repository.checkpoint(input.lease, {
        step: 'tenant_active',
        stepStatus: 'succeeded',
        operationStatus: 'succeeded',
        now: input.now(),
        defaultRouteAllocation: committed as unknown as Record<string, unknown>,
      });
    }
  } catch (error) {
    const now = input.now();
    const code = safeErrorCode(error);
    // A rolling Service Binding update can yield one malformed capacity response while the
    // deterministic child operations continue. Retrying remains fail closed and reuses the same
    // idempotency keys; only the bounded retry budget may turn this into a permanent block.
    const retryableCapacityResponse = code === 'tenant_provisioning_capacity_response_invalid';
    const permanent =
      (code.includes('_invalid') && !retryableCapacityResponse) ||
      code.includes('_conflict') ||
      code.includes('_released') ||
      now - operation.retryBudgetStartedAt >= RETRY_BUDGET_SECONDS;
    await input.repository.checkpoint(input.lease, {
      step: currentStep,
      stepStatus: permanent ? 'blocked' : 'waiting_retry',
      operationStatus: permanent ? 'blocked' : 'waiting_retry',
      now,
      nextAttemptAt: permanent ? null : now + RETRY_SECONDS,
      errorCode: code,
    });
  }
}
