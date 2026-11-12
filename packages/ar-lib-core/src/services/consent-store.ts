import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import type { InformationReleaseAsk, ReleaseApprovalBasis } from './information-release-consent';
import {
  automaticReleaseApproval,
  readInformationReleaseConsentSetting,
} from './information-release-consent';
import { resolveSignInConfirmationPolicy } from '../utils/consent-statements';

/** The information release decision written with the scope consent (claim names only). */
export interface OAuthClientReleaseDecision {
  presented: readonly string[];
  approved: readonly string[];
  declined: readonly string[];
  mode: InformationReleaseAsk;
  basis: ReleaseApprovalBasis;
}

/** The history entry written in the same atomic operation as the consent (`consent_history`). */
export interface OAuthClientConsentHistoryEntry {
  action: 'granted' | 'updated' | 'scopes_updated';
  scopesBefore?: string[] | null;
  scopesAfter: string[];
  ipAddressHash?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

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
  /**
   * The user's consent withdrawal generation for the client the consent is given under, read
   * beforehand. The consent is written only while it is still current (one atomic statement), so
   * an approval racing a withdrawal records nothing.
   */
  consentGeneration: number;
  /**
   * The information release decision, written in the same statement. Left out, the release
   * columns keep what they were (an update) or stay empty (a new consent).
   */
  release?: OAuthClientReleaseDecision;
  /**
   * The history of this decision, written in the same atomic operation: only when the consent
   * itself was written (a withdrawal racing it leaves neither).
   */
  history?: OAuthClientConsentHistoryEntry;
}

/** Thrown when a withdrawal moved the generation on before the consent could be recorded. */
export const OAUTH_CLIENT_CONSENT_GENERATION_CHANGED = 'oauth_client_consent_generation_changed';

export function isOAuthClientConsentGenerationChanged(error: unknown): boolean {
  return error instanceof Error && error.message === OAUTH_CLIENT_CONSENT_GENERATION_CHANGED;
}

/** The condition that the user's withdrawal generation for the client is still `?`. */
const CURRENT_GENERATION_CONDITION = `COALESCE((
         SELECT generation FROM oauth_client_consent_revocations
          WHERE tenant_id = ? AND user_id = ? AND client_id = ?
       ), 0) = ?`;

