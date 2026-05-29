-- =============================================================================
-- Unified Identity Mapping: control-plane schema baseline
--
-- This migration adds policy, catalog, federation, review, activation, and key
-- control-plane tables. Runtime paths remain disabled until later rollout PRs.
-- Each object is linked to schema-readiness-inventory.md by UIM-SCH-* comments.
-- =============================================================================

-- UIM-SCH-016 mapping_policy_sets
CREATE TABLE IF NOT EXISTS mapping_policy_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_key)
);

-- UIM-SCH-017 mapping_policy_versions
CREATE TABLE IF NOT EXISTS mapping_policy_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_set_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  policy_hash TEXT NOT NULL,
  compatibility_range TEXT,
  author_id TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_set_id, version_label),
  FOREIGN KEY (policy_set_id) REFERENCES mapping_policy_sets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mapping_policy_versions_state
  ON mapping_policy_versions(tenant_id, lifecycle_state, updated_at);

-- UIM-SCH-018 mapping_rules
CREATE TABLE IF NOT EXISTS mapping_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_version_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  scope_json TEXT,
  condition_json TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_version_id, rule_key),
  FOREIGN KEY (policy_version_id) REFERENCES mapping_policy_versions(id) ON DELETE CASCADE
);

-- UIM-SCH-019 mapping_rule_edges
CREATE TABLE IF NOT EXISTS mapping_rule_edges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  target_ref_json TEXT NOT NULL,
  edge_kind TEXT NOT NULL DEFAULT 'direct',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE
);

-- UIM-SCH-020 mapping_transform_steps
CREATE TABLE IF NOT EXISTS mapping_transform_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT NOT NULL,
  edge_id TEXT,
  step_order INTEGER NOT NULL,
  operation TEXT NOT NULL,
  parameters_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, rule_id, edge_id, step_order),
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE,
  FOREIGN KEY (edge_id) REFERENCES mapping_rule_edges(id) ON DELETE CASCADE
);

-- UIM-SCH-021 mapping_validation_rules
CREATE TABLE IF NOT EXISTS mapping_validation_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT,
  target_ref_json TEXT NOT NULL,
  validation_kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  parameters_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES mapping_rules(id) ON DELETE CASCADE
);

-- UIM-SCH-022 mapping_release_rules
CREATE TABLE IF NOT EXISTS mapping_release_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_version_id TEXT NOT NULL,
  destination_type TEXT NOT NULL,
  destination_id TEXT,
  source_ref_json TEXT NOT NULL,
  release_action TEXT NOT NULL,
  legal_basis TEXT,
  purpose TEXT,
  condition_json TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_version_id) REFERENCES mapping_policy_versions(id) ON DELETE CASCADE
);

-- UIM-SCH-023 mapping_conflict_rules
CREATE TABLE IF NOT EXISTS mapping_conflict_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_version_id TEXT NOT NULL,
  target_ref_json TEXT NOT NULL,
  conflict_strategy TEXT NOT NULL,
  source_priority_json TEXT,
  condition_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_version_id) REFERENCES mapping_policy_versions(id) ON DELETE CASCADE
);

-- UIM-SCH-024 mapping_policy_activations
CREATE TABLE IF NOT EXISTS mapping_policy_activations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_set_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  activation_scope_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'scheduled',
  active_from INTEGER,
  active_until INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_set_id) REFERENCES mapping_policy_sets(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_version_id) REFERENCES mapping_policy_versions(id) ON DELETE CASCADE
);

-- UIM-SCH-025 compiled_mapping_snapshots
CREATE TABLE IF NOT EXISTS compiled_mapping_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_version_id TEXT NOT NULL,
  catalog_version_id TEXT,
  snapshot_hash TEXT NOT NULL,
  compatibility_range TEXT,
  artifact_ref TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  compiled_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  metadata_json TEXT,
  FOREIGN KEY (policy_version_id) REFERENCES mapping_policy_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_compiled_mapping_snapshots_state
  ON compiled_mapping_snapshots(tenant_id, lifecycle_state, activated_at);

-- UIM-SCH-026 field_catalogs
CREATE TABLE IF NOT EXISTS field_catalogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_key)
);

