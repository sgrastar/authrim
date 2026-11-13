/**
 * A person's information release decision on a SAML service provider, kept in their account
 * database (`saml_sp_release_consents`), with the withdrawal generation it is valid under
 * (`saml_sp_release_consent_revocations`) and its history (`consent_history`, `client_id` = the
 * SP's entity ID, `metadata_json.protocol` = 'saml').
 *
 * SAML has no token to carry an approval after the response: an approval answers the request it
 * was given for (the assertion is built from it), and the record only decides whether the next
 * request asks again, and is what the person sees and withdraws. Every new decision moves the
 * record's revision on: a request resumed after the person decided uses the decision only while it
 * is still the current one (a later decision in another tab, or a withdrawal, wins).
 *
 * Item names are the release item keys (`samlReleaseItemKey`), never values.
 */
import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import type {
  InformationReleaseAsk,
  ReleaseApprovalBasis,
  ReleaseConsentRecord,
} from './information-release-consent';

export interface SamlSpReleaseConsentKey {
  tenantId: string;
  userId: string;
  spEntityId: string;
}

/** The current decision, as the next request reads it. */
export interface SamlSpReleaseConsentRecord extends ReleaseConsentRecord {
  /** The person refused the SP (no assertion): nothing of it is reused. */
  refused: boolean;
  /** Moves on with every decision; a resumed request uses only the one it was decided at. */
  revision: number;
}

/** A decision to record. */
export interface SamlSpReleaseDecision {
  presented: readonly string[];
  approved: readonly string[];
  declined: readonly string[];
  mode: InformationReleaseAsk;
  basis: ReleaseApprovalBasis;
  refused: boolean;
}

/** Thrown when a withdrawal (or another decision) moved on before this one could be recorded. */
export const SAML_SP_RELEASE_CONSENT_CHANGED = 'saml_sp_release_consent_changed';

export function isSamlSpReleaseConsentChanged(error: unknown): boolean {
  return error instanceof Error && error.message === SAML_SP_RELEASE_CONSENT_CHANGED;
}

const CURRENT_GENERATION = `COALESCE((
         SELECT generation FROM saml_sp_release_consent_revocations
          WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ?
       ), 0) = ?`;

function keyParams(key: SamlSpReleaseConsentKey): string[] {
  return [key.tenantId, key.userId, key.spEntityId];
}

function sortedJson(names: readonly string[]): string {
  return JSON.stringify([...new Set(names)].sort());
}

function readNames(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((name) => typeof name === 'string')
      ? [...new Set(parsed)].sort()
      : null;
  } catch {
    return null;
  }
}

const ASK_VALUES: readonly InformationReleaseAsk[] = ['once', 'every_time', 'when_items_change'];
const BASIS_VALUES: readonly ReleaseApprovalBasis[] = ['user', 'trust', 'not_asked'];

/** The withdrawal generation (0 until the first withdrawal), read from the primary. */
export async function findSamlSpReleaseConsentGeneration(
  account: DatabaseAdapter,
  key: SamlSpReleaseConsentKey
): Promise<number> {
  const row = await account.queryOne<{ generation: number | string }>(
    `SELECT generation FROM saml_sp_release_consent_revocations
      WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ?`,
    keyParams(key),
    { consistencyClass: 'primary_required' }
  );
  return row ? Number(row.generation) : 0;
}

interface RecordRow {
  presented_json: string;
  approved_json: string;
  declined_json: string;
  mode: string;
  basis: string;
  refused: number | string | boolean;
  decision_revision: number | string;
  consent_generation: number | string;
  decided_at: number | string;
}

function readRecord(row: RecordRow): SamlSpReleaseConsentRecord | null {
  const presented = readNames(row.presented_json);
  const approved = readNames(row.approved_json);
  const declined = readNames(row.declined_json);
  const revision = Number(row.decision_revision);
  const decidedAt = Number(row.decided_at);
  // A record that cannot be read answers nothing (the person is asked), never "approved".
  if (
    !presented ||
    !approved ||
    !declined ||
    !ASK_VALUES.includes(row.mode as InformationReleaseAsk) ||
    !BASIS_VALUES.includes(row.basis as ReleaseApprovalBasis) ||
    !Number.isSafeInteger(revision) ||
    !Number.isSafeInteger(decidedAt)
  ) {
    return null;
  }
  return {
    presented,
    approved,
    declined,
    mode: row.mode as InformationReleaseAsk,
    basis: row.basis as ReleaseApprovalBasis,
    decidedAt,
    refused: row.refused === true || Number(row.refused) === 1,
    revision,
  };
}

/**
 * The current decision, from the primary: none when it was made under another withdrawal
 * generation than `consentGeneration` (the current one).
 */
export async function findSamlSpReleaseConsent(
  account: DatabaseAdapter,
  input: SamlSpReleaseConsentKey & { consentGeneration: number }
): Promise<SamlSpReleaseConsentRecord | null> {
  const row = await account.queryOne<RecordRow>(
    `SELECT presented_json, approved_json, declined_json, mode, basis, refused,
            decision_revision, consent_generation, decided_at
       FROM saml_sp_release_consents
      WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ?`,
    keyParams(input),
    { consistencyClass: 'primary_required' }
  );
  if (!row || Number(row.consent_generation) !== input.consentGeneration) return null;
  return readRecord(row);
}

