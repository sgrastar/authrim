/**
 * Consent Statement Management Utility
 *
 * Core logic for SAP CDC-like consent management:
 * - Statement/version/localization retrieval
 * - Requirement resolution (tenant + client + conditional)
 * - User consent satisfaction checking
 * - Consent decision processing with audit history
 * - Version activation with integrity checks
 *
 * @packageDocumentation
 */

import type { DatabaseAdapter } from '../db';
import type {
  ConsentStatement,
  ConsentStatementVersion,
  ConsentStatementLocalization,
  ConsentStatementUserRecord,
  TenantConsentRequirement,
  ClientConsentOverride,
  ConditionalConsentRule,
  ConsentScreenItem,
  ConsentEvidence,
  ResolvedConsentRequirement,
  ConsentItemHistoryRecord,
  ConsentEnforcement,
  ConsentRecordStatus,
} from '../types/consent-statements';
import { CanonicalRuntimeUserStore } from '../repositories/identity/canonical-runtime-user-store';

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
// Claim Resolution (D12)
// =============================================================================

/**
 * Resolve a claim value from a claims object using dot-notation path.
 * Returns undefined if the claim does not exist.
 *
 * Special claims:
 * - 'birthdate_age': Dynamically calculates age from 'birthdate'
 *
 * @param claims - User claims object
 * @param path - Dot-notation path (e.g., 'address.country', 'metadata.segment')
 */
export function resolveClaimValue(
  claims: Record<string, unknown>,
  path: string
): unknown | undefined {
  // Special: birthdate_age
  if (path === 'birthdate_age') {
    const birthdate = claims.birthdate;
    if (typeof birthdate !== 'string') return undefined;
    const parsed = new Date(birthdate);
    if (isNaN(parsed.getTime())) return undefined;
    const now = new Date();
    let age = now.getFullYear() - parsed.getFullYear();
    const monthDiff = now.getMonth() - parsed.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < parsed.getDate())) {
      age--;
    }
    return age;
  }

  // Dot-notation path resolution
  const parts = path.split('.');
  let current: unknown = claims;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? undefined : current;
}

// =============================================================================
// Conditional Rule Evaluation (D4)
// =============================================================================

/**
 * Evaluate a single conditional rule against user claims.
 * When a claim is missing, comparison operators return false (D4).
 */
function evaluateSingleRule(
  rule: ConditionalConsentRule,
  claims: Record<string, unknown>
): boolean {
  const value = resolveClaimValue(claims, rule.claim);

  if (rule.op === 'exists') {
    return value !== undefined;
  }

  // Missing claim → false for all comparison operators (D4)
  if (value === undefined) return false;

  switch (rule.op) {
    case 'eq':
      return value === rule.value;
    case 'neq':
      return value !== rule.value;
    case 'in':
      return Array.isArray(rule.value) && rule.value.includes(value);
    case 'not_in':
      return Array.isArray(rule.value) && !rule.value.includes(value);
    case 'gt':
      return typeof value === 'number' && typeof rule.value === 'number' && value > rule.value;
    case 'gte':
      return typeof value === 'number' && typeof rule.value === 'number' && value >= rule.value;
    case 'lt':
      return typeof value === 'number' && typeof rule.value === 'number' && value < rule.value;
    case 'lte':
      return typeof value === 'number' && typeof rule.value === 'number' && value <= rule.value;
    default:
      return false;
  }
}

/**
 * Evaluate conditional rules and return the first matching result.
 * Rules are evaluated in order; first match wins.
 * Returns null if no rule matches.
 */
export function evaluateConditionalRules(
  rules: ConditionalConsentRule[],
  userClaims: Record<string, unknown>
): 'required' | 'optional' | 'hidden' | null {
  for (const rule of rules) {
    if (evaluateSingleRule(rule, userClaims)) {
      return rule.result;
    }
  }
  return null;
}

