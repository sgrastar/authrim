import { GuestLifecycleRepository } from '../repositories/guest-lifecycle';
import { GuestUpgradeRepository, type GuestUpgradeOperation } from '../repositories/guest-upgrade';

export type GuestUpgradeCommitResult = 'completed' | 'pending' | 'denied' | 'expired';

/**
 * The core compare-and-set is the irreversible admission decision shared with deletion.
 * Proof lives in PII storage; a failure between databases is recovered using the core
 * operation identifier. Once admitted, recovery rolls forward even after proof expiry.
 */
export async function commitGuestUpgrade(input: {
  lifecycle: GuestLifecycleRepository;
  operations: GuestUpgradeRepository;
  userId: string;
  clientId: string;
  operationId: string;
  now: number;
  leaseOwner: string;
  /** Read current tenant, method and client permissions immediately before admission. */
  isAllowed: (method: 'email' | 'passkey') => Promise<boolean>;
  /** All side effects must be idempotent under operation_id, including audit evidence. */
  commit: (operation: GuestUpgradeOperation) => Promise<void>;
}): Promise<GuestUpgradeCommitResult> {
  const operation = await input.operations.get(input.operationId);
  if (
    !operation ||
    operation.user_id !== input.userId ||
    operation.client_id !== input.clientId ||
    !['verified', 'committing', 'completed'].includes(operation.state)
  )
    return 'denied';

  let lifecycle = await input.lifecycle.get(input.userId);
  if (!lifecycle || lifecycle.client_id !== input.clientId) return 'denied';
  if (lifecycle.phase === 'active') {
    if (operation.state !== 'verified') return 'denied';
    if (operation.expires_at <= input.now) return 'expired';
    if (!(await input.isAllowed(operation.method))) return 'denied';
    await input.lifecycle.beginUpgrade(
      input.userId,
      operation.operation_id,
      input.now,
      operation.expires_at
    );
    lifecycle = await input.lifecycle.get(input.userId);
  }
  if (
    !lifecycle ||
    lifecycle.upgrade_operation_id !== operation.operation_id ||
    !['upgrading', 'registered'].includes(lifecycle.phase)
  )
    return 'denied';
  if (operation.state === 'completed') {
    if (lifecycle.phase === 'registered')
      await input.lifecycle.acknowledgeUpgrade(input.userId, operation.operation_id, input.now);
    return lifecycle.phase === 'registered' ? 'completed' : 'denied';
  }
  if (!(await input.operations.leaseCommit(operation.operation_id, input.leaseOwner, input.now)))
    return 'pending';

  // A registered row means every durable side effect already succeeded; only PII
  // proof redaction remains after a crash at the last cross-database boundary.
  if (lifecycle.phase === 'upgrading') {
    await input.commit(operation);
    if (!(await input.lifecycle.completeUpgrade(input.userId, operation.operation_id, input.now)))
      throw new Error('guest_upgrade_lifecycle_commit_conflict');
  }
  if (!(await input.operations.complete(operation.operation_id, input.leaseOwner, input.now)))
    return 'pending';
  await input.lifecycle.acknowledgeUpgrade(input.userId, operation.operation_id, input.now);
  return 'completed';
}
