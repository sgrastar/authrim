/**
 * Consent Statement Management Type Definitions
 *
 * SAP CDC-like consent management with:
 * - Arbitrary consent items with versioning
 * - Multi-language localization
 * - Conditional requirements based on user claims
 * - Per-tenant and per-client override support
 * - Full audit history (GDPR Art 7)
 */

// =============================================================================
// Enums
// =============================================================================

export const ConsentCategory = {
  TERMS_OF_SERVICE: 'terms_of_service',
  PRIVACY_POLICY: 'privacy_policy',
  COOKIE_POLICY: 'cookie_policy',
  MARKETING: 'marketing',
  DATA_SHARING: 'data_sharing',
  ANALYTICS: 'analytics',
  DO_NOT_SELL: 'do_not_sell',
  SAML_ATTRIBUTE_RELEASE_CONFIRMATION: 'saml_attribute_release_confirmation',
  CUSTOM: 'custom',
} as const;
export type ConsentCategory = (typeof ConsentCategory)[keyof typeof ConsentCategory];

export const LegalBasis = {
  CONSENT: 'consent',
  LEGITIMATE_INTEREST: 'legitimate_interest',
  CONTRACT: 'contract',
  LEGAL_OBLIGATION: 'legal_obligation',
} as const;
export type LegalBasis = (typeof LegalBasis)[keyof typeof LegalBasis];

export const ConsentEnforcement = {
  BLOCK: 'block',
  ALLOW_CONTINUE: 'allow_continue',
} as const;
export type ConsentEnforcement = (typeof ConsentEnforcement)[keyof typeof ConsentEnforcement];

export const ClientConsentRequirement = {
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  HIDDEN: 'hidden',
  INHERIT: 'inherit',
} as const;
export type ClientConsentRequirement =
  (typeof ClientConsentRequirement)[keyof typeof ClientConsentRequirement];

export const ConsentContentType = {
  URL: 'url',
  INLINE: 'inline',
} as const;
export type ConsentContentType = (typeof ConsentContentType)[keyof typeof ConsentContentType];

export const ConsentVersionStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const;
export type ConsentVersionStatus = (typeof ConsentVersionStatus)[keyof typeof ConsentVersionStatus];

export const ConsentRecordStatus = {
  GRANTED: 'granted',
  DENIED: 'denied',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
} as const;
export type ConsentRecordStatus = (typeof ConsentRecordStatus)[keyof typeof ConsentRecordStatus];

export const ConsentItemAction = {
  GRANTED: 'granted',
  DENIED: 'denied',
  WITHDRAWN: 'withdrawn',
  VERSION_UPGRADED: 'version_upgraded',
  EXPIRED: 'expired',
} as const;
export type ConsentItemAction = (typeof ConsentItemAction)[keyof typeof ConsentItemAction];

// =============================================================================
// Core Types
// =============================================================================

/** Consent item definition */
export interface ConsentStatement {
  id: string;
  tenant_id: string;
  slug: string;
  category: ConsentCategory;
  legal_basis: LegalBasis;
  processing_purpose?: string;
  display_order: number;
  is_active: boolean;
  record_retention_days?: number;
  withdrawal_allowed?: boolean;
  withdrawal_impact?: string;
  reconsent_on_version_change?: boolean;
  reconsent_interval_days?: number;
  created_at: number;
  updated_at: number;
}

/** Version of a consent statement */
export interface ConsentStatementVersion {
  id: string;
  tenant_id: string;
  statement_id: string;
  version: string; // YYYYMMDD
  content_type: ConsentContentType;
  effective_at: number;
  effective_until?: number | null;
  content_hash?: string;
  is_current: boolean;
  status: ConsentVersionStatus;
  created_at: number;
  updated_at: number;
}

/** Localized content for a version */
export interface ConsentStatementLocalization {
  id: string;
  tenant_id: string;
  version_id: string;
  language: string; // BCP 47
  title: string;
  description: string;
  processing_purpose?: string;
  withdrawal_impact?: string;
  document_url?: string;
  inline_content?: string;
  created_at: number;
  updated_at: number;
}

