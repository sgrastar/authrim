import type { AuthrimLock } from './lock.js';
import {
  environmentOperationBlockMessage,
  evaluateEnvironmentOperation,
  type EnvironmentOperationKind,
} from './environment-operation-policy.js';

export interface ReleaseDeploymentGuardResult {
  allowed: boolean;
  currentVersion?: string;
  reason?:
    | 'mixed_worker_versions'
    | 'unknown_worker_version'
    | 'unknown_product_version'
    | 'initial_deploy_required'
    | 'release_update_in_progress'
    | 'topology_update_in_progress'
    | 'release_update_required';
}

/**
 * Worker-only deployment paths are safe only for initial deployment or a
 * same-product redeploy. Product upgrades must use the schema-first release
 * update state machine.
 */
export function evaluateReleaseDeploymentGuard(
  lock: AuthrimLock,
  targetVersion: string,
  operation: Exclude<EnvironmentOperationKind, 'provision' | 'delete' | 'release_update'>,
  options: { releaseManifestChecksum?: string } = {}
): ReleaseDeploymentGuardResult {
  const decision = evaluateEnvironmentOperation({
    operation,
    lock,
    targetVersion,
    ...options,
  });
  if (decision.allowed) return { allowed: true, currentVersion: decision.currentVersion };
  const reason =
    decision.reason === 'release_update_in_progress'
      ? 'release_update_in_progress'
      : decision.reason === 'topology_update_in_progress'
        ? 'topology_update_in_progress'
        : decision.reason === 'release_update_required'
          ? 'release_update_required'
          : decision.reason === 'initial_deploy_required'
            ? 'initial_deploy_required'
            : decision.reason === 'legacy_reconciliation_required'
              ? Object.values(lock.workers ?? {}).some((worker) => !worker.version)
                ? 'unknown_worker_version'
                : new Set(
                      Object.values(lock.workers ?? {}).flatMap((worker) =>
                        worker.version ? [worker.version] : []
                      )
                    ).size > 1
                  ? 'mixed_worker_versions'
                  : [
                        ...new Set(
                          Object.values(lock.workers ?? {}).flatMap((worker) =>
                            worker.version ? [worker.version] : []
                          )
                        ),
                      ][0] !== targetVersion
                    ? 'release_update_required'
                    : 'unknown_product_version'
              : 'unknown_product_version';
  return { allowed: false, currentVersion: decision.currentVersion, reason };
}

export function releaseDeploymentGuardMessage(
  result: ReleaseDeploymentGuardResult,
  targetVersion: string
): string {
  if (result.reason === 'mixed_worker_versions') {
    return 'The lock contains inconsistent deployed Worker versions; resume with authrim-setup update.';
  }
  if (result.reason === 'unknown_worker_version') {
    return 'At least one deployed Worker has no recorded product version; use authrim-setup update to reconcile schema and Workers.';
  }
  if (result.reason === 'release_update_in_progress') {
    return 'A release update is incomplete; resume it with authrim-setup update before any direct deployment.';
  }
  if (result.reason === 'topology_update_in_progress') {
    return 'A topology update is incomplete; resume its dedicated topology command before any other deployment.';
  }
  if (result.reason === 'initial_deploy_required') {
    return 'Initial deployment must use the complete schema-first deploy operation.';
  }
  if (result.reason === 'unknown_product_version') {
    return 'The deployed product version is unknown; use authrim-setup update to reconcile schema and Workers.';
  }
  return `Product update ${result.currentVersion ?? 'unknown'} -> ${targetVersion} requires authrim-setup update so database schemas are applied first.`;
}

export { environmentOperationBlockMessage, evaluateEnvironmentOperation };
