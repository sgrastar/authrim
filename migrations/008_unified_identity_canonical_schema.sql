-- =============================================================================
-- Unified Identity Mapping: canonical identity schema baseline
--
-- Runtime writes remain disabled until the canonical cutover PR. Each schema
-- object is linked to private/docs/design/unified-identity-mapping-control-plane/
-- schema-readiness-inventory.md by UIM-SCH-* comments.
-- =============================================================================

-- UIM-SCH-001 identity_subjects
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_identity_subjects_tenant_type
  ON identity_subjects(tenant_id, subject_type, lifecycle_state);

-- UIM-SCH-002 identity_accounts
CREATE TABLE IF NOT EXISTS identity_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  account_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  legacy_user_id TEXT,
  primary_subject_id TEXT,
  display_label TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (primary_subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_legacy_user
  ON identity_accounts(tenant_id, legacy_user_id);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_tenant_state
  ON identity_accounts(tenant_id, account_type, lifecycle_state);

-- UIM-SCH-003 subject_account_links
CREATE TABLE IF NOT EXISTS subject_account_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'primary',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, subject_id, account_id, link_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subject_account_links_account
  ON subject_account_links(tenant_id, account_id, lifecycle_state);

-- UIM-SCH-004 profiles
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, subject_id, profile_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE
);

-- UIM-SCH-005 profile_attribute_values
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
  is_primary INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_attribute_values_profile
  ON profile_attribute_values(tenant_id, profile_id, catalog_entry_id, lifecycle_state);

-- UIM-SCH-006 structured_attribute_values
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_structured_attribute_values_owner
  ON structured_attribute_values(tenant_id, owner_type, owner_id, catalog_entry_id);

-- UIM-SCH-007 contact_points
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
  is_primary INTEGER NOT NULL DEFAULT 0,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_points_subject
  ON contact_points(tenant_id, subject_id, contact_type, lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_contact_points_lookup
  ON contact_points(tenant_id, contact_type, normalized_hash);

-- UIM-SCH-008 contact_verifications
CREATE TABLE IF NOT EXISTS contact_verifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_point_id TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  evidence_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_verifications_contact
  ON contact_verifications(tenant_id, contact_point_id, verification_state);

-- UIM-SCH-009 identity_bindings
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  UNIQUE (tenant_id, protocol, source_id, provider_subject_key_hash),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_bindings_subject
  ON identity_bindings(tenant_id, subject_id, lifecycle_state);

-- UIM-SCH-010 identity_resolution_events
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
  created_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (binding_id) REFERENCES identity_bindings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_resolution_events_subject
  ON identity_resolution_events(tenant_id, subject_id, created_at);

-- UIM-SCH-011 identity_resolution_candidates
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_resolution_candidates_state
  ON identity_resolution_candidates(tenant_id, decision_state, created_at);

-- UIM-SCH-012 subject_identifiers
ALTER TABLE subject_identifiers ADD COLUMN destination_type TEXT DEFAULT 'global';
ALTER TABLE subject_identifiers ADD COLUMN destination_id TEXT DEFAULT 'default';
ALTER TABLE subject_identifiers ADD COLUMN identifier_value_hash TEXT;
ALTER TABLE subject_identifiers ADD COLUMN identifier_storage_ref TEXT;
ALTER TABLE subject_identifiers ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_subject_identifiers_destination
  ON subject_identifiers(tenant_id, subject_id, destination_type, lifecycle_state);

-- UIM-SCH-013 assurance_evidence
CREATE TABLE IF NOT EXISTS assurance_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  binding_id TEXT,
  evidence_type TEXT NOT NULL,
  issuer_ref TEXT,
  assurance_framework TEXT,
  assurance_level TEXT,
  evidence_hash TEXT,
  evidence_storage_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assurance_evidence_subject
  ON assurance_evidence(tenant_id, subject_id, evidence_type, expires_at);

-- UIM-SCH-014 delegations
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  delegate_subject_id TEXT NOT NULL,
  parent_delegation_id TEXT,
  chain_id TEXT,
  delegation_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  scope_json TEXT,
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-015 entitlements
CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  entitlement_type TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  source_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  value_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, entitlement_type, entitlement_key, subject_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_entitlements_subject
  ON entitlements(tenant_id, subject_id, entitlement_type, lifecycle_state);

-- UIM-SCH-035 value_provenance
CREATE TABLE IF NOT EXISTS value_provenance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_table TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_record_id TEXT,
  source_field_ref TEXT,
  source_authority_contract_id TEXT,
  observed_at INTEGER NOT NULL,
  confidence_score INTEGER,
  provenance_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_value_provenance_owner
  ON value_provenance(tenant_id, owner_table, owner_id, observed_at);

-- UIM-SCH-041 contact_point_search_indexes
CREATE TABLE IF NOT EXISTS contact_point_search_indexes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_point_id TEXT NOT NULL,
  index_kind TEXT NOT NULL,
  index_value TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1,
  classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, index_kind, index_value, index_version),
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
);

