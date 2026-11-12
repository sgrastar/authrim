import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  oauthClientConsentRevocationStatement,
  recordOAuthClientConsentRevocation,
  revokeUserRefreshTokenFamilies,
} from '@authrim/ar-lib-core';

/**
 * Withdraw a user's consent for a client, ending the tokens issued under it. `core` is the user's
 * account database, which holds its consents, their history, the refresh-token family index and
 * the withdrawal state (oauth_client_consent_revocations).
 *
 * 1. The withdrawal is recorded first, moving the consent generation on: from then on ar-token
 *    refuses the codes, approvals and refresh-token families granted under an earlier generation,
 *    so a family the index never recorded or a grant in flight cannot outlive the withdrawal.
 * 2. The indexed families are revoked in their rotators, so they end without a refresh attempt.
 * 3. The consent is deleted with its history row (keeping the release decision it held), and the generation moved on again in the same
 *    batch: a grant read the generation, then found the consent still there, only before this.
 *
 * Any failure throws with the consent kept, so a retry can complete the withdrawal.
 */
export async function withdrawOAuthClientConsent(
  env: Env,
  core: DatabaseAdapter,
  input: {
    tenantId: string;
    userId: string;
    clientId: string;
    previousScopes: string[];
  }
): Promise<{ revokedAt: number; refreshTokenFamilies: number }> {
  const key = { tenantId: input.tenantId, userId: input.userId, clientId: input.clientId };
  await recordOAuthClientConsentRevocation(core, { ...key, revokedAt: Date.now() });

  const { familyCount } = await revokeUserRefreshTokenFamilies(env, core, {
    ...key,
    reason: 'consent_revoked',
  });

  // Also the time a cached consent must postdate: a cache may still hold the one deleted here.
  const revokedAt = Date.now();
  await core.batch([
    // Lock the consent first, so the decision read for the history below is the one deleted (an
    // approval racing the withdrawal waits on the row, then finds it gone).
    {
      sql: `UPDATE oauth_client_consents SET updated_at = updated_at
             WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
      params: [input.tenantId, input.userId, input.clientId],
    },
    // The history keeps what the person had approved and declined for the information released
    // (claim names only), read from the consent in the same batch, before it is deleted.
    {
      sql: `INSERT INTO consent_history (id, tenant_id, user_id, client_id, action, scopes_before, scopes_after, created_at, metadata_json)
            VALUES (?, ?, ?, ?, 'revoked', ?, NULL, ?, (
              SELECT '{"release":{"approved":' || COALESCE(release_approved_json, '[]')
                     || ',"declined":' || COALESCE(release_declined_json, '[]') || '}}'
                FROM oauth_client_consents
               WHERE tenant_id = ? AND user_id = ? AND client_id = ?
                 AND release_decided_at IS NOT NULL
            ))`,
      params: [
        crypto.randomUUID(),
        input.tenantId,
        input.userId,
        input.clientId,
        JSON.stringify(input.previousScopes),
        revokedAt,
        input.tenantId,
        input.userId,
        input.clientId,
      ],
    },
    {
      sql: 'DELETE FROM oauth_client_consents WHERE tenant_id = ? AND user_id = ? AND client_id = ?',
      params: [input.tenantId, input.userId, input.clientId],
    },
    oauthClientConsentRevocationStatement({ ...key, revokedAt }),
  ]);

  return { revokedAt, refreshTokenFamilies: familyCount };
}
