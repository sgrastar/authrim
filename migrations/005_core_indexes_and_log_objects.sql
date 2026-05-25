-- =============================================================================
-- Authrim Core Baseline: Indexes and Log Objects
-- Consolidated for fresh Authrim installs from migrations/000_fresh_schema.sql.
-- =============================================================================
-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX idx_access_review_items_decision ON access_review_items(review_id, decision);

CREATE INDEX idx_access_review_items_review ON access_review_items(review_id);

CREATE INDEX idx_access_review_items_user ON access_review_items(tenant_id, user_id);

CREATE INDEX idx_access_reviews_created ON access_reviews(tenant_id, created_at);

CREATE INDEX idx_access_reviews_due ON access_reviews(tenant_id, due_date);

CREATE INDEX idx_access_reviews_reviewer ON access_reviews(tenant_id, reviewer_id);

CREATE INDEX idx_access_reviews_status ON access_reviews(tenant_id, status);

CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id);

CREATE INDEX idx_admin_jobs_cleanup ON admin_jobs(
  status,
  completed_at
);

CREATE INDEX idx_admin_jobs_status ON admin_jobs(
  tenant_id,
  status,
  created_at DESC
);

CREATE INDEX idx_admin_jobs_tenant ON admin_jobs(
  tenant_id,
  created_at DESC
);

CREATE INDEX idx_admin_jobs_type ON admin_jobs(
  tenant_id,
  job_type,
  created_at DESC
);

CREATE INDEX idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);

CREATE INDEX idx_ai_grants_active ON ai_grants(tenant_id, is_active);

CREATE INDEX idx_ai_grants_client ON ai_grants(tenant_id, client_id);

CREATE INDEX idx_ai_grants_expires ON ai_grants(expires_at);

CREATE INDEX idx_ai_grants_principal ON ai_grants(tenant_id, ai_principal);

CREATE INDEX idx_ai_grants_tenant ON ai_grants(tenant_id);

CREATE INDEX idx_attribute_verifications_result ON attribute_verifications(verification_result);

CREATE INDEX idx_attribute_verifications_user ON attribute_verifications(tenant_id, user_id);

CREATE INDEX idx_audit_log_action ON audit_log(action);

CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);

CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);

CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);

CREATE INDEX idx_check_api_keys_client
    ON check_api_keys(client_id);

CREATE UNIQUE INDEX idx_check_api_keys_hash
    ON check_api_keys(key_hash);

CREATE INDEX idx_check_api_keys_prefix
    ON check_api_keys(key_prefix);

CREATE INDEX idx_check_api_keys_tenant_active
    ON check_api_keys(tenant_id, is_active);

CREATE INDEX idx_ciba_client ON ciba_requests(tenant_id, client_id);

CREATE INDEX idx_ciba_status ON ciba_requests(tenant_id, status);

CREATE INDEX idx_ciba_user ON ciba_requests(tenant_id, user_id);

CREATE INDEX idx_clients_claims_setting ON oauth_clients(allow_claims_without_scope);

CREATE INDEX idx_clients_created_at ON oauth_clients(created_at);

CREATE INDEX idx_clients_software_id_tenant ON oauth_clients(software_id, tenant_id);

CREATE INDEX idx_clients_trusted ON oauth_clients(is_trusted);

CREATE INDEX idx_closure_ancestor_lookup
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, relation);

CREATE INDEX idx_closure_depth
  ON relationship_closure(tenant_id, depth);

CREATE INDEX idx_closure_descendant_lookup
  ON relationship_closure(tenant_id, descendant_type, descendant_id, relation);

CREATE UNIQUE INDEX idx_closure_unique
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, descendant_type, descendant_id, relation);

CREATE INDEX idx_compliance_reports_created ON compliance_reports(tenant_id, created_at);

CREATE INDEX idx_compliance_reports_requested ON compliance_reports(tenant_id, requested_by);

CREATE INDEX idx_compliance_reports_status ON compliance_reports(tenant_id, status);

CREATE INDEX idx_compliance_reports_tenant ON compliance_reports(tenant_id);

CREATE INDEX idx_compliance_reports_type ON compliance_reports(tenant_id, type);

CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id);

CREATE INDEX idx_cih_statement ON consent_item_history(statement_id, created_at);

CREATE INDEX idx_cih_tenant ON consent_item_history(tenant_id, created_at);

CREATE INDEX idx_cih_user ON consent_item_history(tenant_id, user_id, created_at);

CREATE INDEX idx_consent_history_action
  ON consent_history(action, created_at);

CREATE INDEX idx_consent_history_client
  ON consent_history(client_id, created_at);

