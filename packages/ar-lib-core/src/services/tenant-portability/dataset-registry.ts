import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract.js';

/** Dataset intent, not an authorization grant or a claim that an adapter is implemented. */
export type TenantDatasetKind =
  | 'tenant_state'
  | 'settings'
  | 'users'
  | 'admin'
  | 'audit'
  | 'history'
  | 'sensitive_logs'
  | 'delivery_state'
  | 'log_dependencies'
  | 'artifacts'
  | 'external'
  | 'rebuild'
  | 'ephemeral';

export interface TenantDatasetPolicy {
  family: MigrationSchemaFamily;
  table: string;
  kind: TenantDatasetKind;
}

export interface TenantDatasetRowPartition {
  family: MigrationSchemaFamily;
  table: string;
  column: string;
  values: readonly {
    value: string;
    kind: Extract<TenantDatasetKind, 'settings' | 'users' | 'admin'>;
  }[];
}

// Explicit lists make new tables fail the inventory check instead of silently disappearing.
// Logical families are shared across physical backends; schema/adapter parity is verified separately.
const TABLE_GROUPS: Partial<
  Record<MigrationSchemaFamily, Partial<Record<TenantDatasetKind, string>>>
> = {
  core: {
    delivery_state: 'internal_notification_delivery_attempts internal_notification_events',
    settings: `
      application_launchers branding_settings check_api_keys client_consent_overrides
      client_trust_policies consent_policies consent_policy_items consent_policy_versions
      consent_statement_localizations consent_statement_versions consent_statements credential_configurations
      custom_claim_schemas directory_auth_retention_policies directory_auth_tenant_policies directory_connector_instances
      field_usage_bindings flow_assignments flow_versions flows
      groups identity_providers internal_notification_delivery_routes logging_quota_policies
      lookup_retention_policies oauth_clients oidc_scopes org_domain_mappings
      organizations policy_rules presentation_definitions profile_registry provisioning_assignment_rules
      relation_definitions resource_permissions role_assignment_rules roles
      saml_attribute_presets scope_mappings screens sign_in_confirmation_policies
      status_lists tenant_consent_requirements tenant_domain_mappings tenant_vanity_domains
      tenants token_claim_rules trusted_issuers upstream_providers
      web_origin_registry webhook_configs
    `,
    users: `
      account_creation_operations account_legal_hold_states account_lifecycle_event_outbox account_webhook_outbox
      assurance_evidence attribute_release_consents attribute_verifications consent_records
      contact_points contact_verifications delegations device_installations
      device_secrets directory_auth_migration_transactions directory_auth_migration_user_states directory_identity_links
      directory_jit_pending_users entitlements external_lifecycle_signal_decisions group_memberships
      guest_account_lifecycle guest_account_upgrades guest_deletion_audit_outbox guest_devices
      idempotency_keys identity_accounts identity_bindings identity_resolution_candidates
      identity_subjects issued_credentials launcher_favorites legal_holds
      notification_delivery_intents oauth_client_consents passkeys plugin_account_metadata
      plugin_account_metadata_mutations plugin_hook_outbox profile_attribute_values
      profiles provisioning_assignment_ownership relationships role_assignments
      service_group_inputs service_group_manual service_group_write_boundaries structured_attribute_values subject_account_links
      subject_org_membership tenant_invitations totp_backup_codes totp_credentials
      user_consent_records user_custom_fields user_roles user_token_families
      user_verified_attributes users users_core value_provenance
      webhook_deliveries
    `,
    admin: `
      access_review_items access_reviews account_support_contexts admin_jobs
      compliance_reports data_export_requests directory_auth_evidence_exports directory_auth_migration_campaigns
      directory_auth_release_advisories directory_auth_support_bundles logging_catalog_repair_jobs logging_quota_evaluations
      logging_usage_aggregates policy_simulations security_alerts security_threats
      support_operation_actions support_operation_cohort_targets support_operation_cohorts suspicious_activities
    `,
    audit: `
      audit_log permission_change_audit permission_check_audit plugin_account_metadata_audit
      service_group_audit
    `,
    history: `
      consent_history consent_item_history custom_claim_schema_history directory_auth_config_history
      directory_auth_migration_transaction_events directory_connector_status_episodes event_log external_lifecycle_signal_events
      flow_audit_events identity_resolution_events
      legal_hold_events operational_logs provisioning_assignment_events provisioning_revocation_events
      settings_history subject_lifecycle_timeline_events webhook_delivery_logs
    `,
    log_dependencies: `
      log_chunk_manifests log_chunk_record_index log_object_catalog sensitive_detail_chunk_index
    `,
    artifacts: `
      object_catalog object_catalog_objects
    `,
    rebuild: `
      authrim_migrations migration_metadata tenant_database_migration_state
      account_routing_outbox authrim_control_plane_shard_metadata contact_point_search_indexes did_document_cache
      identity_binding_lookup_indexes legal_hold_projection_outbox lookup_retention_policy_projection_outbox refresh_token_shard_configs
      relationship_closure service_group_catalog service_group_epoch service_group_results
      service_group_revisions service_group_scans tenant_database_probe_results
      tenant_placement_migration_captures tenant_placement_migration_outbox
    `,
    ephemeral: `tenant_backup_restore_targets tenant_backup_snapshots tenant_backup_preimages
      authrim_runtime_probes
      ciba_requests credential_offers device_codes external_idp_auth_states
      flow_interaction_steps flow_interactions password_reset_tokens sessions
      vp_requests
    `,
  },
  pii: {
    users: `
      account_webhook_delivery_fields account_webhook_outbox account_webhook_snapshots external_identifier_unlink_operations
      guest_upgrade_operations identity_identifier_replacement_operations identity_sensitive_values linked_identities
      pairwise_subject_identifiers service_group_inputs service_group_write_boundaries subject_identifiers user_anonymization_map
      users_pii users_pii_tombstone
    `,
    sensitive_logs: `
      audit_log_pii pii_log identity_identifier_replacement_history
    `,
    rebuild: `
      authrim_migrations migration_metadata tenant_database_migration_state
      authrim_control_plane_shard_metadata identity_identifier_replacement_outbox identity_identifier_replacement_projections
      tenant_placement_migration_captures tenant_placement_migration_outbox
    `,
    ephemeral: `tenant_backup_restore_targets tenant_backup_snapshots tenant_backup_preimages
      authrim_runtime_probes
      identity_identifier_replacement_challenges
    `,
  },
  admin: {
    // Includes canonical route_status and quarantine denial state in metadata_json.
    // Keep source evidence; the target adapter rebuilds physical cache generations.
    tenant_state: 'tenant_runtime_cache_generations',
    delivery_state: 'internal_notification_delivery_attempts internal_notification_events',
    admin: `
      admin_agent_grants admin_agent_token_revocation_outbox admin_attribute_values admin_attributes
      admin_audit_coverage_status admin_database_connection_usages admin_external_token_refresh_runs admin_external_token_refresh_tenant_runs
      admin_invitations admin_jobs admin_machine_credential_permissions
      admin_machine_credential_tenant_scopes admin_machine_credentials admin_machine_principal_permissions admin_machine_principal_tenant_scopes
      admin_machine_principals admin_machine_resource_scopes admin_passkeys admin_relationships
      admin_role_assignments admin_storage_destination_usages admin_users agent_bulk_plans
      agent_bulk_tenant_executions agent_configuration_plan_steps agent_configuration_plans agent_consents
      agent_management_executions agent_plan_confirmations approval_request_approvals approval_requests
      blind_index_rotation_jobs idempotency_records logging_catalog_repair_jobs logging_dlq_items
      logging_export_jobs logging_message_export_builds logging_message_idempotency_keys logging_message_jobs
      logging_message_repair_findings logging_quota_evaluations logging_rewrap_jobs logging_usage_aggregates
      operational_notification_states replay_jobs review_task_groups review_tasks
      rewrap_jobs
    `,
    settings: `
      admin_destination_capabilities admin_destinations admin_ip_allowlist admin_logging_critical_policies
      admin_logging_sensitive_detail_policies admin_policies admin_rebac_definitions admin_roles
      agent_baseline_assignments agent_baseline_exceptions agent_baselines agent_configuration_templates
      agent_scope_policies agent_scope_policy_versions agent_secret_refs agent_task_set_versions
      agent_task_sets agent_template_copies attribute_field_registry attribute_group_registry
      compiled_mapping_snapshots credential_profile_versions credential_profiles credential_secret_bodies credential_secret_metadata
      custom_field_catalog_entries dependency_graph_snapshots destination_profile_versions destination_profiles external_schema_catalogs
      federation_entity_statements federation_metadata_documents federation_metadata_entity_summaries federation_saml_runtime_entities
      federation_trust_anchors federation_trust_chains federation_trust_context_snapshots federation_trust_scope_bindings federation_trust_sources
      field_catalog_entries field_catalog_versions field_catalogs field_mapping_activations
      field_mapping_sets field_mapping_versions internal_notification_delivery_routes key_material_refs
      key_registries key_versions logging_destination_overrides logging_fallback_policies
      logging_key_material_bodies logging_key_registry logging_key_versions logging_policy_snapshots
      logging_quota_policies mapping_conflict_rules mapping_release_rules mapping_rule_edges
      mapping_rules mapping_templates mapping_transform_steps mapping_validation_rules
      persistent_identifier_profiles protocol_schema_catalogs source_authority_contracts source_profile_parse_drafts
      source_profile_versions source_profiles storage_destination_assignments tenant_settings_documents
    `,
    audit: `
      admin_audit_log key_access_events
    `,
    history: `
      admin_destination_health_events admin_login_attempts federation_metadata_validation_events federation_selected_entity_import_events
       logging_delivery_event_aggregates logging_delivery_events
      logging_destination_override_history mapping_events
    `,
    log_dependencies: `
      log_chunk_manifests log_chunk_record_index log_object_catalog sensitive_detail_chunk_index
    `,
    artifacts: `
      object_catalog object_catalog_objects
    `,
    external: `
      admin_database_connections admin_storage_destinations
    `,
    rebuild: `
      authrim_migrations migration_metadata
      admin_search_projections federation_metadata_refresh_jobs
      identifier_replacement_scheduler_state mapping_activation_leases projection_jobs
      projection_outbox provider_reprojection_jobs provider_reprojection_tenant_state scheduled_task_leases
      tenant_database_active_pointers tenant_database_migration_state tenant_database_probe_results tenant_database_registry
      tenant_database_stats tenant_discovery_indexes tenant_placement_migration_jobs tenant_provisioning_operation_steps
      tenant_provisioning_operations tenant_runtime_registry_snapshots
    `,
    ephemeral: `tenant_backup_restore_targets tenant_backup_snapshots tenant_backup_preimages
      authrim_runtime_probes
      admin_agent_delegation_jtis admin_agent_login_handoffs admin_agent_mcp_sessions admin_agent_token_families
      admin_machine_assertion_jti admin_sessions admin_setup_tokens agent_elevation_challenges
      tenant_backup_uploads tenant_backup_upload_parts tenant_backup_operation_inputs tenant_backup_export_manifests tenant_backup_publications tenant_backup_input_validations tenant_backup_dataset_inspections tenant_backup_input_receipts tenant_backup_cipher_streams tenant_backup_cipher_frames tenant_backup_snapshot_resources tenant_backup_execution_inventories tenant_backup_execution_inventory_items tenant_backup_restore_plan_inventories tenant_backup_restore_plan_inventory_items tenant_backup_restore_cleanup_receipts admin_invitation_enrollments elevation_grants tenant_backup_artifact_attempts tenant_backup_artifact_parts tenant_backup_operations tenant_backup_key_handoffs tenant_backup_validation_sessions
      tenant_backup_validation_records tenant_backup_validation_references
    `,
  },
  control: {
    settings: `
      control_tenant_placement_policies
    `,
    audit: `
      control_audit_events
    `,
    users: `
      control_account_legal_hold_projections
    `,
    external: `
      control_environment_resource_policies control_environments control_external_capability_bindings control_external_capability_sources
      control_plugin_desired_resources control_read_replication_policies control_residency_partitions control_signing_key_metadata
      control_signing_key_verifications
    `,
    rebuild: `
      authrim_migrations migration_metadata tenant_database_migration_state
      control_account_scale_out_forecasts control_bootstrap_accelerator_leases control_bootstrap_accelerator_proofs control_bootstrap_handoffs
      control_bootstrap_worker_evidence control_d1_create_budget_reservations control_desired_resources control_desired_worker_inventory
      control_directory_rewrite_leases control_hmac_rotation_operations control_lookup_bucket_assignments control_lookup_bucket_migrations
      control_lookup_hmac_candidate_verifications control_lookup_hmac_key_state_publications control_lookup_hmac_key_states control_lookup_hmac_rotation_sources
      control_lookup_hmac_rotation_verification_shards control_lookup_physical_shards control_lookup_registry_publications control_lookup_retention_policy_projections
      control_lookup_scale_out_forecasts control_migration_release_catalog control_observed_resources control_operation_release_pins
      control_operation_steps control_operation_transition_assertions control_operations control_plugin_dynamic_worker_bindings
      control_plugin_provider_projection_assertions control_plugin_resource_binding_reconciliations control_plugin_resource_cleanup_items control_plugin_resource_cleanup_operations
      control_plugin_resource_migration_state control_plugin_runner_registry_publications control_provider_identity_projection_assertions control_r2_bucket_metric_reports
      control_r2_metric_scan_state control_read_replication_rollout_targets control_read_replication_rollouts control_release_migration_rollouts
      control_release_migration_targets control_route_projection_migrations control_runtime_registry_publications control_runtime_registry_routes
      control_shard_capacity control_shard_cleanup_bindings control_shard_cleanup_operations control_shard_quarantine_operations
      control_shard_quarantine_tenants control_tenant_database_migration_state control_tenant_default_allocations control_tenant_disaster_recovery_operations
      control_tenant_disaster_recovery_targets control_tenant_placement_migration_inventory control_tenant_placement_migration_shards control_tenant_placement_migrations
      control_tenant_shard_allocations control_tenant_shard_assignments control_tenant_shards control_worker_binding_reconciler_leases
      control_worker_binding_reconciliations control_worker_deployment_leases control_worker_desired_bindings control_worker_inventory_change_events
      control_worker_inventory_drift_findings control_worker_observed_bindings control_worker_required_data_roles
    `,
    ephemeral: `tenant_backup_boundary_plans tenant_backup_boundary_receipts tenant_backup_mutation_permits tenant_backup_mutation_boundaries tenant_backup_restore_targets tenant_backup_snapshots tenant_backup_preimages authrim_runtime_probes`,
  },
  lookup: {
    rebuild: `
      authrim_migrations migration_metadata tenant_database_migration_state
      lookup_bucket_counters lookup_directory_job_cursors lookup_identifier_replacements lookup_identifier_reservations
      lookup_identifiers lookup_migration_state lookup_schema_metadata lookup_tenant_aliases
    `,
    ephemeral: `
      authrim_runtime_probes
      lookup_discovery_otp_challenges
    `,
  },
  plugin_runner: {
    settings: `
      plugin_runner_approved_mutation_scopes plugin_runner_dynamic_worker_credential_slots plugin_runner_dynamic_worker_egress_allowed_hosts plugin_runner_dynamic_worker_hook_policies
      plugin_runner_dynamic_worker_manifests plugin_runner_dynamic_worker_releases plugin_runner_egress_allowed_hosts plugin_runner_encrypted_configs
      plugin_runner_hook_policies plugin_runner_human_verification_configs plugin_runner_installation_mutation_scopes plugin_runner_installations
      plugin_runner_notification_route_entries plugin_runner_notification_route_sets
    `,
    admin: `
      plugin_runner_config_key_rotations plugin_runner_config_mutations plugin_runner_dynamic_worker_rollout_results plugin_runner_dynamic_worker_rollouts
    `,
    audit: `
      plugin_runner_egress_audit
    `,
    external: `
      plugin_runner_dynamic_worker_artifacts plugin_runner_dynamic_worker_resources
    `,
    rebuild: `
      authrim_migrations migration_metadata tenant_database_migration_state
      plugin_runner_circuit_breakers plugin_runner_dispatch_leases plugin_runner_full_sweep_state plugin_runner_migration_state
      plugin_runner_r2_metric_scan_state plugin_runner_rate_limit_buckets plugin_runner_registry_shards plugin_runner_registry_state
      plugin_runner_shard_cursors
    `,
    ephemeral: `tenant_backup_restore_targets tenant_backup_snapshots tenant_backup_preimages authrim_runtime_probes`,
  },
};

