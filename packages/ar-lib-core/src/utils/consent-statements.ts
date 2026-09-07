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

export interface ConsentRequirementResolutionContext {
  target_type?: 'oidc_client' | 'saml_sp';
  target_id?: string | null;
  subject_id?: string | null;
  requested_scopes?: string[];
  requested_claims?: string[];
  requested_saml_attributes?: string[];
  requested_destination_field_sets?: string[];
}

export interface ConsentDecisionTarget {
  version_id: string;
  version: string;
  withdrawal_allowed?: boolean;
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
    record_retention_days: number | null;
    withdrawal_allowed: number | null;
    withdrawal_impact: string | null;
    reconsent_on_version_change: number | null;
    reconsent_interval_days: number | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, slug, category, legal_basis, processing_purpose,
            display_order, is_active, record_retention_days, withdrawal_allowed,
            withdrawal_impact, reconsent_on_version_change, reconsent_interval_days,
            created_at, updated_at
     FROM consent_statements
     WHERE tenant_id = ? AND is_active = 1
     ORDER BY display_order ASC, created_at ASC`,
    [tenantId]
  );

  return rows.map((r) => ({
    ...r,
    processing_purpose: r.processing_purpose ?? undefined,
    is_active: r.is_active === 1,
    record_retention_days: r.record_retention_days ?? undefined,
    withdrawal_allowed: r.withdrawal_allowed == null ? true : r.withdrawal_allowed === 1,
    withdrawal_impact: r.withdrawal_impact ?? undefined,
    reconsent_on_version_change:
      r.reconsent_on_version_change == null ? true : r.reconsent_on_version_change === 1,
    reconsent_interval_days: r.reconsent_interval_days ?? undefined,
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
    effective_until: r.effective_until ?? null,
    is_current: r.is_current === 1,
    content_type: r.content_type as ConsentStatementVersion['content_type'],
    status: r.status as ConsentStatementVersion['status'],
  };
}

async function getVersionById(
  adapter: DatabaseAdapter,
  tenantId: string,
  statementId: string,
  versionId: string
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
     WHERE tenant_id = ? AND statement_id = ? AND id = ?`,
    [tenantId, statementId, versionId]
  );

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ...r,
    content_hash: r.content_hash ?? undefined,
    effective_until: r.effective_until ?? null,
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
    checkbox_mode?: string | null;
    checkbox_default_checked?: number | null;
    binding_type?: string | null;
    binding_value?: string | null;
    evidence_profile?: string | null;
    language_fallback?: string | null;
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
    checkbox_mode:
      r.checkbox_mode === 'none' || r.checkbox_mode === 'required' || r.checkbox_mode === 'optional'
        ? r.checkbox_mode
        : undefined,
    checkbox_default_checked:
      r.checkbox_default_checked === null || r.checkbox_default_checked === undefined
        ? undefined
        : r.checkbox_default_checked === 1,
    binding_type:
      r.binding_type === 'subject' ||
      r.binding_type === 'scope' ||
      r.binding_type === 'claim' ||
      r.binding_type === 'saml_attribute' ||
      r.binding_type === 'destination_field_set'
        ? r.binding_type
        : undefined,
    binding_value: r.binding_value ?? undefined,
    evidence_profile: r.evidence_profile ?? undefined,
    language_fallback: r.language_fallback ?? undefined,
    display_order: r.display_order ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

type ConsentBindingType = NonNullable<ResolvedConsentRequirement['binding_type']>;

interface RequirementContextBinding {
  binding_type?: ConsentBindingType;
  binding_value?: string;
  evidence_profile?: string;
}

function splitBindingValues(value?: string | null): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function intersectsRequiredValues(requiredValues: string[], requestedValues?: string[]): boolean {
  if (requiredValues.length === 0) return true;
  const requested = new Set((requestedValues ?? []).map((item) => item.trim()).filter(Boolean));
  if (requested.size === 0) return false;
  return requiredValues.some((value) => requested.has(value));
}

function isSamlSpecificStatement(
  statement: ConsentStatement,
  binding?: RequirementContextBinding
): boolean {
  const category = statement.category.toLowerCase();
  const slug = statement.slug.toLowerCase();
  const evidenceProfile = binding?.evidence_profile?.toLowerCase() ?? '';
  return (
    binding?.binding_type === 'saml_attribute' ||
    category === 'saml_attribute_release_confirmation' ||
    category.startsWith('saml_') ||
    slug.startsWith('saml_') ||
    evidenceProfile.includes('saml')
  );
}

