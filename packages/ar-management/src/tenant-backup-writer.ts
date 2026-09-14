import type { Env } from '@authrim/ar-lib-core';

function unavailable(): Response {
  return Response.json(
    {
      error: 'backup_mutation_unavailable',
      message: 'The settings update could not be confirmed. Reload settings before retrying.',
    },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' },
    }
  );
}

/** Root, awaited logical mutation only. Nested RPC/deferred effects need explicit propagation. */
export async function runTenantBackupCoveredMutation(
  input: {
    env: Env;
    run: () => Promise<Response>;
    /** False retains the permit when an API reports uncertain partial writes in a successful HTTP response. */
    confirmCompletion?: () => boolean;
  } & ({ tenantId: string; scope?: 'tenant' } | { scope: 'environment' })
): Promise<Response> {
  // This deployment cannot start backup operations until its wrapping key is configured.
  if (!input.env.TENANT_BACKUP_WRAPPING_KEY) return input.run();
  const control = input.env.CONTROL;
  const permitId = crypto.randomUUID();
  let acquire: () => Promise<{ admitted: boolean }>;
  let complete: () => Promise<void>;
  if (input.scope === 'environment') {
    if (
      !control?.acquireEnvironmentBackupMutationPermit ||
      !control.completeEnvironmentBackupMutationPermit
    )
      return unavailable();
    acquire = () =>
      control.acquireEnvironmentBackupMutationPermit?.({ permitId }) ??
      Promise.reject(new Error('backup_mutation_unavailable'));
    complete = () =>
      control.completeEnvironmentBackupMutationPermit?.({ permitId }) ??
      Promise.reject(new Error('backup_mutation_unavailable'));
  } else {
    if (!control?.acquireTenantBackupMutationPermit || !control.completeTenantBackupMutationPermit)
      return unavailable();
    const request = { tenantId: input.tenantId, permitId };
    acquire = () =>
      control.acquireTenantBackupMutationPermit?.(request) ??
      Promise.reject(new Error('backup_mutation_unavailable'));
    complete = () =>
      control.completeTenantBackupMutationPermit?.(request) ??
      Promise.reject(new Error('backup_mutation_unavailable'));
  }
  let admitted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await acquire();
      if (!result || typeof result.admitted !== 'boolean') return unavailable();
      if (!result.admitted) return unavailable();
      admitted = true;
      break;
    } catch {
      // Reuse the private permit ID: the first RPC may have committed before its response was lost.
    }
  }
  if (!admitted) return unavailable();
  const result = await input.run();
  // An exception or server failure can leave uncertain storage effects. Do not assert completion.
  if (result.status >= 500 || (input.confirmCompletion && !input.confirmCompletion()))
    return result;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await complete();
      return result;
    } catch {
      // Completion is idempotent; retain the permit if both acknowledgements remain unavailable.
    }
  }
  return unavailable();
}
