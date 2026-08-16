import type { AuthrimLock } from './lock.js';
import { compareProductVersions } from './release-migrations.js';

export type ReleaseUpdateAvailabilityStatus =
  | 'update_available'
  | 'resume_available'
  | 'reconciliation_required'
  | 'up_to_date'
  | 'initial_deploy_required'
  | 'setup_tool_older'
  | 'blocked';

export interface ReleaseUpdateAvailability {
  status: ReleaseUpdateAvailabilityStatus;
  currentVersion?: string;
  targetVersion: string;
  phase?: NonNullable<AuthrimLock['releaseUpdate']>['phase'];
  canUpdate: boolean;
}

export function evaluateReleaseUpdateAvailability(
  lock: AuthrimLock | null | undefined,
  targetVersion: string
): ReleaseUpdateAvailability {
  if (!lock) {
    return { status: 'initial_deploy_required', targetVersion, canUpdate: false };
  }

  const releaseUpdate = lock.releaseUpdate;
  if (!lock.productVersion && releaseUpdate) {
    return {
      status: 'initial_deploy_required',
      targetVersion,
      phase: releaseUpdate.phase,
      canUpdate: false,
    };
  }
  if (
    releaseUpdate &&
    releaseUpdate.phase !== 'verified' &&
    releaseUpdate.phase !== 'database_only_verified'
  ) {
    if (releaseUpdate.targetVersion === targetVersion) {
      return {
        status: 'resume_available',
        currentVersion: lock.productVersion,
        targetVersion,
        phase: releaseUpdate.phase,
        canUpdate: true,
      };
    }
    return {
      status: 'blocked',
      currentVersion: lock.productVersion,
      targetVersion,
      phase: releaseUpdate.phase,
      canUpdate: false,
    };
  }

  if (!lock.productVersion) {
    const hasWorkers = Object.keys(lock.workers ?? {}).length > 0;
    return {
      status: hasWorkers ? 'reconciliation_required' : 'initial_deploy_required',
      targetVersion,
      canUpdate: hasWorkers,
    };
  }

  const comparison = compareProductVersions(targetVersion, lock.productVersion);
  if (comparison > 0) {
    return {
      status: 'update_available',
      currentVersion: lock.productVersion,
      targetVersion,
      canUpdate: true,
    };
  }
  if (comparison < 0) {
    return {
      status: 'setup_tool_older',
      currentVersion: lock.productVersion,
      targetVersion,
      canUpdate: false,
    };
  }
  return {
    status: 'up_to_date',
    currentVersion: lock.productVersion,
    targetVersion,
    canUpdate: false,
  };
}
