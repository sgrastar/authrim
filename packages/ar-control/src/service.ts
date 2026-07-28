import {
  CloudflareControlApiClient,
  CloudflareControlApiError,
  assertControlPlaneRecordIsSecretFree,
} from '@authrim/ar-lib-core/control-plane';
import type { ControlRepository } from './repository';
import {
  controlTokens,
  type ControlEnv,
  type ControlOperationView,
  type TenantShardDataRole,
  type TenantShardPlan,
  type TenantShardRequest,
  type TenantShardRequestResult,
} from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATA_ROLES = new Set<TenantShardDataRole>([
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
]);
const MAX_RECONCILE_OPERATIONS = 5;
const STANDARD_RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const MAX_RETRY_DELAY_SECONDS = 60 * 60;

export interface ControlServiceDependencies {
  repository: ControlRepository;
  env: ControlEnv;
  now: () => number;
  createApiClient?: (
    env: ControlEnv
  ) => Pick<
    CloudflareControlApiClient,
    'listD1Databases' | 'createD1Database' | 'updateD1Database'
  >;
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

function parseRequest(input: unknown): TenantShardRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_tenant_shard_request');
  }
  const value = input as Record<string, unknown>;
  const dataRole = value.dataRole;
  if (typeof dataRole !== 'string' || !DATA_ROLES.has(dataRole as TenantShardDataRole)) {
    throw new Error('invalid_data_role');
  }
  return {
    environmentId: requiredSafeId(value.environmentId, 'environment_id'),
    dataRole: dataRole as TenantShardDataRole,
    residencyPolicyId: requiredSafeId(value.residencyPolicyId, 'residency_policy_id'),
    residencyPartition: requiredPartition(value.residencyPartition, 'residency_partition'),
    idempotencyKey: requiredSafeId(value.idempotencyKey, 'idempotency_key'),
    dryRun: value.dryRun === true,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24);
}

function retryDelaySeconds(operation: ControlOperationView): number {
  const exponential = Math.min(
    MAX_RETRY_DELAY_SECONDS,
    30 * 2 ** Math.min(Math.max(operation.attemptCount - 1, 0), 7)
  );
  const jitterSeed = Array.from(operation.operationId).reduce(
    (total, character) => total + character.charCodeAt(0),
    0
  );
  return exponential + (jitterSeed % Math.max(1, Math.floor(exponential / 4)));
}

function classifyProviderError(error: unknown): { code: string; permanent: boolean } {
  if (error instanceof CloudflareControlApiError) {
    if (error.status === 401 || error.status === 403) {
      return { code: 'cloudflare_d1_capability_rejected', permanent: true };
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      return { code: 'cloudflare_d1_request_rejected', permanent: true };
    }
  }
  if (
    error instanceof Error &&
    (error.message === 'cloudflare_d1_create_missing_id' ||
      error.message === 'cloudflare_d1_replication_state_mismatch')
  ) {
    return { code: error.message, permanent: true };
  }
  return { code: 'cloudflare_d1_request_failed', permanent: false };
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
      request.dataRole,
      request.residencyPolicyId,
      request.residencyPartition,
      request.idempotencyKey,
    ].join('\0')
  );
  const role = request.dataRole.replace('tenant_', '').replace('/', '-');
  const logicalShardId = `${role}:${request.residencyPartition}:${digest.slice(0, 12)}`;
  const bindingRole = request.dataRole.replace('tenant_', '').replace('/', '_').toUpperCase();
  const plan: TenantShardPlan = {
    operationId: `op_${digest.slice(0, 32)}`,
    desiredResourceId: `d1_${digest.slice(0, 32)}`,
    shardId: `shard_${digest.slice(0, 32)}`,
    environmentId: request.environmentId,
    environmentName,
    dataRole: request.dataRole,
    residencyPolicyId: request.residencyPolicyId,
    residencyPartition: request.residencyPartition,
    logicalShardId,
    databaseName: `authrim-${slug(environmentName)}-${slug(role)}-${slug(request.residencyPartition)}-${digest.slice(0, 8)}`,
    bindingRef: `TDB_${bindingRole}_${digest.slice(0, 8).toUpperCase()}`,
    ownershipFingerprint: digest,
    jurisdiction: partition.jurisdiction ?? undefined,
    locationHint: partition.location_hint ?? undefined,
    readReplicationMode,
    idempotencyKey: request.idempotencyKey,
  };
  assertControlPlaneRecordIsSecretFree(plan);
  return plan;
}