CREATE INDEX idx_consent_history_tenant
  ON consent_history(tenant_id, created_at);

CREATE INDEX idx_consent_history_user
  ON consent_history(user_id, created_at);

CREATE INDEX idx_consent_policy_versions_effective
  ON consent_policy_versions(effective_at);

CREATE INDEX idx_consent_policy_versions_tenant
  ON consent_policy_versions(tenant_id, policy_type);

CREATE INDEX idx_consent_statements_tenant ON consent_statements(tenant_id, is_active);

CREATE INDEX idx_csl_version ON consent_statement_localizations(version_id, language);

CREATE INDEX idx_csv_effective ON consent_statement_versions(effective_at);

CREATE INDEX idx_csv_statement ON consent_statement_versions(statement_id, is_current);

CREATE UNIQUE INDEX idx_csv_unique_current
  ON consent_statement_versions(tenant_id, current_statement_guard);

CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id);

CREATE INDEX idx_consents_expires_at_active
  ON oauth_client_consents(expires_at);

CREATE INDEX idx_consents_user ON oauth_client_consents(tenant_id, user_id);

CREATE INDEX idx_credential_configurations_tenant ON credential_configurations(tenant_id);

CREATE INDEX idx_credential_offers_code ON credential_offers(pre_authorized_code);

CREATE INDEX idx_credential_offers_status ON credential_offers(tenant_id, status);

CREATE INDEX idx_data_export_expires
  ON data_export_requests(expires_at);

CREATE INDEX idx_data_export_status
  ON data_export_requests(status, requested_at);

CREATE INDEX idx_data_export_user
  ON data_export_requests(user_id, status);

CREATE INDEX idx_data_export_object_catalog
  ON data_export_requests(object_catalog_id);

CREATE INDEX idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC);

CREATE INDEX idx_object_catalog_deleted_at
  ON object_catalog(deleted_at);

CREATE INDEX idx_object_catalog_objects_catalog_repr
  ON object_catalog_objects(catalog_id, representation, object_index);

CREATE INDEX idx_object_catalog_objects_bucket_key
  ON object_catalog_objects(bucket_binding, object_key);

CREATE INDEX idx_object_catalog_objects_deleted_at
  ON object_catalog_objects(deleted_at);

CREATE INDEX idx_sensitive_detail_chunk_index_tenant_class
  ON sensitive_detail_chunk_index(tenant_id, object_class, created_at);

CREATE INDEX idx_sensitive_detail_chunk_index_object
  ON sensitive_detail_chunk_index(object_key, line_number);

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
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  deleted_at INTEGER
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
  event_at INTEGER NOT NULL,
  index_profile TEXT NOT NULL,
  indexed_fields TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
  created_at INTEGER NOT NULL,
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
  bucket_start_at INTEGER NOT NULL,
  bucket_end_at INTEGER NOT NULL,
  shard TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);

CREATE INDEX idx_device_codes_client_id ON device_codes(tenant_id, client_id);

CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);

CREATE INDEX idx_device_codes_status ON device_codes(tenant_id, status);

CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);

CREATE INDEX idx_did_document_cache_expires ON did_document_cache(expires_at);

CREATE INDEX idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at);

CREATE INDEX idx_external_idp_auth_states_expires_at
  ON external_idp_auth_states(expires_at);

CREATE INDEX idx_external_idp_auth_states_state
  ON external_idp_auth_states(state);

CREATE INDEX idx_flows_builtin ON flows(is_builtin);

CREATE INDEX idx_flows_client ON flows(tenant_id, client_id);

CREATE INDEX idx_flows_lookup ON flows(tenant_id, client_id, profile_id, is_active);

CREATE INDEX idx_flows_profile ON flows(tenant_id, profile_id);

CREATE INDEX idx_flows_tenant ON flows(tenant_id, is_active);

CREATE INDEX idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);

CREATE INDEX idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key);

CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type);

CREATE INDEX idx_saml_attribute_presets_tenant ON saml_attribute_presets(tenant_id, created_at DESC);
CREATE INDEX idx_saml_attribute_presets_applies_to ON saml_attribute_presets(tenant_id, applies_to);

CREATE INDEX idx_issued_credentials_status ON issued_credentials(tenant_id, status);

CREATE INDEX idx_issued_credentials_type ON issued_credentials(tenant_id, credential_type);

CREATE INDEX idx_issued_credentials_user ON issued_credentials(tenant_id, user_id);

CREATE INDEX idx_issued_credentials_status_list
    ON issued_credentials(tenant_id, status_list_internal_id, status_list_index);

CREATE INDEX idx_linked_identities_provider ON linked_identities(tenant_id, provider_id);

