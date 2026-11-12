/**
 * Consent Statement Management Utility
 *
 * Core logic for consent to statements (documents):
 * - Statement/version/localization retrieval
 * - Requirements for the statements a Flow asks for (flow-consent-statements.ts)
 * - User consent satisfaction checking
 * - Consent decision processing with audit history
 * - Version activation with integrity checks
 *
 * @packageDocumentation
 */

import type { DatabaseAdapter } from '../db';
import type { Env } from '../types/env';
import { readSamlDrConsentIpSalt } from '../services/tenant-portability/saml-dr-runtime-settings';
import type {
  ConsentStatement,
  ConsentStatementVersion,
  ConsentStatementLocalization,
  ConsentScreenItem,
  ConsentEvidence,
  ResolvedConsentRequirement,
} from '../types/consent-statements';
import type { FlowConsentStatement } from '../services/flow-consent-statements';
import { listUserStatementConsentRecords } from '../services/statement-consent-records';
import type { StatementConsentStores } from '../services/statement-consent-stores';
import {
  readStatementConsentRecord,
  readStatementConsentDefinition,
  writeStatementConsentDecision,
  type StatementConsentWriteOptions,
} from '../services/statement-consent-writes';
import { enqueueStatementConsentProjection } from '../services/statement-consent-generations';

export interface ResolvedClientTrustPolicy {
  target_type: 'oidc_client' | 'saml_sp';
  target_id: string;
  first_party: boolean;
  trusted: boolean;
  skip_authorization_consent: boolean;
}

export interface ResolvedSignInConfirmationPolicy {
  mode: 'disabled' | 'first_time' | 'every_time';
  remember_duration_days: number;
  show_application_context: boolean;
  show_tenant_context: boolean;
}

export interface ConsentDecisionTarget {
  version_id: string;
  version: string;
  withdrawal_allowed?: boolean;
  content_hash?: string | null;
}

// =============================================================================
// Version Validation (D2)
// =============================================================================

const VERSION_REGEX = /^\d{8}$/;

/**
 * Validate YYYYMMDD version format and date validity
 */
export function validateVersionFormat(version: string): boolean {
  if (!VERSION_REGEX.test(version)) return false;
  const year = parseInt(version.substring(0, 4), 10);
  const month = parseInt(version.substring(4, 6), 10);
  const day = parseInt(version.substring(6, 8), 10);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day >= 1 && day <= daysInMonth;
}

// =============================================================================
// Statement/Version Retrieval
// =============================================================================

/**
 * Flag columns are INTEGER in D1 and BIGINT in PostgreSQL, where node-postgres returns BIGINT as
 * a string. A required statement read as "0" would silently stop being asked for, so every flag
 * read goes through here.
 */
const isOn = (value: unknown): boolean => value === true || Number(value) === 1;

/**
 * Get all active consent statements for a tenant
 */
export async function getActiveConsentStatements(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<ConsentStatement[]> {
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    slug: string;
    category: string;
    legal_basis: string;
    processing_purpose: string | null;
    display_order: number;
    is_active: number;
    record_retention_days: number | null;
    withdrawal_allowed: number | null;
    withdrawal_impact: string | null;
    reconsent_interval_days: number | null;
    required_consent_version: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, slug, category, legal_basis, processing_purpose,
            display_order, is_active, record_retention_days, withdrawal_allowed,
            withdrawal_impact, reconsent_interval_days, required_consent_version,
            created_at, updated_at
     FROM consent_statements
     WHERE tenant_id = ? AND is_active = 1
     ORDER BY display_order ASC, created_at ASC`,
    [tenantId]
  );

  return rows.map((r) => ({
    ...r,
    processing_purpose: r.processing_purpose ?? undefined,
    display_order: Number(r.display_order),
    is_active: isOn(r.is_active),
    record_retention_days:
      r.record_retention_days == null ? undefined : Number(r.record_retention_days),
    withdrawal_allowed: r.withdrawal_allowed == null ? true : isOn(r.withdrawal_allowed),
    withdrawal_impact: r.withdrawal_impact ?? undefined,
    required_consent_version: r.required_consent_version || null,
    reconsent_interval_days:
      r.reconsent_interval_days == null ? undefined : Number(r.reconsent_interval_days),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    category: r.category as ConsentStatement['category'],
    legal_basis: r.legal_basis as ConsentStatement['legal_basis'],
  }));
}

/**
 * Get the current (is_current=1) version for a statement
 */
async function getCurrentVersion(
  adapter: DatabaseAdapter,
  tenantId: string,
  statementId: string
): Promise<ConsentStatementVersion | null> {
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    statement_id: string;
    version: string;
    content_type: string;
    effective_at: number;
    effective_until: number | null;
    content_hash: string | null;
    is_current: number;
    status: string;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, statement_id, version, content_type, effective_at, effective_until,
            content_hash, is_current, status, created_at, updated_at
     FROM consent_statement_versions
     WHERE tenant_id = ? AND statement_id = ? AND is_current = 1`,
    [tenantId, statementId]
  );

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ...r,
    content_hash: r.content_hash ?? undefined,
    effective_at: Number(r.effective_at),
    effective_until: r.effective_until == null ? null : Number(r.effective_until),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    is_current: isOn(r.is_current),
    content_type: r.content_type as ConsentStatementVersion['content_type'],
    status: r.status as ConsentStatementVersion['status'],
  };
}

