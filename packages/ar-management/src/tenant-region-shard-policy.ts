import {
  buildPolicyConstrainedRegionShardConfig,
  buildRegionShardConfigKvKey,
  saveRegionShardConfig,
  validateRegionShardResidencyStrict,
  type Env,
  type RegionKey,
  type RegionShardConfigV2,
  type RegionShardResidencyProjection,
} from '@authrim/ar-lib-core';
import type { ControlTenantRegionShardPolicy } from '@authrim/ar-lib-core/control-plane';

function policyProjection(
  tenantId: string,
  policy: ControlTenantRegionShardPolicy
): RegionShardResidencyProjection {
  if (policy.tenantId !== tenantId) {
    throw new Error('region_shard_residency_tenant_mismatch');
  }
  return {
    version: 1,
    residencyPolicyId: policy.residencyPolicyId,
    residencyPartition: policy.residencyPartition,
    policyGeneration: policy.policyGeneration,
    allowedRegions: [...policy.allowedRegions] as RegionKey[],
    jurisdiction: policy.jurisdiction,
  };
}

function assertProjectionMatches(
  observed: RegionShardResidencyProjection | undefined,
  expected: RegionShardResidencyProjection
): void {
  if (
    !observed ||
    observed.residencyPolicyId !== expected.residencyPolicyId ||
    observed.residencyPartition !== expected.residencyPartition ||
    observed.policyGeneration !== expected.policyGeneration ||
    observed.jurisdiction !== expected.jurisdiction ||
    observed.allowedRegions.length !== expected.allowedRegions.length ||
    observed.allowedRegions.some((region) => !expected.allowedRegions.includes(region))
  ) {
    throw new Error('region_shard_residency_policy_stale');
  }
}

export async function getControlTenantRegionShardPolicy(
  env: Env,
  tenantId: string
): Promise<RegionShardResidencyProjection> {
  if (!env.CONTROL?.getTenantRegionShardPolicy) {
    throw new Error('region_shard_control_policy_unavailable');
  }
  const policy = await env.CONTROL.getTenantRegionShardPolicy({ tenantId });
  return policyProjection(tenantId, policy);
}

export async function ensureTenantRegionShardConfig(
  env: Env,
  tenantId: string
): Promise<RegionShardConfigV2> {
  return ensureTenantRegionShardConfigForProjection(
    env,
    tenantId,
    await getControlTenantRegionShardPolicy(env, tenantId)
  );
}

export async function ensureTenantProvisioningRegionShardConfig(
  env: Env,
  input: { tenantId: string; residencyPolicyId: string; residencyPartition: string }
): Promise<RegionShardConfigV2> {
  if (!env.CONTROL?.getTenantProvisioningRegionShardPolicy) {
    throw new Error('region_shard_control_policy_unavailable');
  }
  const policy = await env.CONTROL.getTenantProvisioningRegionShardPolicy(input);
  return ensureTenantRegionShardConfigForProjection(
    env,
    input.tenantId,
    policyProjection(input.tenantId, policy)
  );
}

async function ensureTenantRegionShardConfigForProjection(
  env: Env,
  tenantId: string,
  residency: RegionShardResidencyProjection
): Promise<RegionShardConfigV2> {
  if (!env.AUTHRIM_CONFIG) {
    throw new Error('region_shard_config_store_unavailable');
  }
  const existing = await env.AUTHRIM_CONFIG.get<RegionShardConfigV2>(
    buildRegionShardConfigKvKey(tenantId),
    { type: 'json' }
  );
  if (existing) {
    validateRegionShardResidencyStrict(existing);
    assertProjectionMatches(existing.residency, residency);
    return existing;
  }
  const config = buildPolicyConstrainedRegionShardConfig({
    residency,
    updatedBy: 'control-residency-policy',
  });
  await saveRegionShardConfig(env, tenantId, config);
  return config;
}

export async function requireTenantRegionShardConfig(
  env: Env,
  tenantId: string
): Promise<{ config: RegionShardConfigV2; residency: RegionShardResidencyProjection }> {
  if (!env.AUTHRIM_CONFIG) {
    throw new Error('region_shard_config_store_unavailable');
  }
  const residency = await getControlTenantRegionShardPolicy(env, tenantId);
  const config = await env.AUTHRIM_CONFIG.get<RegionShardConfigV2>(
    buildRegionShardConfigKvKey(tenantId),
    { type: 'json' }
  );
  if (!config) {
    throw new Error('region_shard_config_missing');
  }
  validateRegionShardResidencyStrict(config);
  assertProjectionMatches(config.residency, residency);
  return { config, residency };
}

export function assertRegionDistributionAllowed(
  distribution: Record<string, number>,
  residency: RegionShardResidencyProjection
): void {
  const allowed = new Set<string>(residency.allowedRegions);
  if (Object.keys(distribution).some((region) => !allowed.has(region))) {
    throw new Error('region_shard_region_disallowed_by_residency');
  }
}