CREATE INDEX idx_linked_identities_provider_sub ON linked_identities(tenant_id, provider_id, provider_user_id);

CREATE INDEX idx_linked_identities_tenant_provider_user
    ON linked_identities(tenant_id, provider_id, provider_user_id);

CREATE INDEX idx_linked_identities_user ON linked_identities(tenant_id, user_id);

CREATE INDEX idx_linked_identities_tenant_user ON linked_identities(tenant_id, user_id);

CREATE INDEX idx_membership_org ON subject_org_membership(tenant_id, org_id);

CREATE INDEX idx_membership_subject ON subject_org_membership(tenant_id, subject_id);

CREATE INDEX idx_oauth_clients_tenant_id ON oauth_clients(tenant_id);

CREATE INDEX idx_odm_lookup ON org_domain_mappings(
  tenant_id,
  domain_hash,
  is_active,
  verified DESC,
  priority DESC
);

CREATE INDEX idx_odm_org ON org_domain_mappings(org_id);

CREATE INDEX idx_odm_verification_status ON org_domain_mappings(
  verification_status,
  verification_expires_at
);

CREATE INDEX idx_odm_version ON org_domain_mappings(domain_hash_version);

CREATE INDEX idx_operational_logs_actor
    ON operational_logs(actor_id);

CREATE INDEX idx_operational_logs_detail_object_catalog
    ON operational_logs(detail_object_catalog_id);

CREATE INDEX idx_operational_logs_expires
    ON operational_logs(expires_at);

CREATE INDEX idx_operational_logs_subject
    ON operational_logs(subject_type, subject_id);

CREATE INDEX idx_operational_logs_tenant_created
    ON operational_logs(tenant_id, created_at DESC);

CREATE INDEX idx_organizations_is_active ON organizations(is_active);

CREATE INDEX idx_organizations_org_type ON organizations(org_type);

CREATE INDEX idx_organizations_parent_org_id ON organizations(parent_org_id);

CREATE INDEX idx_organizations_tenant_id ON organizations(tenant_id);

CREATE UNIQUE INDEX idx_organizations_tenant_name ON organizations(tenant_id, name);

CREATE INDEX idx_passkeys_tenant ON passkeys(tenant_id);

CREATE INDEX idx_passkeys_user ON passkeys(tenant_id, user_id);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(tenant_id, user_id);

CREATE INDEX idx_pca_api_key
    ON permission_check_audit(api_key_id);

CREATE INDEX idx_pca_checked_at
    ON permission_check_audit(checked_at);

CREATE INDEX idx_pca_denied
    ON permission_check_audit(tenant_id, final_decision);

CREATE INDEX idx_pca_tenant_subject
    ON permission_check_audit(tenant_id, subject_id);

CREATE INDEX idx_pcaudit_event_type
    ON permission_change_audit(tenant_id, event_type);

CREATE INDEX idx_pcaudit_tenant_subject
    ON permission_change_audit(tenant_id, subject_id);

CREATE INDEX idx_pcaudit_timestamp
    ON permission_change_audit(timestamp);

CREATE INDEX idx_policy_rules_priority ON policy_rules(tenant_id, priority DESC);

CREATE INDEX idx_policy_rules_tenant ON policy_rules(tenant_id, enabled);

CREATE INDEX idx_policy_simulations_tenant ON policy_simulations(tenant_id, simulated_at DESC);

CREATE INDEX idx_presentation_definitions_tenant ON presentation_definitions(tenant_id);

CREATE INDEX idx_rar_evaluation ON role_assignment_rules(
  tenant_id,
  is_active,
  priority DESC
);

CREATE INDEX idx_rar_role ON role_assignment_rules(role_id);

CREATE INDEX idx_relation_defs_active
  ON relation_definitions(tenant_id, is_active);

CREATE INDEX idx_relation_defs_lookup
  ON relation_definitions(tenant_id, object_type, relation_name);

CREATE INDEX idx_relation_defs_tenant_object
  ON relation_definitions(tenant_id, object_type);

CREATE UNIQUE INDEX idx_relation_defs_unique
  ON relation_definitions(tenant_id, object_type, relation_name);

CREATE INDEX idx_relationships_evidence_type
  ON relationships(tenant_id, evidence_type);

CREATE INDEX idx_relationships_expires_at ON relationships(expires_at);

CREATE INDEX idx_relationships_from ON relationships(tenant_id, from_type, from_id);

CREATE INDEX idx_relationships_tenant_id ON relationships(tenant_id);

CREATE INDEX idx_relationships_to ON relationships(tenant_id, to_type, to_id);

