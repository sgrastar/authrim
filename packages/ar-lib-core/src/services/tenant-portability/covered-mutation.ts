import type { ControlServiceBinding } from '../control-plane/control-plane-contracts';

export type TenantBackupMutationControl = Pick<
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
    CONTROL?: TenantBackupMutationControl;
  } & CoverageCarrier,
  scope: TenantBackupMutationCoverage,
  run: () => Promise<T>
): Promise<T> {
  if (hasTenantBackupMutationCoverage(input, scope)) return run();
  if (!input.TENANT_BACKUP_WRAPPING_KEY) return run();
  return runRequiredTenantBackupCoveredEffect(input, scope, run);
}

/** Admission required by an installed runtime contract; no backup encryption key is needed. */
export async function runRequiredTenantBackupCoveredEffect<T>(
  input: { CONTROL?: TenantBackupMutationControl } & CoverageCarrier,
  scope: TenantBackupMutationCoverage,
  run: () => Promise<T>
): Promise<T> {
  if (hasTenantBackupMutationCoverage(input, scope)) return run();
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
  let outcomeUnknown = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await acquire();
      outcomeUnknown = false;
      if (!result || typeof result.admitted !== 'boolean') break;
      if (!result.admitted) break;
      admitted = true;
      break;
    } catch {
      // Reuse the same private permit ID: the first RPC may have committed before losing its reply.
      outcomeUnknown = true;
    }
  }
  if (!admitted) {
    if (outcomeUnknown) {
      // The service may have recorded a permit whose reply never arrived. Nothing ran under it, so
      // close it by its ID; the service also refuses an acquisition of that ID that arrives later.
      // If this fails too, the open permit is the one the service reports on its own.
      try {
        await complete();
      } catch {
        // Reported by the service itself as an open permit.
      }
    }
    throw new TenantBackupMutationUnavailableError();
  }
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
