/**
 * Provider-initiated data deletion (Facebook's Data Deletion Request and Deauthorize callbacks)
 *
 * The person asked the identity provider to delete what this app received from it, or removed the
 * app there. Authrim unlinks: the provider's linked identity is removed with everything received
 * from the provider (email, name, raw attributes and claims, profile data, upstream tokens), and
 * the external subject's Lookup route is removed. The Authrim account itself is kept and can still
 * sign in by its other methods; this is not an account deletion.
 *
 * The unlink is the one the account page uses (the account provisioning entrypoint's
 * removeExternalIdpRoute saga under the account's sign-in-method removal lease), so the lookup
 * directory and its projections stay consistent. Unlike the account page it removes the link even
 * when it is the account's last way to sign in: the provider's request is not optional.
 *
 * A legal hold on the account keeps the data: nothing is erased, and the request is recorded as
 * retained (with an audit entry for the administrator). The hold is checked under the removal
 * lease right before the removal, and again after it. Holds live in the account's Core database
 * and the link in its PII database, so the check and the removal cannot be one transaction, and
 * placing a hold does not take the removal lease: a hold placed in that window does not stop the
 * removal (nor the saga's directory cleanup, which does not look at holds for an identifier). It
 * is reported to the administrator (`attention: 'hold_placed_during_unlink'`, audit warning).
 *
 * Every account is resolved from the Lookup directory's primary (`freshRoute`), not a cached
 * route: the request is about who holds the subject now (a cached route may name an account the
 * subject has since left).
 *
 * A suspended or locked account is unlinked as an active one is (the saga and its directory
 * cleanup accept them for this, `restrictedAccountAllowed`); its state is left as it is. An
 * account being deleted is left to its deletion, which erases its linked identities: under a
 * legal hold that deletion stops with the data kept, so the request is retained; without one the
 * deletion is still running and the request is refused as temporarily unavailable (a copy sent
 * shortly after finds the account deleted). A deleted account holds no data from the provider:
 * the request is completed. An account in any other state is refused as temporarily
 * unavailable, never recorded as done.
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  DEFAULT_SIGNED_REQUEST_MAX_AGE_SECONDS,
  EXTERNAL_IDP_SETTINGS_META,
  ensureDatabaseAdapter,
  probeAccountForProviderDataDeletion,
  resolveAccountDataContext,
  resolveAccountDataContextByIdentifier,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveEffectiveSettings,
  withLoginMethodRemovalLock,
  type DatabaseSource,
} from '@authrim/ar-lib-core';
import { findLinkedIdentity } from './linked-identity-store';

export type ProviderDataDeletionOutcome =
  /** The link was removed and its cleanup has finished. */
  | 'unlinked'
  /** The link was removed; the external subject's Lookup route removal still runs. */
  | 'unlink_pending'
  /** No account holds a link for the subject. */
  | 'no_link'
  /** The account is deleted: its deletion erased the link. */
  | 'account_deleted'
  /**
   * The account is being deleted (no hold), or in a state that is neither active, suspended,
   * locked nor deleted: nothing was done, and the request is not recorded as done.
   */
  | 'account_inactive'
  /** A legal hold on the account keeps its data: nothing was erased. */
  | 'retained';

export interface ProviderDataDeletionResult {
  outcome: ProviderDataDeletionOutcome;
  /** The account's user id, when an account holds (or held) the link. */
  userId?: string;
  accountId?: string;
  linkedIdentityId?: string;
  /** The unlink operation (removeExternalIdpRoute), when one was started or is still open. */
  unlinkOperationId?: string;
  /**
   * What the administrator must look at: the subject's unlink stopped (blocked) before its
   * cleanup finished, or a legal hold was placed while the link was being removed.
   */
  attention?: 'unlink_blocked' | 'hold_placed_during_unlink';
}

export class ProviderDataDeletionError extends Error {}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The account page's unlink operation id for a link, so both requests converge on one saga. */
export async function linkedIdentityRemovalOperationId(
  tenantId: string,
  accountId: string,
  linkedIdentityId: string
): Promise<{ digest: string; operationId: string }> {
  const digest = await sha256Hex(`${tenantId}\u0000${accountId}\u0000${linkedIdentityId}`);
  return { digest, operationId: `external-idp-route-remove-${digest.slice(0, 32)}` };
}

/**
 * Whether a link (linked_at, epoch ms) was made after the request was issued (issued_at, epoch
 * s): a later second than the request's. A link made in a later second than the request was
 * issued (relinked to the same or another account, after a failure or not) is never removed by a
 * copy of the request. A link made in the request's own second counts as the request's (erasure
 * wins), so one relinked within that same second is protected only by the replay records. This
 * takes Meta's clock and this server's to agree to within a second or so.
 */
