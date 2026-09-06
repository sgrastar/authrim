import { getAccountId, getRequiredQueues, listQueues } from './cloudflare.js';
import type { AuthrimConfig } from './config.js';
import {
  adoptLegacyQueueIdentities,
  assertLegacyQueueIdentityAdoptionPersisted,
  type LegacyQueueIdentityAdoptionEvidence,
} from './legacy-queue-identity-adoption.js';
import { loadLockFile, saveLockFile, type AuthrimLock } from './lock.js';

export interface LegacyQueueDeletionIdentityResult {
  lock: AuthrimLock;
  adopted: LegacyQueueIdentityAdoptionEvidence[];
}

/**
 * Upgrade the historical Queue `id === name` sentinel before an explicitly confirmed deletion.
 *
 * This is deliberately narrower than normal resource reconciliation. It binds the live inventory
 * to the configured Cloudflare account, accepts only canonical Queue names for the exact
 * environment, and atomically verifies the upgraded lock before any provider mutation can start.
 * A real immutable-ID mismatch remains a hard failure in the deletion preflight.
 */
export async function reconcileLegacyQueueIdentitiesForDeletion(input: {
  lock: AuthrimLock;
  environment: string;
  config: AuthrimConfig | null;
  lockFilePath: string;
}): Promise<LegacyQueueDeletionIdentityResult> {
  const requiresAdoption = Object.values(input.lock.queues ?? {}).some(
    (queue) => queue.id === queue.name
  );
  if (!requiresAdoption) return { lock: input.lock, adopted: [] };

  if (!input.config || input.config.environment.prefix !== input.environment) {
    throw new Error('legacy_queue_adoption_config_required_for_deletion');
  }
  const authenticatedAccountId = await getAccountId();
  if (!authenticatedAccountId) {
    throw new Error('legacy_queue_adoption_authenticated_account_required_for_deletion');
  }
  const liveQueues = await listQueues({ strictOutput: true, requireIds: true });
  const adoption = adoptLegacyQueueIdentities({
    lock: input.lock,
    environment: input.environment,
    authenticatedAccountId,
    configuredAccountId: input.config.cloudflare?.accountId,
    liveQueues,
    canonicalQueues: getRequiredQueues(input.environment),
  });

  await saveLockFile(adoption.lock, input.lockFilePath);
  const checkpoint = await loadLockFile(input.lockFilePath);
  if (!checkpoint) {
    throw new Error('legacy_queue_adoption_checkpoint_verification_failed');
  }
  assertLegacyQueueIdentityAdoptionPersisted(checkpoint, input.environment, adoption.adopted);
  return { lock: checkpoint, adopted: adoption.adopted };
}
