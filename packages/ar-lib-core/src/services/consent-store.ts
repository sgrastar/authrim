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

function isUniqueConstraintError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (/unique constraint|duplicate key|duplicate entry|already exists/iu.test(message)) {
      return true;
    }
    current =
      typeof current === 'object' && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return false;
}

async function findOAuthClientConsent(
  adapter: DatabaseAdapter,
  input: UpsertOAuthClientConsentInput
): Promise<{
  id: string;
  created_at: number | string;
  consent_version: number | null;
} | null> {
  return adapter.queryOne<{
    id: string;
    created_at: number | string;
    consent_version: number | null;
  }>(
    `SELECT id, created_at, consent_version
       FROM oauth_client_consents
      WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [input.tenantId, input.userId, input.clientId]
  );
}

async function updateOAuthClientConsent(
  adapter: DatabaseAdapter,
  input: UpsertOAuthClientConsentInput,
  existing: {
    id: string;
    created_at: number | string;
    consent_version: number | null;
  }
): Promise<UpsertOAuthClientConsentResult> {
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
      WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [
      input.scope,
      input.selectedScopesJson ?? null,
      input.grantedAt,
      input.expiresAt ?? null,
      input.privacyPolicyVersion ?? null,
      input.tosVersion ?? null,
      nextConsentVersion,
      input.now,
      input.tenantId,
      input.userId,
      input.clientId,
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
  let existing = await findOAuthClientConsent(adapter, input);

  if (!existing) {
    try {
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
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      // Another request won the insert race. Re-read the row and continue through
      // the portable update path so callers do not need a database-specific upsert.
      existing = await findOAuthClientConsent(adapter, input);
      if (!existing) throw error;
    }
  }

  return updateOAuthClientConsent(adapter, input, existing);
}