/** User's consent record for a statement */
export interface ConsentStatementUserRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  statement_id: string;
  version_id: string;
  version: string; // YYYYMMDD
  status: ConsentRecordStatus;
  granted_at?: number;
  withdrawn_at?: number;
  expires_at?: number;
  retain_until?: number;
  consent_settings_snapshot_at?: number;
  record_retention_days_snapshot?: number;
  reconsent_interval_days_snapshot?: number;
  client_id?: string;
  ip_address_hash?: string;
  user_agent?: string;
  receipt_id?: string;
  created_at: number;
  updated_at: number;
}

/** Tenant-level consent requirement */
export interface TenantConsentRequirement {
  id: string;
  tenant_id: string;
  statement_id: string;
  is_required: boolean;
  min_version?: string; // YYYYMMDD
  enforcement: ConsentEnforcement;
  show_deletion_link: boolean;
  deletion_url?: string;
  conditional_rules: ConditionalConsentRule[];
  display_order: number;
  created_at: number;
  updated_at: number;
}

/** Client-level consent override */
export interface ClientConsentOverride {
  id: string;
  tenant_id: string;
  client_id: string;
  statement_id: string;
  requirement: ClientConsentRequirement;
  min_version?: string;
  enforcement?: ConsentEnforcement;
  conditional_rules?: ConditionalConsentRule[];
  display_order?: number;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// Conditional Rules
// =============================================================================

export const ConditionalRuleOperator = {
  EQ: 'eq',
  NEQ: 'neq',
  IN: 'in',
  NOT_IN: 'not_in',
  GT: 'gt',
  GTE: 'gte',
  LT: 'lt',
  LTE: 'lte',
  EXISTS: 'exists',
} as const;
export type ConditionalRuleOperator =
  (typeof ConditionalRuleOperator)[keyof typeof ConditionalRuleOperator];

/** Conditional consent rule based on user claims */
export interface ConditionalConsentRule {
  /** Claim path (e.g., 'address.country', 'birthdate_age', 'metadata.segment') */
  claim: string;
  /** Comparison operator */
  op: ConditionalRuleOperator;
  /** Value to compare against (not used for 'exists') */
  value?: unknown;
  /** Result when rule matches: 'required' | 'optional' | 'hidden' */
  result: 'required' | 'optional' | 'hidden';
}

// =============================================================================
// Consent Screen Types
// =============================================================================

/** A single consent item prepared for screen display */
export interface ConsentScreenItem {
  /** Statement ID */
  statement_id: string;
  /** Statement slug */
  slug: string;
  /** Category */
  category: ConsentCategory;
  /** Legal basis */
  legal_basis: LegalBasis;
  /** Display title (localized) */
  title: string;
  /** Display description (localized) */
  description: string;
  /** User-facing processing purpose (localized) */
  processing_purpose?: string;
  /** User-facing withdrawal impact (localized) */
  withdrawal_impact?: string;
  /** Document URL (if content_type='url') */
  document_url?: string;
  /** Inline content (if content_type='inline') */
  inline_content?: string;
  /** Current version string (YYYYMMDD) */
  version: string;
  /** Version ID */
  version_id: string;
  /** Whether this item is required */
  is_required: boolean;
  /** Enforcement mode */
  enforcement: ConsentEnforcement;
  /** User's current consent status (null if no record) */
  current_status?: ConsentRecordStatus;
  /** User's currently consented version (if granted) */
  current_version?: string;
  /** Whether version upgrade is needed */
  needs_version_upgrade: boolean;
  /** Show account deletion link (for block enforcement) */
  show_deletion_link: boolean;
  /** Deletion URL */
  deletion_url?: string;
  /** Checkbox rendering behavior */
  checkbox_mode?: 'none' | 'required' | 'optional';
  /** Whether checkbox starts checked */
  checkbox_default_checked?: boolean;
  /** Optional binding to the subject, scope, claim, SAML attribute, or destination field set */
  binding_type?: 'subject' | 'scope' | 'claim' | 'saml_attribute' | 'destination_field_set';
  /** Binding identifier or space-delimited value */
  binding_value?: string;
  /** Evidence profile recorded for this item */
  evidence_profile?: string;
  /** Per-item language fallback hint */
  language_fallback?: string;
  /** Whether an existing grant may be withdrawn through this decision surface */
  withdrawal_allowed?: boolean;
  /** Display order */
  display_order: number;
}

/** User's consent/denial decision for a single item */
export interface ConsentItemDecision {
  /** Statement ID */
  statement_id: string;
  /** 'granted' or 'denied' */
  decision: 'granted' | 'denied';
}

/** Evidence for consent processing (IP, user agent, etc.) */
export interface ConsentEvidence {
  ip_address?: string;
  user_agent?: string;
  client_id?: string;
}

// =============================================================================
// Consent History
// =============================================================================

/** Consent item history record */
export interface ConsentItemHistoryRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  statement_id: string;
  action: ConsentItemAction;
  version_id_before?: string;
  version_id_after?: string;
  version_before?: string;
  version_after?: string;
  status_before?: string;
  status_after?: string;
  granted_at?: number;
  withdrawn_at?: number;
  expires_at?: number;
  retain_until?: number;
  consent_settings_snapshot_at?: number;
  record_retention_days_snapshot?: number;
  reconsent_interval_days_snapshot?: number;
  ip_address_hash?: string;
  user_agent?: string;
  client_id?: string;
  metadata?: Record<string, unknown>;
  created_at: number;
}

