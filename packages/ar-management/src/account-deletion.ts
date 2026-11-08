/**
 * A routed account's full deletion, the one saga the administrator's delete, SCIM's delete and the
 * clean-up of unfinished sign-ups share (lite plan PR6b-2). It takes nothing from a request: the
 * account's own adapters, and how the sessions it ends are told downstream (the caller's wrapper:
 * an admin request's, SCIM's, or the scheduled job's).
 *
 * The order is the deletion-race rules' (#758, #760, #761):
 * 1. A legal hold refuses it before anything changes.
 * 2. The tombstone is decided (the address's keyed fingerprint, the tenant's retention) while the
 *    address can still be read.
 * 3. Its sessions are ended (their auth state `deleting`), then the directory removal is prepared
 *    (the hold-checked move to `deleting`, after which no hold can be placed and the lifecycle
 *    never goes back), the deletion fenced, the tombstone written (it also stops later PII
 *    writes), the PII erased (the erasure marker in its batch), the runtime user deleted (its core
 *    authority row first; `account.deleted` is written by the core trigger), the sessions' auth
 *    state `deleted`, and the directory removals made ready and attempted.
 *
 * A retry finds what an earlier attempt wrote: the removal adopts its outbox rows, the tombstone is
 * an upsert, the erasure is re-run whole. A hold found by the prepared move throws
 * AccountDeletionHeldError, the account left as it was.
 */
import {
  CanonicalIdentityRepository,
  CanonicalRuntimeUserWriter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { findActiveAccountLegalHold } from './account-legal-hold-guard';
import {
  attemptImmediateAccountDirectoryRemovals,
  eraseAccountPiiAfterDirectoryRemovalPrepared,
  fenceAccountDeletion,
  markAccountDirectoryRemovalsReady,
  prepareAccountDirectoryRemoval,
} from './account-directory-removal-producer';
import { prepareAccountTombstone, writeAccountTombstone } from './account-tombstone-write';
import { transitionEndingSessions, type EndedSession } from './session-end-logout';

/**
 * Runs the work that ends the account's sessions, then starts their downstream logout (also when
 * the work fails: the sessions it ended have ended all the same). An admin request's
 * `withAdminSessionEndLogout`, or an env-only one.
 */
export type AccountDeletionSessionEnd = <T>(
  operationId: string,
  work: (ended: EndedSession[]) => Promise<T>
) => Promise<T>;

export interface DeleteAccountInput {
  tenantId: string;
  userId: string;
  core: DatabaseAdapter;
  pii: DatabaseAdapter;
  /**
   * The address the tombstone keeps a keyed fingerprint of (null: none, as for an unfinished
   * sign-up's, which may sign up again, or a retry after its projection was erased).
   */
  email: string | null | undefined;
  /** The tombstone's tenant (an older record's own), when it differs from `tenantId`. */
  tombstoneTenantId?: string;
  tombstone: { deletedBy: string; reason: string; metadata: Record<string, unknown> };
  endSessions: AccountDeletionSessionEnd;
  /** The erasure's time (epoch seconds); the producer's own when absent. */
  erasedAtSeconds?: number;
}

export type DeleteAccountResult = { status: 'deleted' } | { status: 'held'; holdId: string };

export async function deleteAccount(
  env: Env,
  input: DeleteAccountInput
): Promise<DeleteAccountResult> {
  const { tenantId, userId, core, pii } = input;
  const legalHold = await findActiveAccountLegalHold(core, tenantId, userId);
  if (legalHold) return { status: 'held', holdId: legalHold.holdId };
  // Decided before anything changes: the address's keyed fingerprint and the tenant's retention.
  const tombstoneInput = await prepareAccountTombstone(env, { tenantId, email: input.email });
  // The sessions the deletion ends: their relying parties are told after it (each logout token
  // carries the sub recorded with its session-client, not one read from the account being
  // removed), also when a later step fails.
  const deletingOperationId = crypto.randomUUID();
  await input.endSessions(deletingOperationId, async (ended) => {
    const deletingVersionMs = Date.now();
    await transitionEndingSessions(env, ended, {
      tenantId,
      userId,
      lifecycle: 'deleting',
      sourceVersionMs: deletingVersionMs,
      operationId: deletingOperationId,
    });
    const removals = await prepareAccountDirectoryRemoval(env, { tenantId, userId, core, pii });
    // Holds fenced off before anything is erased (see fenceAccountDeletion).
    await fenceAccountDeletion(core, { tenantId, userId });
    // The tombstone first, in the PII database (GDPR audit trail): it also stops later writes of
    // the person's PII (a response record, a profile value) from landing after the erasure.
    await writeAccountTombstone(pii, {
      tenantId: input.tombstoneTenantId || tenantId,
      userId,
      prepared: tombstoneInput,
      deletedBy: input.tombstone.deletedBy,
      reason: input.tombstone.reason,
      metadata: input.tombstone.metadata,
    });
    if (input.erasedAtSeconds === undefined) {
      await eraseAccountPiiAfterDirectoryRemovalPrepared(pii, { tenantId, userId, core });
    } else {
      await eraseAccountPiiAfterDirectoryRemovalPrepared(
        pii,
        { tenantId, userId, core },
        input.erasedAtSeconds
      );
    }
    await new CanonicalRuntimeUserWriter(
      new CanonicalIdentityRepository(core, tenantId),
      pii
    ).deleteRuntimeUser(userId);
    await transitionEndingSessions(env, ended, {
      tenantId,
      userId,
      lifecycle: 'deleted',
      sourceVersionMs: Math.max(Date.now(), deletingVersionMs + 1),
      operationId: crypto.randomUUID(),
    });
    await markAccountDirectoryRemovalsReady(core, removals);
    await attemptImmediateAccountDirectoryRemovals(env.ACCOUNT_DIRECTORY, removals);
  });
  return { status: 'deleted' };
}
