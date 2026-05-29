import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';

export type IdentitySubjectType = 'person' | 'service_account' | 'agent' | string;
export type IdentityAccountType = 'user' | 'admin' | 'service_account' | 'anonymous' | string;
export type IdentityLifecycleState =
  | 'active'
  | 'inactive'
  | 'suspended'
  | 'deleting'
  | 'deleted'
  | 'archived'
  | 'pending'
  | 'pending_verification'
  | 'provisioning'
  | 'incomplete'
  | 'dormant'
  | 'deprovisioned'
  | string;
export type SubjectAccountLinkType = 'primary' | 'secondary' | 'delegated' | string;
export type ProfileType = 'person' | 'organization' | 'agent' | string;
export type AttributeValueType = 'string' | 'number' | 'boolean' | 'json' | 'reference' | string;
export type AttributeClassification =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'sensitive'
  | 'regulated'
  | string;
export type ContactType = 'email' | 'phone' | 'address' | 'web' | string;
export type ContactVerificationState = 'unverified' | 'verified' | 'expired' | 'revoked' | string;
export type IdentityBindingKind =
  | 'external_subject'
  | 'local_identifier'
  | 'delegated_actor'
  | string;
export type IdentityResolutionOutcome =
  | 'created'
  | 'linked'
  | 'matched'
  | 'rejected'
  | 'review_required'
  | string;
export type IdentityResolutionCandidateState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | string;

export type JsonObject = Record<string, unknown>;

interface IdentityExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; success: boolean }>;
}

