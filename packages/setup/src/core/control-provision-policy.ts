import type { AuthrimLock } from './lock.js';

/**
 * A successful binding patch already verifies the new active deployment and reflected settings.
 * Do not add a fixed per-target delay on top of those provider checks: an initial environment has
 * dozens of targets, so even a small unconditional pause dominates deployment time. A genuinely
 * propagating patch is checkpointed and retried after the executor's bounded retry interval.
 */
export const CONTROL_WORKER_BINDING_INTER_TARGET_DELAY_MS = 0;

/** A release update stopped before its Control handoff was recorded in the lock. */
export function isReleaseUpdateBeforeControlHandoff(lock: AuthrimLock): boolean {
  return lock.releaseUpdate?.phase === 'control_handoff' && !lock.releaseUpdate.controlOperationId;
}

/**
 * Keep Setup-owned Control mutations outside incomplete topology and release transitions.
 *
 * `allowBeforeControlHandoff` admits one more state, for executing a pending shard provisioning
 * only (see assertControlProvisionBeforeControlHandoff): an update stopped before its Control
 * handoff, because refreshing ar-control for the handoff needs every database Control requested
 * meanwhile to be provisioned (environments without automatic provisioning). Without it the
 * update waits for the database and provisioning waits for the update.
 */
export function assertControlProvisionMutationState(
  lock: AuthrimLock,
  options: { allowBeforeControlHandoff?: boolean } = {}
): void {
  if (lock.topologyUpdate) {
    throw new Error('control_provision_topology_update_in_progress');
  }
  const release = lock.releaseUpdate;
  if (
    release &&
    release.phase !== 'verified' &&
    release.phase !== 'database_only_verified' &&
    !(options.allowBeforeControlHandoff && isReleaseUpdateBeforeControlHandoff(lock))
  ) {
    throw new Error('control_provision_release_update_in_progress');
  }
  if (release?.phase === 'verified' && lock.productVersion !== release.targetVersion) {
    throw new Error('control_provision_release_state_inconsistent');
  }
}

/**
 * Before a stopped update's Control handoff, only a shard provisioning operation may run, and
 * only while Control holds no active release rollout: the handoff row can exist in Control before
 * the lock records it. A failed lookup refuses. Callers hold the environment operation lock that
 * update also takes, so no rollout can appear meanwhile.
 */
export async function assertControlProvisionBeforeControlHandoff(input: {
  lock: AuthrimLock;
  operationKind: string;
  loadActiveRollout: () => Promise<unknown>;
}): Promise<void> {
  if (!isReleaseUpdateBeforeControlHandoff(input.lock)) return;
  if (input.operationKind !== 'provision_shard') {
    throw new Error('control_provision_release_update_in_progress');
  }
  if ((await input.loadActiveRollout()) !== null) {
    throw new Error('control_provision_release_update_in_progress');
  }
}