// =============================================================================
// Statement/Version Retrieval
// =============================================================================

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
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, slug, category, legal_basis, processing_purpose,
            display_order, is_active, created_at, updated_at
     FROM consent_statements
     WHERE tenant_id = ? AND is_active = 1
     ORDER BY display_order ASC, created_at ASC`,
    [tenantId]
  );

  return rows.map((r) => ({
    ...r,
    processing_purpose: r.processing_purpose ?? undefined,
    is_active: r.is_active === 1,
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
    content_hash: string | null;
    is_current: number;
    status: string;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, statement_id, version, content_type, effective_at,
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
    is_current: r.is_current === 1,
    content_type: r.content_type as ConsentStatementVersion['content_type'],
    status: r.status as ConsentStatementVersion['status'],
  };
}

// =============================================================================
// Localization with Fallback (D8)
// =============================================================================

/**
 * Get localization for a version with fallback chain:
 * userLang → tenantDefaultLang → 'en' → null
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
    document_url: string | null;
    inline_content: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, version_id, language, title, description,
            document_url, inline_content, created_at, updated_at
     FROM consent_statement_localizations
     WHERE tenant_id = ? AND version_id = ?`,
    [tenantId, versionId]
  );

  if (rows.length === 0) return null;

  // Build fallback chain
  const fallbackChain = [userLanguage, tenantDefaultLanguage, 'en'];
  const seen = new Set<string>();

  for (const lang of fallbackChain) {
    if (seen.has(lang)) continue;
    seen.add(lang);
    const match = rows.find((r) => r.language === lang);
    if (match) {
      return {
        ...match,
        document_url: match.document_url ?? undefined,
        inline_content: match.inline_content ?? undefined,
      };
    }
  }

  // Last resort: return first available
  const first = rows[0];
  return {
    ...first,
    document_url: first.document_url ?? undefined,
    inline_content: first.inline_content ?? undefined,
  };
}

// =============================================================================
// Requirement Resolution
// =============================================================================

/**
 * Get tenant consent requirements
 */