export class ControlService {
  constructor(private readonly dependencies: ControlServiceDependencies) {}

  requestTenantShard(input: unknown): Promise<TenantShardRequestResult> {
    return this.requestTenantShardAs(input, 'admin');
  }

  private async requestTenantShardAs(
    input: unknown,
    requestedByType: 'admin' | 'scheduler'
  ): Promise<TenantShardRequestResult> {
    const request = parseRequest(input);
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
    if (operation.status === 'pending' || operation.status === 'running') {
      return {
        dryRun: false,
        plan,
        operation: await this.provisionPlan(plan),
      };
    }
    return { dryRun: false, plan, operation };
  }

  getOperation(operationId: unknown): Promise<ControlOperationView | null> {
    return this.dependencies.repository.getOperation(requiredSafeId(operationId, 'operation_id'));
  }

  async reconcilePending(): Promise<{ attempted: number; succeeded: number; failed: number }> {
    const plans =
      await this.dependencies.repository.listPendingShardPlans(MAX_RECONCILE_OPERATIONS);
    let succeeded = 0;
    let failed = 0;
    for (const plan of plans) {
      try {
        const operation = await this.provisionPlan(plan);
        if (operation.status === 'blocked' || operation.lastErrorCode) failed += 1;
        else succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    return { attempted: plans.length, succeeded, failed };
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
      new CloudflareControlApiClient({
        accountId: this.dependencies.env.CLOUDFLARE_ACCOUNT_ID,
        tokens: controlTokens(this.dependencies.env),
      });
    try {
      const existing = (await api.listD1Databases()).find(
        (database) => database.name === plan.databaseName
      );
      if (!existing) {
        const budgetAvailable = await this.dependencies.repository.reserveD1CreateBudget(
          lease,
          now
        );
        if (!budgetAvailable) {
          const nextBudgetDay = (Math.floor(now / 86_400) + 1) * 86_400;
          await this.dependencies.repository.markOperationRetry(
            lease,
            'control_daily_d1_budget_exhausted',
            nextBudgetDay,
            now
          );
          const deferred = await this.dependencies.repository.getOperation(plan.operationId);
          if (!deferred) throw new Error('control_operation_missing_after_budget_defer');
          return deferred;
        }
      }
      const database =
        existing ??
        (await api.createD1Database({
          name: plan.databaseName,
          jurisdiction: plan.jurisdiction,
          primary_location_hint: plan.locationHint,
        }));
      if (!database.uuid) throw new Error('cloudflare_d1_create_missing_id');
      const desiredProviderMode = plan.readReplicationMode === 'enabled' ? 'auto' : 'disabled';
      const replicationResult =
        database.read_replication?.mode === desiredProviderMode
          ? database
          : await api.updateD1Database(database.uuid, {
              read_replication: { mode: desiredProviderMode },
            });
      if (replicationResult.read_replication?.mode !== desiredProviderMode) {
        throw new Error('cloudflare_d1_replication_state_mismatch');
      }
      return this.dependencies.repository.markDatabaseCreated(
        lease,
        plan,
        database.uuid,
        plan.readReplicationMode,
        this.dependencies.now()
      );
    } catch (error) {
      const classified = classifyProviderError(error);
      const failedAt = this.dependencies.now();
      if (
        classified.permanent ||
        failedAt - lease.operation.createdAt >= STANDARD_RETRY_BUDGET_SECONDS
      ) {
        await this.dependencies.repository.markOperationBlocked(
          lease,
          classified.permanent ? classified.code : 'cloudflare_d1_retry_budget_exhausted',
          failedAt
        );
      } else {
        await this.dependencies.repository.markOperationRetry(
          lease,
          classified.code,
          failedAt + retryDelaySeconds(lease.operation),
          failedAt
        );
      }
      const operation = await this.dependencies.repository.getOperation(plan.operationId);
      if (!operation) throw new Error('control_operation_missing_after_provider_failure');
      return operation;
    }
  }
}
