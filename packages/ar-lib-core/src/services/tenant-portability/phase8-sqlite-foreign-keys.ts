/** Physical foreign keys for Phase 8 datasets, pinned from the reviewed migration schemas. */
export const PHASE8_SQLITE_FOREIGN_KEY_RULES = [
  {
    from: 'admin.admin_agent_grants',
    columns: ['delegator_id'],
    to: 'admin.admin_users',
  },
  {
    from: 'admin.admin_agent_grants',
    columns: ['grantor_id'],
    to: 'admin.admin_users',
  },
  {
    from: 'admin.admin_agent_token_revocation_outbox',
    columns: ['grant_id'],
    to: 'admin.admin_agent_grants',
  },
  {
    from: 'admin.admin_attribute_values',
    columns: ['admin_attribute_id'],
    to: 'admin.admin_attributes',
  },
  {
    from: 'admin.admin_attribute_values',
    columns: ['admin_user_id'],
    to: 'admin.admin_users',
  },
  {
    from: 'admin.admin_external_token_refresh_tenant_runs',
    columns: ['run_id'],
    to: 'admin.admin_external_token_refresh_runs',
  },
  {
    from: 'admin.admin_machine_credential_permissions',
    columns: ['credential_id'],
    to: 'admin.admin_machine_credentials',
  },
  {
    from: 'admin.admin_machine_credential_tenant_scopes',
    columns: ['credential_id'],
    to: 'admin.admin_machine_credentials',
  },
  {
    from: 'admin.admin_machine_credentials',
    columns: ['principal_id'],
    to: 'admin.admin_machine_principals',
  },
  {
    from: 'admin.admin_machine_principal_permissions',
    columns: ['principal_id'],
    to: 'admin.admin_machine_principals',
  },
  {
    from: 'admin.admin_machine_principal_tenant_scopes',
    columns: ['principal_id'],
    to: 'admin.admin_machine_principals',
  },
  {
    from: 'admin.admin_machine_resource_scopes',
    columns: ['credential_id'],
    to: 'admin.admin_machine_credentials',
  },
  {
    from: 'admin.admin_machine_resource_scopes',
    columns: ['principal_id'],
    to: 'admin.admin_machine_principals',
  },
  {
    from: 'admin.admin_role_assignments',
    columns: ['admin_role_id'],
    to: 'admin.admin_roles',
  },
  {
    from: 'admin.admin_role_assignments',
    columns: ['admin_user_id'],
    to: 'admin.admin_users',
  },
  {
    from: 'admin.agent_bulk_plans',
    columns: ['grant_id'],
    to: 'admin.admin_agent_grants',
  },
  {
    from: 'admin.agent_bulk_tenant_executions',
    columns: ['bulk_plan_id', 'bulk_plan_version'],
    to: 'admin.agent_bulk_plans',
  },
  {
    from: 'admin.agent_configuration_plan_steps',
    columns: ['plan_id', 'plan_version'],
    to: 'admin.agent_configuration_plans',
  },
  {
    from: 'admin.agent_configuration_plans',
    columns: ['grant_id'],
    to: 'admin.admin_agent_grants',
  },
  {
    from: 'admin.agent_consents',
    columns: ['grant_id'],
    to: 'admin.admin_agent_grants',
  },
  {
    from: 'admin.agent_consents',
    columns: ['user_id'],
    to: 'admin.admin_users',
  },
  {
    from: 'admin.approval_request_approvals',
    columns: ['approval_request_id'],
    to: 'admin.approval_requests',
  },
  {
    from: 'admin.approval_requests',
    columns: ['detail_object_catalog_id'],
    to: 'admin.object_catalog',
  },
  {
    from: 'admin.object_catalog_objects',
    columns: ['catalog_id'],
    to: 'admin.object_catalog',
  },
  {
    from: 'core.access_review_items',
    columns: ['review_id'],
    to: 'core.access_reviews',
  },
  {
    from: 'core.account_lifecycle_event_outbox',
    columns: ['account_id'],
    to: 'core.identity_accounts',
  },
  {
    from: 'core.account_support_contexts',
    columns: ['account_id'],
    to: 'core.identity_accounts',
  },
  {
    from: 'core.consent_history',
    columns: ['user_id'],
    to: 'core.users_core',
  },
  {
    from: 'core.contact_points',
    columns: ['account_id'],
    to: 'core.identity_accounts',
  },
  {
    from: 'core.contact_points',
    columns: ['subject_id'],
    to: 'core.identity_subjects',
  },
  {
    from: 'core.contact_verifications',
    columns: ['contact_point_id'],
    to: 'core.contact_points',
  },
  {
    from: 'core.data_export_requests',
    columns: ['user_id'],
    to: 'core.users_core',
  },
  {
    from: 'core.device_secrets',
    columns: ['user_id'],
    to: 'core.users',
  },
  {
    from: 'core.external_lifecycle_signal_decisions',
    columns: ['signal_event_id'],
    to: 'core.external_lifecycle_signal_events',
  },
  {
    from: 'core.group_memberships',
    columns: ['group_id'],
    to: 'core.groups',
  },
  {
    from: 'core.idempotency_keys',
    columns: ['tenant_id'],
    to: 'core.tenants',
  },
  {
    from: 'core.identity_accounts',
    columns: ['primary_subject_id'],
    to: 'core.identity_subjects',
  },
  {
    from: 'core.identity_bindings',
    columns: ['account_id'],
    to: 'core.identity_accounts',
  },
  {
    from: 'core.identity_bindings',
    columns: ['subject_id'],
    to: 'core.identity_subjects',
  },
  {
    from: 'core.identity_resolution_events',
    columns: ['account_id'],
    to: 'core.identity_accounts',
  },
  {
    from: 'core.identity_resolution_events',
    columns: ['binding_id'],
    to: 'core.identity_bindings',
  },
  {
    from: 'core.identity_resolution_events',
    columns: ['subject_id'],
    to: 'core.identity_subjects',
  },
  {
    from: 'core.issued_credentials',
    columns: ['status_list_internal_id'],
    to: 'core.status_lists',
  },
  {
    from: 'core.legal_hold_events',
    columns: ['hold_id'],
    to: 'core.legal_holds',
  },
  {
    from: 'core.object_catalog_objects',
    columns: ['catalog_id'],
    to: 'core.object_catalog',
  },
  {
    from: 'core.operational_logs',
    columns: ['tenant_id'],
    to: 'core.tenants',
  },
  {
    from: 'core.plugin_account_metadata_audit',
    columns: ['tenant_id', 'plugin_installation_id', 'operation_id'],
    to: 'core.plugin_account_metadata_mutations',
  },
  {
    from: 'core.plugin_account_metadata',
    columns: ['account_id'],
    to: 'core.identity_accounts',
  },
  {
    from: 'core.profile_attribute_values',
    columns: ['profile_id'],
    to: 'core.profiles',
  },
  {
    from: 'core.profiles',
    columns: ['subject_id'],
    to: 'core.identity_subjects',
  },
  {
    from: 'core.role_assignments',
    columns: ['role_id'],
    to: 'core.roles',
  },
  {
    from: 'core.role_assignments',
    columns: ['subject_id'],
    to: 'core.users_core',
  },
  {
    from: 'core.security_alerts',
    columns: ['tenant_id'],
    to: 'core.tenants',
  },
  {
    from: 'core.sensitive_detail_chunk_index',
    columns: ['catalog_id'],
    to: 'core.object_catalog',
  },
  {
    from: 'core.subject_account_links',
    columns: ['account_id'],
    to: 'core.identity_accounts',
  },
  {
    from: 'core.subject_account_links',
    columns: ['subject_id'],
    to: 'core.identity_subjects',
  },
  {
    from: 'core.subject_org_membership',
    columns: ['org_id'],
    to: 'core.organizations',
  },
  {
    from: 'core.subject_org_membership',
    columns: ['subject_id'],
    to: 'core.users_core',
  },
  {
    from: 'core.support_operation_actions',
    columns: ['cohort_id'],
    to: 'core.support_operation_cohorts',
  },
  {
    from: 'core.support_operation_cohort_targets',
    columns: ['cohort_id'],
    to: 'core.support_operation_cohorts',
  },
  {
    from: 'core.tenant_invitations',
    columns: ['tenant_id'],
    to: 'core.tenants',
  },
  {
    from: 'core.user_consent_records',
    columns: ['statement_id'],
    to: 'core.consent_statements',
  },
  {
    from: 'core.user_consent_records',
    columns: ['version_id'],
    to: 'core.consent_statement_versions',
  },
  {
    from: 'core.user_roles',
    columns: ['role_id'],
    to: 'core.roles',
  },
  {
    from: 'core.user_roles',
    columns: ['user_id'],
    to: 'core.users_core',
  },
  {
    from: 'core.user_verified_attributes',
    columns: ['verification_id'],
    to: 'core.attribute_verifications',
  },
  {
    from: 'core.users',
    columns: ['identity_provider_id'],
    to: 'core.identity_providers',
  },
  {
    from: 'core.webhook_deliveries',
    columns: ['webhook_id'],
    to: 'core.webhook_configs',
  },
  {
    from: 'core.webhook_delivery_logs',
    columns: ['webhook_id'],
    to: 'core.webhook_configs',
  },
  {
    from: 'pii.identity_identifier_replacement_history',
    columns: ['operation_id'],
    to: 'pii.identity_identifier_replacement_operations',
  },
  {
    from: 'pii.identity_identifier_replacement_operations',
    columns: ['challenge_id'],
    to: 'pii.identity_identifier_replacement_challenges',
  },
] as const;