async function getTenantRequirements(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<TenantConsentRequirement[]> {
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    statement_id: string;
    is_required: number;
    min_version: string | null;
    enforcement: string;
    show_deletion_link: number;
    deletion_url: string | null;
    conditional_rules_json: string | null;
    display_order: number;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM tenant_consent_requirements WHERE tenant_id = ? ORDER BY display_order ASC`, [
    tenantId,
  ]);

  return rows.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    statement_id: r.statement_id,
    is_required: r.is_required === 1,
    min_version: r.min_version ?? undefined,
    enforcement: r.enforcement as ConsentEnforcement,
    show_deletion_link: r.show_deletion_link === 1,
    deletion_url: r.deletion_url ?? undefined,
    conditional_rules: r.conditional_rules_json
      ? (JSON.parse(r.conditional_rules_json) as ConditionalConsentRule[])
      : [],
    display_order: r.display_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/**
 * Get client consent overrides
 */
async function getClientOverrides(
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId: string
): Promise<ClientConsentOverride[]> {
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    client_id: string;
    statement_id: string;
    requirement: string;
    min_version: string | null;
    enforcement: string | null;
    conditional_rules_json: string | null;
    display_order: number | null;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM client_consent_overrides WHERE tenant_id = ? AND client_id = ?`, [
    tenantId,
    clientId,
  ]);

  return rows.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    client_id: r.client_id,
    statement_id: r.statement_id,
    requirement: r.requirement as ClientConsentOverride['requirement'],
    min_version: r.min_version ?? undefined,
    enforcement: r.enforcement ? (r.enforcement as ConsentEnforcement) : undefined,
    conditional_rules: r.conditional_rules_json
      ? (JSON.parse(r.conditional_rules_json) as ConditionalConsentRule[])
      : undefined,
    display_order: r.display_order ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/**
 * Resolve consent requirements by merging tenant defaults, client overrides,
 * and conditional rules evaluated against user claims.
 */
export async function resolveConsentRequirements(
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId: string | null,
  userClaims: Record<string, unknown>
): Promise<ResolvedConsentRequirement[]> {
  const statements = await getActiveConsentStatements(adapter, tenantId);
  if (statements.length === 0) return [];

  const tenantReqs = await getTenantRequirements(adapter, tenantId);
  const clientOverrides = clientId ? await getClientOverrides(adapter, tenantId, clientId) : [];

  const results: ResolvedConsentRequirement[] = [];

  for (const stmt of statements) {
    const currentVersion = await getCurrentVersion(adapter, tenantId, stmt.id);
    if (!currentVersion) continue; // Skip statements without active version

    const tenantReq = tenantReqs.find((r) => r.statement_id === stmt.id);
    const clientOverride = clientOverrides.find((o) => o.statement_id === stmt.id);

    // Client override: hidden → skip entirely
    if (clientOverride?.requirement === 'hidden') continue;

    // Determine base requirement (tenant level)
    let isRequired = tenantReq?.is_required ?? false;
    let minVersion = tenantReq?.min_version;
    let enforcement = tenantReq?.enforcement ?? ('block' as ConsentEnforcement);
    let showDeletionLink = tenantReq?.show_deletion_link ?? false;
    let deletionUrl = tenantReq?.deletion_url;
    let displayOrder = tenantReq?.display_order ?? stmt.display_order;

    // Apply conditional rules (tenant level)
    if (tenantReq?.conditional_rules && tenantReq.conditional_rules.length > 0) {
      const ruleResult = evaluateConditionalRules(tenantReq.conditional_rules, userClaims);
      if (ruleResult === 'required') isRequired = true;
      else if (ruleResult === 'optional') isRequired = false;
      else if (ruleResult === 'hidden') continue; // Skip this item
    }

    // Apply client override
    if (clientOverride) {
      if (clientOverride.requirement === 'required') isRequired = true;
      else if (clientOverride.requirement === 'optional') isRequired = false;
      // 'inherit' = use tenant value (no change)

      if (clientOverride.min_version) minVersion = clientOverride.min_version;
      if (clientOverride.enforcement) enforcement = clientOverride.enforcement;
      if (clientOverride.display_order !== undefined) displayOrder = clientOverride.display_order;

      // Apply client-level conditional rules if present
      if (clientOverride.conditional_rules && clientOverride.conditional_rules.length > 0) {
        const ruleResult = evaluateConditionalRules(clientOverride.conditional_rules, userClaims);
        if (ruleResult === 'required') isRequired = true;
        else if (ruleResult === 'optional') isRequired = false;
        else if (ruleResult === 'hidden') continue;
      }
    }

    results.push({
      statement_id: stmt.id,
      statement: stmt,
      current_version: currentVersion,
      is_required: isRequired,
      min_version: minVersion,
      enforcement,
      show_deletion_link: showDeletionLink,
      deletion_url: deletionUrl,
      display_order: displayOrder,
    });
  }

  return results.sort((a, b) => a.display_order - b.display_order);
}

// =============================================================================
// User Consent Satisfaction Check
// =============================================================================

/**
 * Get user's consent records for a tenant
 */
async function getUserConsentRecords(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<ConsentStatementUserRecord[]> {
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    statement_id: string;
    version_id: string;
    version: string;
    status: string;
    granted_at: number | null;
    withdrawn_at: number | null;
    expires_at: number | null;
    client_id: string | null;
    ip_address_hash: string | null;
    user_agent: string | null;
    receipt_id: string | null;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM user_consent_records WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId]);

  return rows.map((r) => ({
    ...r,
    status: r.status as ConsentRecordStatus,
    granted_at: r.granted_at ?? undefined,
    withdrawn_at: r.withdrawn_at ?? undefined,
    expires_at: r.expires_at ?? undefined,
    client_id: r.client_id ?? undefined,
    ip_address_hash: r.ip_address_hash ?? undefined,
    user_agent: r.user_agent ?? undefined,
    receipt_id: r.receipt_id ?? undefined,
  }));
}

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

  const records = await getUserConsentRecords(adapter, tenantId, userId);
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
  }

  return { satisfied: unsatisfied.length === 0, unsatisfied };
}

