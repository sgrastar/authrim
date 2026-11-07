/**
 * What a PII-only deletion (`DELETE /api/admin/users/:id/pii`) erases besides the profile fields
 * the canonical writer marks deleted: the account stays and can be signed in to, so the sign-in
 * identifiers (its linked identities' provider and subject) stay too.
 *
 * - First (`findPiiOnlyErasureBlocker`): the deletion waits while an operation still needs the
 *   values: an identifier change or an external identifier's unlinking under way, a guest's
 *   registration under way (its proof holds the address), or an external identity provider's
 *   account creation pending (its encrypted plan is the linked identity's profile data). The
 *   check is not a fence: an operation started right after it keeps its values until it has
 *   finished. The handler checks again once it has erased, and answers 409 then (the deletion is
 *   run again once the operation has finished).
 * - The identifier change tables name the account by its user id (self-service, SCIM) or by its
 *   account id (`account:<user id>`): both are matched.
 * - Before the profile is changed (`redactEarlierWebhookEmailSnapshots`): the addresses earlier
 *   account webhook events kept for their deliveries, as JSON `null` (a redacted value, which a
 *   delivery still sends). A notice that an address was removed (`email_after_json` null) keeps
 *   the removed address until it expires as any snapshot does: so the deletion's own notice,
 *   written after this, still reaches the webhooks, also when the deletion is retried.
 * - After it (`eraseRetainedAccountPii`): every value the account keeps in
 *   `identity_sensitive_values` (the writer only moves the profile fields' lifecycle, and leaves
 *   the per-field PII custom attributes active), the linked
 *   identities' provider profile (address, name, raw attributes and claims, profile data) and
 *   their stored provider tokens (with which the profile could be fetched again; a sign-in
 *   through the provider gets new ones), the
 *   raw values of finished identifier changes, of identifier change challenges (an unused one
 *   can no longer be verified) and of finished or stopped external identifier unlinkings, the
 *   proofs of finished guest registrations, the screen response records and the core custom
 *   attributes.
 *
 * No erasure marker is written: unlike a full deletion, the person may enter a profile again
 * afterwards (or bring one from an identity provider).
 */
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

export type PiiOnlyErasureBlocker =
  | 'identifier_change_in_progress'
  | 'external_unlink_in_progress'
  | 'guest_upgrade_in_progress'
  | 'account_provisioning_pending';

/** The ids the identifier change tables may name the account by. */
function accountIds(userId: string): [string, string] {
  return [userId, `account:${userId}`];
}

export async function findPiiOnlyErasureBlocker(
  pii: DatabaseAdapter,
  input: { tenantId: string; userId: string }
): Promise<PiiOnlyErasureBlocker | null> {
  const change = await pii.queryOne<{ operation_id: string }>(
    `SELECT operation_id FROM identity_identifier_replacement_operations
      WHERE tenant_id = ? AND account_id IN (?, ?) AND state NOT IN ('completed', 'canceled')
      LIMIT 1`,
    [input.tenantId, ...accountIds(input.userId)],
    { consistencyClass: 'primary_required' }
  );
  if (change) return 'identifier_change_in_progress';
  const unlink = await pii.queryOne<{ operation_id: string }>(
    `SELECT operation_id FROM external_identifier_unlink_operations
      WHERE tenant_id = ? AND user_id = ? AND state IN ('pending', 'directory_pending')
      LIMIT 1`,
    [input.tenantId, input.userId],
    { consistencyClass: 'primary_required' }
  );
  if (unlink) return 'external_unlink_in_progress';
  const upgrade = await pii.queryOne<{ operation_id: string }>(
    `SELECT operation_id FROM guest_upgrade_operations
      WHERE tenant_id = ? AND user_id = ? AND state IN ('awaiting_proof', 'verified', 'committing')
      LIMIT 1`,
    [input.tenantId, input.userId],
    { consistencyClass: 'primary_required' }
  );
  if (upgrade) return 'guest_upgrade_in_progress';
  const pending = await pii.queryOne<{ id: string }>(
    `SELECT id FROM linked_identities
      WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'pending'
      LIMIT 1`,
    [input.tenantId, input.userId],
    { consistencyClass: 'primary_required' }
  );
  return pending ? 'account_provisioning_pending' : null;
}