-- UIM-SCH-027 field_catalog_versions
CREATE TABLE IF NOT EXISTS field_catalog_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  compatibility_range TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_id, version_label),
  FOREIGN KEY (catalog_id) REFERENCES field_catalogs(id) ON DELETE CASCADE
);

-- UIM-SCH-028 field_catalog_entries
CREATE TABLE IF NOT EXISTS field_catalog_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_version_id TEXT NOT NULL,
  stable_field_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  path TEXT NOT NULL,
  target_taxonomy TEXT NOT NULL,
  value_type TEXT NOT NULL,
  cardinality TEXT NOT NULL DEFAULT 'single',
  classification TEXT NOT NULL DEFAULT 'internal',
  aliases_json TEXT,
  validation_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, catalog_version_id, stable_field_id),
  FOREIGN KEY (catalog_version_id) REFERENCES field_catalog_versions(id) ON DELETE CASCADE
);

-- UIM-SCH-029 custom_field_catalog_entries
CREATE TABLE IF NOT EXISTS custom_field_catalog_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  catalog_entry_id TEXT,
  custom_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  value_type TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, custom_key)
);

-- UIM-SCH-030 protocol_schema_catalogs
CREATE TABLE IF NOT EXISTS protocol_schema_catalogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  protocol TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  schema_version TEXT,
  schema_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, protocol, schema_key, schema_version)
);

-- UIM-SCH-031 external_schema_catalogs
CREATE TABLE IF NOT EXISTS external_schema_catalogs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-032 mapping_templates
CREATE TABLE IF NOT EXISTS mapping_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  template_key TEXT NOT NULL,
  template_scope TEXT NOT NULL DEFAULT 'system',
  display_name TEXT NOT NULL,
  template_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, template_key)
);

-- UIM-SCH-033 source_authority_contracts
CREATE TABLE IF NOT EXISTS source_authority_contracts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  field_ref_json TEXT NOT NULL,
  authority_actions_json TEXT NOT NULL,
  condition_json TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-034 mapping_events
CREATE TABLE IF NOT EXISTS mapping_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  policy_version_id TEXT,
  subject_id TEXT,
  source_id TEXT,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);

-- UIM-SCH-036 projection_outbox
CREATE TABLE IF NOT EXISTS projection_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  subject_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-037 projection_jobs
CREATE TABLE IF NOT EXISTS projection_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  job_type TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-038 replay_jobs
CREATE TABLE IF NOT EXISTS replay_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  replay_type TEXT NOT NULL,
  impact_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  result_summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-039 dependency_graph_snapshots
CREATE TABLE IF NOT EXISTS dependency_graph_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_version_id TEXT,
  snapshot_hash TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- UIM-SCH-040 tenant_discovery_indexes adjustments
ALTER TABLE tenant_discovery_indexes ADD COLUMN mapping_snapshot_id TEXT;
ALTER TABLE tenant_discovery_indexes ADD COLUMN source_projection_version TEXT;

-- UIM-SCH-043 admin_search_projections
CREATE TABLE IF NOT EXISTS admin_search_projections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  projection_kind TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  indexed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-044 review_tasks
CREATE TABLE IF NOT EXISTS review_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_type TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  payload_json TEXT NOT NULL,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-045 review_task_groups
CREATE TABLE IF NOT EXISTS review_task_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
);

-- UIM-SCH-046 operational_notification_states
CREATE TABLE IF NOT EXISTS operational_notification_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  notification_event_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-047 mapping_activation_leases
CREATE TABLE IF NOT EXISTS mapping_activation_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  lease_key TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lease_key)
);

-- UIM-SCH-048 idempotency_records
CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  idempotency_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_ref TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, operation_key, idempotency_key)
);

-- UIM-SCH-049 key_registries
CREATE TABLE IF NOT EXISTS key_registries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_purpose TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  active_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-050 key_versions
CREATE TABLE IF NOT EXISTS key_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  algorithm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  UNIQUE (tenant_id, key_registry_id, version),
  FOREIGN KEY (key_registry_id) REFERENCES key_registries(id) ON DELETE CASCADE
);

-- UIM-SCH-051 key_material_refs
CREATE TABLE IF NOT EXISTS key_material_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_version_id TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  material_ref TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (key_version_id) REFERENCES key_versions(id) ON DELETE CASCADE
);

