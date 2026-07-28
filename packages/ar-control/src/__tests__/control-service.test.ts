import {
  CloudflareControlApiError,
  type CloudflareControlApiClient,
} from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import ControlWorker from '../index';
import type {
  ControlRepository,
  EnvironmentRow,
  ProvisioningLease,
  ResidencyPartitionRow,
  ResourcePolicyRow,
} from '../repository';
import { ControlService } from '../service';
import type {
  ControlEnv,
  ControlOperationView,
  LowWatermarkRequest,
  TenantShardPlan,
} from '../types';

const NOW = 1_800_000_000;

function operation(plan: TenantShardPlan): ControlOperationView {
  return {
    operationId: plan.operationId,
    environmentId: plan.environmentId,
    operationKind: 'provision_shard',
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class FakeRepository implements ControlRepository {
  environment: EnvironmentRow | null = {
    environment_id: 'env-test',
    environment_name: 'test',
    lifecycle_state: 'active',
  };
  partition: ResidencyPartitionRow | null = {
    residency_policy_id: 'residency-default',
    residency_partition: 'jp',
    jurisdiction: null,
    location_hint: 'apac',
  };
  policy: ResourcePolicyRow | null = {
    max_concurrent_provisioning: 2,
    max_ready_spares: 2,
    max_d1_resources: 1000,
    daily_d1_create_budget: 20,
    target_account_count: 100000,
  };
  replicationPolicy: {
    desired_mode: 'enabled' | 'disabled';
    consistency_policy_version: number;
  } | null = null;
  plans = new Map<string, TenantShardPlan>();
  operations = new Map<string, ControlOperationView>();
  pending: TenantShardPlan[] = [];
  lowWatermark: LowWatermarkRequest[] = [];
  allowLease = true;
  allowBudget = true;
  budgetReservations = 0;

  async getEnvironment(): Promise<EnvironmentRow | null> {
    return this.environment;
  }

  async getResidencyPartition(): Promise<ResidencyPartitionRow | null> {
    return this.partition;
  }

  async getResourcePolicy(): Promise<ResourcePolicyRow | null> {
    return this.policy;
  }

  async getReadReplicationPolicy() {
    return this.replicationPolicy;
  }

  async createShardPlan(plan: TenantShardPlan): Promise<ControlOperationView> {
    const existing = this.operations.get(plan.operationId);
    if (existing) return existing;
    this.plans.set(plan.operationId, plan);
    const created = operation(plan);
    this.operations.set(plan.operationId, created);
    return created;
  }

  async getOperation(operationId: string): Promise<ControlOperationView | null> {
    return this.operations.get(operationId) ?? null;
  }

  async listPendingShardPlans(): Promise<TenantShardPlan[]> {
    return this.pending;
  }

  async listLowWatermarkRequests(): Promise<LowWatermarkRequest[]> {
    return this.lowWatermark;
  }

  async tryStartProvisioning(
    operationId: string,
    ownerId: string
  ): Promise<ProvisioningLease | null> {
    if (!this.allowLease) return null;
    const current = this.operations.get(operationId);
    if (!current) return null;
    const running = { ...current, status: 'running', attemptCount: current.attemptCount + 1 };
    this.operations.set(operationId, running);
    return { operation: running, ownerId, fencingToken: running.attemptCount };
  }

  async reserveD1CreateBudget(): Promise<boolean> {
    this.budgetReservations += 1;
    return this.allowBudget;
  }

  async markDatabaseCreated(
    _lease: ProvisioningLease,
    plan: TenantShardPlan
  ): Promise<ControlOperationView> {
    const current = this.operations.get(plan.operationId);
    if (!current) throw new Error('missing_fake_operation');
    const waiting = { ...current, status: 'waiting', lastErrorCode: null };
    this.operations.set(plan.operationId, waiting);
    return waiting;
  }

  async markOperationRetry(
    lease: ProvisioningLease,
    errorCode: string,
    nextAttemptAt: number
  ): Promise<void> {
    const current = this.operations.get(lease.operation.operationId);
    if (!current) return;
    this.operations.set(lease.operation.operationId, {
      ...current,
      status: 'waiting',
      lastErrorCode: errorCode,
      nextAttemptAt,
    });
  }

  async markOperationDeferredIfRunnable(
    operationId: string,
    errorCode: string,
    nextAttemptAt: number
  ): Promise<void> {
    const current = this.operations.get(operationId);
    if (!current || current.status === 'running') return;
    this.operations.set(operationId, {
      ...current,
      status: 'waiting',
      lastErrorCode: errorCode,
      nextAttemptAt,
    });
  }

  async markOperationBlocked(lease: ProvisioningLease, errorCode: string): Promise<void> {
    const current = this.operations.get(lease.operation.operationId);
    if (!current) return;
    this.operations.set(lease.operation.operationId, {
      ...current,
      status: 'blocked',
      lastErrorCode: errorCode,
      nextAttemptAt: null,
    });
  }
}

function env(): ControlEnv {
  return {
    CONTROL_DB: {} as D1Database,
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_D1_API_TOKEN: 'd1-token',
    CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: 'env-test',
    dataRole: 'tenant_core/users',
    residencyPolicyId: 'residency-default',
    residencyPartition: 'jp',
    idempotencyKey: 'tenant-capacity-1',
    ...overrides,
  };
}

function controlApi(
  input: Pick<CloudflareControlApiClient, 'listD1Databases' | 'createD1Database'>
): Pick<CloudflareControlApiClient, 'listD1Databases' | 'createD1Database' | 'updateD1Database'> {
  return {
    ...input,
    updateD1Database: vi.fn(
      async (databaseId: string, update: { read_replication: { mode: 'auto' | 'disabled' } }) => ({
        uuid: databaseId,
        name: 'database',
        read_replication: update.read_replication,
      })
    ),
  };
}

describe('Control Worker boundary', () => {
  it('rejects every public HTTP request', async () => {
    const worker = new ControlWorker({} as ConstructorParameters<typeof ControlWorker>[0], env());
    const response = await worker.fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('exposes validation codes but masks storage implementation errors', async () => {
    const worker = new ControlWorker({} as ConstructorParameters<typeof ControlWorker>[0], env());
    await expect(worker.requestTenantShard(null)).rejects.toThrow('invalid_tenant_shard_request');
    await expect(worker.getOperationStatus('operation-id')).rejects.toThrow(
      'control_internal_error'
    );
  });
});

describe('ControlService tenant shard provisioning', () => {
  it('returns a deterministic dry-run plan without writes or provider calls', async () => {
    const repository = new FakeRepository();
    const listD1Databases = vi.fn();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => controlApi({ listD1Databases, createD1Database: vi.fn() }),
    });

    const first = await service.requestTenantShard(
      request({ dryRun: true, jurisdiction: 'fedramp', locationHint: 'wnam' })
    );
    const second = await service.requestTenantShard(request({ dryRun: true }));

    expect(first.plan).toEqual(second.plan);
    expect(first.plan.locationHint).toBe('apac');
    expect(first.plan.jurisdiction).toBeUndefined();
    expect(repository.operations).toHaveLength(0);
    expect(listD1Databases).not.toHaveBeenCalled();
  });

  it('creates once and reuses the deterministic provider database on retry', async () => {
    const repository = new FakeRepository();
    let providerDatabase: { uuid: string; name: string } | undefined;
    const createD1Database = vi.fn(async ({ name }: { name: string }) => {
      providerDatabase = { uuid: 'database-1', name };
      return providerDatabase;
    });
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => (providerDatabase ? [providerDatabase] : []),
          createD1Database,
        }),
    });

    const first = await service.requestTenantShard(request());
    const second = await service.requestTenantShard(request());

    expect(first.operation?.status).toBe('waiting');
    expect(second.operation?.status).toBe('waiting');
    expect(createD1Database).toHaveBeenCalledTimes(1);
    expect(repository.budgetReservations).toBe(1);
  });

  it('defers before create when the daily D1 budget is exhausted', async () => {
    const repository = new FakeRepository();
    repository.allowBudget = false;
    const createD1Database = vi.fn();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => controlApi({ listD1Databases: async () => [], createD1Database }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.lastErrorCode).toBe('control_daily_d1_budget_exhausted');
    expect(result.operation?.nextAttemptAt).toBe((Math.floor(NOW / 86_400) + 1) * 86_400);
    expect(createD1Database).not.toHaveBeenCalled();
  });

  it('does not call Cloudflare when another reconciler owns the operation lease', async () => {
    const repository = new FakeRepository();
    repository.allowLease = false;
    const listD1Databases = vi.fn();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => controlApi({ listD1Databases, createD1Database: vi.fn() }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.lastErrorCode).toBe('control_concurrency_limited');
    expect(listD1Databases).not.toHaveBeenCalled();
  });

  it('redacts transient provider errors and schedules exponential retry', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => {
            throw new Error('network failure containing provider detail');
          },
          createD1Database: vi.fn(),
        }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.status).toBe('waiting');
    expect(result.operation?.lastErrorCode).toBe('cloudflare_d1_request_failed');
    expect(JSON.stringify(result)).not.toContain('provider detail');
    expect(result.operation?.nextAttemptAt).toBeGreaterThanOrEqual(NOW + 30);
  });

  it('blocks permanent capability failures without exposing provider messages', async () => {
    const repository = new FakeRepository();
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () =>
        controlApi({
          listD1Databases: async () => {
            throw new CloudflareControlApiError('d1.list', 403, [10000]);
          },
          createD1Database: vi.fn(),
        }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.operation?.status).toBe('blocked');
    expect(result.operation?.lastErrorCode).toBe('cloudflare_d1_capability_rejected');
  });

  it('derives enabled read replication from Control DB and verifies provider state', async () => {
    const repository = new FakeRepository();
    repository.replicationPolicy = { desired_mode: 'enabled', consistency_policy_version: 1 };
    const updateD1Database = vi.fn(
      async (databaseId: string, update: { read_replication: { mode: 'auto' | 'disabled' } }) => ({
        uuid: databaseId,
        name: 'database',
        read_replication: update.read_replication,
      })
    );
    const service = new ControlService({
      repository,
      env: env(),
      now: () => NOW,
      createApiClient: () => ({
        listD1Databases: async () => [],
        createD1Database: async ({ name }) => ({
          uuid: 'database-1',
          name,
          read_replication: { mode: 'disabled' },
        }),
        updateD1Database,
      }),
    });

    const result = await service.requestTenantShard(request());

    expect(result.plan.readReplicationMode).toBe('enabled');
    expect(updateD1Database).toHaveBeenCalledWith('database-1', {
      read_replication: { mode: 'auto' },
    });
    expect(result.operation?.lastErrorCode).toBeNull();
  });
});
