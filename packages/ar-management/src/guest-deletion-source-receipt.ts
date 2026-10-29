import {
  GuestLifecycleRepository,
  assertGuestCoreErasureAdmission,
  parseGuestDeletionProgress,
  GUEST_DELETION_STAGES,
  type DatabaseAdapter,
  type GuestErasureCompletionReceipt,
  type GuestErasureDrainReceipt,
  type GuestErasureSourceReceipt,
} from '@authrim/ar-lib-core';
import { requireGuestDeletionAuditTask } from './guest-deletion-audit-outbox';
import {
  guestErasureBoundaryId,
  parseGuestDeletionRoute,
  sameGuestDeletionIdentity,
  type GuestDeletionRouteV2,
} from './guest-deletion-route';

/** Read-only positive proof, checked before the first effect and each resumed step. */
export async function requireGuestErasureSourceReceipt(
  core: DatabaseAdapter,
  expected: GuestDeletionRouteV2
): Promise<GuestErasureSourceReceipt> {
  const rejected = () => new Error('guest_deletion_source_unverified');
  if (core.getType() !== 'd1' || expected.execution.phase !== 'erasure_started') throw rejected();
  await assertGuestCoreErasureAdmission(core);
  const row = await new GuestLifecycleRepository(core, expected.tenantId).get(expected.userId);
  if (
    !row ||
    !['deleting', 'deleted'].includes(row.phase) ||
    row.deletion_operation_id !== expected.operationId
  )
    throw rejected();
  const current = parseGuestDeletionRoute(row.deletion_route_json, {
    tenantId: expected.tenantId,
    userId: expected.userId,
    accountId: expected.accountId,
    operationId: expected.operationId,
  });
  if (
    !sameGuestDeletionIdentity(expected, current) ||
    current.execution.phase !== 'erasure_started' ||
    current.execution.boundaryId !== (await guestErasureBoundaryId(current.operationId)) ||
    current.execution.erasureStartedAtMs === null ||
    current.execution.erasureStartedAtMs < (row.deletion_started_at_ms ?? Number.MAX_SAFE_INTEGER)
  )
    throw rejected();
  const owner = await core.queryOne<{ id: string }>(
    `SELECT account.id FROM identity_accounts account JOIN account_legal_hold_states authority ON authority.tenant_id=account.tenant_id AND authority.account_id=account.id
      WHERE account.tenant_id=? AND account.id=? AND account.legacy_user_id=? AND account.account_type='user' AND account.registration_state='guest'
        AND account.account_route_generation=? AND account.lifecycle_state=? AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=account.tenant_id AND hold.subject_id=account.id AND hold.subject_type='account' AND hold.state='active')`,
    [
      current.tenantId,
      current.accountId,
      current.userId,
      current.accountRouteGeneration,
      row.phase === 'deleted' ? 'deleted' : 'deleting',
    ],
    { consistencyClass: 'primary_required' }
  );
  if (!owner || owner.id !== current.accountId) throw rejected();
  await requireGuestDeletionAuditTask(core, current);
  return {
    tenantId: current.tenantId,
    userId: current.userId,
    accountId: current.accountId,
    accountRouteGeneration: current.accountRouteGeneration,
    operationId: current.operationId,
    boundaryId: current.execution.boundaryId,
    sourceStartedAtMs: current.execution.erasureStartedAtMs,
    piiPin: current.piiPin,
  };
}

/** Only a completed capture/reservation prefix authorizes raw PII drain. */
export async function requireGuestErasureDrainReceipt(
  core: DatabaseAdapter,
  route: GuestDeletionRouteV2
): Promise<GuestErasureDrainReceipt> {
  const source = await requireGuestErasureSourceReceipt(core, route);
  const progress = await new GuestLifecycleRepository(core, route.tenantId).readExecutionProgress(
    JSON.stringify(route),
    route.userId
  );
  if (progress === null) throw new Error('guest_deletion_capture_incomplete');
  if (
    GUEST_DELETION_STAGES.indexOf(parseGuestDeletionProgress(progress).stage) <
    GUEST_DELETION_STAGES.indexOf('drain_pii')
  )
    throw new Error('guest_deletion_capture_incomplete');
  return { ...source, preparedComplete: true };
}

/** Core terminal proof survives the PII compact step and its lost acknowledgement. */
export async function requireGuestErasureCompletionReceipt(
  core: DatabaseAdapter,
  route: GuestDeletionRouteV2
): Promise<GuestErasureCompletionReceipt> {
  const source = await requireGuestErasureDrainReceipt(core, route);
  const lifecycle = new GuestLifecycleRepository(core, route.tenantId);
  const row = await lifecycle.get(route.userId);
  const progress = await lifecycle.readExecutionProgress(JSON.stringify(route), route.userId);
  if (
    !row ||
    row.phase !== 'deleted' ||
    !row.deleted_at ||
    progress === null ||
    !['compact_pii', 'terminal'].includes(parseGuestDeletionProgress(progress).stage)
  )
    throw new Error('guest_deletion_core_incomplete');
  return { ...source, coreCompleted: true };
}