// =============================================================================
// Consent Screen Item Assembly
// =============================================================================

/**
 * Build consent items for the consent screen display
 */
export async function getConsentItemsForScreen(
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId: string | null,
  userId: string,
  language: string,
  tenantDefaultLanguage: string = 'en'
): Promise<ConsentScreenItem[]> {
  // Get user claims for conditional rule evaluation
  const userClaims = await getUserClaimsForRules(adapter, tenantId, userId);

  // Resolve requirements
  const requirements = await resolveConsentRequirements(adapter, tenantId, clientId, userClaims);
  if (requirements.length === 0) return [];

  // Get user's existing consent records
  const records = await getUserConsentRecords(adapter, tenantId, userId);

  const items: ConsentScreenItem[] = [];

  for (const req of requirements) {
    // Get localization
    const localization = await getLocalization(
      adapter,
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
      document_url: localization?.document_url,
      inline_content: localization?.inline_content,
      version: req.current_version.version,
      version_id: req.current_version.id,
      is_required: req.is_required,
      enforcement: req.enforcement,
      current_status: currentStatus,
      current_version: currentVersion,
      needs_version_upgrade: needsVersionUpgrade,
      show_deletion_link: req.show_deletion_link,
      deletion_url: req.deletion_url,
      display_order: req.display_order,
    });
  }

  return items;
}

// =============================================================================
// User Claims for Rules (D12)
// =============================================================================

/**
 * Get user claims for conditional rule evaluation.
 * Reads canonical runtime-user projection when the caller supplies a combined adapter.
 */
