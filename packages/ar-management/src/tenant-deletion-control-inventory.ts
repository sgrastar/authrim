import type { ControlTenantDeletionInventory, Env } from '@authrim/ar-lib-core';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function validateTenantDeletionInventory(
  value: ControlTenantDeletionInventory,
  environmentId: string,
  tenantId: string,
  operationId: string
): ControlTenantDeletionInventory {
  if (
    !value ||
    value.environmentId !== environmentId ||
    value.tenantId !== tenantId ||
    value.operationId !== operationId ||
    (value.state !== 'ready' && value.state !== 'finalized') ||
    !Array.isArray(value.lookupShards) ||
    !Array.isArray(value.tenantShards) ||
    (value.state === 'finalized' &&
      (value.lookupShards.length !== 0 || value.tenantShards.length !== 0))
  ) {
    throw new Error('tenant_deletion_control_inventory_invalid');
  }
  return value;
}

export async function getTenantDeletionInventory(
  env: Env,
  tenantId: string,
  operationId: string
): Promise<ControlTenantDeletionInventory> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_ID.test(environmentId)) {
    throw new Error('tenant_deletion_control_environment_invalid');
  }
  if (!env.CONTROL?.getTenantDeletionInventory) {
    throw new Error('tenant_deletion_control_unavailable');
  }
  return validateTenantDeletionInventory(
    await env.CONTROL.getTenantDeletionInventory({ tenantId, operationId }),
    environmentId,
    tenantId,
    operationId
  );
}
