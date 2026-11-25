import { describe, expect, it, vi } from 'vitest';
import { ControlService } from '../service';
import type { ControlRepository } from '../repository';
import type { ControlEnv } from '../types';

const NOW = 1_800_000_123;
const READY_ENV = {
  AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
  CLOUDFLARE_D1_API_TOKEN: ' d1 ',
  CLOUDFLARE_WORKERS_API_TOKEN: 'workers',
} as ControlEnv;

type Repo = Record<string, ReturnType<typeof vi.fn>>;

function build(repo: Repo, env: Partial<ControlEnv> = READY_ENV) {
  return new ControlService({
    repository: repo as unknown as ControlRepository,
    env: env as ControlEnv,
    now: () => NOW,
  });
}

const AUTHORITY = {
  automaticProvisioningEnabled: true,
  tokenOwnership: 'account',
  capabilityState: 'ready',
};

describe('getProvisioningAuthorityStatus', () => {
  const status = (authority: object | null, env: Partial<ControlEnv> = READY_ENV) =>
    build({ getProvisioningAuthority: vi.fn().mockResolvedValue(authority) }, env);

  it('reports ready control execution when every precondition holds', async () => {
    await expect(status(AUTHORITY).getProvisioningAuthorityStatus('env-1')).resolves.toEqual({
      automaticProvisioningEnabled: true,
      tokenOwnership: 'account',
      capabilityState: 'ready',
      automaticExecutionAvailable: true,
      activeExecutor: 'control',
    });
  });

  it.each([
    ['disabled', { ...AUTHORITY, automaticProvisioningEnabled: false }, READY_ENV, 'disabled'],
    ['pending', { ...AUTHORITY, capabilityState: 'pending' }, READY_ENV, 'pending'],
    ['blocked', { ...AUTHORITY, capabilityState: 'blocked' }, READY_ENV, 'blocked'],
    ['token ownership none', { ...AUTHORITY, tokenOwnership: 'none' }, READY_ENV, 'blocked'],
    ['flag off', AUTHORITY, { ...READY_ENV, AUTHRIM_AUTOMATIC_PROVISIONING: 'false' }, 'blocked'],
    ['no d1 token', AUTHORITY, { ...READY_ENV, CLOUDFLARE_D1_API_TOKEN: undefined }, 'blocked'],
    ['blank d1 token', AUTHORITY, { ...READY_ENV, CLOUDFLARE_D1_API_TOKEN: '  ' }, 'blocked'],
    [
      'no workers token',
      AUTHORITY,
      { ...READY_ENV, CLOUDFLARE_WORKERS_API_TOKEN: undefined },
      'blocked',
    ],
    [
      'blank workers token',
      AUTHORITY,
      { ...READY_ENV, CLOUDFLARE_WORKERS_API_TOKEN: ' ' },
      'blocked',
    ],
    ['shared token', AUTHORITY, { ...READY_ENV, CLOUDFLARE_WORKERS_API_TOKEN: 'd1' }, 'blocked'],
  ])('falls back to the setup operator when %s', async (_name, authority, env, capabilityState) => {
    await expect(
      status(authority, env as Partial<ControlEnv>).getProvisioningAuthorityStatus('env-1')
    ).resolves.toMatchObject({
      capabilityState,
      automaticExecutionAvailable: false,
      activeExecutor: 'setup_operator',
    });
  });

  it('refuses a missing authority row, a missing reader and an unsafe environment', async () => {
    await expect(status(null).getProvisioningAuthorityStatus('env-1')).rejects.toThrow(
      /^control_provisioning_authority_missing$/u
    );
    await expect(build({}).getProvisioningAuthorityStatus('env-1')).rejects.toThrow(
      /^control_provisioning_authority_missing$/u
    );
    await expect(status(AUTHORITY).getProvisioningAuthorityStatus('-env')).rejects.toThrow(
      /^invalid_environment_id$/u
    );
  });

  it('reads the authority of the requested environment', async () => {
    const getProvisioningAuthority = vi.fn().mockResolvedValue(AUTHORITY);
    await build({ getProvisioningAuthority }).getProvisioningAuthorityStatus('env-9');
    expect(getProvisioningAuthority).toHaveBeenCalledWith('env-9');
  });
});