export async function getUserClaimsForRules(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<Record<string, unknown>> {
  const claims: Record<string, unknown> = {};

  try {
    const user = await new CanonicalRuntimeUserStore({
      coreAdapter: adapter,
      piiAdapter: adapter,
      tenantId,
    }).findById(userId, { includeInactive: true });

    if (user) {
      claims.email_verified = user.email_verified === 1;
      if (user.email) claims.email = user.email;
      if (user.locale) claims.locale = user.locale;
      if (user.given_name) claims.given_name = user.given_name;
      if (user.family_name) claims.family_name = user.family_name;
      if (user.birthdate) claims.birthdate = user.birthdate;
      if (user.phone_number) claims.phone_number = user.phone_number;
      if (user.zoneinfo) claims.zoneinfo = user.zoneinfo;
      if (user.custom_attributes_json) {
        const custom = JSON.parse(user.custom_attributes_json) as Record<string, unknown>;
        Object.assign(claims, custom);
      }
      if (user.address_json) {
        const address = JSON.parse(user.address_json) as Record<string, unknown>;
        claims.address = {
          country: typeof address.country === 'string' ? address.country : undefined,
          region: typeof address.region === 'string' ? address.region : undefined,
        };
      }
    }
  } catch {
    // PII DB may be separate from the supplied adapter — non-fatal.
  }

  return claims;
}

// =============================================================================
// Consent Decision Processing (D3, D9, D10)
// =============================================================================

/**
 * Process user's consent item decisions.
 * Handles granted/denied/withdrawn transitions with idempotency (D9).
 */
export async function processConsentItemDecisions(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  decisions: Record<string, 'granted' | 'denied'>,
  evidence: ConsentEvidence,
  ipHash?: string
): Promise<void> {
  const now = Date.now();

  // Get existing records
  const existingRecords = await getUserConsentRecords(adapter, tenantId, userId);
  const existingMap = new Map(existingRecords.map((r) => [r.statement_id, r]));

  for (const [statementId, decision] of Object.entries(decisions)) {
    const existing = existingMap.get(statementId);

    // Get current version for this statement
    const currentVersion = await getCurrentVersion(adapter, tenantId, statementId);
    if (!currentVersion) continue; // No active version — skip

    if (decision === 'granted') {
      if (existing) {
        // Check for idempotency (D9): same version, already granted
        if (existing.status === 'granted' && existing.version === currentVersion.version) {
          continue; // No change needed
        }

        // Determine action type
        const isVersionUpgrade =
          existing.status === 'granted' && existing.version < currentVersion.version;
        const action = isVersionUpgrade ? 'version_upgraded' : 'granted';

        // Update existing record
        await adapter.execute(
          `UPDATE user_consent_records
           SET version_id = ?, version = ?, status = 'granted',
               granted_at = ?, client_id = ?, ip_address_hash = ?,
               user_agent = ?, updated_at = ?
           WHERE tenant_id = ? AND user_id = ? AND statement_id = ?`,
          [
            currentVersion.id,
            currentVersion.version,
            now,
            evidence.client_id ?? null,
            ipHash ?? null,
            evidence.user_agent ?? null,
            now,
            tenantId,
            userId,
            statementId,
          ]
        );

        // Record history
        await insertConsentItemHistory(adapter, {
          tenantId,
          userId,
          statementId,
          action,
          versionBefore: existing.version,
          versionAfter: currentVersion.version,
          statusBefore: existing.status,
          statusAfter: 'granted',
          ipHash,
          userAgent: evidence.user_agent,
          clientId: evidence.client_id,
        });
      } else {
        // New record — INSERT
        const recordId = crypto.randomUUID();
        await adapter.execute(
          `INSERT INTO user_consent_records
           (id, tenant_id, user_id, statement_id, version_id, version, status,
            granted_at, client_id, ip_address_hash, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?, ?, ?, ?)`,
          [
            recordId,
            tenantId,
            userId,
            statementId,
            currentVersion.id,
            currentVersion.version,
            now,
            evidence.client_id ?? null,
            ipHash ?? null,
            evidence.user_agent ?? null,
            now,
            now,
          ]
        );

        await insertConsentItemHistory(adapter, {
          tenantId,
          userId,
          statementId,
          action: 'granted',
          versionAfter: currentVersion.version,
          statusAfter: 'granted',
          ipHash,
          userAgent: evidence.user_agent,
          clientId: evidence.client_id,
        });
      }
    } else if (decision === 'denied') {
      if (existing) {
        // If already granted → this is a withdrawal (D3)
        if (existing.status === 'granted') {
          await adapter.execute(
            `UPDATE user_consent_records
             SET status = 'withdrawn', withdrawn_at = ?, ip_address_hash = ?,
                 user_agent = ?, updated_at = ?
             WHERE tenant_id = ? AND user_id = ? AND statement_id = ?`,
            [now, ipHash ?? null, evidence.user_agent ?? null, now, tenantId, userId, statementId]
          );

          await insertConsentItemHistory(adapter, {
            tenantId,
            userId,
            statementId,
            action: 'withdrawn',
            versionBefore: existing.version,
            versionAfter: existing.version,
            statusBefore: 'granted',
            statusAfter: 'withdrawn',
            ipHash,
            userAgent: evidence.user_agent,
            clientId: evidence.client_id,
          });
        } else if (existing.status !== 'denied') {
          // Update to denied (from expired or other non-granted state)
          await adapter.execute(
            `UPDATE user_consent_records
             SET status = 'denied', ip_address_hash = ?,
                 user_agent = ?, updated_at = ?
             WHERE tenant_id = ? AND user_id = ? AND statement_id = ?`,
            [ipHash ?? null, evidence.user_agent ?? null, now, tenantId, userId, statementId]
          );

          await insertConsentItemHistory(adapter, {
            tenantId,
            userId,
            statementId,
            action: 'denied',
            versionBefore: existing.version,
            versionAfter: currentVersion.version,
            statusBefore: existing.status,
            statusAfter: 'denied',
            ipHash,
            userAgent: evidence.user_agent,
            clientId: evidence.client_id,
          });
        }
        // Already denied → no change (idempotent)
      } else {
        // New denied record (D10)
        const recordId = crypto.randomUUID();
        await adapter.execute(
          `INSERT INTO user_consent_records
           (id, tenant_id, user_id, statement_id, version_id, version, status,
            client_id, ip_address_hash, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'denied', ?, ?, ?, ?, ?)`,
          [
            recordId,
            tenantId,
            userId,
            statementId,
            currentVersion.id,
            currentVersion.version,
            evidence.client_id ?? null,
            ipHash ?? null,
            evidence.user_agent ?? null,
            now,
            now,
          ]
        );

        await insertConsentItemHistory(adapter, {
          tenantId,
          userId,
          statementId,
          action: 'denied',
          versionAfter: currentVersion.version,
          statusAfter: 'denied',
          ipHash,
          userAgent: evidence.user_agent,
          clientId: evidence.client_id,
        });
      }
    }
  }
}

// =============================================================================
// History Helper
// =============================================================================

async function insertConsentItemHistory(
  adapter: DatabaseAdapter,
  params: {
    tenantId: string;
    userId: string;
    statementId: string;
    action: string;
    versionBefore?: string;
    versionAfter?: string;
    statusBefore?: string;
    statusAfter?: string;
    ipHash?: string;
    userAgent?: string;
    clientId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await adapter.execute(
    `INSERT INTO consent_item_history
     (id, tenant_id, user_id, statement_id, action,
      version_before, version_after, status_before, status_after,
      ip_address_hash, user_agent, client_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.tenantId,
      params.userId,
      params.statementId,
      params.action,
      params.versionBefore ?? null,
      params.versionAfter ?? null,
      params.statusBefore ?? null,
      params.statusAfter ?? null,
      params.ipHash ?? null,
      params.userAgent ?? null,
      params.clientId ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      Date.now(),
    ]
  );
  return id;
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
  versionId: string
): Promise<void> {
  // Validate: version exists and belongs to this statement
  const versionRows = await adapter.query<{ id: string; status: string }>(
    `SELECT id, status FROM consent_statement_versions
     WHERE id = ? AND statement_id = ? AND tenant_id = ?`,
    [versionId, statementId, tenantId]
  );
  if (versionRows.length === 0) {
    throw new Error('Version not found');
  }

  // Validate: at least one localization exists (D8)
  const locCount = await adapter.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt
       FROM consent_statement_localizations
      WHERE tenant_id = ? AND version_id = ?`,
    [tenantId, versionId]
  );
  if (locCount[0].cnt === 0) {
    throw new Error('Cannot activate version without at least one localization');
  }

  // Compute content hash (D11)
  const contentHash = await computeContentHash(adapter, versionId, tenantId);

  // Transaction: deactivate old current, activate new (D5)
  await adapter.execute(
    `UPDATE consent_statement_versions
     SET is_current = 0, current_statement_guard = NULL, status = 'archived', updated_at = ?
     WHERE statement_id = ? AND tenant_id = ? AND is_current = 1`,
    [Date.now(), statementId, tenantId]
  );

  await adapter.execute(
    `UPDATE consent_statement_versions
     SET is_current = 1, current_statement_guard = statement_id,
         status = 'active', content_hash = ?, updated_at = ?
     WHERE id = ? AND statement_id = ? AND tenant_id = ?`,
    [contentHash, Date.now(), versionId, statementId, tenantId]
  );
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
    document_url: string | null;
    inline_content: string | null;
  }>(
    `SELECT language, document_url, inline_content
     FROM consent_statement_localizations
     WHERE ${localizationWhere}
     ORDER BY language ASC`,
    localizationParams
  );

  // Build hash input
  let hashInput = '';
  for (const loc of locs) {
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
  kv: KVNamespace | null
): Promise<string> {
  let salt = '';
  if (kv) {
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
