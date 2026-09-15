import {
  hasTenantBackupMutationCoverage,
  type Env,
  type TenantBackupMutationCoverage,
} from '@authrim/ar-lib-core';

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
    run: (coverage?: TenantBackupMutationCoverage) => Promise<Response>;
    /** False reports an uncertain partial write after the awaited effect has stopped. */
    confirmCompletion?: () => boolean;
  } & ({ tenantId: string; scope?: 'tenant' } | { scope: 'environment' })
): Promise<Response> {
  const coverage: TenantBackupMutationCoverage =
    input.scope === 'environment' ? { environment: true } : { tenantId: input.tenantId };
  if (hasTenantBackupMutationCoverage(input.env, coverage)) return input.run(coverage);
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
  let result: Response | undefined;
  let runError: unknown;
  let runFailed = false;
  try {
    result = await input.run(coverage);
  } catch (error) {
    runFailed = true;
    runError = error;
  }
  let completionAcknowledged = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await complete();
      completionAcknowledged = true;
      break;
    } catch {
      // Completion is idempotent. Retry only the acknowledgement RPC, never the mutation.
    }
  }
  if (!completionAcknowledged) return unavailable();
  if (runFailed) throw runError;
  if (!result || (input.confirmCompletion && !input.confirmCompletion())) return unavailable();
  return result;
}
