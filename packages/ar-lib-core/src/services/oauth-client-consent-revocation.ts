import { ensureDatabaseAdapter, type DatabaseSource, type PreparedStatement } from '../db';

/**
 * A user's withdrawals of a client's consent, kept in the user's account databases with its
 * consents (oauth_client_consent_revocations).
 *
 * Every withdrawal increments the generation. What a consent authorizes records the generation it
 * was granted under (an authorization code, a device or CIBA approval, a refresh-token family) and
 * is refused once the generation has moved on: the family index is written in the background and
 * may miss a family, and a grant may be in flight while the consent is withdrawn, so revoking the
 * indexed families alone cannot end every token of the withdrawn consent.
 *
 * The withdrawal time refuses what was issued before a withdrawal without recording a generation
 * (issued before generations were recorded, a device or CIBA request, a Native SSO device secret),
 * and a consent a cache still holds from before it.
 */
export interface OAuthClientConsentRevocationKey {
  tenantId: string;
  userId: string;
  clientId: string;
}

export interface OAuthClientConsentRevocationState {
  /** 0 until the first withdrawal. */
  generation: number;
  /** When the user last withdrew the consent (ms), or null when it never did. */
  revokedAt: number | null;
}

function getAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'oauth-client-consent-revocation');
}

/**
 * The upsert recording a withdrawal: the generation moves on, and the withdrawal time only ever
 * moves later.
 */
export function oauthClientConsentRevocationStatement(
  input: OAuthClientConsentRevocationKey & { revokedAt: number }
): PreparedStatement {
  return {
    sql: `INSERT INTO oauth_client_consent_revocations
            (tenant_id, user_id, client_id, generation, revoked_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (tenant_id, user_id, client_id) DO UPDATE SET
            generation = oauth_client_consent_revocations.generation + 1,
            revoked_at = CASE
              WHEN oauth_client_consent_revocations.revoked_at < excluded.revoked_at
                THEN excluded.revoked_at
              ELSE oauth_client_consent_revocations.revoked_at
            END`,
    params: [input.tenantId, input.userId, input.clientId, input.revokedAt],
  };
}

export async function recordOAuthClientConsentRevocation(
  db: DatabaseSource,
  input: OAuthClientConsentRevocationKey & { revokedAt: number }
): Promise<void> {
  const statement = oauthClientConsentRevocationStatement(input);
  await getAdapter(db).execute(statement.sql, statement.params);
}

/** The current withdrawal state (one keyed read); a user that never withdrew is at generation 0. */
export async function findOAuthClientConsentRevocation(
  db: DatabaseSource,
  input: OAuthClientConsentRevocationKey
): Promise<OAuthClientConsentRevocationState> {
  const row = await getAdapter(db).queryOne<{
    generation: number | string;
    revoked_at: number | string;
  }>(
    `SELECT generation, revoked_at FROM oauth_client_consent_revocations
     WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [input.tenantId, input.userId, input.clientId]
  );
  return row
    ? { generation: Number(row.generation), revokedAt: Number(row.revoked_at) }
    : { generation: 0, revokedAt: null };
}

/**
 * Whether something issued at `issuedAt` (ms) predates the last withdrawal. One without a recorded
 * time counts as issued before any withdrawal.
 */
export function predatesOAuthClientConsentRevocation(
  issuedAt: number | null | undefined,
  revokedAt: number | null
): boolean {
  if (revokedAt === null) return false;
  return typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || issuedAt <= revokedAt;
}

/**
 * Whether a grant was withdrawn: it recorded a generation the withdrawals have moved past, or, one
 * that recorded none, was issued at `issuedAt` before the last withdrawal.
 */
export function isOAuthClientConsentGrantWithdrawn(
  state: OAuthClientConsentRevocationState,
  grant: { generation?: number | null; issuedAt?: number | null }
): boolean {
  if (typeof grant.generation === 'number') return grant.generation !== state.generation;
  return predatesOAuthClientConsentRevocation(grant.issuedAt, state.revokedAt);
}
