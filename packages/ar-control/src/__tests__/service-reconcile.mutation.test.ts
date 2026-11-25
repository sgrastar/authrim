import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlRepository } from '../repository';
import { ControlService } from '../service';
import type { ControlEnv } from '../types';

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createLogger: () => ({ module: () => logger }),
}));

const NOW = 1_800_000_123;
type Repo = Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => vi.clearAllMocks());

const READY_ENV = {
  AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
  CLOUDFLARE_D1_API_TOKEN: 'd1',
  CLOUDFLARE_WORKERS_API_TOKEN: 'workers',
} as ControlEnv;
const READY_AUTHORITY = {
  automaticProvisioningEnabled: true,
  tokenOwnership: 'account',
  capabilityState: 'ready',
};
const operation = (overrides: Record<string, unknown> = {}) => ({
  operationId: 'op-1',
  environmentId: 'env-1',
  operationKind: 'provision_shard',
  status: 'queued',
  attemptCount: 0,
  nextAttemptAt: null,
  lastErrorCode: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});
const plan = (id: string) => ({ operationId: id, environmentId: 'env-1' });

function build(repository: Repo, env: Partial<ControlEnv> = READY_ENV) {
  return new ControlService({
    repository: repository as unknown as ControlRepository,
    env: env as ControlEnv,
    now: () => NOW,
  });
}
const repo = (overrides: Repo = {}): Repo => ({
  listPendingShardPlans: vi.fn().mockResolvedValue([]),
  listPendingMigrationPlans: vi.fn().mockResolvedValue([]),
  getProvisioningAuthority: vi.fn().mockResolvedValue(READY_AUTHORITY),
  markOperationAwaitingOperator: vi.fn().mockResolvedValue(operation()),
  tryStartProvisioning: vi.fn().mockResolvedValue(null),
  tryStartMigration: vi.fn().mockResolvedValue(null),
  markOperationDeferredIfRunnable: vi.fn().mockResolvedValue(undefined),
  getOperation: vi
    .fn()
    .mockResolvedValue(operation({ lastErrorCode: 'control_concurrency_limited' })),
  ...overrides,
});

