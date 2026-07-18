-- User data access is no longer part of the general built-in read/configuration Task Sets.
-- Built-in v3 snapshots included search_users/get_user, so active Grants pinned to those
-- snapshots must fail closed and be explicitly recreated with either v4 or user_data_reader.

INSERT INTO admin_audit_log (
  id, tenant_id, admin_user_id, action, resource_type, resource_id,
  result, severity, metadata_json, created_at, actor_type, actor_sub, grant_id
)
SELECT
  'audit_agent_user_data_split_' || id,
  tenant_id,
  NULL,
  'agent.grant.suspended',
  'admin_agent_grant',
  id,
  'success',
  'warning',
  '{"reason":"builtin_task_set_user_data_split","source":"migration_019","replacement_version":4}',
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  'system',
  'migration:019',
  id
FROM admin_agent_grants
WHERE status = 'active'
  AND task_set_version = 3
  AND task_set_id IN (
    'builtin_agent_task_set_read_only_inspector',
    'builtin_agent_task_set_diagnostics_operator',
    'builtin_agent_task_set_configuration_designer',
    'builtin_agent_task_set_configuration_operator',
    'builtin_agent_task_set_bulk_configuration_operator'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM admin_audit_log existing
    WHERE existing.id = 'audit_agent_user_data_split_' || admin_agent_grants.id
  );

UPDATE agent_consents
SET revoked_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    revoked_reason = 'grant_updated',
    last_mutation_id = 'migration_019:' || grant_id
WHERE revoked_at IS NULL
  AND grant_id IN (
    SELECT id
    FROM admin_agent_grants
    WHERE status = 'active'
      AND task_set_version = 3
      AND task_set_id IN (
        'builtin_agent_task_set_read_only_inspector',
        'builtin_agent_task_set_diagnostics_operator',
        'builtin_agent_task_set_configuration_designer',
        'builtin_agent_task_set_configuration_operator',
        'builtin_agent_task_set_bulk_configuration_operator'
      )
  );

UPDATE admin_agent_token_families
SET status = 'revoked',
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE status IN ('pending_finalization', 'active', 'revocation_pending')
  AND grant_id IN (
    SELECT id
    FROM admin_agent_grants
    WHERE status = 'active'
      AND task_set_version = 3
      AND task_set_id IN (
        'builtin_agent_task_set_read_only_inspector',
        'builtin_agent_task_set_diagnostics_operator',
        'builtin_agent_task_set_configuration_designer',
        'builtin_agent_task_set_configuration_operator',
        'builtin_agent_task_set_bulk_configuration_operator'
      )
  );

UPDATE admin_agent_grants
SET status = 'suspended',
    active_uniqueness_key = id,
    generation = generation + 1,
    consent_version = consent_version + 1,
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    last_mutation_id = 'migration_019:' || id
WHERE status = 'active'
  AND task_set_version = 3
  AND task_set_id IN (
    'builtin_agent_task_set_read_only_inspector',
    'builtin_agent_task_set_diagnostics_operator',
    'builtin_agent_task_set_configuration_designer',
    'builtin_agent_task_set_configuration_operator',
    'builtin_agent_task_set_bulk_configuration_operator'
  );
