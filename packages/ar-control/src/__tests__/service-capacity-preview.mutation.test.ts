import { describe, expect, it, vi } from 'vitest';
import { ControlService } from '../service';
import type { ControlRepository } from '../repository';
import type { ControlEnv } from '../types';

const NOW = 1_800_000_123;
type Repo = Record<string, ReturnType<typeof vi.fn>>;

const resource = (dataRole: string, extra: Record<string, unknown> = {}) => ({
  resourceClass: 'd1',
  dataRole,
  residencyPolicyId: 'res-1',
  residencyPartition: 'jp',
  workerScripts: ['test-ar-auth'],
  d1Count: 1,
  ...extra,
});
const unit = (dataRole: string, extra: Record<string, unknown> = {}, resourceExtra = {}) => ({
  unitKey: `unit:${dataRole}`,
  priority: 10,
  readyUnits: 0,
  inFlightUnits: 0,
  minimumRequiredUnits: 1,
  recommendedTargetUnits: 1,
  hardMaximumUnits: 10,
  resources: [resource(dataRole, resourceExtra)],
  ...extra,
});
const planner = (targets: object[], overrides: Record<string, unknown> = {}) => ({
  scope: 'shared_pool',
  tenantId: null,
  currentEnvironmentD1Count: 10,
  environmentD1Limit: 1000,
  targets,
  ...overrides,
});
const PARTITION = {
  residency_policy_id: 'res-1',
  residency_partition: 'jp',
  lookup_capacity_domain_id: 'lookup:res-1:jp',
  jurisdiction: null,
  location_hint: null,
};

function repo(overrides: Repo = {}): Repo {
  return {
    getCapacityPlannerInput: vi.fn().mockResolvedValue(planner([unit('tenant_core/users')])),
    getEnvironment: vi
      .fn()
      .mockResolvedValue({ environment_id: 'env-1', environment_name: 'test' }),
    getResidencyPartition: vi.fn().mockResolvedValue(PARTITION),
    getReadReplicationPolicy: vi.fn().mockResolvedValue(null),
    getResourcePolicy: vi.fn().mockResolvedValue({ max_d1_resources: 1000 }),
    getTenantPlacementPolicy: vi.fn().mockResolvedValue(null),
    createShardPlan: vi.fn().mockResolvedValue({
      operationId: 'op-1',
      environmentId: 'env-1',
      operationKind: 'provision_shard',
      status: 'succeeded',
      attemptCount: 1,
      nextAttemptAt: null,
      lastErrorCode: null,
      createdAt: 1,
      updatedAt: 1,
    }),
    ...overrides,
  };
}
const svc = (repository: Repo) =>
  new ControlService({
    repository: repository as unknown as ControlRepository,
    env: {} as ControlEnv,
    now: () => NOW,
  });

const PREVIEW = { profile: 'recommended', scope: 'shared_pool', tenantId: null };
const REQUEST = { ...PREVIEW, requestedById: 'admin-1', idempotencyKey: 'capacity-1' };