-- UIM-SCH-042 identity_binding_lookup_indexes
CREATE TABLE IF NOT EXISTS identity_binding_lookup_indexes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  identity_binding_id TEXT NOT NULL,
  lookup_kind TEXT NOT NULL,
  lookup_value TEXT NOT NULL,
  lookup_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lookup_kind, lookup_value, lookup_version),
  FOREIGN KEY (identity_binding_id) REFERENCES identity_bindings(id) ON DELETE CASCADE
);

-- UIM-SCH-061 groups
CREATE TABLE IF NOT EXISTS "groups" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  parent_group_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
);

CREATE INDEX IF NOT EXISTS idx_groups_tenant_state
  ON "groups"(tenant_id, lifecycle_state, display_name);

-- UIM-SCH-062 group_memberships
CREATE TABLE IF NOT EXISTS group_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  membership_type TEXT NOT NULL DEFAULT 'member',
  assignment_source TEXT NOT NULL DEFAULT 'manual',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_id, subject_id, account_id, membership_type),
  FOREIGN KEY (group_id) REFERENCES "groups"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_memberships_subject
  ON group_memberships(tenant_id, subject_id, lifecycle_state);

-- UIM-SCH-063 provisioning_assignment_rules
CREATE TABLE IF NOT EXISTS provisioning_assignment_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  rule_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-064 provisioning_assignment_events
CREATE TABLE IF NOT EXISTS provisioning_assignment_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT,
  subject_id TEXT,
  account_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);

-- UIM-SCH-065 org_domain_mappings migration
ALTER TABLE org_domain_mappings ADD COLUMN group_id TEXT;
ALTER TABLE org_domain_mappings ADD COLUMN provisioning_assignment_rule_id TEXT;
ALTER TABLE org_domain_mappings ADD COLUMN org_to_group_migration_state TEXT DEFAULT 'pending';

-- UIM-SCH-066 provisioning_assignment_ownership
CREATE TABLE IF NOT EXISTS provisioning_assignment_ownership (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  assignment_type TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  source_id TEXT,
  ownership_policy TEXT NOT NULL DEFAULT 'source_owned',
  revoke_policy TEXT NOT NULL DEFAULT 'review',
  protected_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, assignment_type, assignment_id, source_id)
);

-- UIM-SCH-067 provisioning_revocation_events
CREATE TABLE IF NOT EXISTS provisioning_revocation_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  source_event_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
);

-- UIM-SCH-068 external_lifecycle_signal_events
CREATE TABLE IF NOT EXISTS external_lifecycle_signal_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_timestamp INTEGER,
  observed_at INTEGER NOT NULL,
  binding_version TEXT,
  payload_ref TEXT,
  signal_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, source_type, source_id, dedupe_key)
);

-- UIM-SCH-069 external_lifecycle_signal_decisions
CREATE TABLE IF NOT EXISTS external_lifecycle_signal_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  signal_event_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  decision TEXT NOT NULL,
  propagation_targets_json TEXT,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (signal_event_id) REFERENCES external_lifecycle_signal_events(id) ON DELETE CASCADE
);

-- UIM-SCH-070 subject_lifecycle_timeline_events
CREATE TABLE IF NOT EXISTS subject_lifecycle_timeline_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  event_type TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  summary_json TEXT,
  event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subject_lifecycle_timeline_subject
  ON subject_lifecycle_timeline_events(tenant_id, subject_id, event_at);

-- UIM-SCH-088 attribute_release_consents
CREATE TABLE IF NOT EXISTS attribute_release_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  destination_type TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  attribute_set_hash TEXT NOT NULL,
  consent_mode TEXT NOT NULL,
  consent_state TEXT NOT NULL DEFAULT 'granted',
  consent_record_id TEXT,
  first_granted_at INTEGER,
  last_confirmed_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
);

CREATE INDEX IF NOT EXISTS idx_attribute_release_consents_destination
  ON attribute_release_consents(tenant_id, destination_type, destination_id, consent_state);
