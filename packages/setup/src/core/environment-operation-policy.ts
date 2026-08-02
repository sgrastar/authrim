import type { AuthrimLock } from './lock.js';
import { compareProductVersions } from './release-migrations.js';

export type EnvironmentLifecycle =
  | 'absent'
  | 'provisioned'
  | 'legacy'
  | 'updating'
  | 'deployed'
  | 'inconsistent';

export type EnvironmentOperationKind =
  | 'provision'
  | 'initial_deploy'
  | 'release_update'
  | 'worker_redeploy'
  | 'topology_change'
  | 'manual_migration'
  | 'config_mutation'
  | 'structure_migration'
  | 'delete';

export type EnvironmentOperationBlockReason =
  | 'environment_already_exists'
  | 'environment_not_found'
  | 'initial_deploy_required'
  | 'release_update_required'
  | 'release_update_in_progress'
  | 'topology_update_in_progress'
  | 'legacy_reconciliation_required'
  | 'inconsistent_release_state'
  | 'target_version_required'
  | 'product_downgrade_not_supported'
  | 'operation_not_allowed';

export interface EnvironmentOperationDecision {
  allowed: boolean;
  lifecycle: EnvironmentLifecycle;
  operation: EnvironmentOperationKind;
  currentVersion?: string;
  reason?: EnvironmentOperationBlockReason;
}

export function classifyEnvironmentLifecycle(lock?: AuthrimLock | null): EnvironmentLifecycle {
  if (!lock) return 'absent';

  const workers = Object.values(lock.workers ?? {});
  const release = lock.releaseUpdate;
  if (release && release.phase !== 'verified') return 'updating';
  if (
    release?.phase === 'verified' &&
    (!lock.productVersion || release.targetVersion !== lock.productVersion)
  ) {
    return 'inconsistent';
  }
  if (lock.productVersion) return 'deployed';
  if (workers.length === 0) return 'provisioned';
  return 'legacy';
}

function denied(
  operation: EnvironmentOperationKind,
  lifecycle: EnvironmentLifecycle,
  reason: EnvironmentOperationBlockReason,
  currentVersion?: string
): EnvironmentOperationDecision {
  return {
    allowed: false,
    lifecycle,
    operation,
    ...(currentVersion ? { currentVersion } : {}),
    reason,
  };
}

