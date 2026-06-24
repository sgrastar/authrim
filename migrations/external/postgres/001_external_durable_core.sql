-- Authrim external durable core schema for PostgreSQL.
-- Runtime support is intentionally gated separately; this migration reserves the
-- shared external durable layout used by future core/authorization adapters.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  execution_time_ms INTEGER,
  rollback_sql TEXT
);

CREATE TABLE IF NOT EXISTS identity_subjects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  display_label TEXT,
  primary_account_id TEXT,
  risk_tier TEXT,
  assurance_level TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_identity_subjects_tenant_type
  ON identity_subjects(tenant_id, subject_type, lifecycle_state);

CREATE TABLE IF NOT EXISTS identity_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  account_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  legacy_user_id TEXT,
  primary_subject_id TEXT,
  display_label TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT identity_accounts_subject_fk
    FOREIGN KEY (primary_subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_legacy_user
  ON identity_accounts(tenant_id, legacy_user_id);
CREATE INDEX IF NOT EXISTS idx_identity_accounts_tenant_state
  ON identity_accounts(tenant_id, account_type, lifecycle_state);

CREATE TABLE IF NOT EXISTS subject_account_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'primary',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  source_ref TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT subject_account_links_unique_link UNIQUE (tenant_id, subject_id, account_id, link_type),
  CONSTRAINT subject_account_links_subject_fk
    FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  CONSTRAINT subject_account_links_account_fk
    FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subject_account_links_account
  ON subject_account_links(tenant_id, account_id, lifecycle_state);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  profile_type TEXT NOT NULL DEFAULT 'person',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  locale TEXT,
  zoneinfo TEXT,
  display_name_ref TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT profiles_unique_subject_type UNIQUE (tenant_id, subject_id, profile_type),
  CONSTRAINT profiles_subject_fk FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_attribute_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT,
  value_storage_ref TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  purpose TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT profile_attribute_values_profile_fk
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_attribute_values_profile
  ON profile_attribute_values(tenant_id, profile_id, catalog_entry_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_profile_attribute_values_hash
  ON profile_attribute_values(tenant_id, catalog_entry_id, value_hash, lifecycle_state);

CREATE TABLE IF NOT EXISTS structured_attribute_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  projected_index_json TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_structured_attribute_values_owner
  ON structured_attribute_values(tenant_id, owner_type, owner_id, catalog_entry_id);

CREATE TABLE IF NOT EXISTS contact_points (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  contact_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'primary',
  normalized_hash TEXT,
  value_storage_ref TEXT,
  display_label TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT contact_points_subject_fk
    FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  CONSTRAINT contact_points_account_fk
    FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_points_subject
  ON contact_points(tenant_id, subject_id, contact_type, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_contact_points_lookup
  ON contact_points(tenant_id, contact_type, normalized_hash);

CREATE TABLE IF NOT EXISTS contact_verifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_point_id TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  evidence_ref TEXT,
  verified_at BIGINT,
  expires_at BIGINT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT contact_verifications_contact_fk
    FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_verifications_contact
  ON contact_verifications(tenant_id, contact_point_id, verification_state);

CREATE TABLE IF NOT EXISTS identity_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  protocol TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider_subject_key_hash TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT 'external_subject',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  assurance_level TEXT,
  trust_context_snapshot_id TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  last_seen_at BIGINT,
  CONSTRAINT identity_bindings_unique_provider_subject
    UNIQUE (tenant_id, protocol, source_id, provider_subject_key_hash),
  CONSTRAINT identity_bindings_subject_fk
    FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  CONSTRAINT identity_bindings_account_fk
    FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_bindings_subject
  ON identity_bindings(tenant_id, subject_id, lifecycle_state);

CREATE TABLE IF NOT EXISTS identity_resolution_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  binding_id TEXT,
  source_id TEXT NOT NULL,
  resolution_method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  CONSTRAINT identity_resolution_events_subject_fk
    FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL,
  CONSTRAINT identity_resolution_events_account_fk
    FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL,
  CONSTRAINT identity_resolution_events_binding_fk
    FOREIGN KEY (binding_id) REFERENCES identity_bindings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_resolution_events_subject
  ON identity_resolution_events(tenant_id, subject_id, created_at);

CREATE TABLE IF NOT EXISTS identity_resolution_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  candidate_subject_id TEXT,
  candidate_account_id TEXT,
  candidate_binding_id TEXT,
  candidate_score INTEGER NOT NULL DEFAULT 0,
  risk_tier TEXT,
  decision_state TEXT NOT NULL DEFAULT 'pending',
  reason_codes_json TEXT,
  review_task_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_resolution_candidates_state
  ON identity_resolution_candidates(tenant_id, decision_state, created_at);

CREATE TABLE IF NOT EXISTS users_core (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_number_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_domain_hash TEXT,
  email_domain_hash_version INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  user_type TEXT NOT NULL DEFAULT 'end_user',
  pii_partition TEXT NOT NULL DEFAULT 'default',
  pii_status TEXT NOT NULL DEFAULT 'pending',
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  suspended_at BIGINT,
  suspended_until BIGINT,
  locked_at BIGINT,
  locked_until BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_login_at BIGINT,
  CONSTRAINT users_core_status_check CHECK (status IN ('active', 'suspended', 'locked')),
  CONSTRAINT users_core_lifecycle_state_check CHECK (
    lifecycle_state IN (
      'invited',
      'pending_verification',
      'provisioning',
      'incomplete',
      'active',
      'dormant',
      'archived',
      'deprovisioned'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_users_core_tenant
  ON users_core(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_core_tenant_active
  ON users_core(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_users_core_domain_hash
  ON users_core(tenant_id, email_domain_hash, email_domain_hash_version);
CREATE INDEX IF NOT EXISTS idx_users_core_external_id
  ON users_core(tenant_id, external_id);
CREATE INDEX IF NOT EXISTS idx_users_core_status
  ON users_core(tenant_id, status);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  aaguid TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  CONSTRAINT passkeys_unique_credential UNIQUE(tenant_id, credential_id)
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user
  ON passkeys(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_credential
  ON passkeys(tenant_id, credential_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'custom',
  hierarchy_level INTEGER NOT NULL DEFAULT 0,
  is_assignable BOOLEAN NOT NULL DEFAULT TRUE,
  parent_role_id TEXT,
  display_name TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT,
  CONSTRAINT roles_unique_name UNIQUE(tenant_id, name),
  CONSTRAINT roles_parent_fk FOREIGN KEY (parent_role_id) REFERENCES roles(id)
);

CREATE INDEX IF NOT EXISTS idx_roles_tenant_type
  ON roles(tenant_id, role_type);

CREATE TABLE IF NOT EXISTS role_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at BIGINT,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT role_assignments_subject_fk FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  CONSTRAINT role_assignments_role_fk FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_role_assignments_subject
  ON role_assignments(tenant_id, subject_id, scope_type, scope_target);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role
  ON role_assignments(tenant_id, role_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_expires
  ON role_assignments(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  relationship_type TEXT NOT NULL,
  from_type TEXT NOT NULL DEFAULT 'subject',
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL DEFAULT 'subject',
  to_id TEXT NOT NULL,
  permission_level TEXT NOT NULL DEFAULT 'full',
  expires_at BIGINT,
  is_bidirectional BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json TEXT,
  evidence_type TEXT DEFAULT 'manual',
  evidence_ref TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relationships_from
  ON relationships(tenant_id, from_type, from_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_to
  ON relationships(tenant_id, to_type, to_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_expires
  ON relationships(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS oauth_client_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  granted_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT oauth_client_consents_unique_client UNIQUE(tenant_id, user_id, client_id),
  CONSTRAINT oauth_client_consents_user_fk FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_consents_user
  ON oauth_client_consents(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_client_consents_client
  ON oauth_client_consents(tenant_id, client_id);

CREATE TABLE IF NOT EXISTS consent_statements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'custom',
  legal_basis TEXT NOT NULL DEFAULT 'consent',
  processing_purpose TEXT,
  display_order BIGINT NOT NULL DEFAULT 0,
  is_active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_statements_unique_slug UNIQUE(tenant_id, slug)
);

ALTER TABLE consent_statements ADD COLUMN IF NOT EXISTS record_retention_days BIGINT;
ALTER TABLE consent_statements ADD COLUMN IF NOT EXISTS withdrawal_allowed BIGINT NOT NULL DEFAULT 1;
ALTER TABLE consent_statements ADD COLUMN IF NOT EXISTS withdrawal_impact TEXT;
ALTER TABLE consent_statements ADD COLUMN IF NOT EXISTS reconsent_on_version_change BIGINT NOT NULL DEFAULT 1;
ALTER TABLE consent_statements ADD COLUMN IF NOT EXISTS reconsent_interval_days BIGINT;

CREATE TABLE IF NOT EXISTS consent_statement_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'url',
  effective_at BIGINT NOT NULL,
  effective_until BIGINT,
  content_hash TEXT,
  is_current BIGINT NOT NULL DEFAULT 0,
  current_statement_guard TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_statement_versions_unique_version UNIQUE(tenant_id, statement_id, version),
  CONSTRAINT consent_statement_versions_statement_fk FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_consent_statement_versions_statement
  ON consent_statement_versions(tenant_id, statement_id, is_current);
CREATE INDEX IF NOT EXISTS idx_consent_statement_versions_effective
  ON consent_statement_versions(effective_at);
ALTER TABLE consent_statement_versions ADD COLUMN IF NOT EXISTS effective_until BIGINT;

CREATE TABLE IF NOT EXISTS consent_statement_localizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version_id TEXT NOT NULL,
  language TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  processing_purpose TEXT,
  withdrawal_impact TEXT,
  document_url TEXT,
  inline_content TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_statement_localizations_unique_language UNIQUE(version_id, language),
  CONSTRAINT consent_statement_localizations_version_fk FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE CASCADE
);

ALTER TABLE consent_statement_localizations ADD COLUMN IF NOT EXISTS processing_purpose TEXT;
ALTER TABLE consent_statement_localizations ADD COLUMN IF NOT EXISTS withdrawal_impact TEXT;

CREATE INDEX IF NOT EXISTS idx_consent_statement_localizations_version
  ON consent_statement_localizations(version_id, language);

CREATE TABLE IF NOT EXISTS consent_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  is_active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_policies_unique_name UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS consent_policy_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'required',
  version_mode TEXT NOT NULL DEFAULT 'current',
  version_id TEXT,
  min_version TEXT,
  checkbox_mode TEXT NOT NULL DEFAULT 'required',
  checkbox_default_checked BIGINT NOT NULL DEFAULT 0,
  binding_type TEXT,
  binding_value TEXT,
  evidence_profile TEXT,
  language_fallback TEXT,
  display_order BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_policy_items_unique_statement UNIQUE(tenant_id, policy_id, statement_id),
  CONSTRAINT consent_policy_items_policy_fk FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_consent_policy_items_policy
  ON consent_policy_items(tenant_id, policy_id, display_order);

CREATE TABLE IF NOT EXISTS consent_policy_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  assignment_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  policy_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_policy_assignments_unique_target UNIQUE(tenant_id, assignment_type, target_id),
  CONSTRAINT consent_policy_assignments_policy_fk FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_consent_policy_assignments_policy
  ON consent_policy_assignments(tenant_id, policy_id);

CREATE TABLE IF NOT EXISTS client_trust_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  first_party BIGINT NOT NULL DEFAULT 0,
  trusted BIGINT NOT NULL DEFAULT 0,
  skip_authorization_consent BIGINT NOT NULL DEFAULT 0,
  is_active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT client_trust_policies_unique_name UNIQUE(tenant_id, name),
  CONSTRAINT client_trust_policies_unique_target UNIQUE(tenant_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_client_trust_policies_target
  ON client_trust_policies(tenant_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS sign_in_confirmation_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'login',
  mode TEXT NOT NULL DEFAULT 'disabled',
  remember_duration_days BIGINT NOT NULL DEFAULT 365,
  show_application_context BIGINT NOT NULL DEFAULT 1,
  show_tenant_context BIGINT NOT NULL DEFAULT 1,
  is_active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT sign_in_confirmation_policies_unique_name UNIQUE(tenant_id, name),
  CONSTRAINT sign_in_confirmation_policies_unique_trigger UNIQUE(tenant_id, trigger_type)
);

CREATE TABLE IF NOT EXISTS user_consent_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  granted_at BIGINT,
  withdrawn_at BIGINT,
  expires_at BIGINT,
  retain_until BIGINT,
  consent_settings_snapshot_at BIGINT,
  record_retention_days_snapshot BIGINT,
  reconsent_interval_days_snapshot BIGINT,
  client_id TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  receipt_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT user_consent_records_unique_statement UNIQUE(tenant_id, user_id, statement_id),
  CONSTRAINT user_consent_records_user_fk FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_consent_records_user
  ON user_consent_records(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_consent_records_status
  ON user_consent_records(tenant_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_consent_records_retain_until
  ON user_consent_records(retain_until);

CREATE TABLE IF NOT EXISTS consent_item_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version_id_before TEXT,
  version_id_after TEXT,
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  granted_at BIGINT,
  withdrawn_at BIGINT,
  expires_at BIGINT,
  retain_until BIGINT,
  consent_settings_snapshot_at BIGINT,
  record_retention_days_snapshot BIGINT,
  reconsent_interval_days_snapshot BIGINT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_item_history_user
  ON consent_item_history(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_item_history_statement
  ON consent_item_history(statement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_item_history_retain_until
  ON consent_item_history(retain_until);

CREATE TABLE IF NOT EXISTS user_custom_fields (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_name TEXT NOT NULL,
  field_value TEXT,
  field_type TEXT,
  searchable BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT user_custom_fields_pk PRIMARY KEY (tenant_id, user_id, field_name),
  CONSTRAINT user_custom_fields_user_fk FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_custom_fields_search
  ON user_custom_fields(tenant_id, field_name, field_value);

CREATE TABLE IF NOT EXISTS custom_claim_schemas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  active_field_key TEXT,
  display_label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'string',
  is_pii BOOLEAN NOT NULL DEFAULT FALSE,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  validation_rules JSONB,
  include_in_id_token BOOLEAN NOT NULL DEFAULT FALSE,
  include_in_userinfo BOOLEAN NOT NULL DEFAULT FALSE,
  include_in_introspection BOOLEAN NOT NULL DEFAULT FALSE,
  required_scopes JSONB,
  scope_mode TEXT NOT NULL DEFAULT 'any',
  is_searchable BOOLEAN NOT NULL DEFAULT TRUE,
  is_exportable BOOLEAN NOT NULL DEFAULT TRUE,
  is_vc_claim BOOLEAN NOT NULL DEFAULT FALSE,
  claim_namespace TEXT,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  operation_status TEXT NOT NULL DEFAULT 'active',
  operation_detail TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  show_on_registration BOOLEAN NOT NULL DEFAULT FALSE,
  registration_required BOOLEAN NOT NULL DEFAULT FALSE,
  registration_order INTEGER NOT NULL DEFAULT 0,
  registration_placeholder TEXT,
  ui_group_key TEXT,
  ui_group_label TEXT,
  ui_group_order INTEGER NOT NULL DEFAULT 0,
  ui_field_order INTEGER NOT NULL DEFAULT 0,
  examples_json JSONB,
  CONSTRAINT custom_claim_schemas_active_key UNIQUE(tenant_id, active_field_key),
  CONSTRAINT custom_claim_schemas_scope_mode_check CHECK (scope_mode IN ('all', 'any'))
);

CREATE INDEX IF NOT EXISTS idx_custom_claim_schemas_tenant_active
  ON custom_claim_schemas(tenant_id, is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_custom_claim_schemas_tenant_key
  ON custom_claim_schemas(tenant_id, field_key);
CREATE INDEX IF NOT EXISTS idx_custom_claim_schemas_operation
  ON custom_claim_schemas(tenant_id, operation_status);

CREATE TABLE IF NOT EXISTS custom_claim_schema_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  schema_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  changes JSONB NOT NULL,
  actor_id TEXT,
  actor_type TEXT,
  change_source TEXT,
  created_at BIGINT NOT NULL,
  CONSTRAINT custom_claim_schema_history_unique_version UNIQUE(tenant_id, schema_id, version),
  CONSTRAINT custom_claim_schema_history_operation_check CHECK (
    operation IN ('create', 'update', 'delete', 'rename', 'toggle_active')
  ),
  CONSTRAINT custom_claim_schema_history_actor_type_check CHECK (
    actor_type IS NULL OR actor_type IN ('user', 'admin', 'system', 'api')
  ),
  CONSTRAINT custom_claim_schema_history_change_source_check CHECK (
    change_source IS NULL OR change_source IN ('admin_api', 'admin_ui', 'migration', 'rollback')
  )
);

CREATE INDEX IF NOT EXISTS idx_custom_claim_schema_history_schema
  ON custom_claim_schema_history(tenant_id, schema_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_custom_claim_schema_history_cleanup
  ON custom_claim_schema_history(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS field_usage_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  binding_type TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  protection TEXT NOT NULL DEFAULT 'warn',
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'admin',
  metadata_json JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT field_usage_bindings_unique_binding
    UNIQUE(tenant_id, field_key, binding_type, binding_id),
  CONSTRAINT field_usage_bindings_binding_type_check CHECK (
    binding_type IN (
      'authentication_method',
      'notification',
      'discovery',
      'consent',
      'policy',
      'protocol_output',
      'display',
      'ui',
      'custom'
    )
  ),
  CONSTRAINT field_usage_bindings_protection_check CHECK (
    protection IN ('none', 'warn', 'delete_blocked')
  ),
  CONSTRAINT field_usage_bindings_source_check CHECK (
    source IN ('system', 'admin', 'derived', 'migration')
  )
);

CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_tenant_field
  ON field_usage_bindings(tenant_id, field_key, is_active);
CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_binding
  ON field_usage_bindings(tenant_id, binding_type, binding_id, is_active);
CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_protection
  ON field_usage_bindings(tenant_id, protection, is_active);

CREATE TABLE IF NOT EXISTS verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  issuer TEXT,
  credential_id TEXT,
  verified_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT verified_attributes_unique_name UNIQUE(tenant_id, subject_id, attribute_name)
);

CREATE INDEX IF NOT EXISTS idx_verified_attributes_subject
  ON verified_attributes(tenant_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_verified_attributes_name
  ON verified_attributes(tenant_id, attribute_name);

CREATE TABLE IF NOT EXISTS log_object_catalog (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('chunk', 'manifest', 'dlq_payload', 'export_artifact')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'orphan_candidate', 'deleted')),
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  compression TEXT CHECK (compression IN ('none', 'gzip_block')),
  encryption_scope TEXT,
  key_version INTEGER,
  created_at BIGINT NOT NULL,
  committed_at BIGINT,
  deleted_at BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_object_catalog_object_key
  ON log_object_catalog(object_key);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_status
  ON log_object_catalog(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_record_index (
  record_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  line_number INTEGER,
  block_offset INTEGER,
  block_length INTEGER,
  record_offset INTEGER,
  record_length INTEGER,
  event_at BIGINT NOT NULL,
  index_profile TEXT NOT NULL,
  indexed_fields JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_key, log_type, plane, record_id)
);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_time
  ON log_chunk_record_index(tenant_key, log_type, plane, event_at);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_object
  ON log_chunk_record_index(object_catalog_id);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_status
  ON log_chunk_record_index(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_manifests (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  bucket_start_at BIGINT NOT NULL,
  bucket_end_at BIGINT NOT NULL,
  shard TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);
