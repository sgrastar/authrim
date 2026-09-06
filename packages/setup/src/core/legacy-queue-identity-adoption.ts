import type { AuthrimLock } from './lock.js';

export interface LegacyQueueIdentityAdoptionEvidence {
  binding: string;
  name: string;
  previousId: string;
  providerId: string;
}

export interface LegacyQueueIdentityAdoptionResult {
  lock: AuthrimLock;
  adopted: LegacyQueueIdentityAdoptionEvidence[];
}

/**
 * Build an explicit, one-time upgrade from the historical Queue `id === name` sentinel.
 *
 * The live inventory is already scoped to the authenticated Cloudflare account by the caller.
 * This helper additionally binds that account to the persisted environment configuration and
 * accepts only canonical Queue names for the exact environment. It never adopts a missing ID or
 * replaces a real immutable ID.
 */
export function adoptLegacyQueueIdentities(input: {
  lock: AuthrimLock;
  environment: string;
  authenticatedAccountId: string;
  configuredAccountId: string | undefined;
  liveQueues: ReadonlyArray<{ name: string; id?: string }>;
  canonicalQueues: ReadonlyArray<{ binding: string; name: string }>;
}): LegacyQueueIdentityAdoptionResult {
  if (input.lock.env !== input.environment) {
    throw new Error('legacy_queue_adoption_environment_mismatch');
  }
  const configuredAccountId = input.configuredAccountId?.trim();
  const authenticatedAccountId = input.authenticatedAccountId.trim();
  if (!configuredAccountId || configuredAccountId !== authenticatedAccountId) {
    throw new Error('legacy_queue_adoption_account_mismatch');
  }

  const canonicalByBinding = new Map<string, { binding: string; name: string }>();
  const canonicalNames = new Set<string>();
  for (const queue of input.canonicalQueues) {
    if (
      !queue.binding ||
      !queue.name ||
      canonicalByBinding.has(queue.binding) ||
      canonicalNames.has(queue.name)
    ) {
      throw new Error('legacy_queue_adoption_canonical_inventory_invalid');
    }
    canonicalByBinding.set(queue.binding, queue);
    canonicalNames.add(queue.name);
  }

  const liveByName = new Map<string, Array<{ name: string; id?: string }>>();
  const liveIdOwners = new Map<string, Set<string>>();
  for (const queue of input.liveQueues) {
    const matches = liveByName.get(queue.name) ?? [];
    matches.push(queue);
    liveByName.set(queue.name, matches);
    const providerId = queue.id?.trim();
    if (providerId) {
      const owners = liveIdOwners.get(providerId) ?? new Set<string>();
      owners.add(queue.name);
      liveIdOwners.set(providerId, owners);
    }
  }

  const adopted: LegacyQueueIdentityAdoptionEvidence[] = [];
  const queues = { ...(input.lock.queues ?? {}) };
  for (const [binding, lockedQueue] of Object.entries(input.lock.queues ?? {})) {
    if (lockedQueue.id !== lockedQueue.name) continue;
    const canonical = canonicalByBinding.get(binding);
    if (!canonical || canonical.name !== lockedQueue.name) {
      throw new Error(`legacy_queue_adoption_noncanonical_target:${binding}`);
    }
    const liveMatches = liveByName.get(lockedQueue.name) ?? [];
    if (liveMatches.length !== 1) {
      throw new Error(`legacy_queue_adoption_live_name_not_unique:${binding}`);
    }
    const providerId = liveMatches[0]?.id?.trim();
    if (!providerId || providerId === lockedQueue.name) {
      throw new Error(`legacy_queue_adoption_provider_id_unavailable:${binding}`);
    }
    if ((liveIdOwners.get(providerId)?.size ?? 0) !== 1) {
      throw new Error(`legacy_queue_adoption_provider_id_ambiguous:${binding}`);
    }
    queues[binding] = { ...lockedQueue, id: providerId };
    adopted.push({
      binding,
      name: lockedQueue.name,
      previousId: lockedQueue.id,
      providerId,
    });
  }

  if (adopted.length === 0) {
    throw new Error('legacy_queue_adoption_not_required');
  }
  return {
    lock: { ...input.lock, queues },
    adopted: adopted.sort((left, right) => left.binding.localeCompare(right.binding)),
  };
}

/** Fail closed when an atomic lock checkpoint cannot be read back exactly. */
export function assertLegacyQueueIdentityAdoptionPersisted(
  lock: AuthrimLock | null,
  environment: string,
  evidence: readonly LegacyQueueIdentityAdoptionEvidence[]
): void {
  if (!lock || lock.env !== environment || evidence.length === 0) {
    throw new Error('legacy_queue_adoption_checkpoint_verification_failed');
  }
  for (const adopted of evidence) {
    const checkpoint = lock.queues?.[adopted.binding];
    if (checkpoint?.name !== adopted.name || checkpoint.id !== adopted.providerId) {
      throw new Error(`legacy_queue_adoption_checkpoint_verification_failed:${adopted.binding}`);
    }
  }
}