export function evaluateEnvironmentOperation(input: {
  operation: EnvironmentOperationKind;
  lock?: AuthrimLock | null;
  targetVersion?: string;
  releaseManifestChecksum?: string;
  environmentObservedRemotely?: boolean;
}): EnvironmentOperationDecision {
  const { operation, lock, targetVersion, releaseManifestChecksum, environmentObservedRemotely } =
    input;
  const lifecycle = classifyEnvironmentLifecycle(lock);
  const currentVersion = lock?.productVersion;

  if (operation === 'delete') {
    return lifecycle === 'absent' && !environmentObservedRemotely
      ? denied(operation, lifecycle, 'environment_not_found')
      : { allowed: true, lifecycle, operation, ...(currentVersion ? { currentVersion } : {}) };
  }

  if (lifecycle === 'absent') {
    return operation === 'provision' || operation === 'config_mutation'
      ? { allowed: true, lifecycle, operation }
      : denied(operation, lifecycle, 'environment_not_found');
  }

  if (operation === 'provision') {
    return denied(operation, lifecycle, 'environment_already_exists', currentVersion);
  }

  if (lock?.topologyUpdate) {
    if (operation !== 'topology_change') {
      return denied(operation, lifecycle, 'topology_update_in_progress', currentVersion);
    }
    if (!targetVersion) {
      return denied(operation, lifecycle, 'target_version_required', currentVersion);
    }
    if (
      currentVersion !== targetVersion ||
      lock.topologyUpdate.targetProductVersion !== targetVersion
    ) {
      return denied(operation, lifecycle, 'release_update_required', currentVersion);
    }
    return { allowed: true, lifecycle, operation, currentVersion };
  }

  if (operation === 'release_update' && lifecycle !== 'provisioned') {
    if (!targetVersion) {
      return denied(operation, lifecycle, 'target_version_required', currentVersion);
    }
    if (currentVersion && compareProductVersions(targetVersion, currentVersion) < 0) {
      return denied(operation, lifecycle, 'product_downgrade_not_supported', currentVersion);
    }
  }

  if (lifecycle === 'inconsistent') {
    return operation === 'release_update'
      ? { allowed: true, lifecycle, operation, ...(currentVersion ? { currentVersion } : {}) }
      : denied(operation, lifecycle, 'inconsistent_release_state', currentVersion);
  }

  if (lifecycle === 'updating') {
    const workers = Object.values(lock?.workers ?? {});
    const release = lock?.releaseUpdate;
    const resumableInitialDeploy =
      operation === 'initial_deploy' &&
      !currentVersion &&
      Boolean(targetVersion) &&
      Boolean(releaseManifestChecksum) &&
      release?.targetVersion === targetVersion &&
      release?.manifestChecksum === releaseManifestChecksum &&
      release?.phase !== 'verified' &&
      workers.every((worker) => worker.version === targetVersion);
    if (resumableInitialDeploy) {
      return { allowed: true, lifecycle, operation };
    }
    if (operation === 'release_update' && lock?.releaseUpdate?.targetVersion === targetVersion) {
      return { allowed: true, lifecycle, operation, ...(currentVersion ? { currentVersion } : {}) };
    }
    return denied(operation, lifecycle, 'release_update_in_progress', currentVersion);
  }

  if (operation === 'structure_migration') {
    return { allowed: true, lifecycle, operation, ...(currentVersion ? { currentVersion } : {}) };
  }

  if (lifecycle === 'provisioned') {
    if (operation === 'initial_deploy' || operation === 'config_mutation') {
      return { allowed: true, lifecycle, operation };
    }
    return denied(operation, lifecycle, 'initial_deploy_required');
  }

  if (lifecycle === 'legacy') {
    return operation === 'release_update'
      ? { allowed: true, lifecycle, operation }
      : denied(operation, lifecycle, 'legacy_reconciliation_required');
  }

  if (operation === 'initial_deploy') {
    return denied(operation, lifecycle, 'operation_not_allowed', currentVersion);
  }

  const requiresSameVersion =
    operation === 'worker_redeploy' ||
    operation === 'topology_change' ||
    operation === 'manual_migration' ||
    operation === 'config_mutation';
  if (requiresSameVersion && !targetVersion) {
    return denied(operation, lifecycle, 'target_version_required', currentVersion);
  }
  if (requiresSameVersion && currentVersion !== targetVersion) {
    return denied(operation, lifecycle, 'release_update_required', currentVersion);
  }

  return { allowed: true, lifecycle, operation, ...(currentVersion ? { currentVersion } : {}) };
}

export function environmentOperationBlockMessage(
  decision: EnvironmentOperationDecision,
  targetVersion?: string
): string {
  switch (decision.reason) {
    case 'environment_already_exists':
      return 'The environment already exists; provisioning cannot replace its lock or release state.';
    case 'environment_not_found':
      return 'The environment has not been provisioned.';
    case 'initial_deploy_required':
      return 'Initial deployment must use the complete schema-first deploy operation.';
    case 'release_update_required':
      return `Product update ${decision.currentVersion ?? 'unknown'} -> ${targetVersion ?? 'unknown'} requires authrim-setup update so database schemas are applied first.`;
    case 'release_update_in_progress':
      return 'A release update is incomplete; resume it with authrim-setup update before another environment operation.';
    case 'topology_update_in_progress':
      return 'A topology update is incomplete; resume its dedicated topology command before another environment operation.';
    case 'legacy_reconciliation_required':
      return 'The deployed product version is not recorded; use authrim-setup update to reconcile schema and Workers.';
    case 'inconsistent_release_state':
      return 'The environment lock contains inconsistent release state; only authrim-setup update may reconcile it.';
    case 'target_version_required':
      return 'The operation did not provide its target product version; refusing to bypass the release update guard.';
    case 'product_downgrade_not_supported':
      return `Product downgrade ${decision.currentVersion ?? 'unknown'} -> ${targetVersion ?? 'unknown'} is not supported.`;
    default:
      return `Operation ${decision.operation} is not allowed while the environment is ${decision.lifecycle}.`;
  }
}