function isLinkNewerThanRequest(linkedAtMs: number, requestIssuedAt: number): boolean {
  return Number.isFinite(linkedAtMs) && Math.floor(linkedAtMs / 1000) > requestIssuedAt;
}

function isInactiveAccountError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'lookup_destination_revalidation_failed' &&
    (error as Error & { cause?: unknown }).cause === 'account_inactive'
  );
}

/**
 * The account's active legal hold, by its authoritative state (as the administrator's deletions
 * check it; an elapsed expiry stays active until the expiry worker records it).
 */
async function hasActiveAccountLegalHold(
  coreDb: DatabaseSource,
  tenantId: string,
  accountId: string
): Promise<boolean> {
  const adapter = ensureDatabaseAdapter(coreDb, 'external-idp-data-deletion-hold');
  const row = await adapter.queryOne<{ id: string }>(
    `SELECT id FROM legal_holds
      WHERE tenant_id = ? AND subject_type = 'account' AND subject_id = ? AND state = 'active'
      LIMIT 1`,
    [tenantId, accountId],
    { consistencyClass: 'primary_required' }
  );
  return Boolean(row);
}

/**
 * An unlink of the subject not completed for the account (the link is already gone): still
 * running, or stopped (blocked) with its directory cleanup and raw values left.
 */