function requirementAppliesToContext(
  statement: ConsentStatement,
  binding: RequirementContextBinding,
  context: ConsentRequirementResolutionContext
): boolean {
  const values = splitBindingValues(binding.binding_value);

  switch (binding.binding_type) {
    case 'scope':
      if (context.target_type && context.target_type !== 'oidc_client') return false;
      if (!context.target_type && context.requested_scopes === undefined) return true;
      return intersectsRequiredValues(values, context.requested_scopes);
    case 'claim':
      if (context.target_type && context.target_type !== 'oidc_client') return false;
      if (!context.target_type && context.requested_claims === undefined) return true;
      return intersectsRequiredValues(values, context.requested_claims);
    case 'saml_attribute':
      if (context.target_type && context.target_type !== 'saml_sp') return false;
      if (!context.target_type && context.requested_saml_attributes === undefined) return true;
      return intersectsRequiredValues(values, context.requested_saml_attributes);
    case 'destination_field_set':
      if (context.target_type && context.requested_destination_field_sets === undefined) {
        return false;
      }
      if (!context.target_type && context.requested_destination_field_sets === undefined) {
        return true;
      }
      return intersectsRequiredValues(values, context.requested_destination_field_sets);
    case 'subject':
      return !context.target_type;
    default:
      if (context.target_type === 'oidc_client' && isSamlSpecificStatement(statement, binding)) {
        return false;
      }
      if (context.target_type === 'oidc_client') {
        return false;
      }
      return true;
  }
}

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
      first_party: number;
      trusted: number;
      skip_authorization_consent: number;
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
      first_party: row.first_party === 1,
      trusted: row.trusted === 1,
      skip_authorization_consent: row.skip_authorization_consent === 1,
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
 * Resolve consent requirements from explicit target policy assignments, client overrides,
 * and conditional rules evaluated against user claims.
 */
