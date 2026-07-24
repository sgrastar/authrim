-- Built-in Task Set v5 pins the session-local Discovery Profile control Tool. Existing v4
-- snapshots remain immutable, so active built-in Grants must be suspended and re-consented
-- instead of being reinterpreted against the v5 Tool catalog.

INSERT INTO admin_audit_log (
  id, tenant_id, admin_user_id, action, resource_type, resource_id,
  result, severity, metadata_json, created_at, actor_type, actor_sub, grant_id
)
SELECT
  'audit_agent_discovery_profile_upgrade_' || id,
  tenant_id,
  NULL,
  'agent.grant.suspended',
  'admin_agent_grant',
  id,
  'success',
  'warning',
  '{"reason":"builtin_task_set_discovery_profile_upgrade","source":"migration_024","replacement_version":5}',
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  'system',
  'migration:024',
  id
FROM admin_agent_grants
WHERE status = 'active'
  AND task_set_version = 4
  AND task_set_id IN (
    'builtin_agent_task_set_read_only_inspector',
    'builtin_agent_task_set_user_data_reader',
    'builtin_agent_task_set_diagnostics_operator',
    'builtin_agent_task_set_configuration_designer',
    'builtin_agent_task_set_configuration_operator',
    'builtin_agent_task_set_bulk_configuration_operator'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM admin_audit_log existing
    WHERE existing.id = 'audit_agent_discovery_profile_upgrade_' || admin_agent_grants.id
  );

UPDATE agent_consents
SET revoked_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    revoked_reason = 'grant_updated',
    last_mutation_id = 'migration_024:' || grant_id
WHERE revoked_at IS NULL
  AND grant_id IN (
    SELECT id
    FROM admin_agent_grants
    WHERE status = 'active'
      AND task_set_version = 4
      AND task_set_id IN (
        'builtin_agent_task_set_read_only_inspector',
        'builtin_agent_task_set_user_data_reader',
        'builtin_agent_task_set_diagnostics_operator',
        'builtin_agent_task_set_configuration_designer',
        'builtin_agent_task_set_configuration_operator',
        'builtin_agent_task_set_bulk_configuration_operator'
      )
  );

UPDATE admin_agent_token_families
SET status = 'revocation_pending',
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    revocation_outbox_id = 'migration_024_revoke_' || grant_id
WHERE status IN ('pending_finalization', 'active', 'revocation_pending')
  AND grant_id IN (
    SELECT id
    FROM admin_agent_grants
    WHERE status = 'active'
      AND task_set_version = 4
      AND task_set_id IN (
        'builtin_agent_task_set_read_only_inspector',
        'builtin_agent_task_set_user_data_reader',
        'builtin_agent_task_set_diagnostics_operator',
        'builtin_agent_task_set_configuration_designer',
        'builtin_agent_task_set_configuration_operator',
        'builtin_agent_task_set_bulk_configuration_operator'
      )
  );

INSERT INTO admin_agent_token_revocation_outbox (
  id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
  status, attempt_count, processing_fence, next_attempt_at, created_at
)
SELECT
  'migration_024_revoke_' || grant.id,
  grant.tenant_id,
  grant.id,
  grant.generation,
  grant.client_id,
  'revoke_grant_families',
  json_object(
    'family_ids', json(COALESCE((SELECT json_group_array(family_id) FROM (
      SELECT family_id FROM admin_agent_token_families
      WHERE tenant_id = grant.tenant_id
        AND revocation_outbox_id = 'migration_024_revoke_' || grant.id
      ORDER BY family_id
    )), '[]')),
    'family_jtis', json(COALESCE((SELECT json_group_array(family_jti) FROM (
      SELECT family_jti FROM admin_agent_token_families
      WHERE tenant_id = grant.tenant_id
        AND revocation_outbox_id = 'migration_024_revoke_' || grant.id
      ORDER BY family_id
    )), '[]')),
    'reason', 'builtin_task_set_discovery_profile_upgrade'
  ),
  'pending',
  0,
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
FROM admin_agent_grants grant
WHERE grant.status = 'active'
  AND grant.task_set_version = 4
  AND grant.task_set_id IN (
    'builtin_agent_task_set_read_only_inspector',
    'builtin_agent_task_set_user_data_reader',
    'builtin_agent_task_set_diagnostics_operator',
    'builtin_agent_task_set_configuration_designer',
    'builtin_agent_task_set_configuration_operator',
    'builtin_agent_task_set_bulk_configuration_operator'
  )
  AND EXISTS (
    SELECT 1 FROM admin_agent_token_families family
    WHERE family.tenant_id = grant.tenant_id
      AND family.revocation_outbox_id = 'migration_024_revoke_' || grant.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM admin_agent_token_revocation_outbox existing
    WHERE existing.id = 'migration_024_revoke_' || grant.id
  );

UPDATE admin_agent_grants
SET status = 'suspended',
    active_uniqueness_key = id,
    generation = generation + 1,
    consent_version = consent_version + 1,
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    last_mutation_id = 'migration_024:' || id
WHERE status = 'active'
  AND task_set_version = 4
  AND task_set_id IN (
    'builtin_agent_task_set_read_only_inspector',
    'builtin_agent_task_set_user_data_reader',
    'builtin_agent_task_set_diagnostics_operator',
    'builtin_agent_task_set_configuration_designer',
    'builtin_agent_task_set_configuration_operator',
    'builtin_agent_task_set_bulk_configuration_operator'
  );
