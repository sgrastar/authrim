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
 * 3. The consent is deleted with its history row, and the generation moved on again in the same
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
    {
      sql: 'DELETE FROM oauth_client_consents WHERE tenant_id = ? AND user_id = ? AND client_id = ?',
      params: [input.tenantId, input.userId, input.clientId],
    },
    {
      sql: `INSERT INTO consent_history (id, tenant_id, user_id, client_id, action, scopes_before, scopes_after, created_at)
            VALUES (?, ?, ?, ?, 'revoked', ?, NULL, ?)`,
      params: [
        crypto.randomUUID(),
        input.tenantId,
        input.userId,
        input.clientId,
        JSON.stringify(input.previousScopes),
        revokedAt,
      ],
    },
    oauthClientConsentRevocationStatement({ ...key, revokedAt }),
  ]);

  return { revokedAt, refreshTokenFamilies: familyCount };
}