export const TENANT_DATASET_POLICIES: readonly TenantDatasetPolicy[] = Object.entries(
  TABLE_GROUPS
).flatMap(([family, groups]) =>
  Object.entries(groups).flatMap(([kind, tables]) =>
    tables
      .trim()
      .split(/\s+/)
      .map((table) => ({
        family: family as MigrationSchemaFamily,
        table,
        kind: kind as TenantDatasetKind,
      }))
  )
);

/**
 * Finite row partitions for tables whose records belong to independently selectable categories.
 * Unknown values stop snapshot admission; they never fall through to a broader category.
 */
export const TENANT_DATASET_ROW_PARTITIONS: readonly TenantDatasetRowPartition[] = [
  {
    family: 'core',
    table: 'resource_permissions',
    column: 'subject_type',
    values: [
      { value: 'user', kind: 'users' },
      { value: 'role', kind: 'settings' },
      { value: 'org', kind: 'settings' },
    ],
  },
];

export interface TenantDatasetCoverage {
  unclassified: string[];
  stale: string[];
  duplicates: string[];
}

/** Compare a complete logical-family schema inventory; never equate classification with export support. */
export function checkTenantDatasetCoverage(
  family: MigrationSchemaFamily,
  tables: readonly string[],
  policies: readonly TenantDatasetPolicy[] = TENANT_DATASET_POLICIES
): TenantDatasetCoverage {
  const actual = new Set(tables);
  const declared = new Set<string>();
  const duplicates = new Set<string>();
  for (const policy of policies.filter((entry) => entry.family === family)) {
    if (declared.has(policy.table)) duplicates.add(policy.table);
    declared.add(policy.table);
  }
  return {
    unclassified: [...actual].filter((table) => !declared.has(table)).sort(),
    stale: [...declared].filter((table) => !actual.has(table)).sort(),
    duplicates: [...duplicates].sort(),
  };
}
