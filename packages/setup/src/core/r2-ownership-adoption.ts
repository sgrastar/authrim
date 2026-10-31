import type { R2OwnershipAdoptionCandidate } from './cloudflare.js';
import { createLockFile, type AuthrimLock } from './lock.js';

/** Use the provisioning lock shape, preserving every existing identity and checkpoint. */
export function withAdoptedR2Ownership(
  lock: AuthrimLock | null,
  environment: string,
  candidates: readonly R2OwnershipAdoptionCandidate[]
): AuthrimLock {
  if (lock && lock.env !== environment) throw new Error('R2 adoption lock environment mismatch');
  const adopted = createLockFile(environment, { d1: [], kv: [], queues: [], r2: [...candidates] });
  for (const candidate of candidates) {
    if (candidate.environment !== environment || lock?.r2?.[candidate.binding]) {
      throw new Error(`R2 adoption would replace an existing binding: ${candidate.binding}`);
    }
  }
  return {
    ...(lock ?? adopted),
    r2: { ...lock?.r2, ...adopted.r2 },
    updatedAt: new Date().toISOString(),
  };
}