const target = (overrides: Record<string, unknown> = {}) => ({
  shardId: 'shard-a',
  dataRole: 'tenant_core/default',
  residencyPolicyId: 'res-1',
  residencyPartition: 'jp',
  routeGeneration: 1,
  bindingRef: 'DB_A',
  databaseId: 'db-a',
  databaseName: 'name-a',
  allocationScope: 'shared_pool',
  ownerTenantId: null,
  assignmentGeneration: 1,
  ...overrides,
});
const SET = [
  target(),
  target({ shardId: 'shard-b', dataRole: 'tenant_core/users', bindingRef: 'DB_B' }),
  target({ shardId: 'shard-c', dataRole: 'tenant_pii', bindingRef: 'DB_C' }),
];
const ROUTE_INPUT = { tenantId: 'tenant-1', residencyPolicyId: 'res-1', residencyPartition: 'jp' };
const placement = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-1',
  isolationPolicy: 'shared_pool',
  policyGeneration: 3,
  state: 'active',
  ...overrides,
});

function routeRepo(policy: object | null, targets: object[]) {
  return {
    getTenantPlacementPolicy: vi.fn().mockResolvedValue(policy),
    listActiveTenantShardTargets: vi.fn().mockResolvedValue(targets),
  };
}

describe('tenant route targets', () => {
  it('returns the complete target set and queries the exact scope', async () => {
    const repo = routeRepo(placement(), SET);
    await expect(build(repo).getTenantRuntimeRouteTargets(ROUTE_INPUT, 'env-1')).resolves.toBe(SET);
    expect(repo.getTenantPlacementPolicy).toHaveBeenCalledExactlyOnceWith('env-1', 'tenant-1');
    expect(repo.listActiveTenantShardTargets).toHaveBeenCalledExactlyOnceWith({
      environmentId: 'env-1',
      tenantId: 'tenant-1',
      residencyPolicyId: 'res-1',
      residencyPartition: 'jp',
    });
  });

  it('accepts several users and pii shards but exactly one default shard', async () => {
    const extra = [
      target({ shardId: 'shard-d', dataRole: 'tenant_core/users', bindingRef: 'DB_D' }),
      target({ shardId: 'shard-e', dataRole: 'tenant_pii', bindingRef: 'DB_E' }),
    ];
    await expect(
      build(routeRepo(placement(), [...SET, ...extra])).getTenantRuntimeRouteTargets(
        ROUTE_INPUT,
        'env-1'
      )
    ).resolves.toHaveLength(5);
    for (const incomplete of [
      SET.slice(1),
      SET.slice(0, 2),
      [SET[0], SET[2]],
      [...SET, target({ shardId: 'shard-z', bindingRef: 'DB_Z' })],
    ]) {
      await expect(
        build(routeRepo(placement(), incomplete)).getTenantRuntimeRouteTargets(ROUTE_INPUT, 'env-1')
      ).rejects.toThrow(/^control_tenant_shard_assignment_incomplete$/u);
    }
  });

  it('rejects duplicate shard ids and binding references', async () => {
    for (const duplicate of [
      target({ shardId: 'shard-a', dataRole: 'tenant_pii', bindingRef: 'DB_X' }),
      target({ shardId: 'shard-x', dataRole: 'tenant_pii', bindingRef: 'DB_A' }),
    ]) {
      await expect(
        build(routeRepo(placement(), [...SET, duplicate])).getTenantRuntimeRouteTargets(
          ROUTE_INPUT,
          'env-1'
        )
      ).rejects.toThrow(/^control_tenant_shard_assignment_incomplete$/u);
    }
  });

  it('enforces the policy states for runtime and provisioning views', async () => {
    const provisioning = placement({ state: 'provisioning' });
    await expect(
      build(routeRepo(provisioning, SET)).getTenantRuntimeRouteTargets(ROUTE_INPUT, 'env-1')
    ).rejects.toThrow(/^control_tenant_shard_assignment_policy_missing$/u);
    await expect(
      build(routeRepo(provisioning, SET)).getTenantProvisioningRouteTargets(ROUTE_INPUT, 'env-1')
    ).resolves.toBe(SET);
    await expect(
      build(routeRepo(placement({ state: 'retired' }), SET)).getTenantProvisioningRouteTargets(
        ROUTE_INPUT,
        'env-1'
      )
    ).rejects.toThrow(/^control_tenant_shard_assignment_policy_missing$/u);
    await expect(
      build(routeRepo(null, SET)).getTenantRuntimeRouteTargets(ROUTE_INPUT, 'env-1')
    ).rejects.toThrow(/^control_tenant_shard_assignment_policy_missing$/u);
  });

  it.each([
    ['other residency policy', { residencyPolicyId: 'res-2' }, placement()],
    ['other partition', { residencyPartition: 'us' }, placement()],
    ['shared target with owner', { ownerTenantId: 'tenant-1' }, placement()],
    ['exclusive target without owner', {}, placement({ isolationPolicy: 'tenant_exclusive' })],
    [
      'exclusive target of another tenant',
      { allocationScope: 'tenant_exclusive', ownerTenantId: 'tenant-2' },
      placement({ isolationPolicy: 'tenant_exclusive' }),
    ],
    ['scope differs from policy', { allocationScope: 'tenant_exclusive' }, placement()],
  ])('rejects a target with %s', async (_name, patch, policy) => {
    await expect(
      build(routeRepo(policy, [target(patch), SET[1], SET[2]])).getTenantRuntimeRouteTargets(
        ROUTE_INPUT,
        'env-1'
      )
    ).rejects.toThrow(/^control_tenant_shard_assignment_owner_mismatch$/u);
  });

  it('accepts exclusive targets owned by the tenant', async () => {
    const owned = SET.map((entry) => ({
      ...entry,
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'tenant-1',
    }));
    await expect(
      build(
        routeRepo(placement({ isolationPolicy: 'tenant_exclusive' }), owned)
      ).getTenantRuntimeRouteTargets(ROUTE_INPUT, 'env-1')
    ).resolves.toBe(owned);
  });

  it.each([
    [null],
    [[]],
    ['x'],
    [{ ...ROUTE_INPUT, extra: 1 }],
    [{ tenantId: 'tenant-1', residencyPolicyId: 'res-1' }],
  ])('rejects the malformed request %j', async (input) => {
    const repo = routeRepo(placement(), SET);
    await expect(build(repo).getTenantRuntimeRouteTargets(input, 'env-1')).rejects.toThrow(
      /^invalid_tenant_runtime_route_request$/u
    );
    expect(repo.getTenantPlacementPolicy).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...ROUTE_INPUT, tenantId: '-x' }, 'invalid_tenant_id'],
    [{ ...ROUTE_INPUT, residencyPolicyId: '' }, 'invalid_residency_policy_id'],
    [{ ...ROUTE_INPUT, residencyPartition: 'JP' }, 'invalid_residency_partition'],
    [{ ...ROUTE_INPUT, residencyPartition: '-jp' }, 'invalid_residency_partition'],
    [{ ...ROUTE_INPUT, residencyPartition: 5 }, 'invalid_residency_partition'],
  ])('rejects %j with %s', async (input, code) => {
    await expect(
      build(routeRepo(placement(), SET)).getTenantRuntimeRouteTargets(input, 'env-1')
    ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });
});

