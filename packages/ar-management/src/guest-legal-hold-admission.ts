import { GuestLifecycleRepository, type DatabaseAdapter } from '@authrim/ar-lib-core';

/** Existing idempotent hold results are resolved before this new-hold check. */
export async function assertGuestLegalHoldAdmission(
  core: DatabaseAdapter,
  tenantId: string,
  accountId: string
): Promise<void> {
  const account = await core.queryOne<{
    legacy_user_id: string;
    registration_state: string;
    account_route_generation: number | string;
  }>(
    'SELECT legacy_user_id,registration_state,account_route_generation FROM identity_accounts WHERE tenant_id=? AND id=?',
    [tenantId, accountId],
    { consistencyClass: 'primary_required' }
  );
  if (!account || account.registration_state !== 'guest') return;
  const row = await new GuestLifecycleRepository(core, tenantId).get(account.legacy_user_id);
  if (!row || ['active', 'upgrading', 'registered'].includes(row.phase)) return;
  if (row.phase === 'deleted') throw new Error('guest_erasure_already_started');
  if (row.phase !== 'deleting' || !row.deletion_operation_id)
    throw new Error('guest_hold_admission_unverified');
  let receipt;
  try {
    receipt = GuestLifecycleRepository.parseDeletionRouteV2(row.deletion_route_json, {
      tenantId,
      userId: account.legacy_user_id,
      accountId,
      operationId: row.deletion_operation_id,
    });
  } catch {
    throw new Error('guest_hold_admission_unverified');
  }
  if (receipt.accountRouteGeneration !== Number(account.account_route_generation))
    throw new Error('guest_hold_admission_unverified');
  if (receipt.execution.phase === 'erasure_started')
    throw new Error('guest_erasure_already_started');
  if (core.getType() !== 'd1') throw new Error('guest_hold_admission_backend_unsupported');
  // The existing authority-row write and account lifecycle predicate serialize the actual INSERT
  // against confirmErasureStart's atomic account=deleting transition, after this read-only check.
}