CREATE INDEX idx_relationships_type ON relationships(tenant_id, relationship_type);

CREATE UNIQUE INDEX idx_relationships_unique
  ON relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);

CREATE INDEX idx_role_assignments_role ON role_assignments(tenant_id, role_id);

CREATE INDEX idx_role_assignments_subject ON role_assignments(tenant_id, subject_id);

CREATE INDEX idx_roles_hierarchy_level ON roles(hierarchy_level);

CREATE INDEX idx_roles_name ON roles(tenant_id, name);

CREATE INDEX idx_roles_parent_role_id ON roles(tenant_id, parent_role_id);

CREATE INDEX idx_roles_role_type ON roles(role_type);

CREATE INDEX idx_roles_tenant_id ON roles(tenant_id);

CREATE INDEX idx_rp_expires ON resource_permissions(expires_at);

CREATE INDEX idx_rp_lookup ON resource_permissions(
  tenant_id,
  subject_type,
  subject_id,
  resource_type,
  is_active
);

CREATE INDEX idx_rp_resource ON resource_permissions(
  tenant_id,
  resource_type,
  resource_id,
  is_active
);

CREATE INDEX idx_rtsc_activated_at
  ON refresh_token_shard_configs(activated_at);

CREATE INDEX idx_rtsc_generation
  ON refresh_token_shard_configs(generation);

CREATE INDEX idx_rtsc_tenant_client
  ON refresh_token_shard_configs(tenant_id, client_id);

CREATE INDEX idx_schema_migrations_applied_at ON schema_migrations(applied_at DESC);

CREATE INDEX idx_schema_migrations_checksum ON schema_migrations(checksum);

CREATE INDEX idx_scope_mappings_scope ON scope_mappings(tenant_id, scope);

CREATE INDEX idx_security_alerts_tenant_created
    ON security_alerts(tenant_id, created_at DESC);

CREATE INDEX idx_security_alerts_tenant_severity
    ON security_alerts(tenant_id, severity);

CREATE INDEX idx_security_alerts_tenant_status
    ON security_alerts(tenant_id, status);

CREATE INDEX idx_security_alerts_tenant_type
    ON security_alerts(tenant_id, type);

CREATE INDEX idx_security_alerts_user
    ON security_alerts(user_id);

CREATE INDEX idx_security_threats_detected ON security_threats(tenant_id, detected_at);

CREATE INDEX idx_security_threats_severity ON security_threats(tenant_id, severity);

CREATE INDEX idx_security_threats_status ON security_threats(tenant_id, status);

CREATE INDEX idx_security_threats_tenant ON security_threats(tenant_id);

CREATE INDEX idx_security_threats_type ON security_threats(tenant_id, type);

CREATE INDEX idx_session_clients_client_id ON session_clients(tenant_id, client_id);

CREATE INDEX idx_session_clients_last_seen_at ON session_clients(last_seen_at);

CREATE INDEX idx_session_clients_session_id ON session_clients(tenant_id, session_id);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);

CREATE INDEX idx_sessions_user ON sessions(tenant_id, user_id);

CREATE INDEX idx_settings_history_actor ON settings_history(
  actor_id,
  created_at DESC
);

CREATE INDEX idx_settings_history_category ON settings_history(
  tenant_id,
  category,
  version DESC
);

CREATE INDEX idx_settings_history_cleanup ON settings_history(
  tenant_id,
  category,
  created_at
);

CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id);
CREATE INDEX idx_status_lists_tenant_public ON status_lists(tenant_id, public_id);

CREATE INDEX idx_subject_identifiers_lookup
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

CREATE INDEX idx_subject_identifiers_primary
  ON subject_identifiers(tenant_id, subject_id, is_primary);

CREATE INDEX idx_subject_identifiers_tenant_subject
  ON subject_identifiers(tenant_id, subject_id);

CREATE UNIQUE INDEX idx_subject_identifiers_unique
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

CREATE INDEX idx_suspicious_activities_created ON suspicious_activities(tenant_id, created_at);

CREATE INDEX idx_suspicious_activities_severity ON suspicious_activities(tenant_id, severity);

CREATE INDEX idx_suspicious_activities_tenant ON suspicious_activities(tenant_id);

CREATE INDEX idx_suspicious_activities_type ON suspicious_activities(tenant_id, type);

CREATE INDEX idx_suspicious_activities_user ON suspicious_activities(tenant_id, user_id);

CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id);

CREATE INDEX idx_tcr_evaluation ON token_claim_rules(
  tenant_id,
  token_type,
  is_active,
  priority DESC,
  created_at ASC
);

CREATE INDEX idx_token_families_client ON user_token_families(tenant_id, client_id);