export interface IdentitySubjectRow {
  id: string;
  tenant_id: string;
  subject_type: IdentitySubjectType;
  lifecycle_state: IdentityLifecycleState;
  display_label: string | null;
  primary_account_id: string | null;
  risk_tier: string | null;
  assurance_level: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface IdentityAccountRow {
  id: string;
  tenant_id: string;
  account_type: IdentityAccountType;
  lifecycle_state: IdentityLifecycleState;
  legacy_user_id: string | null;
  primary_subject_id: string | null;
  display_label: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface SubjectAccountLinkRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  account_id: string;
  link_type: SubjectAccountLinkType;
  lifecycle_state: IdentityLifecycleState;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ProfileRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  profile_type: ProfileType;
  lifecycle_state: IdentityLifecycleState;
  locale: string | null;
  zoneinfo: string | null;
  display_name_ref: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ProfileAttributeValueRow {
  id: string;
  tenant_id: string;
  profile_id: string;
  catalog_entry_id: string;
  value_type: AttributeValueType;
  value_json: string | null;
  value_storage_ref: string | null;
  value_hash: string | null;
  classification: AttributeClassification;
  purpose: string | null;
  is_primary: number;
  display_order: number;
  lifecycle_state: IdentityLifecycleState;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface StructuredAttributeValueRow {
  id: string;
  tenant_id: string;
  owner_type: string;
  owner_id: string;
  catalog_entry_id: string;
  canonical_json: string;
  projected_index_json: string | null;
  classification: AttributeClassification;
  lifecycle_state: IdentityLifecycleState;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ContactPointRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  account_id: string | null;
  contact_type: ContactType;
  purpose: string;
  normalized_hash: string;
  value_storage_ref: string;
  display_label: string | null;
  is_primary: number;
  verification_state: ContactVerificationState;
  lifecycle_state: IdentityLifecycleState;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ContactVerificationRow {
  id: string;
  tenant_id: string;
  contact_point_id: string;
  verification_type: string;
  verification_state: ContactVerificationState;
  evidence_ref: string | null;
  verified_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface IdentityBindingRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  account_id: string | null;
  protocol: string;
  source_id: string;
  provider_subject_key_hash: string;
  binding_kind: IdentityBindingKind;
  lifecycle_state: IdentityLifecycleState;
  assurance_level: string | null;
  trust_context_snapshot_id: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  last_seen_at: number | null;
}

export interface IdentityResolutionEventRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  account_id: string | null;
  binding_id: string | null;
  source_id: string;
  resolution_method: string;
  outcome: IdentityResolutionOutcome;
  reason_codes_json: string | null;
  trace_ref: string | null;
  metadata_json: string | null;
  created_at: number;
}

export interface IdentityResolutionCandidateRow {
  id: string;
  tenant_id: string;
  source_id: string;
  candidate_subject_id: string | null;
  candidate_account_id: string | null;
  candidate_binding_id: string | null;
  candidate_score: number;
  risk_tier: string | null;
  decision_state: IdentityResolutionCandidateState;
  reason_codes_json: string | null;
  review_task_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export interface AssuranceEvidenceRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  account_id: string | null;
  binding_id: string | null;
  evidence_type: string;
  assurance_level: string;
  evidence_ref: string | null;
  issuer_ref: string | null;
  issued_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ValueProvenanceRow {
  id: string;
  tenant_id: string;
  owner_table: string;
  owner_id: string;
  source_id: string;
  source_record_id: string | null;
  source_field_ref: string | null;
  source_authority_contract_id: string | null;
  observed_at: number;
  confidence_score: number | null;
  provenance_json: string | null;
  created_at: number;
}

export interface SubjectLifecycleTimelineEventRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  account_id: string | null;
  event_type: string;
  source_type: string | null;
  source_id: string | null;
  summary_json: string | null;
  event_at: number;
  created_at: number;
}

export interface ContactPointSearchIndexRow {
  id: string;
  tenant_id: string;
  contact_point_id: string;
  index_kind: string;
  index_value: string;
  index_version: number;
  classification: AttributeClassification;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface IdentityBindingLookupIndexRow {
  id: string;
  tenant_id: string;
  identity_binding_id: string;
  lookup_kind: string;
  lookup_value: string;
  lookup_version: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface CreateIdentitySubjectInput {
  id?: string;
  tenant_id?: string;
  subject_type?: IdentitySubjectType;
  lifecycle_state?: IdentityLifecycleState;
  display_label?: string | null;
  primary_account_id?: string | null;
  risk_tier?: string | null;
  assurance_level?: string | null;
  metadata?: JsonObject | null;
}

export interface CreateIdentityAccountInput {
  id?: string;
  tenant_id?: string;
  account_type?: IdentityAccountType;
  lifecycle_state?: IdentityLifecycleState;
  legacy_user_id?: string | null;
  primary_subject_id?: string | null;
  display_label?: string | null;
  metadata?: JsonObject | null;
}

export interface CreateSubjectAccountLinkInput {
  id?: string;
  tenant_id?: string;
  subject_id: string;
  account_id: string;
  link_type?: SubjectAccountLinkType;
  lifecycle_state?: IdentityLifecycleState;
  source_ref?: string | null;
}

export interface CreateProfileInput {
  id?: string;
  tenant_id?: string;
  subject_id: string;
  profile_type?: ProfileType;
  lifecycle_state?: IdentityLifecycleState;
  locale?: string | null;
  zoneinfo?: string | null;
  display_name_ref?: string | null;
  metadata?: JsonObject | null;
}

export interface CreateProfileAttributeValueInput {
  id?: string;
  tenant_id?: string;
  profile_id: string;
  catalog_entry_id: string;
  value_type: AttributeValueType;
  value?: unknown;
  value_storage_ref?: string | null;
  value_hash?: string | null;
  classification?: AttributeClassification;
  purpose?: string | null;
  is_primary?: boolean;
  display_order?: number;
  lifecycle_state?: IdentityLifecycleState;
}

export interface CreateStructuredAttributeValueInput {
  id?: string;
  tenant_id?: string;
  owner_type: string;
  owner_id: string;
  catalog_entry_id: string;
  canonical: unknown;
  projected_index?: JsonObject | null;
  classification?: AttributeClassification;
  lifecycle_state?: IdentityLifecycleState;
}

export interface CreateContactPointInput {
  id?: string;
  tenant_id?: string;
  subject_id?: string | null;
  account_id?: string | null;
  contact_type: ContactType;
  purpose?: string;
  normalized_hash: string;
  value_storage_ref: string;
  display_label?: string | null;
  is_primary?: boolean;
  verification_state?: ContactVerificationState;
  lifecycle_state?: IdentityLifecycleState;
}

export interface CreateContactVerificationInput {
  id?: string;
  tenant_id?: string;
  contact_point_id: string;
  verification_type: string;
  verification_state: ContactVerificationState;
  evidence_ref?: string | null;
  verified_at?: number | null;
  expires_at?: number | null;
  revoked_at?: number | null;
}

export interface CreateIdentityBindingInput {
  id?: string;
  tenant_id?: string;
  subject_id: string;
  account_id?: string | null;
  protocol: string;
  source_id: string;
  provider_subject_key_hash: string;
  binding_kind?: IdentityBindingKind;
  lifecycle_state?: IdentityLifecycleState;
  assurance_level?: string | null;
  trust_context_snapshot_id?: string | null;
  metadata?: JsonObject | null;
  last_seen_at?: number | null;
}

export interface RecordIdentityResolutionEventInput {
  id?: string;
  tenant_id?: string;
  subject_id?: string | null;
  account_id?: string | null;
  binding_id?: string | null;
  source_id: string;
  resolution_method: string;
  outcome: IdentityResolutionOutcome;
  reason_codes?: string[] | null;
  trace_ref?: string | null;
  metadata?: JsonObject | null;
}

export interface CreateIdentityResolutionCandidateInput {
  id?: string;
  tenant_id?: string;
  source_id: string;
  candidate_subject_id?: string | null;
  candidate_account_id?: string | null;
  candidate_binding_id?: string | null;
  candidate_score: number;
  risk_tier?: string | null;
  decision_state?: IdentityResolutionCandidateState;
  reason_codes?: string[] | null;
  review_task_id?: string | null;
  expires_at?: number | null;
}

export interface CreateAssuranceEvidenceInput {
  id?: string;
  tenant_id?: string;
  subject_id?: string | null;
  account_id?: string | null;
  binding_id?: string | null;
  evidence_type: string;
  assurance_level: string;
  evidence_ref?: string | null;
  issuer_ref?: string | null;
  issued_at?: number | null;
  expires_at?: number | null;
  revoked_at?: number | null;
  metadata?: JsonObject | null;
}

export interface CreateValueProvenanceInput {
  id?: string;
  tenant_id?: string;
  owner_table: string;
  owner_id: string;
  source_id: string;
  source_record_id?: string | null;
  source_field_ref?: string | null;
  source_authority_contract_id?: string | null;
  observed_at?: number;
  confidence_score?: number | null;
  provenance?: JsonObject | null;
}

export interface CreateSubjectLifecycleTimelineEventInput {
  id?: string;
  tenant_id?: string;
  subject_id?: string | null;
  account_id?: string | null;
  event_type: string;
  source_type?: string | null;
  source_id?: string | null;
  summary?: JsonObject | null;
  event_at?: number;
}

export interface CreateContactPointSearchIndexInput {
  id?: string;
  tenant_id?: string;
  contact_point_id: string;
  index_kind: string;
  index_value: string;
  index_version?: number;
  classification?: AttributeClassification;
  status?: string;
}

export interface CreateIdentityBindingLookupIndexInput {
  id?: string;
  tenant_id?: string;
  identity_binding_id: string;
  lookup_kind: string;
  lookup_value: string;
  lookup_version?: number;
  status?: string;
}

export interface CreateCanonicalIdentityGraphInput {
  subject?: Omit<CreateIdentitySubjectInput, 'primary_account_id'>;
  account?: Omit<CreateIdentityAccountInput, 'primary_subject_id'>;
  link?: Omit<CreateSubjectAccountLinkInput, 'subject_id' | 'account_id'>;
  profile?: Omit<CreateProfileInput, 'subject_id'>;
}

export interface CanonicalIdentityGraph {
  subject: IdentitySubjectRow;
  account: IdentityAccountRow;
  link: SubjectAccountLinkRow;
  profile: ProfileRow | null;
}

function requireTenantId(tenantId: string | undefined, context: string): string {
  const normalized = tenantId?.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

function resolveTenantId(repositoryTenantId: string, inputTenantId: string | undefined): string {
  if (inputTenantId === undefined) {
    return repositoryTenantId;
  }
  const normalized = requireTenantId(inputTenantId, 'CanonicalIdentityRepository input');
  if (normalized !== repositoryTenantId) {
    throw new Error('CanonicalIdentityRepository input tenantId does not match repository tenant');
  }
  return normalized;
}

function encodeJson(value: unknown | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function encodeStringArray(value: string[] | null | undefined): string | null {
  if (!value || value.length === 0) {
    return null;
  }
  return JSON.stringify(value);
}

function assertProfileAttributeStorageBoundary(input: CreateProfileAttributeValueInput): void {
  const classification = input.classification ?? 'internal';
  const hasInlineValue = input.value !== undefined && input.value !== null;
  if ((classification === 'sensitive' || classification === 'regulated') && hasInlineValue) {
    throw new Error(
      'Sensitive or regulated profile attributes must use value_storage_ref instead of value_json'
    );
  }
}

function activeClause(includeInactive: boolean | undefined, tableAlias?: string): string {
  if (includeInactive) {
    return '';
  }
  const prefix = tableAlias ? `${tableAlias}.` : '';
  return ` AND ${prefix}lifecycle_state = 'active'`;
}

/**
 * Canonical identity repository for the unified identity schema.
 *
 * Runtime protocol code should use CanonicalRuntimeUserStore so graph rows remain in the
 * core database and sensitive values remain in the PII database.
 */
export class CanonicalIdentityRepository {
  private readonly tenantId: string;

  constructor(
    private readonly adapter: DatabaseAdapter,
    tenantId: string
  ) {
    this.tenantId = requireTenantId(tenantId, 'CanonicalIdentityRepository');
  }

  async createIdentityGraph(
    input: CreateCanonicalIdentityGraphInput
  ): Promise<CanonicalIdentityGraph> {
    return this.adapter.transaction(async (tx) => {
      const subject = await this.insertSubject(tx, input.subject ?? {});
      const account = await this.insertAccount(tx, {
        ...(input.account ?? {}),
        primary_subject_id: subject.id,
      });
      const link = await this.insertSubjectAccountLink(tx, {
        ...(input.link ?? {}),
        subject_id: subject.id,
        account_id: account.id,
      });

      const updatedSubject = {
        ...subject,
        primary_account_id: account.id,
        updated_at: getCurrentTimestamp(),
      };
      await tx.execute(
        `UPDATE identity_subjects
            SET primary_account_id = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [updatedSubject.primary_account_id, updatedSubject.updated_at, subject.id, this.tenantId]
      );

      const profile = input.profile
        ? await this.insertProfile(tx, { ...input.profile, subject_id: subject.id })
        : null;

      return {
        subject: updatedSubject,
        account,
        link,
        profile,
      };
    });
  }

  async createSubject(input: CreateIdentitySubjectInput): Promise<IdentitySubjectRow> {
    return this.insertSubject(this.adapter, input);
  }

  async findSubjectById(
    subjectId: string,
    options?: { includeInactive?: boolean }
  ): Promise<IdentitySubjectRow | null> {
    return this.adapter.queryOne<IdentitySubjectRow>(
      `SELECT *
         FROM identity_subjects
        WHERE id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}`,
      [subjectId, this.tenantId]
    );
  }

  async findSubjectByPrimaryAccountId(
    accountId: string,
    options?: { includeInactive?: boolean }
  ): Promise<IdentitySubjectRow | null> {
    return this.adapter.queryOne<IdentitySubjectRow>(
      `SELECT *
         FROM identity_subjects
        WHERE primary_account_id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}`,
      [accountId, this.tenantId]
    );
  }

  async transitionSubjectLifecycle(
    subjectId: string,
    lifecycleState: IdentityLifecycleState
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const deletedAt = lifecycleState === 'deleted' || lifecycleState === 'deleting' ? now : null;
    const result = await this.adapter.execute(
      `UPDATE identity_subjects
          SET lifecycle_state = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [lifecycleState, now, deletedAt, subjectId, this.tenantId]
    );
    return result.rowsAffected > 0;
  }

  async updateSubjectRuntimeFields(
    subjectId: string,
    input: {
      lifecycleState: IdentityLifecycleState;
      displayLabel?: string | null;
    }
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const deletedAt =
      input.lifecycleState === 'deleted' || input.lifecycleState === 'deleting' ? now : null;
    const result = await this.adapter.execute(
      `UPDATE identity_subjects
          SET lifecycle_state = ?, display_label = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [input.lifecycleState, input.displayLabel ?? null, now, deletedAt, subjectId, this.tenantId]
    );
    return result.rowsAffected > 0;
  }

  async createAccount(input: CreateIdentityAccountInput): Promise<IdentityAccountRow> {
    return this.insertAccount(this.adapter, input);
  }

  async findAccountById(
    accountId: string,
    options?: { includeInactive?: boolean }
  ): Promise<IdentityAccountRow | null> {
    return this.adapter.queryOne<IdentityAccountRow>(
      `SELECT *
         FROM identity_accounts
        WHERE id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}`,
      [accountId, this.tenantId]
    );
  }

  async findAccountByLegacyUserId(
    legacyUserId: string,
    options?: { includeInactive?: boolean }
  ): Promise<IdentityAccountRow | null> {
    return this.adapter.queryOne<IdentityAccountRow>(
      `SELECT *
         FROM identity_accounts
        WHERE legacy_user_id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}`,
      [legacyUserId, this.tenantId]
    );
  }

  async transitionAccountLifecycle(
    accountId: string,
    lifecycleState: IdentityLifecycleState
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const deletedAt = lifecycleState === 'deleted' || lifecycleState === 'deleting' ? now : null;
    const result = await this.adapter.execute(
      `UPDATE identity_accounts
          SET lifecycle_state = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [lifecycleState, now, deletedAt, accountId, this.tenantId]
    );
    return result.rowsAffected > 0;
  }

  async updateAccountRuntimeFields(
    accountId: string,
    input: {
      lifecycleState: IdentityLifecycleState;
      displayLabel?: string | null;
      metadata?: JsonObject | null;
    }
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const deletedAt =
      input.lifecycleState === 'deleted' || input.lifecycleState === 'deleting' ? now : null;
    const hasMetadata = Object.prototype.hasOwnProperty.call(input, 'metadata');
    const result = hasMetadata
      ? await this.adapter.execute(
          `UPDATE identity_accounts
              SET lifecycle_state = ?, display_label = ?, metadata_json = ?, updated_at = ?, deleted_at = ?
            WHERE id = ? AND tenant_id = ?`,
          [
            input.lifecycleState,
            input.displayLabel ?? null,
            encodeJson(input.metadata),
            now,
            deletedAt,
            accountId,
            this.tenantId,
          ]
        )
      : await this.adapter.execute(
          `UPDATE identity_accounts
              SET lifecycle_state = ?, display_label = ?, updated_at = ?, deleted_at = ?
            WHERE id = ? AND tenant_id = ?`,
          [
            input.lifecycleState,
            input.displayLabel ?? null,
            now,
            deletedAt,
            accountId,
            this.tenantId,
          ]
        );
    return result.rowsAffected > 0;
  }

  async createSubjectAccountLink(
    input: CreateSubjectAccountLinkInput
  ): Promise<SubjectAccountLinkRow> {
    return this.insertSubjectAccountLink(this.adapter, input);
  }

  async findSubjectAccountLinks(
    subjectId: string,
    options?: { includeInactive?: boolean }
  ): Promise<SubjectAccountLinkRow[]> {
    return this.adapter.query<SubjectAccountLinkRow>(
      `SELECT *
         FROM subject_account_links
        WHERE subject_id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}
        ORDER BY created_at ASC`,
      [subjectId, this.tenantId]
    );
  }

  async createProfile(input: CreateProfileInput): Promise<ProfileRow> {
    return this.insertProfile(this.adapter, input);
  }

  async findProfilesForSubject(
    subjectId: string,
    options?: { includeInactive?: boolean }
  ): Promise<ProfileRow[]> {
    return this.adapter.query<ProfileRow>(
      `SELECT *
         FROM profiles
        WHERE subject_id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}
        ORDER BY profile_type ASC, created_at ASC`,
      [subjectId, this.tenantId]
    );
  }

  async updateProfileRuntimeFields(
    profileId: string,
    input: {
      lifecycleState: IdentityLifecycleState;
      locale?: string | null;
      zoneinfo?: string | null;
    }
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const deletedAt =
      input.lifecycleState === 'deleted' || input.lifecycleState === 'deleting' ? now : null;
    const result = await this.adapter.execute(
      `UPDATE profiles
          SET lifecycle_state = ?, locale = ?, zoneinfo = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [
        input.lifecycleState,
        input.locale ?? null,
        input.zoneinfo ?? null,
        now,
        deletedAt,
        profileId,
        this.tenantId,
      ]
    );
    return result.rowsAffected > 0;
  }

  async createProfileAttributeValue(
    input: CreateProfileAttributeValueInput
  ): Promise<ProfileAttributeValueRow> {
    assertProfileAttributeStorageBoundary(input);

    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ProfileAttributeValueRow = {
      id,
      tenant_id: tenantId,
      profile_id: input.profile_id,
      catalog_entry_id: input.catalog_entry_id,
      value_type: input.value_type,
      value_json: encodeJson(input.value),
      value_storage_ref: input.value_storage_ref ?? null,
      value_hash: input.value_hash ?? null,
      classification: input.classification ?? 'internal',
      purpose: input.purpose ?? null,
      is_primary: input.is_primary ? 1 : 0,
      display_order: input.display_order ?? 0,
      lifecycle_state: input.lifecycle_state ?? 'active',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await this.adapter.execute(
      `INSERT INTO profile_attribute_values (
        id, tenant_id, profile_id, catalog_entry_id, value_type, value_json, value_storage_ref,
        value_hash, classification, purpose, is_primary, display_order, lifecycle_state,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.profile_id,
        row.catalog_entry_id,
        row.value_type,
        row.value_json,
        row.value_storage_ref,
        row.value_hash,
        row.classification,
        row.purpose,
        row.is_primary,
        row.display_order,
        row.lifecycle_state,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  async upsertProfileAttributeValue(
    input: CreateProfileAttributeValueInput
  ): Promise<ProfileAttributeValueRow> {
    assertProfileAttributeStorageBoundary(input);

    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ProfileAttributeValueRow = {
      id,
      tenant_id: tenantId,
      profile_id: input.profile_id,
      catalog_entry_id: input.catalog_entry_id,
      value_type: input.value_type,
      value_json: encodeJson(input.value),
      value_storage_ref: input.value_storage_ref ?? null,
      value_hash: input.value_hash ?? null,
      classification: input.classification ?? 'internal',
      purpose: input.purpose ?? null,
      is_primary: input.is_primary ? 1 : 0,
      display_order: input.display_order ?? 0,
      lifecycle_state: input.lifecycle_state ?? 'active',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await this.adapter.execute(
      `INSERT INTO profile_attribute_values (
        id, tenant_id, profile_id, catalog_entry_id, value_type, value_json, value_storage_ref,
        value_hash, classification, purpose, is_primary, display_order, lifecycle_state,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile_id = excluded.profile_id,
        catalog_entry_id = excluded.catalog_entry_id,
        value_type = excluded.value_type,
        value_json = excluded.value_json,
        value_storage_ref = excluded.value_storage_ref,
        value_hash = excluded.value_hash,
        classification = excluded.classification,
        purpose = excluded.purpose,
        is_primary = excluded.is_primary,
        display_order = excluded.display_order,
        lifecycle_state = excluded.lifecycle_state,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at`,
      [
        row.id,
        row.tenant_id,
        row.profile_id,
        row.catalog_entry_id,
        row.value_type,
        row.value_json,
        row.value_storage_ref,
        row.value_hash,
        row.classification,
        row.purpose,
        row.is_primary,
        row.display_order,
        row.lifecycle_state,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  async transitionProfileAttributeValueLifecycle(
    attributeValueId: string,
    lifecycleState: IdentityLifecycleState
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const deletedAt = lifecycleState === 'deleted' || lifecycleState === 'deleting' ? now : null;
    const result = await this.adapter.execute(
      `UPDATE profile_attribute_values
          SET lifecycle_state = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [lifecycleState, now, deletedAt, attributeValueId, this.tenantId]
    );
    return result.rowsAffected > 0;
  }

  async createStructuredAttributeValue(
    input: CreateStructuredAttributeValueInput
  ): Promise<StructuredAttributeValueRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: StructuredAttributeValueRow = {
      id,
      tenant_id: tenantId,
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      catalog_entry_id: input.catalog_entry_id,
      canonical_json: JSON.stringify(input.canonical),
      projected_index_json: encodeJson(input.projected_index),
      classification: input.classification ?? 'internal',
      lifecycle_state: input.lifecycle_state ?? 'active',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await this.adapter.execute(
      `INSERT INTO structured_attribute_values (
        id, tenant_id, owner_type, owner_id, catalog_entry_id, canonical_json,
        projected_index_json, classification, lifecycle_state, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.owner_type,
        row.owner_id,
        row.catalog_entry_id,
        row.canonical_json,
        row.projected_index_json,
        row.classification,
        row.lifecycle_state,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  async upsertStructuredAttributeValue(
    input: CreateStructuredAttributeValueInput
  ): Promise<StructuredAttributeValueRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: StructuredAttributeValueRow = {
      id,
      tenant_id: tenantId,
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      catalog_entry_id: input.catalog_entry_id,
      canonical_json: JSON.stringify(input.canonical),
      projected_index_json: encodeJson(input.projected_index),
      classification: input.classification ?? 'internal',
      lifecycle_state: input.lifecycle_state ?? 'active',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await this.adapter.execute(
      `INSERT INTO structured_attribute_values (
        id, tenant_id, owner_type, owner_id, catalog_entry_id, canonical_json,
        projected_index_json, classification, lifecycle_state, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_type = excluded.owner_type,
        owner_id = excluded.owner_id,
        catalog_entry_id = excluded.catalog_entry_id,
        canonical_json = excluded.canonical_json,
        projected_index_json = excluded.projected_index_json,
        classification = excluded.classification,
        lifecycle_state = excluded.lifecycle_state,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at`,
      [
        row.id,
        row.tenant_id,
        row.owner_type,
        row.owner_id,
        row.catalog_entry_id,
        row.canonical_json,
        row.projected_index_json,
        row.classification,
        row.lifecycle_state,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  async transitionStructuredAttributeValueLifecycle(
    structuredValueId: string,
    lifecycleState: IdentityLifecycleState
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const deletedAt = lifecycleState === 'deleted' || lifecycleState === 'deleting' ? now : null;
    const result = await this.adapter.execute(
      `UPDATE structured_attribute_values
          SET lifecycle_state = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [lifecycleState, now, deletedAt, structuredValueId, this.tenantId]
    );
    return result.rowsAffected > 0;
  }

  async createContactPoint(input: CreateContactPointInput): Promise<ContactPointRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ContactPointRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id ?? null,
      account_id: input.account_id ?? null,
      contact_type: input.contact_type,
      purpose: input.purpose ?? 'primary',
      normalized_hash: input.normalized_hash,
      value_storage_ref: input.value_storage_ref,
      display_label: input.display_label ?? null,
      is_primary: input.is_primary ? 1 : 0,
      verification_state: input.verification_state ?? 'unverified',
      lifecycle_state: input.lifecycle_state ?? 'active',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await this.adapter.execute(
      `INSERT INTO contact_points (
        id, tenant_id, subject_id, account_id, contact_type, purpose, normalized_hash,
        value_storage_ref, display_label, is_primary, verification_state, lifecycle_state,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.contact_type,
        row.purpose,
        row.normalized_hash,
        row.value_storage_ref,
        row.display_label,
        row.is_primary,
        row.verification_state,
        row.lifecycle_state,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  async upsertContactPoint(input: CreateContactPointInput): Promise<ContactPointRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ContactPointRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id ?? null,
      account_id: input.account_id ?? null,
      contact_type: input.contact_type,
      purpose: input.purpose ?? 'primary',
      normalized_hash: input.normalized_hash,
      value_storage_ref: input.value_storage_ref,
      display_label: input.display_label ?? null,
      is_primary: input.is_primary ? 1 : 0,
      verification_state: input.verification_state ?? 'unverified',
      lifecycle_state: input.lifecycle_state ?? 'active',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await this.adapter.execute(
      `INSERT INTO contact_points (
        id, tenant_id, subject_id, account_id, contact_type, purpose, normalized_hash,
        value_storage_ref, display_label, is_primary, verification_state, lifecycle_state,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        subject_id = excluded.subject_id,
        account_id = excluded.account_id,
        contact_type = excluded.contact_type,
        purpose = excluded.purpose,
        normalized_hash = excluded.normalized_hash,
        value_storage_ref = excluded.value_storage_ref,
        display_label = excluded.display_label,
        is_primary = excluded.is_primary,
        verification_state = excluded.verification_state,
        lifecycle_state = excluded.lifecycle_state,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.contact_type,
        row.purpose,
        row.normalized_hash,
        row.value_storage_ref,
        row.display_label,
        row.is_primary,
        row.verification_state,
        row.lifecycle_state,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  async findContactPointByNormalizedHash(
    normalizedHash: string,
    options?: { includeInactive?: boolean }
  ): Promise<ContactPointRow | null> {
    return this.adapter.queryOne<ContactPointRow>(
      `SELECT *
         FROM contact_points
        WHERE normalized_hash = ? AND tenant_id = ?${activeClause(options?.includeInactive)}
        LIMIT 1`,
      [normalizedHash, this.tenantId]
    );
  }

  async createContactVerification(
    input: CreateContactVerificationInput
  ): Promise<ContactVerificationRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ContactVerificationRow = {
      id,
      tenant_id: tenantId,
      contact_point_id: input.contact_point_id,
      verification_type: input.verification_type,
      verification_state: input.verification_state,
      evidence_ref: input.evidence_ref ?? null,
      verified_at: input.verified_at ?? null,
      expires_at: input.expires_at ?? null,
      revoked_at: input.revoked_at ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO contact_verifications (
        id, tenant_id, contact_point_id, verification_type, verification_state, evidence_ref,
        verified_at, expires_at, revoked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.contact_point_id,
        row.verification_type,
        row.verification_state,
        row.evidence_ref,
        row.verified_at,
        row.expires_at,
        row.revoked_at,
        row.created_at,
        row.updated_at,
      ]
    );
    return row;
  }

  async createIdentityBinding(input: CreateIdentityBindingInput): Promise<IdentityBindingRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: IdentityBindingRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id ?? null,
      account_id: input.account_id ?? null,
      protocol: input.protocol,
      source_id: input.source_id,
      provider_subject_key_hash: input.provider_subject_key_hash,
      binding_kind: input.binding_kind ?? 'external_subject',
      lifecycle_state: input.lifecycle_state ?? 'active',
      assurance_level: input.assurance_level ?? null,
      trust_context_snapshot_id: input.trust_context_snapshot_id ?? null,
      metadata_json: encodeJson(input.metadata),
      created_at: now,
      updated_at: now,
      deleted_at: null,
      last_seen_at: input.last_seen_at ?? null,
    };

    await this.adapter.execute(
      `INSERT INTO identity_bindings (
        id, tenant_id, subject_id, account_id, protocol, source_id, provider_subject_key_hash,
        binding_kind, lifecycle_state, assurance_level, trust_context_snapshot_id, metadata_json,
        created_at, updated_at, deleted_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.protocol,
        row.source_id,
        row.provider_subject_key_hash,
        row.binding_kind,
        row.lifecycle_state,
        row.assurance_level,
        row.trust_context_snapshot_id,
        row.metadata_json,
        row.created_at,
        row.updated_at,
        row.deleted_at,
        row.last_seen_at,
      ]
    );
    return row;
  }

  async findBindingByProviderSubjectHash(
    protocol: string,
    sourceId: string,
    providerSubjectKeyHash: string,
    options?: { includeInactive?: boolean }
  ): Promise<IdentityBindingRow | null> {
    return this.adapter.queryOne<IdentityBindingRow>(
      `SELECT *
         FROM identity_bindings
        WHERE protocol = ?
          AND source_id = ?
          AND provider_subject_key_hash = ?
          AND tenant_id = ?${activeClause(options?.includeInactive)}
        LIMIT 1`,
      [protocol, sourceId, providerSubjectKeyHash, this.tenantId]
    );
  }

  async recordResolutionEvent(
    input: RecordIdentityResolutionEventInput
  ): Promise<IdentityResolutionEventRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: IdentityResolutionEventRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id ?? null,
      account_id: input.account_id ?? null,
      binding_id: input.binding_id ?? null,
      source_id: input.source_id,
      resolution_method: input.resolution_method,
      outcome: input.outcome,
      reason_codes_json: encodeStringArray(input.reason_codes),
      trace_ref: input.trace_ref ?? null,
      metadata_json: encodeJson(input.metadata),
      created_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO identity_resolution_events (
        id, tenant_id, subject_id, account_id, binding_id, source_id, resolution_method,
        outcome, reason_codes_json, trace_ref, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.binding_id,
        row.source_id,
        row.resolution_method,
        row.outcome,
        row.reason_codes_json,
        row.trace_ref,
        row.metadata_json,
        row.created_at,
      ]
    );
    return row;
  }

  async createResolutionCandidate(
    input: CreateIdentityResolutionCandidateInput
  ): Promise<IdentityResolutionCandidateRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: IdentityResolutionCandidateRow = {
      id,
      tenant_id: tenantId,
      source_id: input.source_id,
      candidate_subject_id: input.candidate_subject_id ?? null,
      candidate_account_id: input.candidate_account_id ?? null,
      candidate_binding_id: input.candidate_binding_id ?? null,
      candidate_score: input.candidate_score,
      risk_tier: input.risk_tier ?? null,
      decision_state: input.decision_state ?? 'pending',
      reason_codes_json: encodeStringArray(input.reason_codes),
      review_task_id: input.review_task_id ?? null,
      created_at: now,
      updated_at: now,
      expires_at: input.expires_at ?? null,
    };

    await this.adapter.execute(
      `INSERT INTO identity_resolution_candidates (
        id, tenant_id, source_id, candidate_subject_id, candidate_account_id,
        candidate_binding_id, candidate_score, risk_tier, decision_state, reason_codes_json,
        review_task_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.source_id,
        row.candidate_subject_id,
        row.candidate_account_id,
        row.candidate_binding_id,
        row.candidate_score,
        row.risk_tier,
        row.decision_state,
        row.reason_codes_json,
        row.review_task_id,
        row.created_at,
        row.updated_at,
        row.expires_at,
      ]
    );
    return row;
  }

  async transitionResolutionCandidate(
    candidateId: string,
    decisionState: IdentityResolutionCandidateState
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE identity_resolution_candidates
          SET decision_state = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [decisionState, getCurrentTimestamp(), candidateId, this.tenantId]
    );
    return result.rowsAffected > 0;
  }

  async createAssuranceEvidence(
    input: CreateAssuranceEvidenceInput
  ): Promise<AssuranceEvidenceRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: AssuranceEvidenceRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id ?? null,
      account_id: input.account_id ?? null,
      binding_id: input.binding_id ?? null,
      evidence_type: input.evidence_type,
      assurance_level: input.assurance_level,
      evidence_ref: input.evidence_ref ?? null,
      issuer_ref: input.issuer_ref ?? null,
      issued_at: input.issued_at ?? null,
      expires_at: input.expires_at ?? null,
      revoked_at: input.revoked_at ?? null,
      metadata_json: encodeJson(input.metadata),
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO assurance_evidence (
        id, tenant_id, subject_id, account_id, binding_id, evidence_type, assurance_level,
        evidence_ref, issuer_ref, issued_at, expires_at, revoked_at, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.binding_id,
        row.evidence_type,
        row.assurance_level,
        row.evidence_ref,
        row.issuer_ref,
        row.issued_at,
        row.expires_at,
        row.revoked_at,
        row.metadata_json,
        row.created_at,
        row.updated_at,
      ]
    );
    return row;
  }

  async recordValueProvenance(input: CreateValueProvenanceInput): Promise<ValueProvenanceRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ValueProvenanceRow = {
      id,
      tenant_id: tenantId,
      owner_table: input.owner_table,
      owner_id: input.owner_id,
      source_id: input.source_id,
      source_record_id: input.source_record_id ?? null,
      source_field_ref: input.source_field_ref ?? null,
      source_authority_contract_id: input.source_authority_contract_id ?? null,
      observed_at: input.observed_at ?? now,
      confidence_score: input.confidence_score ?? null,
      provenance_json: encodeJson(input.provenance),
      created_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO value_provenance (
        id, tenant_id, owner_table, owner_id, source_id, source_record_id,
        source_field_ref, source_authority_contract_id, observed_at, confidence_score,
        provenance_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.owner_table,
        row.owner_id,
        row.source_id,
        row.source_record_id,
        row.source_field_ref,
        row.source_authority_contract_id,
        row.observed_at,
        row.confidence_score,
        row.provenance_json,
        row.created_at,
      ]
    );
    return row;
  }

  async recordSubjectLifecycleTimelineEvent(
    input: CreateSubjectLifecycleTimelineEventInput
  ): Promise<SubjectLifecycleTimelineEventRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: SubjectLifecycleTimelineEventRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id ?? null,
      account_id: input.account_id ?? null,
      event_type: input.event_type,
      source_type: input.source_type ?? null,
      source_id: input.source_id ?? null,
      summary_json: encodeJson(input.summary),
      event_at: input.event_at ?? now,
      created_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO subject_lifecycle_timeline_events (
        id, tenant_id, subject_id, account_id, event_type, source_type, source_id,
        summary_json, event_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.event_type,
        row.source_type,
        row.source_id,
        row.summary_json,
        row.event_at,
        row.created_at,
      ]
    );
    return row;
  }

  async createContactPointSearchIndex(
    input: CreateContactPointSearchIndexInput
  ): Promise<ContactPointSearchIndexRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ContactPointSearchIndexRow = {
      id,
      tenant_id: tenantId,
      contact_point_id: input.contact_point_id,
      index_kind: input.index_kind,
      index_value: input.index_value,
      index_version: input.index_version ?? 1,
      classification: input.classification ?? 'internal',
      status: input.status ?? 'active',
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO contact_point_search_indexes (
        id, tenant_id, contact_point_id, index_kind, index_value, index_version,
        classification, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.contact_point_id,
        row.index_kind,
        row.index_value,
        row.index_version,
        row.classification,
        row.status,
        row.created_at,
        row.updated_at,
      ]
    );
    return row;
  }

  async createIdentityBindingLookupIndex(
    input: CreateIdentityBindingLookupIndexInput
  ): Promise<IdentityBindingLookupIndexRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: IdentityBindingLookupIndexRow = {
      id,
      tenant_id: tenantId,
      identity_binding_id: input.identity_binding_id,
      lookup_kind: input.lookup_kind,
      lookup_value: input.lookup_value,
      lookup_version: input.lookup_version ?? 1,
      status: input.status ?? 'active',
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO identity_binding_lookup_indexes (
        id, tenant_id, identity_binding_id, lookup_kind, lookup_value, lookup_version,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.identity_binding_id,
        row.lookup_kind,
        row.lookup_value,
        row.lookup_version,
        row.status,
        row.created_at,
        row.updated_at,
      ]
    );
    return row;
  }

  private async insertSubject(
    executor: IdentityExecutor | TransactionContext,
    input: CreateIdentitySubjectInput
  ): Promise<IdentitySubjectRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: IdentitySubjectRow = {
      id,
      tenant_id: tenantId,
      subject_type: input.subject_type ?? 'person',
      lifecycle_state: input.lifecycle_state ?? 'active',
      display_label: input.display_label ?? null,
      primary_account_id: input.primary_account_id ?? null,
      risk_tier: input.risk_tier ?? null,
      assurance_level: input.assurance_level ?? null,
      metadata_json: encodeJson(input.metadata),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await executor.execute(
      `INSERT INTO identity_subjects (
        id, tenant_id, subject_type, lifecycle_state, display_label, primary_account_id,
        risk_tier, assurance_level, metadata_json, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_type,
        row.lifecycle_state,
        row.display_label,
        row.primary_account_id,
        row.risk_tier,
        row.assurance_level,
        row.metadata_json,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  private async insertAccount(
    executor: IdentityExecutor | TransactionContext,
    input: CreateIdentityAccountInput
  ): Promise<IdentityAccountRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: IdentityAccountRow = {
      id,
      tenant_id: tenantId,
      account_type: input.account_type ?? 'user',
      lifecycle_state: input.lifecycle_state ?? 'active',
      legacy_user_id: input.legacy_user_id ?? null,
      primary_subject_id: input.primary_subject_id ?? null,
      display_label: input.display_label ?? null,
      metadata_json: encodeJson(input.metadata),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await executor.execute(
      `INSERT INTO identity_accounts (
        id, tenant_id, account_type, lifecycle_state, legacy_user_id, primary_subject_id,
        display_label, metadata_json, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.account_type,
        row.lifecycle_state,
        row.legacy_user_id,
        row.primary_subject_id,
        row.display_label,
        row.metadata_json,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  private async insertSubjectAccountLink(
    executor: IdentityExecutor | TransactionContext,
    input: CreateSubjectAccountLinkInput
  ): Promise<SubjectAccountLinkRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: SubjectAccountLinkRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id,
      account_id: input.account_id,
      link_type: input.link_type ?? 'primary',
      lifecycle_state: input.lifecycle_state ?? 'active',
      source_ref: input.source_ref ?? null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await executor.execute(
      `INSERT INTO subject_account_links (
        id, tenant_id, subject_id, account_id, link_type, lifecycle_state, source_ref,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.link_type,
        row.lifecycle_state,
        row.source_ref,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }

  private async insertProfile(
    executor: IdentityExecutor | TransactionContext,
    input: CreateProfileInput
  ): Promise<ProfileRow> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    const tenantId = resolveTenantId(this.tenantId, input.tenant_id);
    const row: ProfileRow = {
      id,
      tenant_id: tenantId,
      subject_id: input.subject_id,
      profile_type: input.profile_type ?? 'person',
      lifecycle_state: input.lifecycle_state ?? 'active',
      locale: input.locale ?? null,
      zoneinfo: input.zoneinfo ?? null,
      display_name_ref: input.display_name_ref ?? null,
      metadata_json: encodeJson(input.metadata),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    await executor.execute(
      `INSERT INTO profiles (
        id, tenant_id, subject_id, profile_type, lifecycle_state, locale, zoneinfo,
        display_name_ref, metadata_json, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.profile_type,
        row.lifecycle_state,
        row.locale,
        row.zoneinfo,
        row.display_name_ref,
        row.metadata_json,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ]
    );
    return row;
  }
}