describe('tenant region shard policy', () => {
  const residency = (overrides: Record<string, unknown> = {}) => ({
    residency_policy_id: 'res-1',
    residency_partition: 'jp',
    policy_generation: 7,
    jurisdiction: null,
    location_hint: 'apac',
    ...overrides,
  });
  const repo = (residencies: unknown[]) => ({
    ...routeRepo(placement(), SET),
    listTenantActiveResidencies: vi.fn().mockResolvedValue(residencies),
  });

  it('derives the allowed regions from the single active residency', async () => {
    const repository = repo([residency()]);
    await expect(
      build(repository).getTenantRegionShardPolicy({ tenantId: 'tenant-1' }, 'env-1')
    ).resolves.toEqual({
      tenantId: 'tenant-1',
      residencyPolicyId: 'res-1',
      residencyPartition: 'jp',
      policyGeneration: 7,
      allowedRegions: ['apac'],
      jurisdiction: null,
      locationHint: 'apac',
    });
    expect(repository.listTenantActiveResidencies).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      'tenant-1'
    );
  });

  it('maps jurisdictions to their regions', async () => {
    await expect(
      build(
        repo([residency({ jurisdiction: 'eu', location_hint: null })])
      ).getTenantRegionShardPolicy({ tenantId: 'tenant-1' }, 'env-1')
    ).resolves.toMatchObject({ allowedRegions: ['weur', 'eeur'], jurisdiction: 'eu' });
  });

  it.each([[[]], [[residency(), residency()]]])(
    'requires exactly one residency (%j)',
    async (residencies) => {
      await expect(
        build(repo(residencies)).getTenantRegionShardPolicy({ tenantId: 'tenant-1' }, 'env-1')
      ).rejects.toThrow(/^control_tenant_region_shard_residency_missing$/u);
    }
  );

  it('requires the residency reader and a single tenantId key', async () => {
    await expect(
      build(routeRepo(placement(), SET)).getTenantRegionShardPolicy(
        { tenantId: 'tenant-1' },
        'env-1'
      )
    ).rejects.toThrow(/^control_tenant_region_shard_repository_unavailable$/u);
    for (const bad of [
      null,
      [],
      'x',
      {},
      { tenantId: 'tenant-1', extra: 1 },
      { other: 'tenant-1' },
    ]) {
      await expect(
        build(repo([residency()])).getTenantRegionShardPolicy(bad, 'env-1')
      ).rejects.toThrow(/^invalid_tenant_region_shard_policy_request$/u);
    }
    await expect(
      build(repo([residency()])).getTenantRegionShardPolicy({ tenantId: '-x' }, 'env-1')
    ).rejects.toThrow(/^invalid_tenant_id$/u);
  });

  describe('provisioning view', () => {
    const provisioning = (placementPolicy: object | null, partition: object | null) => ({
      ...routeRepo(placementPolicy, SET),
      getResidencyPartition: vi.fn().mockResolvedValue(partition),
    });
    const partition = { jurisdiction: 'fedramp', location_hint: null };

    it('combines the placement policy generation with the partition placement', async () => {
      const repository = provisioning(
        placement({ state: 'provisioning', policyGeneration: 9 }),
        partition
      );
      await expect(
        build(repository).getTenantProvisioningRegionShardPolicy(ROUTE_INPUT, 'env-1')
      ).resolves.toEqual({
        tenantId: 'tenant-1',
        residencyPolicyId: 'res-1',
        residencyPartition: 'jp',
        policyGeneration: 9,
        allowedRegions: ['enam', 'wnam'],
        jurisdiction: 'fedramp',
        locationHint: null,
      });
      expect(repository.getResidencyPartition).toHaveBeenCalledExactlyOnceWith(
        'env-1',
        'res-1',
        'jp'
      );
    });

    it('requires an active or provisioning policy and a known partition', async () => {
      await expect(
        build(provisioning(placement(), null)).getTenantProvisioningRegionShardPolicy(
          ROUTE_INPUT,
          'env-1'
        )
      ).rejects.toThrow(/^control_tenant_region_shard_residency_missing$/u);
      const states = ['migrating', 'retired', 'suspended'];
      for (const state of states) {
        await expect(
          build(
            provisioning(placement({ state }), partition)
          ).getTenantProvisioningRegionShardPolicy(ROUTE_INPUT, 'env-1')
        ).rejects.toThrow(
          /control_tenant_shard_assignment_policy_missing|control_tenant_region_shard_residency_missing/u
        );
      }
    });

    it.each([[null], [[]], ['x'], [{ ...ROUTE_INPUT, extra: 1 }], [{ tenantId: 'tenant-1' }]])(
      'rejects the malformed request %j',
      async (input) => {
        await expect(
          build(provisioning(placement(), partition)).getTenantProvisioningRegionShardPolicy(
            input,
            'env-1'
          )
        ).rejects.toThrow(/^invalid_tenant_region_shard_policy_request$/u);
      }
    );
  });
});

