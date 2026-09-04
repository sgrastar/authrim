import type { AuthrimLock } from './lock.js';

/**
 * A successful binding patch already verifies the new active deployment and reflected settings.
 * Do not add a fixed per-target delay on top of those provider checks: an initial environment has
 * dozens of targets, so even a small unconditional pause dominates deployment time. A genuinely
 * propagating patch is checkpointed and retried after the executor's bounded retry interval.
 */
export const CONTROL_WORKER_BINDING_INTER_TARGET_DELAY_MS = 0;

/** Keep Setup-owned Control mutations outside incomplete topology and release transitions. */
export function assertControlProvisionMutationState(lock: AuthrimLock): void {
  if (lock.topologyUpdate) {
    throw new Error('control_provision_topology_update_in_progress');
  }
  const release = lock.releaseUpdate;
  if (release && release.phase !== 'verified' && release.phase !== 'database_only_verified') {
    throw new Error('control_provision_release_update_in_progress');
  }
  if (release?.phase === 'verified' && lock.productVersion !== release.targetVersion) {
    throw new Error('control_provision_release_state_inconsistent');
  }
}