describe('capacity profile request validation', () => {
  it.each([
    [null],
    [[]],
    ['x'],
    [{ ...PREVIEW, extra: 1 }],
    [{ profile: 'minimum', scope: 'shared_pool' }],
    [{ ...PREVIEW, profile: 'maximum' }],
    [{ ...PREVIEW, profile: 5 }],
    [{ ...PREVIEW, scope: 'global' }],
    [{ ...PREVIEW, tenantId: 'tenant-1' }],
    [{ ...PREVIEW, scope: 'tenant_exclusive', tenantId: null }],
    [{ ...PREVIEW, scope: 'tenant_exclusive', tenantId: '-x' }],
    [{ ...PREVIEW, scope: 'tenant_exclusive', tenantId: 5 }],
    [{ ...PREVIEW, scope: 'tenant_exclusive', tenantId: 'a'.repeat(129) }],
  ])('rejects the preview request %j', async (input) => {
    const repository = repo();
    await expect(svc(repository).previewCapacityProvisioning(input, 'env-1')).rejects.toThrow(
      /^control_capacity_profile_request_invalid$/u
    );
    expect(repository.getCapacityPlannerInput).not.toHaveBeenCalled();
  });

  it.each([['minimum'], ['recommended'], ['extra_headroom']])(
    'accepts the %s profile and reads the planner input for the exact scope',
    async (profile) => {
      const repository = repo();
      await svc(repository).previewCapacityProvisioning({ ...PREVIEW, profile }, 'env-1');
      expect(repository.getCapacityPlannerInput).toHaveBeenCalledExactlyOnceWith(
        'env-1',
        'shared_pool',
        null
      );
    }
  );

  it('accepts a tenant exclusive request with a safe tenant id', async () => {
    const repository = repo({
      getCapacityPlannerInput: vi
        .fn()
        .mockResolvedValue(
          planner([unit('tenant_core/users')], { scope: 'tenant_exclusive', tenantId: 'tenant-1' })
        ),
    });
    const preview = await svc(repository).previewCapacityProvisioning(
      { profile: 'minimum', scope: 'tenant_exclusive', tenantId: 'tenant-1' },
      'env-1'
    );
    expect(preview).toMatchObject({
      scope: 'tenant_exclusive',
      tenantId: 'tenant-1',
      dryRun: true,
    });
    expect(repository.getCapacityPlannerInput).toHaveBeenCalledWith(
      'env-1',
      'tenant_exclusive',
      'tenant-1'
    );
  });

  it('rejects an unknown environment after reading the planner input', async () => {
    const repository = repo({ getEnvironment: vi.fn().mockResolvedValue(null) });
    await expect(svc(repository).previewCapacityProvisioning(PREVIEW, 'env-1')).rejects.toThrow(
      /^control_environment_not_found$/u
    );
  });

  it('rejects an unsafe environment id', async () => {
    await expect(svc(repo()).previewCapacityProvisioning(PREVIEW, '-env')).rejects.toThrow(
      /^invalid_environment_id$/u
    );
  });

  it('requires every residency partition to exist', async () => {
    const repository = repo({ getResidencyPartition: vi.fn().mockResolvedValue(null) });
    await expect(svc(repository).previewCapacityProvisioning(PREVIEW, 'env-1')).rejects.toThrow(
      /^control_residency_partition_missing$/u
    );
    expect(repository.getResidencyPartition).toHaveBeenCalledWith('env-1', 'res-1', 'jp');
  });

  it('rejects a lookup resource pinned to a different capacity domain', async () => {
    const repository = repo({
      getCapacityPlannerInput: vi
        .fn()
        .mockResolvedValue(
          planner([unit('lookup', {}, { lookupCapacityDomainId: 'lookup:other:jp' })])
        ),
    });
    await expect(svc(repository).previewCapacityProvisioning(PREVIEW, 'env-1')).rejects.toThrow(
      /^control_lookup_capacity_domain_mismatch$/u
    );
  });

  it('accepts a lookup resource pinned to the partition capacity domain and plans a canonical name', async () => {
    const repository = repo({
      getCapacityPlannerInput: vi
        .fn()
        .mockResolvedValue(
          planner([unit('lookup', {}, { lookupCapacityDomainId: 'lookup:res-1:jp' })])
        ),
    });
    const preview = await svc(repository).previewCapacityProvisioning(PREVIEW, 'env-1');
    expect(preview.targets[0]).toMatchObject({
      dataRole: 'lookup',
      lookupCapacityDomainId: 'lookup:res-1:jp',
      environmentId: 'env-1',
    });
    expect(preview.targets[0]?.bindingRef).toMatch(/^TEST_TDB_LOOKUP_[A-F0-9]{8}_LOOKUP$/u);
  });

  it('numbers new units after the ready and in-flight ones', async () => {
    const repository = repo({
      getCapacityPlannerInput: vi.fn().mockResolvedValue(
        planner([
          unit('tenant_core/users', {
            readyUnits: 1,
            inFlightUnits: 1,
            minimumRequiredUnits: 4,
            recommendedTargetUnits: 4,
          }),
        ])
      ),
    });
    const preview = await svc(repository).previewCapacityProvisioning(PREVIEW, 'env-1');
    expect(preview.targets.map((target) => target.unitIndex)).toEqual([3, 4]);
    expect(new Set(preview.targets.map((target) => target.operationId)).size).toBe(2);
    expect(preview).toMatchObject({ capacityUnitsAdded: 2, d1DatabasesAdded: 2 });
  });

  it('is deterministic for the same inputs', async () => {
    const first = await svc(repo()).previewCapacityProvisioning(PREVIEW, 'env-1');
    const second = await svc(repo()).previewCapacityProvisioning(PREVIEW, 'env-1');
    expect(second).toEqual(first);
    const other = await svc(
      repo({
        getEnvironment: vi
          .fn()
          .mockResolvedValue({ environment_id: 'env-1', environment_name: 'other' }),
      })
    ).previewCapacityProvisioning(PREVIEW, 'env-1');
    expect(other.targets[0]?.databaseName).not.toBe(first.targets[0]?.databaseName);
  });
});