export async function redactEarlierWebhookEmailSnapshots(
  pii: DatabaseAdapter,
  input: { tenantId: string; userId: string }
): Promise<void> {
  await pii.execute(
    `UPDATE account_webhook_snapshots SET email_before_json = 'null', email_after_json = 'null'
      WHERE tenant_id = ? AND user_id = ?
        AND email_after_json IS NOT NULL AND email_after_json <> 'null'`,
    [input.tenantId, input.userId]
  );
}

export async function eraseRetainedAccountPii(
  pii: DatabaseAdapter,
  core: DatabaseAdapter,
  input: { tenantId: string; userId: string },
  nowMs = Date.now()
): Promise<void> {
  const now = Math.floor(nowMs / 1000);
  const ids = accountIds(input.userId);
  const statements = [
    {
      // Every value the account keeps (as a full deletion erases them): the profile fields the
      // writer marked deleted, the per-field PII custom attributes it does not touch, and any
      // value kind added later. A value entered again afterwards is the person's own.
      sql: `UPDATE identity_sensitive_values
          SET value_json = NULL, lifecycle_state = 'deleted', updated_at = ?
        WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?
          AND (value_json IS NOT NULL OR lifecycle_state <> 'deleted')`,
      params: [nowMs, input.tenantId, input.userId],
    },
    {
      sql: `UPDATE linked_identities
          SET provider_email = NULL, provider_name = NULL, raw_attributes = NULL,
              raw_claims = NULL, profile_data = NULL,
              access_token_encrypted = NULL, refresh_token_encrypted = NULL,
              token_expires_at = NULL, updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'active'`,
      params: [nowMs, input.tenantId, input.userId],
    },
    {
      sql: `UPDATE identity_identifier_replacement_history
          SET old_value_json = NULL, new_value_json = NULL, raw_values_erased_at = ?
        WHERE raw_values_erased_at IS NULL AND operation_id IN (
          SELECT operation_id FROM identity_identifier_replacement_operations
           WHERE tenant_id = ? AND account_id IN (?, ?) AND state IN ('completed', 'canceled')
        )`,
      params: [now, input.tenantId, ...ids],
    },
    {
      // An unused challenge is used up with its value (its code is answered as invalid).
      sql: `UPDATE identity_identifier_replacement_challenges
          SET normalized_value_json = 'null', raw_value_erased_at = ?,
              attempt_count = CASE WHEN consumed_at IS NULL AND attempt_count < attempt_limit
                THEN attempt_limit ELSE attempt_count END,
              updated_at = ?
        WHERE tenant_id = ? AND account_id IN (?, ?) AND raw_value_erased_at IS NULL`,
      params: [now, now, input.tenantId, ...ids],
    },
    {
      // An unlinked external identifier, kept while its unlinking ran (a stopped one keeps it).
      sql: `UPDATE external_identifier_unlink_operations
          SET issuer_json = NULL, subject_json = NULL, raw_values_erased_at = ?, updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND state IN ('completed', 'blocked')
          AND raw_values_erased_at IS NULL`,
      params: [now, now, input.tenantId, input.userId],
    },
    {
      // A finished guest registration's proof (its address) and verifier.
      sql: `UPDATE guest_upgrade_operations
          SET proof_payload_json = NULL, reservation_publication_json = NULL,
              challenge_verifier = NULL, updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND state IN ('completed', 'canceled')
          AND (proof_payload_json IS NOT NULL OR reservation_publication_json IS NOT NULL
               OR challenge_verifier IS NOT NULL)`,
      params: [now, input.tenantId, input.userId],
    },
    {
      // What the person answered to login screens (their response records).
      sql: 'DELETE FROM screen_responses WHERE tenant_id = ? AND user_id = ?',
      params: [input.tenantId, input.userId],
    },
  ];
  const results = await pii.batch(statements);
  if (results.length !== statements.length || results.some((result) => !result.success)) {
    throw new Error('account_pii_only_erasure_batch_failed');
  }
  await core.execute('DELETE FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?', [
    input.tenantId,
    input.userId,
  ]);
}