async function findOpenUnlinkOperation(
  piiDb: DatabaseSource,
  tenantId: string,
  accountId: string,
  providerId: string,
  providerUserId: string
): Promise<{ operationId: string; blocked: boolean } | null> {
  const adapter = ensureDatabaseAdapter(piiDb, 'external-idp-data-deletion-open-unlink');
  const [issuerDigest, subjectDigest] = await Promise.all([
    sha256Hex(providerId),
    sha256Hex(providerUserId),
  ]);
  const row = await adapter.queryOne<{ operation_id: string; state: string }>(
    `SELECT operation_id, state FROM external_identifier_unlink_operations
      WHERE tenant_id = ? AND account_id = ? AND issuer_sha256 = ? AND subject_sha256 = ?
        AND state IN ('pending', 'directory_pending', 'blocked')
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, accountId, issuerDigest, subjectDigest],
    { consistencyClass: 'primary_required' }
  );
  return row ? { operationId: row.operation_id, blocked: row.state === 'blocked' } : null;
}

/**
 * The answer for a subject whose account is not active, suspended or locked: read again whatever
 * its state, to tell an account being deleted (left to its deletion; retained under a hold) and a
 * deleted one (completed) from any other (refused for now).
 */
async function answerForRemovedAccount(
  env: Env,
  input: { tenantId: string; providerId: string; providerUserId: string }
): Promise<ProviderDataDeletionResult> {
  // Read-only: the account's state, its hold, and whether data for the subject remains.
  let probe: Awaited<ReturnType<typeof probeAccountForProviderDataDeletion>>;
  const subject = { issuer: input.providerId, subject: input.providerUserId };
  try {
    probe = await probeAccountForProviderDataDeletion(env, {
      tenantId: input.tenantId,
      account: subject,
      remains: subject,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') {
      return { outcome: 'no_link' };
    }
    if (isInactiveAccountError(error)) return { outcome: 'account_inactive' };
    throw error;
  }
  const base = { userId: probe.legacyUserId, accountId: probe.accountId };
  if (probe.lifecycleState === 'deleted') {
    // Completed only once nothing for the subject remains (the deletion erased it); otherwise
    // the deletion is not done with it yet.
    return probe.providerDataRemains
      ? { outcome: 'account_inactive', ...base }
      : { outcome: 'account_deleted', ...base };
  }
  if (probe.lifecycleState === 'deleting') {
    // A deletion a hold stopped stays here with the data kept.
    return probe.legalHoldActive
      ? { outcome: 'retained', ...base }
      : { outcome: 'account_inactive', ...base };
  }
  return { outcome: 'account_inactive', ...base };
}

/**
 * The answer when the account holds no link this request may remove: the route still names the
 * account, so an earlier unlink of the subject may still be running (or have stopped).
 */
async function answerWithoutLink(
  account: { accountId: string; legacyUserId: string; piiDb: DatabaseSource },
  input: { tenantId: string; providerId: string; providerUserId: string }
): Promise<ProviderDataDeletionResult> {
  const open = await findOpenUnlinkOperation(
    account.piiDb,
    input.tenantId,
    account.accountId,
    input.providerId,
    input.providerUserId
  );
  return open
    ? {
        outcome: 'unlink_pending',
        userId: account.legacyUserId,
        accountId: account.accountId,
        unlinkOperationId: open.operationId,
        ...(open.blocked ? { attention: 'unlink_blocked' as const } : {}),
      }
    : { outcome: 'no_link' };
}

/**
 * Unlink the provider's subject from whichever account of the tenant holds it. Throws
 * LoginMethodRemovalInProgressError when another change to how the account signs in is running.
 *
 * A request concerns only the link that existed when it was issued: one made after it (the person
 * linked the provider again since, to this account or another), one that replaced it while the
 * request waited for the lease, and any found after the same signed payload already removed one
 * (`mayRemoveLink`, `payloadGuard`) are left alone, so a copy sent again, delayed or sent to the
 * other callback never removes a newer link.
 */
export async function unlinkProviderSubject(
  env: Env,
  input: {
    tenantId: string;
    providerId: string;
    providerUserId: string;
    /** When the provider issued the request (epoch seconds). */
    requestIssuedAt: number;
    /**
     * False when this request (its signed payload) already removed the subject's link, through
     * either callback: a link found now was made since, and is left alone.
     */
    mayRemoveLink?: boolean;
    /**
     * The same, asked again and recorded under the account's removal lease (which every copy of
     * the request takes), so a copy that read `mayRemoveLink` before another copy removed the
     * link cannot remove a link made since.
     */
    payloadGuard?: {
      alreadyRemoved(): Promise<boolean>;
      markRemoved(): Promise<void>;
    };
  }
): Promise<ProviderDataDeletionResult> {
  const { tenantId, providerId, providerUserId } = input;
  let account: Awaited<ReturnType<typeof resolveAccountDataContextByIdentifier>>;
  try {
    // Active, suspended or locked: the accounts whose link this request removes.
    account = await resolveAccountDataContextByIdentifier(env, {
      tenantId,
      indexKind: 'external_subject',
      identifier: { issuer: providerId, subject: providerUserId },
      acceptLifecycle: 'restricted',
      freshRoute: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') {
      // No account's route names the subject. (An unlink whose directory removal succeeded but
      // whose last PII step has not yet run may still hold the raw subject in its operation row;
      // without the route its PII database cannot be found, and the saga's worker erases it when
      // it retries that step.)
      return { outcome: 'no_link' };
    }
    if (isInactiveAccountError(error)) return answerForRemovedAccount(env, input);
    throw error;
  }

  const identity = await findLinkedIdentity(
    env,
    tenantId,
    providerId,
    providerUserId,
    account.piiDb
  );
  if (!identity) return answerWithoutLink(account, input);
  if (identity.userId !== account.legacyUserId || identity.providerId !== providerId) {
    throw new ProviderDataDeletionError('provider_data_deletion_account_mismatch');
  }
  if (
    input.mayRemoveLink === false ||
    isLinkNewerThanRequest(identity.linkedAt, input.requestIssuedAt)
  ) {
    return { outcome: 'no_link' };
  }

  const provisioner = env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
  if (!provisioner)
    throw new ProviderDataDeletionError('external_idp_account_provisioner_unavailable');
  const { digest, operationId } = await linkedIdentityRemovalOperationId(
    tenantId,
    account.accountId,
    identity.id
  );

  const removal = await withLoginMethodRemovalLock(
    env,
    tenantId,
    account.legacyUserId,
    async (lease) => {
      // Read again under the lease: the link may have been removed, or made anew, meanwhile.
      const current = await findLinkedIdentity(
        env,
        tenantId,
        providerId,
        providerUserId,
        account.piiDb
      );
      if (current?.id !== identity.id) return 'changed' as const;
      if (await input.payloadGuard?.alreadyRemoved()) return 'changed' as const;
      // Checked under the lease, right before the removal: a hold keeps everything.
      if (await hasActiveAccountLegalHold(account.coreDb, tenantId, account.accountId)) {
        return null;
      }
      await lease.assertHeld();
      const removed = await provisioner.removeExternalIdpRoute({
        schemaVersion: 1,
        operationId,
        idempotencyKey: `auth-external-idp-route-remove:${digest}`,
        tenantId,
        accountId: account.accountId,
        userId: account.legacyUserId,
        linkedIdentityId: identity.id,
        providerId: identity.providerId,
        providerUserId: identity.providerUserId,
        removalLeaseOwner: lease.owner,
        restrictedAccountAllowed: true,
      });
      // Still under the lease: a copy of this request waiting for it now leaves any link alone.
      await input.payloadGuard?.markRemoved();
      // A hold placed since the check: the link is gone, but the administrator must know.
      const heldSince = await hasActiveAccountLegalHold(
        account.coreDb,
        tenantId,
        account.accountId
      );
      return { removed, heldSince };
    }
  );
  const base = {
    userId: account.legacyUserId,
    accountId: account.accountId,
    linkedIdentityId: identity.id,
  };
  if (!removal) return { outcome: 'retained', ...base };
  // Removed since the first read (by another copy of the request, or the person), or replaced by
  // a link made since: the link this request concerned is gone, and a newer one is left alone.
  if (removal === 'changed') return answerWithoutLink(account, input);
  const { removed, heldSince } = removal;
  if (
    removed.operationId !== operationId ||
    removed.accountId !== account.accountId ||
    (removed.status !== 201 && removed.status !== 202)
  ) {
    throw new ProviderDataDeletionError('external_idp_route_removal_response_invalid');
  }
  return {
    outcome: removed.status === 201 ? 'unlinked' : 'unlink_pending',
    ...base,
    unlinkOperationId: operationId,
    ...(heldSince ? { attention: 'hold_placed_during_unlink' as const } : {}),
  };
}

// =============================================================================
// Settings
// =============================================================================

/**
 * How long after `issued_at` a signed request is accepted: the tenant's setting (KV, then the
 * environment variable), else the default. When the settings cannot be read, the shortest
 * allowed (the safe side).
 */
export async function resolveSignedRequestMaxAgeSeconds(
  env: Env,
  tenantId: string
): Promise<number> {
  const meta = EXTERNAL_IDP_SETTINGS_META['external_idp.signed_request_max_age_seconds'];
  try {
    const values = await resolveEffectiveSettings(env, 'external-idp', { tenantId });
    const value = values['external_idp.signed_request_max_age_seconds'];
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= (meta.min ?? 0) &&
      value <= (meta.max ?? Number.MAX_SAFE_INTEGER)
      ? value
      : DEFAULT_SIGNED_REQUEST_MAX_AGE_SECONDS;
  } catch {
    return meta.min ?? DEFAULT_SIGNED_REQUEST_MAX_AGE_SECONDS;
  }
}

// =============================================================================
// Status records (the URL the provider shows the person)
// =============================================================================

export type DataDeletionRequestState = 'pending' | 'completed' | 'retained';

/** A confirmation code: 128 random bits, base64url. */
export const CONFIRMATION_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

interface DataDeletionRequestRow {
  tenant_id: string;
  confirmation_code: string;
  provider_id: string;
  state: DataDeletionRequestState;
  account_id: string | null;
  unlink_operation_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function generateConfirmationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

async function statusAdapter(env: Env, tenantId: string, partition: string) {
  return resolveAuthCorePersistenceAdapterFromEnv(env, partition, { tenantId });
}

/**
 * The state a request's status shows for an unlink outcome; null for one that is not recorded
 * (an inactive account: nothing was done, the request is refused for now).
 */
export function dataDeletionStateFor(
  outcome: ProviderDataDeletionOutcome
): DataDeletionRequestState | null {
  switch (outcome) {
    case 'account_inactive':
      return null;
    case 'unlink_pending':
      return 'pending';
    case 'retained':
      return 'retained';
    case 'unlinked':
    case 'no_link':
    case 'account_deleted':
      return 'completed';
    default: {
      // A new outcome must be mapped here: never recorded as done by default.
      const unmapped: never = outcome;
      throw new ProviderDataDeletionError(`data_deletion_outcome_unmapped:${String(unmapped)}`);
    }
  }
}

/** Record a data deletion request's status; returns its confirmation code. */
export async function createDataDeletionRequest(
  env: Env,
  input: {
    tenantId: string;
    providerId: string;
    result: ProviderDataDeletionResult;
    nowSeconds?: number;
  }
): Promise<{ confirmationCode: string; state: DataDeletionRequestState }> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const state = dataDeletionStateFor(input.result.outcome);
  if (!state) throw new ProviderDataDeletionError('data_deletion_request_not_recordable');
  // Only a pending request names its account and unlink (to look the outcome up later).
  const accountId = state === 'pending' ? (input.result.accountId ?? null) : null;
  const operationId = state === 'pending' ? (input.result.unlinkOperationId ?? null) : null;
  if (state === 'pending' && (!accountId || !operationId)) {
    throw new ProviderDataDeletionError('data_deletion_request_pending_reference_missing');
  }
  const confirmationCode = generateConfirmationCode();
  const adapter = await statusAdapter(env, input.tenantId, 'bridge-data-deletion:create');
  await adapter.execute(
    `INSERT INTO external_idp_data_deletion_requests (
       tenant_id, confirmation_code, provider_id, state, account_id, unlink_operation_id,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.tenantId,
      confirmationCode,
      input.providerId,
      state,
      accountId,
      operationId,
      now,
      now,
      state === 'completed' ? now : null,
    ]
  );
  return { confirmationCode, state };
}