describe('requestCapacityProvisioning', () => {
  it.each([
    [null],
    [[]],
    ['x'],
    [{ ...PREVIEW, requestedById: 'a' }],
    [{ ...REQUEST, extra: 1 }],
    [{ ...REQUEST, profile: 'maximum' }],
  ])('rejects the malformed request %j', async (input) => {
    const repository = repo();
    await expect(svc(repository).requestCapacityProvisioning(input, 'env-1')).rejects.toThrow(
      /^control_capacity_(provisioning|profile)_request_invalid$/u
    );
    expect(repository.getCapacityPlannerInput).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...REQUEST, requestedById: '' }, 'invalid_requested_by_id'],
    [{ ...REQUEST, requestedById: '-x' }, 'invalid_requested_by_id'],
    [{ ...REQUEST, idempotencyKey: '' }, 'invalid_idempotency_key'],
    [{ ...REQUEST, idempotencyKey: 5 }, 'invalid_idempotency_key'],
  ])('rejects the unsafe identifier in %j', async (input, code) => {
    await expect(svc(repo()).requestCapacityProvisioning(input, 'env-1')).rejects.toThrow(
      new RegExp(`^${code}$`, 'u')
    );
  });

  it('refuses a plan the planner marks unavailable with its reason code', async () => {
    const repository = repo({
      getCapacityPlannerInput: vi.fn().mockResolvedValue(
        planner([unit('tenant_core/users')], {
          currentEnvironmentD1Count: 1000,
          environmentD1Limit: 1000,
        })
      ),
    });
    const preview = await svc(repository).previewCapacityProvisioning(PREVIEW, 'env-1');
    expect(preview.available).toBe(false);
    await expect(svc(repository).requestCapacityProvisioning(REQUEST, 'env-1')).rejects.toThrow(
      new RegExp(`^${preview.reasonCode ?? 'control_capacity_profile_unavailable'}$`, 'u')
    );
    expect(repository.createShardPlan).not.toHaveBeenCalled();
  });

  it('creates one idempotent operation per previewed target', async () => {
    const repository = repo();
    const result = await svc(repository).requestCapacityProvisioning(REQUEST, 'env-1');
    expect(result.operations).toEqual([
      {
        operationId: 'op-1',
        status: 'succeeded',
        attemptCount: 1,
        nextAttemptAt: null,
        lastErrorCode: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(result.preview.targets).toHaveLength(1);
    const [plan, now, requestedBy] = repository.createShardPlan.mock.calls[0] as [
      { operationId: string; idempotencyKey: string },
      number,
      string,
    ];
    expect(plan.operationId).toBe(result.preview.targets[0]?.operationId);
    expect(plan.idempotencyKey).toMatch(/^capacity:shared_pool:shared:[0-9a-f]{24}:1$/u);
    expect(now).toBe(NOW);
    expect(requestedBy).toBe('admin');
  });

  it('keys exclusive capacity by the tenant', async () => {
    const repository = repo({
      getCapacityPlannerInput: vi
        .fn()
        .mockResolvedValue(
          planner([unit('tenant_core/users')], { scope: 'tenant_exclusive', tenantId: 'tenant-1' })
        ),
      getTenantPlacementPolicy: vi
        .fn()
        .mockResolvedValue({ isolationPolicy: 'tenant_exclusive', state: 'active' }),
    });
    await svc(repository).requestCapacityProvisioning(
      { ...REQUEST, scope: 'tenant_exclusive', tenantId: 'tenant-1' },
      'env-1'
    );
    const plan = repository.createShardPlan.mock.calls[0]?.[0] as {
      idempotencyKey: string;
      ownerTenantId: string;
      allocationScope: string;
    };
    expect(plan.idempotencyKey).toMatch(/^capacity:tenant_exclusive:tenant-1:[0-9a-f]{24}:1$/u);
    expect(plan).toMatchObject({ ownerTenantId: 'tenant-1', allocationScope: 'tenant_exclusive' });
  });
});