// =============================================================================
// Resolved Requirement (after tenant + client + conditional evaluation)
// =============================================================================

/** A fully resolved consent requirement after merging tenant, client, and conditional rules */
export interface ResolvedConsentRequirement {
  statement_id: string;
  statement: ConsentStatement;
  current_version: ConsentStatementVersion;
  is_required: boolean;
  min_version?: string;
  fixed_version_id?: string;
  reconsent_interval_days?: number;
  enforcement: ConsentEnforcement;
  show_deletion_link: boolean;
  deletion_url?: string;
  checkbox_mode?: 'none' | 'required' | 'optional';
  checkbox_default_checked?: boolean;
  binding_type?: 'subject' | 'scope' | 'claim' | 'saml_attribute' | 'destination_field_set';
  binding_value?: string;
  evidence_profile?: string;
  language_fallback?: string;
  display_order: number;
}

// =============================================================================
// Admin API Types
// =============================================================================

export interface CreateConsentStatementInput {
  slug: string;
  category?: ConsentCategory;
  legal_basis?: LegalBasis;
  processing_purpose?: string;
  record_retention_days?: number | null;
  withdrawal_allowed?: boolean;
  withdrawal_impact?: string | null;
  reconsent_on_version_change?: boolean;
  reconsent_interval_days?: number | null;
  display_order?: number;
}

export interface UpdateConsentStatementInput {
  slug?: string;
  category?: ConsentCategory;
  legal_basis?: LegalBasis;
  processing_purpose?: string;
  record_retention_days?: number | null;
  withdrawal_allowed?: boolean;
  withdrawal_impact?: string | null;
  reconsent_on_version_change?: boolean;
  reconsent_interval_days?: number | null;
  display_order?: number;
  is_active?: boolean;
}

export interface CreateConsentVersionInput {
  version: string; // YYYYMMDD
  content_type?: ConsentContentType;
  effective_at: number;
}

export interface UpdateConsentVersionInput {
  content_type?: ConsentContentType;
  effective_at?: number;
}

export interface UpsertLocalizationInput {
  title: string;
  description: string;
  document_url?: string;
  inline_content?: string;
}

export interface SetTenantRequirementInput {
  is_required: boolean;
  min_version?: string;
  enforcement?: ConsentEnforcement;
  show_deletion_link?: boolean;
  deletion_url?: string;
  conditional_rules?: ConditionalConsentRule[];
  display_order?: number;
}

export interface SetClientOverrideInput {
  requirement: ClientConsentRequirement;
  min_version?: string;
  enforcement?: ConsentEnforcement;
  conditional_rules?: ConditionalConsentRule[];
  display_order?: number;
}

// =============================================================================
// Consent Item Event Data
// =============================================================================

export interface ConsentItemEventData {
  userId: string;
  statementId: string;
  statementSlug: string;
  version: string;
  clientId?: string;
  timestamp?: number;
}

export interface ConsentItemVersionUpgradedEventData extends ConsentItemEventData {
  previousVersion: string;
}