function currentGenerationParams(input: UpsertOAuthClientConsentInput): unknown[] {
  return [input.tenantId, input.userId, input.clientId, input.consentGeneration];
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

const RELEASE_UPDATE_COLUMNS = `,
            release_presented_json = ?,
            release_approved_json = ?,
            release_declined_json = ?,
            release_mode = ?,
            release_basis = ?,
            release_decided_at = ?`;

const NO_RELEASE_PARAMS = [null, null, null, null, null, null];

function sortedJson(names: readonly string[]): string {
  return JSON.stringify([...new Set(names)].sort());
}

function releaseParams(release: OAuthClientReleaseDecision, now: number): unknown[] {
  return [
    sortedJson(release.presented),
    sortedJson(release.approved),
    sortedJson(release.declined),
    release.mode,
    release.basis,
    now,
  ];
}

/**
 * Run the consent's statement, with its history entry when there is one. The entry is written in
 * the same batch (all or nothing), and only if the consent row now carries this write (its
 * consent_version and updated_at), so a write the generation condition refused leaves no history.
 */
async function executeWithHistory(
  adapter: DatabaseAdapter,
  sql: string,
  params: unknown[],
  input: UpsertOAuthClientConsentInput,
  consentVersion: number
): Promise<{ rowsAffected: number }> {
  if (!input.history) return adapter.execute(sql, params);
  const history = input.history;
  const statements: PreparedStatement[] = [
    { sql, params },
    {
      sql: `INSERT INTO consent_history (
              id, tenant_id, user_id, client_id, action, scopes_before, scopes_after,
              ip_address_hash, user_agent, created_at, metadata_json
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM oauth_client_consents
                WHERE tenant_id = ? AND user_id = ? AND client_id = ?
                  AND consent_version = ? AND updated_at = ? AND consent_generation = ?
             )`,
      params: [
        crypto.randomUUID(),
        input.tenantId,
        input.userId,
        input.clientId,
        history.action,
        history.scopesBefore ? JSON.stringify(history.scopesBefore) : null,
        JSON.stringify(history.scopesAfter),
        history.ipAddressHash ?? null,
        history.userAgent ?? null,
        input.now,
        JSON.stringify({
          ...(history.metadata ?? {}),
          ...(input.release
            ? {
                release: {
                  presented: [...input.release.presented].sort(),
                  approved: [...input.release.approved].sort(),
                  declined: [...input.release.declined].sort(),
                  mode: input.release.mode,
                  basis: input.release.basis,
                },
              }
            : {}),
        }),
        input.tenantId,
        input.userId,
        input.clientId,
        consentVersion,
        input.now,
        input.consentGeneration,
      ],
    },
  ];
  const [result] = await adapter.batch(statements);
  return { rowsAffected: result?.rowsAffected ?? 0 };
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
  const result = await executeWithHistory(
    adapter,
    `UPDATE oauth_client_consents
        SET scope = ?,
            selected_scopes = ?,
            granted_at = ?,
            expires_at = ?,
            privacy_policy_version = ?,
            tos_version = ?,
            consent_version = ?,
            consent_generation = ?,
            updated_at = ?${input.release ? RELEASE_UPDATE_COLUMNS : ''}
      WHERE tenant_id = ? AND user_id = ? AND client_id = ?
        AND ${CURRENT_GENERATION_CONDITION}`,
    [
      input.scope,
      input.selectedScopesJson ?? null,
      input.grantedAt,
      input.expiresAt ?? null,
      input.privacyPolicyVersion ?? null,
      input.tosVersion ?? null,
      nextConsentVersion,
      input.consentGeneration,
      input.now,
      ...(input.release ? releaseParams(input.release, input.now) : []),
      input.tenantId,
      input.userId,
      input.clientId,
      ...currentGenerationParams(input),
    ],
    input,
    nextConsentVersion
  );
  // No row: withdrawn meanwhile (the withdrawal deletes the consent and moves the generation on).
  if (result.rowsAffected === 0) throw new Error(OAUTH_CLIENT_CONSENT_GENERATION_CHANGED);

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
      const result = await executeWithHistory(
        adapter,
        `INSERT INTO oauth_client_consents (
           id, user_id, client_id, scope, selected_scopes, granted_at, expires_at,
           privacy_policy_version, tos_version, consent_version, created_at, updated_at, tenant_id,
           consent_generation, release_presented_json, release_approved_json,
           release_declined_json, release_mode, release_basis, release_decided_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${CURRENT_GENERATION_CONDITION}`,
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
          input.consentGeneration,
          ...(input.release ? releaseParams(input.release, input.now) : NO_RELEASE_PARAMS),
          ...currentGenerationParams(input),
        ],
        input,
        1
      );
      if (result.rowsAffected === 0) throw new Error(OAUTH_CLIENT_CONSENT_GENERATION_CHANGED);

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
  release_approved_json: string | null;
  release_declined_json: string | null;
  release_basis: string | null;
  release_decided_at: number | null;
  /**
   * How a new authorization of this client is approved today without asking (trusted, or a
   * setting that does not ask), whatever the record says; null when the person's decision counts.
   */
  release_current_basis: Exclude<ReleaseApprovalBasis, 'user'> | null;
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
    Omit<OAuthClientConsentListRow, 'client_name' | 'logo_uri' | 'release_current_basis'>
  >(
    `SELECT id, client_id, scope, selected_scopes, granted_at, expires_at,
            privacy_policy_version, tos_version, consent_version,
            release_approved_json, release_declined_json, release_basis, release_decided_at
       FROM oauth_client_consents
      WHERE tenant_id = ? AND user_id = ?
      ORDER BY granted_at DESC`,
    [input.tenantId, input.userId]
  );
  const clientIds = [...new Set(consents.map((row) => row.client_id))];
  const clients = new Map<
    string,
    { client_name: string | null; logo_uri: string | null; information_release_consent: unknown }
  >();
  const trusted = new Set<string>();
  for (let offset = 0; offset < clientIds.length; offset += CLIENT_LOOKUP_CHUNK_SIZE) {
    const chunk = clientIds.slice(offset, offset + CLIENT_LOOKUP_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const [rows, trustRows] = await Promise.all([
      input.tenantMetadata.query<{
        client_id: string;
        client_name: string | null;
        logo_uri: string | null;
        information_release_consent: unknown;
      }>(
        `SELECT client_id, client_name, logo_uri, information_release_consent
           FROM oauth_clients
          WHERE tenant_id = ? AND client_id IN (${placeholders})`,
        [input.tenantId, ...chunk]
      ),
      // The same trust /authorize applies (an active policy that skips the consent screen).
      input.tenantMetadata.query<{ target_id: string }>(
        `SELECT target_id
           FROM client_trust_policies
          WHERE tenant_id = ? AND is_active = 1 AND target_type = 'oidc_client'
            AND (trusted = 1 OR skip_authorization_consent = 1)
            AND target_id IN (${placeholders})`,
        [input.tenantId, ...chunk]
      ),
    ]);
    for (const row of rows) clients.set(row.client_id, row);
    for (const row of trustRows) trusted.add(row.target_id);
  }
  // A sign-in confirmation asked every time puts every client through the consent screen.
  const confirmEveryTime =
    clientIds.length > 0 &&
    (await resolveSignInConfirmationPolicy(input.tenantMetadata, input.tenantId))?.mode ===
      'every_time';
  return consents.map((row) => {
    const client = clients.get(row.client_id);
    const automatic = client
      ? automaticReleaseApproval(
          readInformationReleaseConsentSetting(client.information_release_consent),
          trusted.has(row.client_id) && !confirmEveryTime
        )
      : null;
    return {
      ...row,
      release_current_basis: automatic?.basis ?? null,
      client_name: client?.client_name ?? null,
      logo_uri: client?.logo_uri ?? null,
    };
  });
}