// =============================================================================
// Localization with Fallback (D8)
// =============================================================================

/**
 * Get localization for a version with fallback chain:
 * user language -> tenant default language -> English -> first available localization.
 */
export async function getLocalization(
  adapter: DatabaseAdapter,
  tenantId: string,
  versionId: string,
  userLanguage: string,
  tenantDefaultLanguage: string = 'en'
): Promise<ConsentStatementLocalization | null> {
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    version_id: string;
    language: string;
    title: string;
    description: string;
    processing_purpose: string | null;
    withdrawal_impact: string | null;
    document_url: string | null;
    inline_content: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, version_id, language, title, description,
            processing_purpose, withdrawal_impact, document_url, inline_content, created_at, updated_at
     FROM consent_statement_localizations
     WHERE tenant_id = ? AND version_id = ?`,
    [tenantId, versionId]
  );

  if (rows.length === 0) return null;

  const fallbackChain = [userLanguage, tenantDefaultLanguage, 'en']
    .map((lang) => lang?.trim())
    .filter((lang): lang is string => Boolean(lang));
  const seen = new Set<string>();

  for (const lang of fallbackChain) {
    if (seen.has(lang)) continue;
    seen.add(lang);
    const match = rows.find((r) => r.language === lang);
    if (match) {
      return {
        ...match,
        processing_purpose: match.processing_purpose ?? undefined,
        withdrawal_impact: match.withdrawal_impact ?? undefined,
        document_url: match.document_url ?? undefined,
        inline_content: match.inline_content ?? undefined,
        created_at: Number(match.created_at),
        updated_at: Number(match.updated_at),
      };
    }
  }

  // Last resort: return first available
  const first = rows[0];
  return {
    ...first,
    processing_purpose: first.processing_purpose ?? undefined,
    withdrawal_impact: first.withdrawal_impact ?? undefined,
    document_url: first.document_url ?? undefined,
    inline_content: first.inline_content ?? undefined,
    created_at: Number(first.created_at),
    updated_at: Number(first.updated_at),
  };
}

// =============================================================================
// Requirement Resolution
// =============================================================================

export async function resolveClientTrustPolicy(
  adapter: DatabaseAdapter,
  tenantId: string,
  targetType: 'oidc_client' | 'saml_sp',
  targetId: string
): Promise<ResolvedClientTrustPolicy | null> {
  try {
    const rows = await adapter.query<{
      target_type: string;
      target_id: string;
      first_party: number | string;
      trusted: number | string;
      skip_authorization_consent: number | string;
    }>(
      `SELECT target_type, target_id, first_party, trusted, skip_authorization_consent
         FROM client_trust_policies
        WHERE tenant_id = ?
          AND is_active = 1
          AND target_type = ?
          AND target_id = ?
        LIMIT 1`,
      [tenantId, targetType, targetId]
    );

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      target_type: row.target_type as ResolvedClientTrustPolicy['target_type'],
      target_id: row.target_id,
      first_party: row.first_party === 1 || row.first_party === '1',
      trusted: row.trusted === 1 || row.trusted === '1',
      skip_authorization_consent:
        row.skip_authorization_consent === 1 || row.skip_authorization_consent === '1',
    };
  } catch {
    return null;
  }
}

export async function resolveSignInConfirmationPolicy(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<ResolvedSignInConfirmationPolicy | null> {
  try {
    const rows = await adapter.query<{
      mode: string;
      remember_duration_days: number;
      show_application_context: number;
      show_tenant_context: number;
    }>(
      `SELECT mode, remember_duration_days, show_application_context, show_tenant_context
         FROM sign_in_confirmation_policies
        WHERE tenant_id = ? AND trigger_type = 'login' AND is_active = 1
        LIMIT 1`,
      [tenantId]
    );

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      mode: row.mode as ResolvedSignInConfirmationPolicy['mode'],
      remember_duration_days: row.remember_duration_days,
      show_application_context: row.show_application_context === 1,
      show_tenant_context: row.show_tenant_context === 1,
    };
  } catch {
    return null;
  }
}

/**
 * The requirements for statements a Flow asks for (`statements` of a consent step, or the
 * statements a sign-in Flow requires at single sign-on): each active statement with a current
 * version, in the order given. Agreement is required from the statement's
 * `required_consent_version` (the current version for a statement published before it was kept).
 * An inactive statement, or one with no current version, is not asked for.
 */
export async function resolveStatementRequirements(
  adapter: DatabaseAdapter,
  tenantId: string,
  statements: readonly FlowConsentStatement[]
): Promise<ResolvedConsentRequirement[]> {
  if (statements.length === 0) return [];
  const active = await getActiveConsentStatements(adapter, tenantId);
  const resolved: ResolvedConsentRequirement[] = [];
  for (const [order, entry] of statements.entries()) {
    const statement = active.find((candidate) => candidate.id === entry.statement_id);
    if (!statement) continue;
    const currentVersion = await getCurrentVersion(adapter, tenantId, statement.id);
    if (!currentVersion || currentVersion.status !== 'active') continue;
    resolved.push({
      statement_id: statement.id,
      statement,
      current_version: currentVersion,
      is_required: entry.required,
      min_version: statement.required_consent_version ?? currentVersion.version,
      reconsent_interval_days: statement.reconsent_interval_days,
      enforcement: 'block',
      show_deletion_link: false,
      checkbox_mode: entry.required ? 'required' : 'optional',
      checkbox_default_checked: false,
      display_order: order,
    });
  }
  return resolved;
}

// =============================================================================
// User Consent Satisfaction Check
// =============================================================================

/**
 * Check if a user satisfies all consent requirements.
 * Returns the list of unsatisfied requirement statement IDs.
 */
export async function checkUserConsentSatisfaction(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  requirements: ResolvedConsentRequirement[]
): Promise<{ satisfied: boolean; unsatisfied: string[] }> {
  if (requirements.length === 0) return { satisfied: true, unsatisfied: [] };

  const records = await listUserStatementConsentRecords(adapter, tenantId, userId);
  const unsatisfied: string[] = [];

  for (const req of requirements) {
    if (!req.is_required) continue;

    const record = records.find((r) => r.statement_id === req.statement_id);

    if (!record || record.status !== 'granted') {
      unsatisfied.push(req.statement_id);
      continue;
    }

    // Check expiration
    if (record.expires_at && record.expires_at < Date.now()) {
      unsatisfied.push(req.statement_id);
      continue;
    }

    // Check min_version (D2: YYYYMMDD string comparison)
    if (req.min_version && record.version < req.min_version) {
      unsatisfied.push(req.statement_id);
      continue;
    }

    if (
      record.consent_settings_snapshot_at === undefined &&
      req.reconsent_interval_days !== undefined &&
      req.reconsent_interval_days > 0 &&
      record.granted_at !== undefined
    ) {
      const intervalMs = req.reconsent_interval_days * 24 * 60 * 60 * 1000;
      if (record.granted_at + intervalMs < Date.now()) {
        unsatisfied.push(req.statement_id);
        continue;
      }
    }
  }

  return { satisfied: unsatisfied.length === 0, unsatisfied };
}

// =============================================================================
// Consent Screen Item Assembly
// =============================================================================

/**
 * The subject's consent records could not be read from the account database.
 *
 * A required statement cannot be treated as "not agreed yet" (the screen would ask again and
 * overwrite what was recorded) or as "nothing to ask" (a required agreement would be skipped), and
 * the definitions are never a substitute for the records. Callers answer with an error.
 */
export class StatementConsentAccountReadError extends Error {
  constructor(cause: unknown) {
    super('statement_consent_account_read_failed', { cause });
    this.name = 'StatementConsentAccountReadError';
  }
}

/**
 * Build consent items for the consent screen display.
 *
 * Definitions (statements, versions, localizations, requirements, overrides) are read from the
 * metadata database; the subject's profile claims and consent records from the account database.
 * The two are joined here, never in SQL.
 */
export async function getConsentItemsForScreen(
  stores: StatementConsentStores,
  tenantId: string,
  requirements: readonly ResolvedConsentRequirement[],
  userId: string,
  language: string,
  tenantDefaultLanguage: string = 'en'
): Promise<ConsentScreenItem[]> {
  if (requirements.length === 0) return [];

  // Get user's existing consent records
  const records = await listUserStatementConsentRecords(stores.account, tenantId, userId).catch(
    (error: unknown) => {
      throw new StatementConsentAccountReadError(error);
    }
  );

  const items: ConsentScreenItem[] = [];

  for (const req of requirements) {
    // Get localization
    const localization = await getLocalization(
      stores.metadata,
      tenantId,
      req.current_version.id,
      language,
      tenantDefaultLanguage
    );

    // Fallback title/description from slug if no localization
    const title = localization?.title ?? req.statement.slug;
    const description = localization?.description ?? '';

    // Find user's existing record
    const record = records.find((r) => r.statement_id === req.statement_id);
    const currentStatus = record?.status;
    const currentVersion = record?.version;

    // Determine if version upgrade is needed
    const needsVersionUpgrade =
      currentStatus === 'granted' &&
      currentVersion !== undefined &&
      req.min_version !== undefined &&
      currentVersion < req.min_version;

    items.push({
      statement_id: req.statement_id,
      slug: req.statement.slug,
      category: req.statement.category,
      legal_basis: req.statement.legal_basis,
      title,
      description,
      processing_purpose: localization?.processing_purpose,
      withdrawal_impact: localization?.withdrawal_impact,
      document_url: localization?.document_url,
      inline_content: localization?.inline_content,
      version: req.current_version.version,
      version_id: req.current_version.id,
      content_hash: req.current_version.content_hash ?? null,
      is_required: req.is_required,
      enforcement: req.enforcement,
      current_status: currentStatus,
      current_version: currentVersion,
      needs_version_upgrade: needsVersionUpgrade,
      show_deletion_link: req.show_deletion_link,
      deletion_url: req.deletion_url,
      checkbox_mode: req.checkbox_mode,
      checkbox_default_checked: req.checkbox_default_checked,
      binding_type: req.binding_type,
      binding_value: req.binding_value,
      evidence_profile: req.evidence_profile,
      language_fallback: req.language_fallback,
      withdrawal_allowed: req.statement.withdrawal_allowed,
      display_order: req.display_order,
    });
  }

  return items;
}

// =============================================================================
// Consent Decision Processing (D3, D9, D10)
// =============================================================================

/** Process each key through its account-local atomic transition. */
export async function processConsentItemDecisions(
  stores: StatementConsentStores,
  tenantId: string,
  userId: string,
  decisions: Record<string, 'granted' | 'denied'>,
  evidence: ConsentEvidence,
  ipHash?: string,
  targets: Record<string, ConsentDecisionTarget> = {},
  options: StatementConsentWriteOptions & {
    /**
     * The answers were given at this time (ms), earlier than now: a statement answered since is
     * left as it is. The record read here is the one the atomic write compares, so an answer
     * recorded after it is not overwritten either.
     */
    givenAtMs?: number;
  } = {}
): Promise<void> {
  for (const [statementId, decision] of Object.entries(decisions)) {
    const target = targets[statementId];
    const definition = await readStatementConsentDefinition(
      stores.metadata,
      tenantId,
      statementId,
      target?.version_id
    );
    if (!definition) {
      if (target) throw new Error('document_changed');
      continue;
    }
    if (
      target &&
      (target.version !== definition.version ||
        (Object.hasOwn(target, 'content_hash') && target.content_hash !== definition.content_hash))
    )
      throw new Error('document_changed');
    if (
      decision === 'granted' &&
      (definition.is_active !== 1 || definition.version_status !== 'active')
    )
      throw new Error('document_changed');
    const before = await readStatementConsentRecord(stores.account, tenantId, userId, statementId);
    if (options.givenAtMs !== undefined && before && before.updated_at > options.givenAtMs)
      continue;
    await writeStatementConsentDecision(
      stores,
      tenantId,
      userId,
      statementId,
      decision,
      definition,
      before,
      evidence,
      ipHash,
      options
    );
  }
}

// =============================================================================
// Version Activation (D5)
// =============================================================================

/**
 * Activate a version for a statement.
 * Runs within a transaction: deactivate old → activate new.
 * Validates at least one localization exists (D8).
 */
export async function activateVersion(
  adapter: DatabaseAdapter,
  tenantId: string,
  statementId: string,
  versionId: string,
  /**
   * `reconsent` (the default): people who agreed to an earlier version are asked again (agreement
   * is required from this version on). Otherwise they are not (a change that does not alter what
   * they agreed to); the first version published always becomes where agreement starts.
   */
  options: { reconsent?: boolean } = {}
): Promise<void> {
  const reconsent = options.reconsent !== false;
  // Validate: version exists and belongs to this statement
  const versionRows = await adapter.query<{
    id: string;
    status: string;
    updated_at: number | string;
  }>(
    `SELECT id, status, updated_at FROM consent_statement_versions
     WHERE id = ? AND statement_id = ? AND tenant_id = ?`,
    [versionId, statementId, tenantId]
  );
  if (versionRows.length === 0) {
    throw new Error('Version not found');
  }

  // Validate: at least one localization exists (D8)
  const locCount = await adapter.query<{ cnt: number | string }>(
    `SELECT COUNT(*) as cnt
       FROM consent_statement_localizations
      WHERE tenant_id = ? AND version_id = ?`,
    [tenantId, versionId]
  );
  const localizationCount = Number(locCount[0]?.cnt);
  if (!Number.isSafeInteger(localizationCount) || localizationCount < 1) {
    throw new Error('Cannot activate version without at least one localization');
  }

  // Without asking again, the version published must not be older than the one agreement is
  // required from: agreement to it would never satisfy the statement.
  if (!reconsent) {
    const bounds = await adapter.queryOne<{
      version: string;
      required_consent_version: string | null;
    }>(
      `SELECT v.version, d.required_consent_version
         FROM consent_statement_versions v
         JOIN consent_statements d ON d.tenant_id = v.tenant_id AND d.id = v.statement_id
        WHERE v.tenant_id = ? AND v.statement_id = ? AND v.id = ?`,
      [tenantId, statementId, versionId]
    );
    if (bounds?.required_consent_version && bounds.version < bounds.required_consent_version) {
      throw new Error('version_older_than_required_consent_version');
    }
  }

  // Compute content hash (D11)
  const contentHash = await computeContentHash(adapter, versionId, tenantId);

  const revision = Number(versionRows[0].updated_at);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    throw new Error('statement_consent_version_revision_invalid');
  const now = Math.max(Date.now(), revision + 1);
  const token = `activation:${crypto.randomUUID()}`;
  const reserved = `EXISTS (SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id=? AND v.statement_id=? AND v.id=? AND v.current_statement_guard=?)`;
  const proof = [tenantId, statementId, versionId, token];
  // Reserve the version row before touching the old current. Draft edits co-commit a monotone
  // updated_at revision, so a hash read before such an edit cannot activate afterwards. The
  // transient token is visible only inside this batch and also serializes PostgreSQL writers.
  const result = await adapter.batch([
    {
      // The statement row first: publishes of one statement's versions are serialized on it, so
      // what is judged below (its required version) is not moved by another publish meanwhile.
      sql: `UPDATE consent_statements SET updated_at=updated_at WHERE tenant_id=? AND id=?`,
      params: [tenantId, statementId],
    },
    {
      // Without asking again, only a version not older than the one agreement is required from
      // (judged in the same write, so a concurrent publish that moved it is not overtaken).
      sql: `UPDATE consent_statement_versions SET current_statement_guard=? WHERE tenant_id=? AND statement_id=? AND id=? AND updated_at=? AND status=?
        AND (?=1 OR NOT EXISTS (SELECT 1 FROM consent_statements d WHERE d.tenant_id=consent_statement_versions.tenant_id
          AND d.id=consent_statement_versions.statement_id
          AND d.required_consent_version IS NOT NULL AND d.required_consent_version > consent_statement_versions.version))`,
      params: [
        token,
        tenantId,
        statementId,
        versionId,
        revision,
        versionRows[0].status,
        reconsent ? 1 : 0,
      ],
    },
    {
      sql: `UPDATE consent_statement_versions SET is_current=0,current_statement_guard=NULL,status='archived',updated_at=?
      WHERE statement_id=? AND tenant_id=? AND is_current=1 AND id<>? AND ${reserved}`,
      params: [now, statementId, tenantId, versionId, ...proof],
    },
    {
      sql: `UPDATE consent_statements SET definition_generation=definition_generation+1,updated_at=?,
        required_consent_version=CASE WHEN ?=1 OR required_consent_version IS NULL
          THEN (SELECT v.version FROM consent_statement_versions v
                 WHERE v.tenant_id=? AND v.statement_id=? AND v.id=?)
          ELSE required_consent_version END
      WHERE tenant_id=? AND id=? AND ${reserved}`,
      params: [
        now,
        reconsent ? 1 : 0,
        tenantId,
        statementId,
        versionId,
        tenantId,
        statementId,
        ...proof,
      ],
    },
    enqueueStatementConsentProjection(tenantId, statementId, now, { versionId, token }),
    {
      sql: `UPDATE consent_statement_versions SET is_current=1,current_statement_guard=statement_id,status='active',content_hash=?,updated_at=?
      WHERE tenant_id=? AND statement_id=? AND id=? AND current_statement_guard=?`,
      params: [contentHash, now, ...proof],
    },
  ]);
  if (result.length !== 6 || result.some((entry) => !entry.success))
    throw new Error('statement_consent_activation_result_unknown');
  if (result[1].rowsAffected !== 1 || result[5].rowsAffected !== 1)
    throw new Error('document_changed');
}

// =============================================================================
// Content Hash (D11)
// =============================================================================

/**
 * Compute SHA-256 content hash from all localizations of a version.
 */
export async function computeContentHash(
  adapter: DatabaseAdapter,
  versionId: string,
  tenantId?: string
): Promise<string> {
  // Get version to determine content_type
  const versionWhere = tenantId ? 'id = ? AND tenant_id = ?' : 'id = ?';
  const versionParams = tenantId ? [versionId, tenantId] : [versionId];
  const versionRows = await adapter.query<{ content_type: string }>(
    `SELECT content_type FROM consent_statement_versions WHERE ${versionWhere}`,
    versionParams
  );
  if (versionRows.length === 0) throw new Error('Version not found for content hash');

  const contentType = versionRows[0].content_type;

  // Get all localizations ordered by language for deterministic hash
  const localizationWhere = tenantId ? 'tenant_id = ? AND version_id = ?' : 'version_id = ?';
  const localizationParams = tenantId ? [tenantId, versionId] : [versionId];
  const locs = await adapter.query<{
    language: string;
    processing_purpose: string | null;
    withdrawal_impact: string | null;
    document_url: string | null;
    inline_content: string | null;
  }>(
    `SELECT language, processing_purpose, withdrawal_impact, document_url, inline_content
     FROM consent_statement_localizations
     WHERE ${localizationWhere}
     ORDER BY language ASC`,
    localizationParams
  );

  // Build hash input
  let hashInput = '';
  for (const loc of locs) {
    hashInput += `${loc.language}:purpose:${loc.processing_purpose ?? ''}\n`;
    hashInput += `${loc.language}:withdrawal:${loc.withdrawal_impact ?? ''}\n`;
    if (contentType === 'url') {
      hashInput += `${loc.language}:${loc.document_url ?? ''}\n`;
    } else {
      hashInput += `${loc.language}:${loc.inline_content ?? ''}\n`;
    }
  }

  // SHA-256
  const encoder = new TextEncoder();
  const data = encoder.encode(hashInput);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// =============================================================================
// IP Hash (D7)
// =============================================================================

/**
 * Hash an IP address with a tenant-scoped salt.
 */
export async function hashIpAddress(
  ip: string,
  tenantId: string,
  kv: KVNamespace | null,
  env?: Pick<Env, 'ENABLE_SAML_DR_EXPORT' | 'KEY_MANAGER'>
): Promise<string> {
  let salt = '';
  if (env?.ENABLE_SAML_DR_EXPORT === 'true') {
    salt = await readSamlDrConsentIpSalt(env, tenantId);
  } else if (kv) {
    try {
      const storedSalt = await kv.get(`consent:ip_salt:${tenantId}`);
      if (storedSalt) {
        salt = storedSalt;
      } else {
        // Generate and store new salt
        salt = crypto.randomUUID();
        await kv.put(`consent:ip_salt:${tenantId}`, salt);
      }
    } catch {
      salt = tenantId; // Fallback
    }
  } else {
    salt = tenantId;
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(`${salt}:${ip}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
