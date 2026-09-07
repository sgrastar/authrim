import type {
  ControlTenantPlacementPolicy,
  Env,
  TenantRuntimeRegistryPlacementSnapshot,
} from '@authrim/ar-lib-core';

function isUsablePolicyState(
  value: ControlTenantPlacementPolicy['state']
): value is 'provisioning' | 'active' | 'migrating' {
  return value === 'provisioning' || value === 'active' || value === 'migrating';
}

export async function resolveTenantRuntimePlacementSnapshot(
  env: Env,
  tenantId: string
): Promise<TenantRuntimeRegistryPlacementSnapshot> {
  if (!env.CONTROL?.getTenantPlacementPolicy) {
    throw new Error('tenant_runtime_registry_placement_control_unavailable');
  }
  const policy = await env.CONTROL.getTenantPlacementPolicy(tenantId);
  if (
    !policy ||
    policy.tenantId !== tenantId ||
    !isUsablePolicyState(policy.state) ||
    (policy.isolationPolicy !== 'shared_pool' && policy.isolationPolicy !== 'tenant_exclusive') ||
    !Number.isSafeInteger(policy.policyGeneration) ||
    policy.policyGeneration < 1
  ) {
    throw new Error('tenant_runtime_registry_placement_invalid');
  }
  return {
    isolationPolicy: policy.isolationPolicy,
    policyGeneration: policy.policyGeneration,
  };
}
