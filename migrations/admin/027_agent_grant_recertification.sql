-- Agent Grants are time-bounded authorization credentials. The expiry is the recertification
-- deadline: active Grants cannot be permanent or exceed 90 days. Catalog v8 also raises tenant
-- user-data reads to operation-bound high risk and binds a human goal into configuration Plans.

CREATE TRIGGER IF NOT EXISTS trg_admin_agent_grants_expiry_insert
BEFORE INSERT ON admin_agent_grants
WHEN NEW.status = 'active' AND (
  NEW.expires_at IS NULL
  OR NEW.expires_at < NEW.created_at + 3600000
  OR NEW.expires_at > NEW.created_at + 7776000000
)
BEGIN
  SELECT RAISE(ABORT, 'active Agent Grant expiry must be between 1 hour and 90 days');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_agent_grants_expiry_update
BEFORE UPDATE OF status, expires_at, updated_at ON admin_agent_grants
WHEN NEW.status = 'active' AND (
  NEW.expires_at IS NULL
  OR NEW.expires_at < NEW.updated_at + 3600000
  OR NEW.expires_at > NEW.updated_at + 7776000000
)
BEGIN
  SELECT RAISE(ABORT, 'active Agent Grant expiry must be between 1 hour and 90 days');
END;

INSERT INTO admin_audit_log (
  id, tenant_id, admin_user_id, action, resource_type, resource_id,
  result, severity, metadata_json, created_at, actor_type, actor_sub, grant_id
)
SELECT
  'audit_agent_recertification_upgrade_' || id,
  tenant_id,
  NULL,
  'agent.grant.suspended',
  'admin_agent_grant',
  id,
  'success',
  'warning',
  '{"reason":"agent_security_recertification_upgrade","source":"migration_027","replacement_version":7,"catalog_version":"admin-agent-access-v8","maximum_ttl_days":90}',
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  'system',
  'migration:027',
  id
