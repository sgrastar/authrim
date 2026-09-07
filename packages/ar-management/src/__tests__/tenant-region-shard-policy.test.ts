import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Env,
  RegionShardConfigV2,
  RegionShardResidencyProjection,
} from '@authrim/ar-lib-core';
import {
  assertRegionDistributionAllowed,
  ensureTenantProvisioningRegionShardConfig,
  ensureTenantRegionShardConfig,
  requireTenantRegionShardConfig,
} from '../tenant-region-shard-policy';

function fixture() {
  const values = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string, options?: { type?: string }) => {
      const value = values.get(key);
      return options?.type === 'json' && value ? (JSON.parse(value) as unknown) : (value ?? null);
    }),
    put: vi.fn(async (key: string, value: string) => void values.set(key, value)),
  };
  const getTenantRegionShardPolicy = vi.fn().mockResolvedValue({
    tenantId: 'tenant-a',
    residencyPolicyId: 'policy-eu',
    residencyPartition: 'primary',
    policyGeneration: 2,
    allowedRegions: ['weur', 'eeur'],
    jurisdiction: 'eu',
    locationHint: null,
  });
  const getTenantProvisioningRegionShardPolicy = vi
    .fn()
    .mockImplementation(getTenantRegionShardPolicy);
  const env = {
    AUTHRIM_CONFIG: kv,
    CONTROL: { getTenantRegionShardPolicy, getTenantProvisioningRegionShardPolicy },
  } as unknown as Env;
  return {
    env,
    kv,
    values,
    getTenantRegionShardPolicy,
    getTenantProvisioningRegionShardPolicy,
  };
}

describe('tenant region shard policy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the first config from Control-owned residency and then preserves it', async () => {
    const { env, kv, values } = fixture();
    const created = await ensureTenantRegionShardConfig(env, 'tenant-a');
    expect(created).toMatchObject({
      currentGeneration: 1,
      residency: {
        residencyPolicyId: 'policy-eu',
        policyGeneration: 2,
        allowedRegions: ['weur', 'eeur'],
        jurisdiction: 'eu',
      },
    });
    expect(Object.keys(created.currentRegions).sort()).toEqual(['eeur', 'weur']);
    expect(kv.put).toHaveBeenCalledOnce();
    expect(values.has('region_shard_config:tenant-a')).toBe(true);

    await expect(ensureTenantRegionShardConfig(env, 'tenant-a')).resolves.toEqual(created);
    expect(kv.put).toHaveBeenCalledOnce();
  });

  it('creates a provisioning config from the operation-bound residency projection', async () => {
    const { env, getTenantProvisioningRegionShardPolicy } = fixture();

    await expect(
      ensureTenantProvisioningRegionShardConfig(env, {
        tenantId: 'tenant-a',
        residencyPolicyId: 'policy-eu',
        residencyPartition: 'primary',
      })
    ).resolves.toMatchObject({
      residency: {
        residencyPolicyId: 'policy-eu',
        residencyPartition: 'primary',
        policyGeneration: 2,
      },
    });
    expect(getTenantProvisioningRegionShardPolicy).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      residencyPolicyId: 'policy-eu',
      residencyPartition: 'primary',
    });
  });

  it('rejects cross-tenant Control responses and stale policy generations', async () => {
    const crossTenant = fixture();
    crossTenant.getTenantRegionShardPolicy.mockResolvedValueOnce({
      tenantId: 'tenant-b',
      residencyPolicyId: 'policy-eu',
      residencyPartition: 'primary',
      policyGeneration: 2,
      allowedRegions: ['weur', 'eeur'],
      jurisdiction: 'eu',
      locationHint: null,
    });
    await expect(ensureTenantRegionShardConfig(crossTenant.env, 'tenant-a')).rejects.toThrow(
      'region_shard_residency_tenant_mismatch'
    );
    expect(crossTenant.kv.put).not.toHaveBeenCalled();

    const stale = fixture();
    const staleConfig: RegionShardConfigV2 = {
      currentGeneration: 1,
      currentTotalShards: 1,
      currentRegions: { weur: { startShard: 0, endShard: 0, shardCount: 1 } },
      previousGenerations: [],
      maxPreviousGenerations: 5,
      updatedAt: 1,
      residency: {
        version: 1,
        residencyPolicyId: 'policy-eu',
        residencyPartition: 'primary',
        policyGeneration: 1,
        allowedRegions: ['weur', 'eeur'],
        jurisdiction: 'eu',
      },
    };
    stale.values.set('region_shard_config:tenant-a', JSON.stringify(staleConfig));
    await expect(requireTenantRegionShardConfig(stale.env, 'tenant-a')).rejects.toThrow(
      'region_shard_residency_policy_stale'
    );
  });

  it('rejects distributions that route new objects outside the allowed residency regions', () => {
    const residency: RegionShardResidencyProjection = {
      version: 1,
      residencyPolicyId: 'policy-eu',
      residencyPartition: 'primary',
      policyGeneration: 2,
      allowedRegions: ['weur', 'eeur'],
      jurisdiction: 'eu',
    };
    expect(() => assertRegionDistributionAllowed({ weur: 50, apac: 50 }, residency)).toThrow(
      'region_shard_region_disallowed_by_residency'
    );
    expect(() => assertRegionDistributionAllowed({ weur: 100, apac: 0 }, residency)).toThrow(
      'region_shard_region_disallowed_by_residency'
    );
  });
});