/**
 * A data deletion request's state, by its confirmation code and provider. A pending one is looked
 * up again (its unlink's cleanup may have finished since) and, once done, recorded as completed
 * with its account and operation references cleared. Null when there is no such request.
 */
export async function readDataDeletionRequestState(
  env: Env,
  input: { tenantId: string; providerId: string; confirmationCode: string; nowSeconds?: number }
): Promise<DataDeletionRequestState | null> {
  if (!CONFIRMATION_CODE_PATTERN.test(input.confirmationCode)) return null;
  const adapter = await statusAdapter(env, input.tenantId, 'bridge-data-deletion:read');
  const row = await adapter.queryOne<DataDeletionRequestRow>(
    `SELECT tenant_id, confirmation_code, provider_id, state, account_id, unlink_operation_id,
            created_at, updated_at, completed_at
       FROM external_idp_data_deletion_requests
      WHERE tenant_id = ? AND confirmation_code = ?`,
    [input.tenantId, input.confirmationCode]
  );
  if (!row || row.provider_id !== input.providerId) return null;
  if (row.state !== 'pending' || !row.account_id || !row.unlink_operation_id) return row.state;

  const done = await isUnlinkFinished(env, input.tenantId, row.account_id, row.unlink_operation_id);
  if (!done) return 'pending';
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  await adapter.execute(
    `UPDATE external_idp_data_deletion_requests
        SET state = 'completed', account_id = NULL, unlink_operation_id = NULL,
            updated_at = ?, completed_at = ?
      WHERE tenant_id = ? AND confirmation_code = ? AND state = 'pending'`,
    [now, now, input.tenantId, input.confirmationCode]
  );
  return 'completed';
}