/**
 * Record a decision, only under the current withdrawal generation: the record and its history
 * entry are written together (all or nothing), and the history only when the record now carries
 * this write. Returns the decision's revision. Throws SAML_SP_RELEASE_CONSENT_CHANGED when the
 * generation moved on (a withdrawal), or another decision replaced this one at once.
 */
export async function recordSamlSpReleaseDecision(
  account: DatabaseAdapter,
  input: SamlSpReleaseConsentKey & {
    consentGeneration: number;
    decision: SamlSpReleaseDecision;
    /** Names this write, so its own row is told apart from a concurrent one. */
    operationId: string;
    now: number;
    history?: { userAgent?: string | null; ipAddressHash?: string | null };
  }
): Promise<{ revision: number }> {
  const { decision } = input;
  const values = [
    sortedJson(decision.presented),
    sortedJson(decision.approved),
    sortedJson(decision.declined),
    decision.mode,
    decision.basis,
    decision.refused ? 1 : 0,
  ];
  const statements: PreparedStatement[] = [
    {
      sql: `INSERT INTO saml_sp_release_consents (
              tenant_id, user_id, sp_entity_id, presented_json, approved_json, declined_json,
              mode, basis, refused, decision_revision, consent_generation, operation_id,
              decided_at, created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?
             WHERE ${CURRENT_GENERATION}
            ON CONFLICT (tenant_id, user_id, sp_entity_id) DO UPDATE SET
              presented_json = excluded.presented_json,
              approved_json = excluded.approved_json,
              declined_json = excluded.declined_json,
              mode = excluded.mode,
              basis = excluded.basis,
              refused = excluded.refused,
              decision_revision = saml_sp_release_consents.decision_revision + 1,
              consent_generation = excluded.consent_generation,
              operation_id = excluded.operation_id,
              decided_at = excluded.decided_at,
              updated_at = excluded.updated_at`,
      params: [
        ...keyParams(input),
        ...values,
        input.consentGeneration,
        input.operationId,
        input.now,
        input.now,
        input.now,
        ...keyParams(input),
        input.consentGeneration,
      ],
    },
    {
      sql: `INSERT INTO consent_history (
              id, tenant_id, user_id, client_id, action, scopes_before, scopes_after,
              ip_address_hash, user_agent, created_at, metadata_json
            )
            SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM saml_sp_release_consents
                WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ? AND operation_id = ?
             )`,
      params: [
        crypto.randomUUID(),
        input.tenantId,
        input.userId,
        input.spEntityId,
        decision.refused ? 'denied' : 'granted',
        input.history?.ipAddressHash ?? null,
        input.history?.userAgent ?? null,
        input.now,
        JSON.stringify({
          protocol: 'saml',
          release: {
            presented: [...new Set(decision.presented)].sort(),
            approved: [...new Set(decision.approved)].sort(),
            declined: [...new Set(decision.declined)].sort(),
            mode: decision.mode,
            basis: decision.basis,
            refused: decision.refused,
          },
        }),
        ...keyParams(input),
        input.operationId,
      ],
    },
  ];
  await account.batch(statements);
  const row = await account.queryOne<{
    decision_revision: number | string;
    operation_id: string | null;
    consent_generation: number | string;
  }>(
    `SELECT decision_revision, operation_id, consent_generation
       FROM saml_sp_release_consents
      WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ?`,
    keyParams(input),
    { consistencyClass: 'primary_required' }
  );
  if (
    !row ||
    row.operation_id !== input.operationId ||
    Number(row.consent_generation) !== input.consentGeneration
  ) {
    throw new Error(SAML_SP_RELEASE_CONSENT_CHANGED);
  }
  return { revision: Number(row.decision_revision) };
}

/**
 * Withdraw the person's decision on the SP: the generation moves on (a request in flight issues
 * nothing under the old one), the record is deleted, and the withdrawal is kept in the history,
 * in one batch. Returns whether there was a decision to withdraw.
 */
