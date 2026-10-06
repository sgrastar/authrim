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

export interface OAuthClientConsentListRow {
  id: string;
  client_id: string;
  scope: string;
  selected_scopes: string | null;
  granted_at: number;
  expires_at: number | null;
  privacy_policy_version: string | null;
  tos_version: string | null;
  consent_version: number | null;
  client_name: string | null;
  logo_uri: string | null;
}

// D1 accepts at most 100 bound parameters per statement; one is the tenant ID.
const CLIENT_LOOKUP_CHUNK_SIZE = 90;

/**
 * List a user's OAuth client consents, newest first, with each client's display name and logo.
 *
 * Consents are stored with the user in its account database, while client records are tenant
 * metadata, so the two are read from their own databases and joined here.
 */
export async function listOAuthClientConsentsWithClients(input: {
  accountCore: DatabaseAdapter;
  tenantMetadata: DatabaseAdapter;
  tenantId: string;
  userId: string;
}): Promise<OAuthClientConsentListRow[]> {
  const consents = await input.accountCore.query<
    Omit<OAuthClientConsentListRow, 'client_name' | 'logo_uri'>
  >(
    `SELECT id, client_id, scope, selected_scopes, granted_at, expires_at,
            privacy_policy_version, tos_version, consent_version
       FROM oauth_client_consents
      WHERE tenant_id = ? AND user_id = ?
      ORDER BY granted_at DESC`,
    [input.tenantId, input.userId]
  );
  const clientIds = [...new Set(consents.map((row) => row.client_id))];
  const clients = new Map<string, { client_name: string | null; logo_uri: string | null }>();
  for (let offset = 0; offset < clientIds.length; offset += CLIENT_LOOKUP_CHUNK_SIZE) {
    const chunk = clientIds.slice(offset, offset + CLIENT_LOOKUP_CHUNK_SIZE);
    const rows = await input.tenantMetadata.query<{
      client_id: string;
      client_name: string | null;
      logo_uri: string | null;
    }>(
      `SELECT client_id, client_name, logo_uri
         FROM oauth_clients
        WHERE tenant_id = ? AND client_id IN (${chunk.map(() => '?').join(', ')})`,
      [input.tenantId, ...chunk]
    );
    for (const row of rows) {
      clients.set(row.client_id, { client_name: row.client_name, logo_uri: row.logo_uri });
    }
  }
  return consents.map((row) => ({
    ...row,
    client_name: clients.get(row.client_id)?.client_name ?? null,
    logo_uri: clients.get(row.client_id)?.logo_uri ?? null,
  }));
}