FROM admin_agent_grants
WHERE status = 'active'
  AND (
    expires_at IS NULL
    OR expires_at <= __AUTHRIM_NOW_EPOCH_MILLISECONDS__
    OR expires_at > __AUTHRIM_NOW_EPOCH_MILLISECONDS__ + 7776000000
    OR (
      task_set_version = 6
      AND task_set_id IN (
        'builtin_agent_task_set_read_only_inspector',
        'builtin_agent_task_set_user_data_reader',
        'builtin_agent_task_set_diagnostics_operator',
        'builtin_agent_task_set_configuration_designer',
        'builtin_agent_task_set_configuration_operator',
        'builtin_agent_task_set_bulk_configuration_operator'
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM admin_audit_log existing
    WHERE existing.id = 'audit_agent_recertification_upgrade_' || admin_agent_grants.id
  );

UPDATE agent_consents
SET revoked_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    revoked_reason = 'grant_updated',
    last_mutation_id = 'migration_027:' || grant_id
WHERE revoked_at IS NULL
  AND grant_id IN (
    SELECT id FROM admin_agent_grants
    WHERE status = 'active'
      AND (
        expires_at IS NULL
        OR expires_at <= __AUTHRIM_NOW_EPOCH_MILLISECONDS__
        OR expires_at > __AUTHRIM_NOW_EPOCH_MILLISECONDS__ + 7776000000
        OR (task_set_version = 6 AND task_set_id IN (
          'builtin_agent_task_set_read_only_inspector',
          'builtin_agent_task_set_user_data_reader',
          'builtin_agent_task_set_diagnostics_operator',
          'builtin_agent_task_set_configuration_designer',
          'builtin_agent_task_set_configuration_operator',
          'builtin_agent_task_set_bulk_configuration_operator'
        ))
      )
  );

UPDATE admin_agent_token_families
SET status = 'revocation_pending',
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    revocation_outbox_id = 'migration_027_revoke_' || grant_id
WHERE status IN ('pending_finalization', 'active', 'revocation_pending')
  AND grant_id IN (
    SELECT id FROM admin_agent_grants
    WHERE status = 'active'
      AND (
        expires_at IS NULL
        OR expires_at <= __AUTHRIM_NOW_EPOCH_MILLISECONDS__
        OR expires_at > __AUTHRIM_NOW_EPOCH_MILLISECONDS__ + 7776000000
        OR (task_set_version = 6 AND task_set_id IN (
          'builtin_agent_task_set_read_only_inspector',
          'builtin_agent_task_set_user_data_reader',
          'builtin_agent_task_set_diagnostics_operator',
          'builtin_agent_task_set_configuration_designer',
          'builtin_agent_task_set_configuration_operator',
          'builtin_agent_task_set_bulk_configuration_operator'
        ))
      )
  );

INSERT INTO admin_agent_token_revocation_outbox (
  id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
  status, attempt_count, processing_fence, next_attempt_at, created_at
)
SELECT
  'migration_027_revoke_' || grant.id,
  grant.tenant_id,
  grant.id,
  grant.generation,
  grant.client_id,
  'revoke_grant_families',
  json_object(
    'family_ids', json(COALESCE((SELECT json_group_array(family_id) FROM (
      SELECT family_id FROM admin_agent_token_families
      WHERE tenant_id = grant.tenant_id
        AND revocation_outbox_id = 'migration_027_revoke_' || grant.id
      ORDER BY family_id
    )), '[]')),
    'family_jtis', json(COALESCE((SELECT json_group_array(family_jti) FROM (
      SELECT family_jti FROM admin_agent_token_families
      WHERE tenant_id = grant.tenant_id
        AND revocation_outbox_id = 'migration_027_revoke_' || grant.id
      ORDER BY family_id
    )), '[]')),
    'reason', 'agent_security_recertification_upgrade'
  ),
  'pending', 0, 0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
FROM admin_agent_grants grant
WHERE grant.status = 'active'
  AND (
    grant.expires_at IS NULL
    OR grant.expires_at <= __AUTHRIM_NOW_EPOCH_MILLISECONDS__
    OR grant.expires_at > __AUTHRIM_NOW_EPOCH_MILLISECONDS__ + 7776000000
    OR (grant.task_set_version = 6 AND grant.task_set_id IN (
      'builtin_agent_task_set_read_only_inspector',
      'builtin_agent_task_set_user_data_reader',
      'builtin_agent_task_set_diagnostics_operator',
      'builtin_agent_task_set_configuration_designer',
      'builtin_agent_task_set_configuration_operator',
      'builtin_agent_task_set_bulk_configuration_operator'
    ))
  )
  AND EXISTS (
    SELECT 1 FROM admin_agent_token_families family
    WHERE family.tenant_id = grant.tenant_id
      AND family.revocation_outbox_id = 'migration_027_revoke_' || grant.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM admin_agent_token_revocation_outbox existing
    WHERE existing.id = 'migration_027_revoke_' || grant.id
  );

UPDATE admin_agent_grants
SET status = 'suspended',
    active_uniqueness_key = id,
    generation = generation + 1,
    consent_version = consent_version + 1,
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    last_mutation_id = 'migration_027:' || id
WHERE status = 'active'
  AND (
    expires_at IS NULL
    OR expires_at <= __AUTHRIM_NOW_EPOCH_MILLISECONDS__
    OR expires_at > __AUTHRIM_NOW_EPOCH_MILLISECONDS__ + 7776000000
    OR (task_set_version = 6 AND task_set_id IN (
      'builtin_agent_task_set_read_only_inspector',
      'builtin_agent_task_set_user_data_reader',
      'builtin_agent_task_set_diagnostics_operator',
      'builtin_agent_task_set_configuration_designer',
      'builtin_agent_task_set_configuration_operator',
      'builtin_agent_task_set_bulk_configuration_operator'
    ))
  );