export async function withdrawSamlSpReleaseConsent(
  account: DatabaseAdapter,
  input: SamlSpReleaseConsentKey & { now: number; userAgent?: string | null }
): Promise<{ withdrawn: boolean }> {
  const existing = await account.queryOne<{ sp_entity_id: string }>(
    `SELECT sp_entity_id FROM saml_sp_release_consents
      WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ?`,
    keyParams(input),
    { consistencyClass: 'primary_required' }
  );
  await account.batch([
    {
      sql: `INSERT INTO saml_sp_release_consent_revocations
              (tenant_id, user_id, sp_entity_id, generation, revoked_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT (tenant_id, user_id, sp_entity_id) DO UPDATE SET
              generation = saml_sp_release_consent_revocations.generation + 1,
              revoked_at = CASE
                WHEN saml_sp_release_consent_revocations.revoked_at < excluded.revoked_at
                  THEN excluded.revoked_at
                ELSE saml_sp_release_consent_revocations.revoked_at
              END`,
      params: [...keyParams(input), input.now],
    },
    {
      sql: `DELETE FROM saml_sp_release_consents
             WHERE tenant_id = ? AND user_id = ? AND sp_entity_id = ?`,
      params: keyParams(input),
    },
    {
      sql: `INSERT INTO consent_history (
              id, tenant_id, user_id, client_id, action, scopes_before, scopes_after,
              ip_address_hash, user_agent, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, 'revoked', NULL, NULL, NULL, ?, ?, ?)`,
      params: [
        crypto.randomUUID(),
        input.tenantId,
        input.userId,
        input.spEntityId,
        input.userAgent ?? null,
        input.now,
        JSON.stringify({ protocol: 'saml' }),
      ],
    },
  ]);
  return { withdrawn: Boolean(existing) };
}

/** A person's decisions on SAML SPs, newest first (for the account page). */
export interface SamlSpReleaseConsentListRow {
  sp_entity_id: string;
  approved_json: string;
  declined_json: string;
  basis: string;
  refused: number | string | boolean;
  decided_at: number | string;
  created_at: number | string;
}

export async function listSamlSpReleaseConsents(
  account: DatabaseAdapter,
  input: { tenantId: string; userId: string }
): Promise<SamlSpReleaseConsentListRow[]> {
  return account.query<SamlSpReleaseConsentListRow>(
    // Only decisions under the current withdrawal generation: a write that raced a withdrawal
    // may leave an older one behind, which answers nothing and is not shown.
    `SELECT c.sp_entity_id, c.approved_json, c.declined_json, c.basis, c.refused, c.decided_at,
            c.created_at
       FROM saml_sp_release_consents c
      WHERE c.tenant_id = ? AND c.user_id = ?
        AND c.consent_generation = COALESCE((
          SELECT r.generation FROM saml_sp_release_consent_revocations r
           WHERE r.tenant_id = c.tenant_id AND r.user_id = c.user_id
             AND r.sp_entity_id = c.sp_entity_id
        ), 0)
      ORDER BY c.decided_at DESC`,
    [input.tenantId, input.userId]
  );
}

/** A decision on a SAML SP as the account page shows it, with the SP's name. */
export interface SamlSpReleaseConsentWithProvider {
  spEntityId: string;
  spName: string | null;
  decidedAt: number;
  /**
   * How a new sign-in to the SP is approved today without asking (its trust), whatever the record
   * says; null when the person's decision counts.
   */
  currentBasis: 'trust' | null;
  release: {
    basis: ReleaseApprovalBasis;
    approved: string[];
    declined: string[];
    refused: boolean;
  } | null;
}

/**
 * A person's decisions on SAML SPs with each SP's name. Decisions are kept with the person in
 * their account database, the SPs are tenant metadata: read from each and joined here. A record
 * that cannot be read is shown without its items (never as "nothing approved").
 */
export async function listSamlSpReleaseConsentsWithProviders(input: {
  accountCore: DatabaseAdapter;
  tenantMetadata: DatabaseAdapter;
  tenantId: string;
  userId: string;
}): Promise<SamlSpReleaseConsentWithProvider[]> {
  const rows = await listSamlSpReleaseConsents(input.accountCore, input);
  if (rows.length === 0) return [];
  const [providers, trustRows] = await Promise.all([
    input.tenantMetadata.query<{ name: string | null; config_json: string }>(
      `SELECT name, config_json FROM identity_providers
        WHERE tenant_id = ? AND provider_type = 'saml_sp'`,
      [input.tenantId]
    ),
    input.tenantMetadata.query<{ target_id: string }>(
      `SELECT target_id FROM client_trust_policies
        WHERE tenant_id = ? AND is_active = 1 AND target_type = 'saml_sp'
          AND (trusted = 1 OR skip_authorization_consent = 1)`,
      [input.tenantId]
    ),
  ]);
  const names = new Map<string, string>();
  for (const provider of providers) {
    try {
      const entityId = (JSON.parse(provider.config_json) as { entityId?: unknown }).entityId;
      if (typeof entityId === 'string' && provider.name) names.set(entityId, provider.name);
    } catch {
      // A provider whose configuration cannot be read has no name to show.
    }
  }
  const trusted = new Set(trustRows.map((row) => row.target_id));
  return rows.map((row) => {
    const approved = readNames(row.approved_json);
    const declined = readNames(row.declined_json);
    const basis = BASIS_VALUES.includes(row.basis as ReleaseApprovalBasis)
      ? (row.basis as ReleaseApprovalBasis)
      : null;
    return {
      spEntityId: row.sp_entity_id,
      spName: names.get(row.sp_entity_id) ?? null,
      decidedAt: Number(row.decided_at),
      currentBasis: trusted.has(row.sp_entity_id) ? 'trust' : null,
      release:
        approved && declined && basis
          ? {
              basis,
              approved,
              declined,
              refused: row.refused === true || Number(row.refused) === 1,
            }
          : null,
    };
  });
}
