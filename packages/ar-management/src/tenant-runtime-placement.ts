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

export interface ResolveTenantRuntimePlacementOptions {
  /**
   * Accept a policy that Control has retired (tenant deletion finalisation keeps the row but moves it
   * to `retired`). Only for publishing a `disabled` route: the snapshot still has to carry the
   * placement the stores were allocated under, and nothing is routed. Never for an active route.
   */
  allowRetired?: boolean;
}

export async function resolveTenantRuntimePlacementSnapshot(
  env: Env,
  tenantId: string,
  options: ResolveTenantRuntimePlacementOptions = {}
): Promise<TenantRuntimeRegistryPlacementSnapshot> {
  if (!env.CONTROL?.getTenantPlacementPolicy) {
    throw new Error('tenant_runtime_registry_placement_control_unavailable');
  }
  const policy = await env.CONTROL.getTenantPlacementPolicy(tenantId);
  if (
    !policy ||
    policy.tenantId !== tenantId ||
    !(
      isUsablePolicyState(policy.state) ||
      (options.allowRetired === true && policy.state === 'retired')
    ) ||
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
