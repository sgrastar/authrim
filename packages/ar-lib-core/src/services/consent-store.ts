import type { DatabaseAdapter } from '../db/adapter';

export interface UpsertOAuthClientConsentInput {
  consentId: string;
  userId: string;
  clientId: string;
  tenantId: string;
  scope: string;
  selectedScopesJson?: string | null;
  grantedAt: number;
  expiresAt?: number | null;
  privacyPolicyVersion?: string | null;
  tosVersion?: string | null;
  now: number;
}

export interface UpsertOAuthClientConsentResult {
  id: string;
  consentVersion: number;
  createdAt: number | string;
  updatedAt: number;
  inserted: boolean;
}

/**
 * Portable upsert for oauth_client_consents.
 *
 * Row-replacement upsert idioms change the row identity and do not map
 * cleanly to PostgreSQL/MySQL. We preserve the existing row and bump the
 * logical consent_version on update.
 */
export async function upsertOAuthClientConsent(
  adapter: DatabaseAdapter,
  input: UpsertOAuthClientConsentInput
): Promise<UpsertOAuthClientConsentResult> {
  const existing = await adapter.queryOne<{
    id: string;
    created_at: number | string;
    consent_version: number | null;
  }>(
    `SELECT id, created_at, consent_version
       FROM oauth_client_consents
      WHERE user_id = ? AND client_id = ? AND tenant_id = ?`,
    [input.userId, input.clientId, input.tenantId]
  );

  if (!existing) {
    await adapter.execute(
      `INSERT INTO oauth_client_consents (
         id, user_id, client_id, scope, selected_scopes, granted_at, expires_at,
         privacy_policy_version, tos_version, consent_version, created_at, updated_at, tenant_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.consentId,
        input.userId,
        input.clientId,
        input.scope,
        input.selectedScopesJson ?? null,
        input.grantedAt,
        input.expiresAt ?? null,
        input.privacyPolicyVersion ?? null,
        input.tosVersion ?? null,
        1,
        input.now,
        input.now,
        input.tenantId,
      ]
    );

    return {
      id: input.consentId,
      consentVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
      inserted: true,
    };
  }

  const nextConsentVersion = (existing.consent_version ?? 0) + 1;
  await adapter.execute(
    `UPDATE oauth_client_consents
        SET scope = ?,
            selected_scopes = ?,
            granted_at = ?,
            expires_at = ?,
            privacy_policy_version = ?,
            tos_version = ?,
            consent_version = ?,
            updated_at = ?
      WHERE user_id = ? AND client_id = ? AND tenant_id = ?`,
    [
      input.scope,
      input.selectedScopesJson ?? null,
      input.grantedAt,
      input.expiresAt ?? null,
      input.privacyPolicyVersion ?? null,
      input.tosVersion ?? null,
      nextConsentVersion,
      input.now,
      input.userId,
      input.clientId,
      input.tenantId,
    ]
  );

  return {
    id: existing.id,
    consentVersion: nextConsentVersion,
    createdAt: existing.created_at,
    updatedAt: input.now,
    inserted: false,
  };
}