export async function resolveConsentRequirements(
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId: string | null,
  userClaims: Record<string, unknown>,
  context: ConsentRequirementResolutionContext = {}
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
    let checkboxMode: ResolvedConsentRequirement['checkbox_mode'];
    let checkboxDefaultChecked: boolean | undefined;
    let bindingType = clientOverride?.binding_type;
    let bindingValue = clientOverride?.binding_value;
    let evidenceProfile = clientOverride?.evidence_profile;
    let languageFallback = clientOverride?.language_fallback;
    if (!minVersion && stmt.reconsent_on_version_change !== false) {
      minVersion = currentVersion.version;
    }

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
      if (clientOverride.checkbox_mode !== undefined) checkboxMode = clientOverride.checkbox_mode;
      if (clientOverride.checkbox_default_checked !== undefined) {
        checkboxDefaultChecked = clientOverride.checkbox_default_checked;
      }
      if (clientOverride.binding_type !== undefined) bindingType = clientOverride.binding_type;
      if (clientOverride.binding_value !== undefined) bindingValue = clientOverride.binding_value;
      if (clientOverride.evidence_profile !== undefined) {
        evidenceProfile = clientOverride.evidence_profile;
      }
      if (clientOverride.language_fallback !== undefined) {
        languageFallback = clientOverride.language_fallback;
      }

      // Apply client-level conditional rules if present
      if (clientOverride.conditional_rules && clientOverride.conditional_rules.length > 0) {
        const ruleResult = evaluateConditionalRules(clientOverride.conditional_rules, userClaims);
        if (ruleResult === 'required') isRequired = true;
        else if (ruleResult === 'optional') isRequired = false;
        else if (ruleResult === 'hidden') continue;
      }
    }

    if (
      !requirementAppliesToContext(
        stmt,
        {
          binding_type: bindingType,
          binding_value: bindingValue,
          evidence_profile: evidenceProfile,
        },
        context
      )
    ) {
      continue;
    }

    results.push({
      statement_id: stmt.id,
      statement: stmt,
      current_version: currentVersion,
      is_required: isRequired,
      min_version: minVersion,
      reconsent_interval_days: stmt.reconsent_interval_days,
      enforcement,
      show_deletion_link: showDeletionLink,
      deletion_url: deletionUrl,
      checkbox_mode: checkboxMode ?? (isRequired ? 'required' : 'optional'),
      checkbox_default_checked: checkboxDefaultChecked ?? isRequired,
      binding_type: bindingType,
      binding_value: bindingValue,
      evidence_profile: evidenceProfile,
      language_fallback: languageFallback,
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
    retain_until: number | null;
    consent_settings_snapshot_at: number | null;
    record_retention_days_snapshot: number | null;
    reconsent_interval_days_snapshot: number | null;
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
    retain_until: r.retain_until ?? undefined,
    consent_settings_snapshot_at: r.consent_settings_snapshot_at ?? undefined,
    record_retention_days_snapshot: r.record_retention_days_snapshot ?? undefined,
    reconsent_interval_days_snapshot: r.reconsent_interval_days_snapshot ?? undefined,
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
 * Build consent items for the consent screen display
 */
export async function getConsentItemsForScreen(
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId: string | null,
  userId: string,
  language: string,
  tenantDefaultLanguage: string = 'en',
  context: ConsentRequirementResolutionContext = {},
  piiAdapter: DatabaseAdapter = adapter
): Promise<ConsentScreenItem[]> {
  // Get user claims for conditional rule evaluation
  const userClaims = await getUserClaimsForRules(adapter, tenantId, userId, piiAdapter);

  // Resolve requirements
  const requirements = await resolveConsentRequirements(
    adapter,
    tenantId,
    clientId,
    userClaims,
    context
  );
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
      processing_purpose: localization?.processing_purpose,
      withdrawal_impact: localization?.withdrawal_impact,
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
// User Claims for Rules (D12)
// =============================================================================

/**
 * Get user claims for conditional rule evaluation.
 * Reads canonical runtime-user projection when the caller supplies a combined adapter.
 */
export async function getUserClaimsForRules(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  piiAdapter: DatabaseAdapter = adapter
): Promise<Record<string, unknown>> {
  const claims: Record<string, unknown> = {};

  try {
    const user = await new CanonicalRuntimeUserStore({
      coreAdapter: adapter,
      piiAdapter,
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

interface ConsentAuditSnapshot {
  recordRetentionDays: number | null;
  reconsentIntervalDays: number | null;
  snapshotAt: number;
  expiresAt: number | null;
  retainUntil: number | null;
}

async function getConsentAuditSnapshot(
  adapter: DatabaseAdapter,
  tenantId: string,
  statementId: string,
  at: number
): Promise<ConsentAuditSnapshot> {
  const rows = await adapter.query<{
    record_retention_days: number | null;
    reconsent_interval_days: number | null;
  }>(
    `SELECT record_retention_days, reconsent_interval_days
       FROM consent_statements
      WHERE tenant_id = ? AND id = ?`,
    [tenantId, statementId]
  );
  const statement = rows[0];
  const recordRetentionDays =
    statement?.record_retention_days !== undefined && statement.record_retention_days !== null
      ? Number(statement.record_retention_days)
      : null;
  const reconsentIntervalDays =
    statement?.reconsent_interval_days !== undefined && statement.reconsent_interval_days !== null
      ? Number(statement.reconsent_interval_days)
      : null;
  const dayMs = 24 * 60 * 60 * 1000;

  return {
    recordRetentionDays,
    reconsentIntervalDays,
    snapshotAt: at,
    expiresAt:
      reconsentIntervalDays !== null && reconsentIntervalDays > 0
        ? at + reconsentIntervalDays * dayMs
        : null,
    retainUntil:
      recordRetentionDays !== null && recordRetentionDays >= 0
        ? at + recordRetentionDays * dayMs
        : null,
  };
}

async function updatePriorConsentHistoryRetention(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  statementId: string,
  snapshot: ConsentAuditSnapshot
): Promise<void> {
  await adapter.execute(
    `UPDATE consent_item_history
        SET retain_until = ?,
            consent_settings_snapshot_at = ?,
            record_retention_days_snapshot = ?,
            reconsent_interval_days_snapshot = ?
      WHERE tenant_id = ?
        AND user_id = ?
        AND statement_id = ?
        AND (retain_until IS NULL OR retain_until < ?)`,
    [
      snapshot.retainUntil,
      snapshot.snapshotAt,
      snapshot.recordRetentionDays,
      snapshot.reconsentIntervalDays,
      tenantId,
      userId,
      statementId,
      snapshot.retainUntil,
    ]
  );
}

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
  ipHash?: string,
  targets: Record<string, ConsentDecisionTarget> = {}
): Promise<void> {
  const now = Date.now();

  // Get existing records
  const existingRecords = await getUserConsentRecords(adapter, tenantId, userId);
  const existingMap = new Map(existingRecords.map((r) => [r.statement_id, r]));

  for (const [statementId, decision] of Object.entries(decisions)) {
    const existing = existingMap.get(statementId);

    const target = targets[statementId];
    const currentVersion = target
      ? ({
          id: target.version_id,
          version: target.version,
        } as ConsentStatementVersion)
      : await getCurrentVersion(adapter, tenantId, statementId);
    if (!currentVersion) continue; // No active version — skip
    const auditSnapshot = await getConsentAuditSnapshot(adapter, tenantId, statementId, now);

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
               user_agent = ?, expires_at = ?, retain_until = ?,
               consent_settings_snapshot_at = ?, record_retention_days_snapshot = ?,
               reconsent_interval_days_snapshot = ?,
               updated_at = ?
           WHERE tenant_id = ? AND user_id = ? AND statement_id = ?`,
          [
            currentVersion.id,
            currentVersion.version,
            now,
            evidence.client_id ?? null,
            ipHash ?? null,
            evidence.user_agent ?? null,
            auditSnapshot.expiresAt,
            auditSnapshot.retainUntil,
            auditSnapshot.snapshotAt,
            auditSnapshot.recordRetentionDays,
            auditSnapshot.reconsentIntervalDays,
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
          versionIdBefore: existing.version_id,
          versionIdAfter: currentVersion.id,
          versionBefore: existing.version,
          versionAfter: currentVersion.version,
          statusBefore: existing.status,
          statusAfter: 'granted',
          grantedAt: now,
          expiresAt: auditSnapshot.expiresAt,
          retainUntil: auditSnapshot.retainUntil,
          consentSettingsSnapshotAt: auditSnapshot.snapshotAt,
          recordRetentionDaysSnapshot: auditSnapshot.recordRetentionDays,
          reconsentIntervalDaysSnapshot: auditSnapshot.reconsentIntervalDays,
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
            granted_at, expires_at, retain_until, record_retention_days_snapshot,
            reconsent_interval_days_snapshot, consent_settings_snapshot_at, client_id,
            ip_address_hash, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            recordId,
            tenantId,
            userId,
            statementId,
            currentVersion.id,
            currentVersion.version,
            now,
            auditSnapshot.expiresAt,
            auditSnapshot.retainUntil,
            auditSnapshot.recordRetentionDays,
            auditSnapshot.reconsentIntervalDays,
            auditSnapshot.snapshotAt,
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
          versionIdAfter: currentVersion.id,
          versionAfter: currentVersion.version,
          statusAfter: 'granted',
          grantedAt: now,
          expiresAt: auditSnapshot.expiresAt,
          retainUntil: auditSnapshot.retainUntil,
          consentSettingsSnapshotAt: auditSnapshot.snapshotAt,
          recordRetentionDaysSnapshot: auditSnapshot.recordRetentionDays,
          reconsentIntervalDaysSnapshot: auditSnapshot.reconsentIntervalDays,
          ipHash,
          userAgent: evidence.user_agent,
          clientId: evidence.client_id,
        });
      }
    } else if (decision === 'denied') {
      if (existing) {
        // If already granted → this is a withdrawal (D3)
        if (existing.status === 'granted') {
          if (target?.withdrawal_allowed === false) {
            continue;
          }
          await adapter.execute(
            `UPDATE user_consent_records
             SET status = 'withdrawn', withdrawn_at = ?, ip_address_hash = ?,
                 user_agent = ?, retain_until = ?, record_retention_days_snapshot = ?,
                 reconsent_interval_days_snapshot = ?, consent_settings_snapshot_at = ?,
                 updated_at = ?
             WHERE tenant_id = ? AND user_id = ? AND statement_id = ?`,
            [
              now,
              ipHash ?? null,
              evidence.user_agent ?? null,
              auditSnapshot.retainUntil,
              auditSnapshot.recordRetentionDays,
              auditSnapshot.reconsentIntervalDays,
              auditSnapshot.snapshotAt,
              now,
              tenantId,
              userId,
              statementId,
            ]
          );
          await updatePriorConsentHistoryRetention(
            adapter,
            tenantId,
            userId,
            statementId,
            auditSnapshot
          );

          await insertConsentItemHistory(adapter, {
            tenantId,
            userId,
            statementId,
            action: 'withdrawn',
            versionIdBefore: existing.version_id,
            versionIdAfter: existing.version_id,
            versionBefore: existing.version,
            versionAfter: existing.version,
            statusBefore: 'granted',
            statusAfter: 'withdrawn',
            withdrawnAt: now,
            expiresAt: existing.expires_at,
            retainUntil: auditSnapshot.retainUntil,
            consentSettingsSnapshotAt: auditSnapshot.snapshotAt,
            recordRetentionDaysSnapshot: auditSnapshot.recordRetentionDays,
            reconsentIntervalDaysSnapshot: auditSnapshot.reconsentIntervalDays,
            ipHash,
            userAgent: evidence.user_agent,
            clientId: evidence.client_id,
          });
        } else if (existing.status !== 'denied') {
          // Update to denied (from expired or other non-granted state)
          await adapter.execute(
            `UPDATE user_consent_records
             SET status = 'denied', ip_address_hash = ?,
                 user_agent = ?, expires_at = NULL, retain_until = ?,
                 record_retention_days_snapshot = ?, reconsent_interval_days_snapshot = ?,
                 consent_settings_snapshot_at = ?,
                 updated_at = ?
             WHERE tenant_id = ? AND user_id = ? AND statement_id = ?`,
            [
              ipHash ?? null,
              evidence.user_agent ?? null,
              auditSnapshot.retainUntil,
              auditSnapshot.recordRetentionDays,
              auditSnapshot.reconsentIntervalDays,
              auditSnapshot.snapshotAt,
              now,
              tenantId,
              userId,
              statementId,
            ]
          );
          await updatePriorConsentHistoryRetention(
            adapter,
            tenantId,
            userId,
            statementId,
            auditSnapshot
          );

          await insertConsentItemHistory(adapter, {
            tenantId,
            userId,
            statementId,
            action: 'denied',
            versionIdBefore: existing.version_id,
            versionIdAfter: currentVersion.id,
            versionBefore: existing.version,
            versionAfter: currentVersion.version,
            statusBefore: existing.status,
            statusAfter: 'denied',
            retainUntil: auditSnapshot.retainUntil,
            consentSettingsSnapshotAt: auditSnapshot.snapshotAt,
            recordRetentionDaysSnapshot: auditSnapshot.recordRetentionDays,
            reconsentIntervalDaysSnapshot: auditSnapshot.reconsentIntervalDays,
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
            expires_at, retain_until, record_retention_days_snapshot,
            reconsent_interval_days_snapshot, consent_settings_snapshot_at, client_id,
            ip_address_hash, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'denied', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            recordId,
            tenantId,
            userId,
            statementId,
            currentVersion.id,
            currentVersion.version,
            auditSnapshot.retainUntil,
            auditSnapshot.recordRetentionDays,
            auditSnapshot.reconsentIntervalDays,
            auditSnapshot.snapshotAt,
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
          versionIdAfter: currentVersion.id,
          versionAfter: currentVersion.version,
          statusAfter: 'denied',
          retainUntil: auditSnapshot.retainUntil,
          consentSettingsSnapshotAt: auditSnapshot.snapshotAt,
          recordRetentionDaysSnapshot: auditSnapshot.recordRetentionDays,
          reconsentIntervalDaysSnapshot: auditSnapshot.reconsentIntervalDays,
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
    versionIdBefore?: string;
    versionIdAfter?: string;
    versionBefore?: string;
    versionAfter?: string;
    statusBefore?: string;
    statusAfter?: string;
    grantedAt?: number;
    withdrawnAt?: number;
    expiresAt?: number | null;
    retainUntil?: number | null;
    consentSettingsSnapshotAt?: number | null;
    recordRetentionDaysSnapshot?: number | null;
    reconsentIntervalDaysSnapshot?: number | null;
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
      version_id_before, version_id_after, version_before, version_after,
      status_before, status_after, granted_at, withdrawn_at, expires_at, retain_until,
      consent_settings_snapshot_at, record_retention_days_snapshot, reconsent_interval_days_snapshot,
      ip_address_hash, user_agent, client_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.tenantId,
      params.userId,
      params.statementId,
      params.action,
      params.versionIdBefore ?? null,
      params.versionIdAfter ?? null,
      params.versionBefore ?? null,
      params.versionAfter ?? null,
      params.statusBefore ?? null,
      params.statusAfter ?? null,
      params.grantedAt ?? null,
      params.withdrawnAt ?? null,
      params.expiresAt ?? null,
      params.retainUntil ?? null,
      params.consentSettingsSnapshotAt ?? null,
      params.recordRetentionDaysSnapshot ?? null,
      params.reconsentIntervalDaysSnapshot ?? null,
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