/**
 * Whether a pending unlink has finished, or the account is gone altogether (deleted, its route
 * removed with everything it held). A stopped (blocked) unlink, or one of an account being
 * deleted now, is still pending; a suspended or locked account's unlink is looked up as an
 * active one's.
 */
async function isUnlinkFinished(
  env: Env,
  tenantId: string,
  accountId: string,
  operationId: string
): Promise<boolean> {
  let account: Awaited<ReturnType<typeof resolveAccountDataContext>>;
  try {
    account = await resolveAccountDataContext(env, {
      tenantId,
      accountId,
      acceptLifecycle: 'restricted',
      freshRoute: true,
    });
  } catch (error) {
    // The account's own route is removed only by its deletion, which also erases what an open
    // unlink of it still held (raw values cleared, the operation blocked as account_deleted:
    // ar-management account-directory-removal-producer.ts).
    if (error instanceof Error && error.message === 'account_data_route_not_found') return true;
    if (!isInactiveAccountError(error)) throw error;
    // Being deleted since (still pending: a hold may stop that deletion), or deleted: done only
    // once the unlink operation no longer holds its raw values (the deletion erases them).
    try {
      const probe = await probeAccountForProviderDataDeletion(env, {
        tenantId,
        account: { accountId },
        remains: { unlinkOperationId: operationId },
      });
      return probe.lifecycleState === 'deleted' && !probe.providerDataRemains;
    } catch (again) {
      if (again instanceof Error && again.message === 'account_data_route_not_found') return true;
      if (isInactiveAccountError(again)) return false;
      throw again;
    }
  }
  const provisioner = env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
  if (!provisioner)
    throw new ProviderDataDeletionError('external_idp_account_provisioner_unavailable');
  try {
    const status = await provisioner.getExternalIdpRouteRemovalStatus({
      restrictedAccountAllowed: true,
      schemaVersion: 1,
      tenantId,
      accountId,
      userId: account.legacyUserId,
      operationId,
    });
    return status.operationId === operationId && status.status === 201;
  } catch (error) {
    // Blocked (for example by a legal hold placed since) or not yet visible: still pending.
    if (
      error instanceof Error &&
      /^external_idp_route_removal_status_(blocked|not_found)$/u.test(error.message)
    ) {
      return false;
    }
    throw error;
  }
}
