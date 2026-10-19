import type { AdminMachineAccessRepository } from '@authrim/ar-lib-core';

/**
 * What the machine principal (and its credential) may do for the tenant; the agent grant is
 * limited by it. The principal and the credential are read as one snapshot, so the scope of one
 * stored state is never combined with the permissions of another.
 */
export async function machinePermissionLimit(
  machineRepository: AdminMachineAccessRepository,
  tenantId: string,
  principalId: string,
  credentialId: string | undefined
): Promise<string[] | null> {
  const limit = await machineRepository.resolveTenantMachineLimit(
    tenantId,
    principalId,
    credentialId
  );
  return limit?.permissions ?? null;
}