describe('reconcilePending', () => {
  it('reads at most five plans of each kind', async () => {
    const repository = repo();
    await expect(build(repository).reconcilePending()).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(repository.listPendingShardPlans).toHaveBeenCalledExactlyOnceWith(5);
    expect(repository.listPendingMigrationPlans).toHaveBeenCalledExactlyOnceWith(5);
  });

  it('defers a plan whose lease is busy and counts the deferral as a failure', async () => {
    const repository = repo({ listPendingShardPlans: vi.fn().mockResolvedValue([plan('op-1')]) });
    await expect(build(repository).reconcilePending()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(repository.tryStartProvisioning).toHaveBeenCalledExactlyOnceWith(
      'op-1',
      expect.stringMatching(/^reconciler:[0-9a-f-]{36}$/u),
      NOW
    );
    expect(repository.markOperationDeferredIfRunnable).toHaveBeenCalledExactlyOnceWith(
      'op-1',
      'control_concurrency_limited',
      NOW + 30,
      NOW
    );
    expect(repository.getOperation).toHaveBeenCalledExactlyOnceWith('op-1');
  });

  it('counts an operation without an error as a success', async () => {
    const repository = repo({
      listPendingShardPlans: vi.fn().mockResolvedValue([plan('op-1')]),
      getOperation: vi
        .fn()
        .mockResolvedValue(operation({ status: 'running', lastErrorCode: null })),
    });
    await expect(build(repository).reconcilePending()).resolves.toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
  });

  it('counts a blocked operation as a failure even without an error code', async () => {
    const repository = repo({
      listPendingShardPlans: vi.fn().mockResolvedValue([plan('op-1')]),
      getOperation: vi
        .fn()
        .mockResolvedValue(operation({ status: 'blocked', lastErrorCode: null })),
    });
    await expect(build(repository).reconcilePending()).resolves.toMatchObject({
      succeeded: 0,
      failed: 1,
    });
  });

  it('hands plans to the operator when automatic execution is unavailable', async () => {
    const repository = repo({
      listPendingShardPlans: vi.fn().mockResolvedValue([plan('op-1'), plan('op-2')]),
      getProvisioningAuthority: vi
        .fn()
        .mockResolvedValue({ ...READY_AUTHORITY, capabilityState: 'blocked' }),
    });
    await expect(build(repository).reconcilePending()).resolves.toEqual({
      attempted: 2,
      succeeded: 0,
      failed: 2,
    });
    expect(repository.markOperationAwaitingOperator.mock.calls).toEqual([
      ['op-1', NOW],
      ['op-2', NOW],
    ]);
    expect(repository.tryStartProvisioning).not.toHaveBeenCalled();
  });

  it('still counts the failure when the repository has no operator handoff', async () => {
    const repository = repo({
      listPendingShardPlans: vi.fn().mockResolvedValue([plan('op-1')]),
      getProvisioningAuthority: vi
        .fn()
        .mockResolvedValue({ ...READY_AUTHORITY, capabilityState: 'blocked' }),
    });
    delete repository.markOperationAwaitingOperator;
    await expect(build(repository).reconcilePending()).resolves.toMatchObject({
      failed: 1,
      attempted: 1,
    });
  });

  it('shares the five slot budget between plans and migrations', async () => {
    const plans = [plan('p1'), plan('p2'), plan('p3'), plan('p4')];
    const migrations = [plan('m1'), plan('m2'), plan('m3')];
    const repository = repo({
      listPendingShardPlans: vi.fn().mockResolvedValue(plans),
      listPendingMigrationPlans: vi.fn().mockResolvedValue(migrations),
    });
    await expect(build(repository).reconcilePending()).resolves.toEqual({
      attempted: 5,
      succeeded: 0,
      failed: 5,
    });
    expect(repository.tryStartProvisioning).toHaveBeenCalledTimes(4);
    expect(repository.tryStartMigration.mock.calls.map((call) => call[0] as unknown)).toEqual([
      'm1',
    ]);
    const none = repo({
      listPendingShardPlans: vi
        .fn()
        .mockResolvedValue([plan('1'), plan('2'), plan('3'), plan('4'), plan('5')]),
      listPendingMigrationPlans: vi.fn().mockResolvedValue([plan('m1')]),
    });
    await expect(build(none).reconcilePending()).resolves.toMatchObject({ attempted: 5 });
    expect(none.tryStartMigration).not.toHaveBeenCalled();
  });

  it('defers migrations with their own lease prefix and code', async () => {
    const repository = repo({ listPendingMigrationPlans: vi.fn().mockResolvedValue([plan('m1')]) });
    await expect(build(repository).reconcilePending()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(repository.tryStartMigration).toHaveBeenCalledExactlyOnceWith(
      'm1',
      expect.stringMatching(/^migration-reconciler:[0-9a-f-]{36}$/u),
      NOW
    );
    expect(repository.markOperationDeferredIfRunnable).toHaveBeenCalledExactlyOnceWith(
      'm1',
      'control_concurrency_limited',
      NOW + 30,
      NOW
    );
  });

  it('hands migrations to the operator too', async () => {
    const repository = repo({
      listPendingMigrationPlans: vi.fn().mockResolvedValue([plan('m1')]),
      getProvisioningAuthority: vi.fn().mockResolvedValue(null),
    });
    await expect(build(repository).reconcilePending()).resolves.toMatchObject({ failed: 1 });
    expect(repository.markOperationAwaitingOperator).toHaveBeenCalledExactlyOnceWith('m1', NOW);
    expect(repository.tryStartMigration).not.toHaveBeenCalled();
  });

  it('logs and counts failures of individual plans without stopping the batch', async () => {
    const repository = repo({
      listPendingShardPlans: vi.fn().mockResolvedValue([plan('op-1'), plan('op-2')]),
      tryStartProvisioning: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('x'.repeat(400)))
        .mockRejectedValueOnce('plain failure'),
      listPendingMigrationPlans: vi.fn().mockResolvedValue([plan('m1')]),
      tryStartMigration: vi.fn().mockRejectedValue(new Error('migration down')),
    });
    await expect(build(repository).reconcilePending()).resolves.toEqual({
      attempted: 3,
      succeeded: 0,
      failed: 3,
    });
    expect(logger.error.mock.calls).toEqual([
      [
        'Control reconcile item failed',
        {
          kind: 'provision_shard',
          operationId: 'op-1',
          environmentId: 'env-1',
          errorName: 'TypeError',
          errorMessage: 'x'.repeat(300),
        },
      ],
      [
        'Control reconcile item failed',
        {
          kind: 'provision_shard',
          operationId: 'op-2',
          environmentId: 'env-1',
          errorName: 'NonErrorThrow',
          errorMessage: 'plain failure',
        },
      ],
      [
        'Control reconcile item failed',
        {
          kind: 'migration',
          operationId: 'm1',
          environmentId: 'env-1',
          errorName: 'Error',
          errorMessage: 'migration down',
        },
      ],
    ]);
  });

  it('fails an item whose deferred operation vanished', async () => {
    const repository = repo({
      listPendingShardPlans: vi.fn().mockResolvedValue([plan('op-1')]),
      listPendingMigrationPlans: vi.fn().mockResolvedValue([plan('m1')]),
      getOperation: vi.fn().mockResolvedValue(null),
    });
    await expect(build(repository).reconcilePending()).resolves.toMatchObject({ failed: 2 });
    const messages = logger.error.mock.calls.map(
      (call) => (call[1] as { errorMessage: string }).errorMessage
    );
    expect(messages).toEqual([
      'control_operation_missing_after_defer',
      'control_operation_missing_after_migration_defer',
    ]);
  });
});

describe('replenishLowWatermark', () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    environmentId: 'env-1',
    tenantId: 'tenant-1',
    dataRole: 'tenant_core/users',
    residencyPolicyId: 'res-1',
    residencyPartition: 'jp',
    allocationScope: 'shared_pool',
    ownerTenantId: null,
    activeSupplyCount: 2,
    ...overrides,
  });
  const planning = (overrides: Repo = {}) =>
    repo({
      listLowWatermarkRequests: vi.fn().mockResolvedValue([request()]),
      findAssignableTenantShard: vi.fn().mockResolvedValue(null),
      assignTenantShard: vi.fn().mockResolvedValue({}),
      getEnvironment: vi
        .fn()
        .mockResolvedValue({ environment_id: 'env-1', environment_name: 'test' }),
      getResidencyPartition: vi.fn().mockResolvedValue({
        residency_policy_id: 'res-1',
        residency_partition: 'jp',
        lookup_capacity_domain_id: 'x',
        jurisdiction: null,
        location_hint: null,
      }),
      getResourcePolicy: vi.fn().mockResolvedValue({ max_d1_resources: 10 }),
      getReadReplicationPolicy: vi.fn().mockResolvedValue(null),
      getTenantPlacementPolicy: vi.fn().mockResolvedValue(null),
      createShardPlan: vi.fn().mockResolvedValue(operation({ status: 'succeeded' })),
      ...overrides,
    });

  it('assigns an existing shard using the converged idempotency key', async () => {
    const repository = planning({
      findAssignableTenantShard: vi.fn().mockResolvedValue({ shardId: 'shard-a' }),
    });
    await expect(build(repository).replenishLowWatermark()).resolves.toEqual({
      planned: 1,
      failed: 0,
    });
    expect(repository.listLowWatermarkRequests).toHaveBeenCalledExactlyOnceWith(5);
    expect(repository.findAssignableTenantShard).toHaveBeenCalledExactlyOnceWith({
      environmentId: 'env-1',
      tenantId: 'tenant-1',
      dataRole: 'tenant_core/users',
      residencyPolicyId: 'res-1',
      residencyPartition: 'jp',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
    });
    const [assignment, now] = repository.assignTenantShard.mock.calls[0] as [
      Record<string, unknown>,
      number,
    ];
    expect(assignment).toMatchObject({
      environmentId: 'env-1',
      tenantId: 'tenant-1',
      dataRole: 'tenant_core/users',
      residencyPolicyId: 'res-1',
      residencyPartition: 'jp',
      shardId: 'shard-a',
    });
    expect(assignment.sourceOperationId).toMatch(
      /^low-water:shared_pool:tenant-core-users:2:[0-9a-f]{24}$/u
    );
    expect(now).toBe(NOW);
    expect(repository.createShardPlan).not.toHaveBeenCalled();
  });

  it('plans a new shard as the scheduler when nothing is assignable', async () => {
    const repository = planning();
    await expect(build(repository).replenishLowWatermark()).resolves.toEqual({
      planned: 1,
      failed: 0,
    });
    const [shardPlan, now, requestedBy] = repository.createShardPlan.mock.calls[0] as [
      { idempotencyKey: string; ownerTenantId: string | null },
      number,
      string,
    ];
    expect(shardPlan.idempotencyKey).toMatch(/^low-water:shared_pool:tenant-core-users:2:/u);
    expect(requestedBy).toBe('scheduler');
    expect(now).toBe(NOW);
    expect(repository.assignTenantShard).not.toHaveBeenCalled();
  });

  it('logs and counts a failed replenishment without stopping the batch', async () => {
    const repository = planning({
      listLowWatermarkRequests: vi
        .fn()
        .mockResolvedValue([request(), request({ dataRole: 'tenant_pii' })]),
      findAssignableTenantShard: vi
        .fn()
        .mockRejectedValueOnce(new RangeError('storage unavailable'))
        .mockResolvedValueOnce(null),
    });
    await expect(build(repository).replenishLowWatermark()).resolves.toEqual({
      planned: 1,
      failed: 1,
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Control reconcile item failed', {
      kind: 'low_watermark',
      environmentId: 'env-1',
      dataRole: 'tenant_core/users',
      errorName: 'RangeError',
      errorMessage: 'storage unavailable',
    });
  });
});