describe('region shard policy hardening', () => {
  const residency = {
    residency_policy_id: 'res-1',
    residency_partition: 'jp',
    policy_generation: 7,
    jurisdiction: null,
    location_hint: 'Bearer leaked-token',
  };
  const region = (locationHint: string) => ({
    ...routeRepo(placement(), SET),
    listTenantActiveResidencies: vi
      .fn()
      .mockResolvedValue([{ ...residency, location_hint: locationHint }]),
    getResidencyPartition: vi
      .fn()
      .mockResolvedValue({ jurisdiction: null, location_hint: locationHint }),
  });

  it('refuses a policy carrying credential like text', async () => {
    await expect(
      build(region('Bearer leaked-token')).getTenantRegionShardPolicy(
        { tenantId: 'tenant-1' },
        'env-1'
      )
    ).rejects.toThrow(/control_plane_sensitive_value_forbidden/u);
    await expect(
      build(region('Bearer leaked-token')).getTenantProvisioningRegionShardPolicy(
        ROUTE_INPUT,
        'env-1'
      )
    ).rejects.toThrow(/control_plane_sensitive_value_forbidden/u);
  });

  it('rejects an unsafe environment before reading anything', async () => {
    const repository = region('apac');
    await expect(
      build(repository).getTenantRegionShardPolicy({ tenantId: 'tenant-1' }, '-env')
    ).rejects.toThrow(/^invalid_environment_id$/u);
    expect(repository.listTenantActiveResidencies).not.toHaveBeenCalled();
  });

  it('accepts an active placement policy in the provisioning view', async () => {
    await expect(
      build(region('apac')).getTenantProvisioningRegionShardPolicy(ROUTE_INPUT, 'env-1')
    ).resolves.toMatchObject({ policyGeneration: 3, allowedRegions: ['apac'] });
  });
});