-- UIM-SCH-052 key_access_events
CREATE TABLE IF NOT EXISTS key_access_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  key_version_id TEXT,
  actor_id TEXT,
  access_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- UIM-SCH-053 blind_index_rotation_jobs
CREATE TABLE IF NOT EXISTS blind_index_rotation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-054 rewrap_jobs
CREATE TABLE IF NOT EXISTS rewrap_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key_registry_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT NOT NULL,
  artifact_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-055 recovery_sets
CREATE TABLE IF NOT EXISTS recovery_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  recovery_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  manifest_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-056 recovery_set_artifacts
CREATE TABLE IF NOT EXISTS recovery_set_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  recovery_set_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  checksum TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (recovery_set_id) REFERENCES recovery_sets(id) ON DELETE CASCADE
);

-- UIM-SCH-057 restore_validation_jobs
CREATE TABLE IF NOT EXISTS restore_validation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  recovery_set_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-058 quota_policies
CREATE TABLE IF NOT EXISTS quota_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  artifact_class TEXT NOT NULL,
  quota_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, artifact_class)
);

-- UIM-SCH-059 quota_usage_snapshots
CREATE TABLE IF NOT EXISTS quota_usage_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  artifact_class TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- UIM-SCH-060 retention_cleanup_jobs
CREATE TABLE IF NOT EXISTS retention_cleanup_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  retention_scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-071 federation_trust_sources
CREATE TABLE IF NOT EXISTS federation_trust_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  protocol_payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, source_type, source_key)
);

-- UIM-SCH-072 federation_trust_anchors
CREATE TABLE IF NOT EXISTS federation_trust_anchors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  anchor_type TEXT NOT NULL,
  anchor_hash TEXT NOT NULL,
  anchor_ref TEXT,
  not_before INTEGER,
  not_after INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE
);

-- UIM-SCH-073 federation_metadata_documents
CREATE TABLE IF NOT EXISTS federation_metadata_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  source_url TEXT,
  document_hash TEXT NOT NULL,
  document_ref TEXT,
  fetched_at INTEGER,
  validated_at INTEGER,
  validation_state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE
);

-- UIM-SCH-074 federation_entity_statements
CREATE TABLE IF NOT EXISTS federation_entity_statements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  statement_hash TEXT NOT NULL,
  statement_ref TEXT,
  expires_at INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-075 federation_trust_chains
CREATE TABLE IF NOT EXISTS federation_trust_chains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  subject TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  chain_json TEXT,
  validation_state TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-076 legacy SAML federation trust profile storage is intentionally removed.
-- Normalized federation_trust_sources are the canonical trust profile source of truth.

-- UIM-SCH-077 federation_metadata_refresh_jobs
CREATE TABLE IF NOT EXISTS federation_metadata_refresh_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  refresh_mode TEXT NOT NULL DEFAULT 'manual',
  scheduled_for INTEGER,
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-078 federation_metadata_validation_events
CREATE TABLE IF NOT EXISTS federation_metadata_validation_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT,
  metadata_document_id TEXT,
  validation_state TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);

-- UIM-SCH-079 federation_trust_context_snapshots
CREATE TABLE IF NOT EXISTS federation_trust_context_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  trust_context_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  activated_at INTEGER
);

-- UIM-SCH-080 federation_trust_rank_profiles
CREATE TABLE IF NOT EXISTS federation_trust_rank_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  rank_model_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);

-- UIM-SCH-081 federation_trust_fail_policies
CREATE TABLE IF NOT EXISTS federation_trust_fail_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_key TEXT NOT NULL,
  state_policy_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_key)
);

-- UIM-SCH-082 federation_trust_scope_bindings
CREATE TABLE IF NOT EXISTS federation_trust_scope_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- UIM-SCH-083 federation_metadata_entity_summaries
CREATE TABLE IF NOT EXISTS federation_metadata_entity_summaries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  metadata_document_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_role TEXT NOT NULL,
  display_name TEXT,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, metadata_document_id, entity_id, entity_role)
);

-- UIM-SCH-084 federation_selected_entity_import_events
CREATE TABLE IF NOT EXISTS federation_selected_entity_import_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  metadata_entity_summary_id TEXT,
  provider_id TEXT,
  import_action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
);
