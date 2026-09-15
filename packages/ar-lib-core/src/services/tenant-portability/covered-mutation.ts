import type { ControlServiceBinding } from '../control-plane/control-plane-contracts';

type MutationControl = Pick<
  ControlServiceBinding,
  | 'acquireTenantBackupMutationPermit'
  | 'completeTenantBackupMutationPermit'
  | 'acquireEnvironmentBackupMutationPermit'
  | 'completeEnvironmentBackupMutationPermit'
>;

export type TenantBackupMutationCoverage =
  | Readonly<{ tenantId: string }>
  | Readonly<{ environment: true }>;

const TENANT_BACKUP_MUTATION_COVERAGE = Symbol('tenant_backup_mutation_coverage');

type CoverageCarrier = {
  [TENANT_BACKUP_MUTATION_COVERAGE]?: TenantBackupMutationCoverage;
};

export function withTenantBackupMutationCoverage<T extends object>(
  input: T,
  coverage: TenantBackupMutationCoverage
): T & CoverageCarrier {
  return Object.assign({}, input, { [TENANT_BACKUP_MUTATION_COVERAGE]: coverage });
}

export function hasTenantBackupMutationCoverage(
  input: object,
  scope: TenantBackupMutationCoverage
): boolean {
  const coverage = (input as CoverageCarrier)[TENANT_BACKUP_MUTATION_COVERAGE];
  return Boolean(
    coverage &&
    ('environment' in coverage ||
      ('tenantId' in coverage && 'tenantId' in scope && coverage.tenantId === scope.tenantId))
  );
}

export class TenantBackupMutationUnavailableError extends Error {
  constructor() {
    super('backup_mutation_unavailable');
    this.name = 'TenantBackupMutationUnavailableError';
  }
}

/** Hold a Control admission permit until one awaited storage effect has stopped running. */
export async function runTenantBackupCoveredEffect<T>(
  input: {
    TENANT_BACKUP_WRAPPING_KEY?: string;
    CONTROL?: MutationControl;
  } & CoverageCarrier,
  scope: TenantBackupMutationCoverage,
  run: () => Promise<T>
): Promise<T> {
  if (hasTenantBackupMutationCoverage(input, scope)) return run();
  if (!input.TENANT_BACKUP_WRAPPING_KEY) return run();
  const permitId = crypto.randomUUID();
  const control = input.CONTROL;
  const tenantScope = 'tenantId' in scope;
  if (
    !control ||
    (tenantScope &&
      (!control.acquireTenantBackupMutationPermit ||
        !control.completeTenantBackupMutationPermit)) ||
    (!tenantScope &&
      (!control.acquireEnvironmentBackupMutationPermit ||
        !control.completeEnvironmentBackupMutationPermit))
  )
    throw new TenantBackupMutationUnavailableError();
  const acquire = () =>
    tenantScope
      ? control.acquireTenantBackupMutationPermit?.({ tenantId: scope.tenantId, permitId })
      : control.acquireEnvironmentBackupMutationPermit?.({ permitId });
  const complete = () =>
    tenantScope
      ? control.completeTenantBackupMutationPermit?.({ tenantId: scope.tenantId, permitId })
      : control.completeEnvironmentBackupMutationPermit?.({ permitId });
  let admitted = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await acquire();
      if (!result || typeof result.admitted !== 'boolean') break;
      if (!result.admitted) break;
      admitted = true;
      break;
    } catch {
      // Reuse the same private permit ID: the first RPC may have committed before losing its reply.
    }
  }
  if (!admitted) throw new TenantBackupMutationUnavailableError();
  let result!: T;
  let runError: unknown;
  let runFailed = false;
  try {
    result = await run();
  } catch (error) {
    runFailed = true;
    runError = error;
  }
  let completionAcknowledged = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await complete();
      completionAcknowledged = true;
      break;
    } catch {
      // Completion is idempotent. Retry only the acknowledgement RPC, never the storage effect.
    }
  }
  if (!completionAcknowledged) throw new TenantBackupMutationUnavailableError();
  if (runFailed) throw runError;
  return result;
}