CREATE INDEX idx_token_families_user ON user_token_families(tenant_id, user_id);

CREATE INDEX idx_trusted_issuers_did ON trusted_issuers(issuer_did);

CREATE INDEX idx_trusted_issuers_tenant ON trusted_issuers(tenant_id);

CREATE INDEX idx_upstream_providers_enabled
  ON upstream_providers(tenant_id, enabled);

CREATE INDEX idx_upstream_providers_tenant_id
  ON upstream_providers(tenant_id);

CREATE UNIQUE INDEX idx_upstream_providers_tenant_name
  ON upstream_providers(tenant_id, name);

CREATE UNIQUE INDEX idx_upstream_providers_tenant_slug
  ON upstream_providers(tenant_id, slug);

CREATE INDEX idx_upstream_providers_enable_sso
  ON upstream_providers(tenant_id, enable_sso);

CREATE INDEX idx_ucr_expires ON user_consent_records(expires_at);

CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);

CREATE INDEX idx_ucr_status ON user_consent_records(status);

CREATE INDEX idx_ucr_user ON user_consent_records(tenant_id, user_id);

CREATE INDEX idx_user_verified_attributes_name ON user_verified_attributes(tenant_id, attribute_name);

CREATE INDEX idx_user_verified_attributes_user ON user_verified_attributes(tenant_id, user_id);

CREATE INDEX idx_users_core_email_domain ON users_core(email_domain_hash);

CREATE INDEX idx_users_core_partition ON users_core(pii_partition);

CREATE INDEX idx_users_core_pii_status ON users_core(pii_status);

CREATE INDEX idx_users_core_status ON users_core(tenant_id, status);

CREATE INDEX idx_users_core_tenant ON users_core(tenant_id);

CREATE INDEX idx_users_core_tenant_external_id ON users_core(tenant_id, external_id);

CREATE INDEX idx_users_core_type ON users_core(tenant_id, user_type);

CREATE INDEX idx_users_created_at ON users(created_at);

CREATE UNIQUE INDEX idx_users_tenant_email ON users(tenant_id, email);

CREATE INDEX idx_users_tenant_id ON users(tenant_id);

CREATE INDEX idx_users_tenant_status ON users(tenant_id, status);

CREATE INDEX idx_users_user_type ON users(user_type);

CREATE INDEX idx_verified_attributes_expires
  ON verified_attributes(tenant_id, expires_at);

CREATE INDEX idx_verified_attributes_lookup
  ON verified_attributes(tenant_id, subject_id, attribute_name);

CREATE INDEX idx_verified_attributes_source
  ON verified_attributes(tenant_id, source);

CREATE INDEX idx_verified_attributes_tenant_subject
  ON verified_attributes(tenant_id, subject_id);

CREATE INDEX idx_verified_attributes_unique_check
  ON verified_attributes(tenant_id, subject_id, attribute_name, source);

CREATE INDEX idx_vp_requests_nonce ON vp_requests(nonce);

CREATE INDEX idx_vp_requests_tenant_status ON vp_requests(tenant_id, status);

CREATE INDEX idx_webhook_configs_active ON webhook_configs(tenant_id, active);

CREATE INDEX idx_webhook_configs_client ON webhook_configs(tenant_id, client_id);

CREATE INDEX idx_webhook_configs_scope ON webhook_configs(tenant_id, scope);

CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id);

CREATE INDEX idx_webhook_delivery_logs_created ON webhook_delivery_logs(created_at);

CREATE INDEX idx_webhook_delivery_logs_event ON webhook_delivery_logs(event_id);

CREATE INDEX idx_webhook_delivery_logs_tenant ON webhook_delivery_logs(tenant_id);

CREATE INDEX idx_webhook_delivery_logs_webhook ON webhook_delivery_logs(webhook_id);

CREATE INDEX idx_webhook_deliveries_detail_object_catalog
  ON webhook_deliveries(detail_object_catalog_id);

CREATE INDEX idx_webhook_deliveries_status_created
  ON webhook_deliveries(status, created_at DESC);

CREATE INDEX idx_webhook_deliveries_tenant_created
  ON webhook_deliveries(tenant_id, created_at DESC);

CREATE INDEX idx_webhook_deliveries_webhook_created
  ON webhook_deliveries(webhook_id, created_at DESC);

CREATE INDEX idx_ws_subs_active
    ON websocket_subscriptions(is_active);

CREATE INDEX idx_ws_subs_connection
    ON websocket_subscriptions(connection_id);

CREATE INDEX idx_ws_subs_subject
    ON websocket_subscriptions(subject_id, is_active);
