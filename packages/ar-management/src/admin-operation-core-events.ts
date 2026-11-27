/**
 * Admin operations that were written to the end-user (core) audit log.
 *
 * These configuration changes (screens, flows, clients, roles, tenants, settings and so on)
 * belong in the admin audit log. Older rows stay in the core log until its retention removes
 * them, and the end-user audit views leave them out.
 *
 * Each entry pairs a resource type with the actions an admin route wrote for it. A row is left
 * out only when both match. The pair, not the action alone, is the test: several actions have
 * generic names (`create`, `update`) and the same resource names are used by other writers.
 * A pair is listed only when no writer other than an admin route emits it; the inventory test
 * (`admin-operation-core-events.test.ts`) checks that against the sources. Admin operations on
 * an end user (suspend, delete, revoke consent ...) are not listed: they stay in that user's
 * history.
 *
 * `client.created/updated/deleted` are also event types the event dispatcher writes to the core
 * log with resource `client`; the only publisher of those is the admin client routes.
 */
export const ADMIN_OPERATION_CORE_EVENTS: Readonly<Record<string, readonly string[]>> = {
  access_review: [
    'access_review.created',
    'access_review.decided',
    'access_review.completed',
    'access_review.cancelled',
  ],
  application_launcher: [
    'launcher.created',
    'launcher.updated',
    'launcher.deleted',
    'launcher.reordered',
    'launcher.shared_updated',
    'launcher.shared_reverted',
  ],
  client: [
    'client.created',
    'client.updated',
    'client.deleted',
    'client.enabled',
    'client.disabled',
    'client.secret_regenerate',
  ],
  compliance_report: [
    'compliance_report.created',
    'compliance_report.failed',
    'compliance_report.downloaded',
  ],
  connection: ['identity_mapping.inbound.saved'],
  credential_profile: [
    'credential_profile.created',
    'credential_profile.updated',
    'credential_profile.version_created',
    'credential_profile.published',
  ],
  custom_claim_schema: ['create', 'update', 'delete', 'custom_claim.preset_applied'],
  data_retention: ['data_retention.category_updated'],
  device_secret: ['device_secret.cleanup'],
  directory_auth_evidence_export: [
    'directory_auth.evidence_export.created',
    'directory_auth.evidence_export.downloaded',
    'directory_auth.evidence_export.deleted_after_download',
  ],
  directory_auth_maintenance: ['directory_auth.maintenance.cleanup'],
  directory_auth_migration_campaign: [
    'directory_auth.migration_campaign.created',
    'directory_auth.migration_campaign.updated',
  ],
  directory_auth_migration_user_state: ['directory_auth.migration_state.reset'],
  directory_auth_retention_policy: ['directory_auth.retention_policy.updated'],
  directory_auth_support_bundle: [
    'directory_auth.support_bundle.created',
    'directory_auth.support_bundle.downloaded',
  ],
  directory_auth_tenant_policy: ['directory_auth.tenant_policy.updated'],
  directory_connector: [
    'directory_connector.updated',
    'directory_connector.secret.issued',
    'directory_connector.secret.rotated',
  ],
  // The connector heartbeat's `directory_connector_heartbeat.failed` for this resource is a
  // system event (the system log), not an admin operation; it is not listed.
  directory_connector_instance: [
    'directory_connector_instance.acknowledge',
    'directory_connector_instance.deactivate',
    'directory_connector_instance.reactivate',
  ],
  directory_jit_pending_user: [
    'directory_jit_pending_user.approved',
    'directory_jit_pending_user.rejected',
  ],
  federation_trust_source: [
    'saml.federation.exceptions_updated',
    'saml.federation.idp_selection_updated',
  ],
  field_mapping_hash_key: ['field_mapping.hash_key.rotate'],
  field_mapping_set: ['identity_mapping.set.saved', 'identity_mapping.set.deleted'],
  flow: [
    'flow_create',
    'flow_update',
    'flow_delete',
    'flow_publish',
    'flow_import',
    'flow_copy',
    'flow_assignment_upsert',
  ],
  flow_assignment: ['flow_assignment_delete'],
  group: [
    'group.created',
    'group.updated',
    'group.deleted',
    'group.member_added',
    'group.member_removed',
    'group.role_assigned',
    'group.role_removed',
  ],
  iat_token: ['iat.token.create', 'iat.token.revoke'],
  identifier_exceptions: ['identifier_exceptions.imported'],
  identifier_salt: [
    'identifier_salt.created',
    'identifier_salt.unchanged',
    'identifier_salt.replaced',
  ],
  identifier_source: ['identifier_source.imported'],
  identifier_store: ['identifier_store.imported'],
  identity_mapping_test_users: ['identity_mapping.test_users.replaced'],
  job: ['job.created'],
  policy_rule: ['policy_rule_create', 'policy_rule_update', 'policy_rule_delete'],
  relation_definition: ['create', 'update', 'delete'],
  relationship_tuple: ['create', 'delete'],
  role: ['role.created', 'role.updated', 'role.deleted'],
  scim_settings: ['scim.settings.update'],
  scim_token: ['scim.token.create', 'scim.token.revoke'],
  screen: ['screen.created', 'screen.updated', 'screen.deleted'],
  security: ['security.ip_reputation_check'],
  security_alert: ['security_alert.acknowledge'],
  settings: [
    'settings.settings.updated',
    'settings.patch.failure',
    'settings.plugin.external_shutdown',
    'settings.bulk_apply',
    'settings.certification_profile_sections_removed',
    'settings.legacy_import',
    'settings.legacy_import.rejections_accepted',
  ],
  signing_keys: [
    'signing_keys.status.read',
    'signing_keys.rotate.normal',
    'signing_keys.rotate.emergency',
    'signing_keys.vc_issuer.revoke',
  ],
  tenant: [
    'tenant.provisioning_requested',
    'tenant.updated',
    'tenant.lifecycle.suspend',
    'tenant.lifecycle.resume',
    'tenant.lifecycle.freeze',
    'tenant.lifecycle.unfreeze',
    'tenant.lifecycle.restore-validate',
    'tenant.lifecycle.validation_retry_requested',
    'tenant.provisioning_retry.requested',
    'tenant.provisioning_cleanup.succeeded',
    'tenant.delete_queued',
    'tenant.set_default',
    'tenant.clone.requested',
    'tenant.clone.prepared',
    'tenant.cloned',
    'tenant.placement_migration_requested',
    'tenant.placement_migration_canceled',
    'tenant.placement_migration_purge_approved',
  ],
  tenant_domain_mapping: [
    'tenant_domain_mapping.created',
    'tenant_domain_mapping.updated',
    'tenant_domain_mapping.deleted',
    'tenant_domain_mapping.verification_initiated',
    'tenant_domain_mapping.verified',
  ],
  tenant_invitation: ['tenant_invitation.create', 'tenant_invitation.cancel'],
  tenant_vanity_domain: ['tenant_vanity_domain.created'],
  tombstone: ['tombstone.email_checked'],
  // Creating or deleting a user's attribute names that user and stays in their history.
  user_attribute: ['update', 'bulk_delete'],
  webhook: [
    'webhook.created',
    'webhook.updated',
    'webhook.deleted',
    'webhook.test',
    'webhook.test_failed',
    'webhook.replay',
    'webhook.replay_failed',
  ],
};

const ADMIN_OPERATION_CORE_EVENT_INDEX: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(ADMIN_OPERATION_CORE_EVENTS).map(([resource, actions]) => [
    resource,
    new Set(actions),
  ])
);

/** Whether an action written for a resource type is a listed admin operation. */
export function isAdminOperationCoreEventPair(action: string, resourceType: string): boolean {
  return ADMIN_OPERATION_CORE_EVENT_INDEX.get(resourceType)?.has(action) === true;
}

/**
 * Whether a `core.event_log` row is a listed admin operation. The legacy mirror records the
 * resource type as `details.resourceType`; a row without readable details is kept.
 */
export function isAdminOperationCoreEventRow(row: {
  readonly event_type?: unknown;
  readonly details_json?: unknown;
}): boolean {
  if (typeof row.event_type !== 'string' || typeof row.details_json !== 'string') return false;
  let details: unknown;
  try {
    details = JSON.parse(row.details_json);
  } catch {
    return false;
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const resourceType = (details as Record<string, unknown>).resourceType;
  return (
    typeof resourceType === 'string' && isAdminOperationCoreEventPair(row.event_type, resourceType)
  );
}
