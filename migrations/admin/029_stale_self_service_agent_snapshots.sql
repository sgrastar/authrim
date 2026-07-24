-- Self-service Task Sets use per-Grant version 1 snapshots, so the built-in-version-only v8
-- cut-over in migration 028 could not identify them. Suspend only active system-managed
-- self-service Grants whose pinned Task Set is missing or predates catalog v9. Their immutable
-- snapshots are rebuilt after fresh human consent; managed/custom Grants are not reinterpreted.

INSERT INTO admin_audit_log (
  id, tenant_id, admin_user_id, action, resource_type, resource_id,
  result, severity, metadata_json, created_at, actor_type, actor_sub, grant_id
)
SELECT
  'audit_stale_self_service_snapshot_' || grant.id,
  grant.tenant_id,
  NULL,
  'agent.grant.suspended',
  'admin_agent_grant',
  grant.id,
  'success',
  'warning',
  '{"reason":"stale_self_service_tool_catalog","source":"migration_029","catalog_version":"admin-agent-access-v9"}',
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  'system',
  'migration:029',
  grant.id
FROM admin_agent_grants grant
WHERE grant.status = 'active'
  AND grant.purpose = 'interactive_self_service'
  AND grant.management_mode = 'system_managed'
  AND NOT EXISTS (
    SELECT 1
    FROM agent_task_sets task_set
    JOIN agent_task_set_versions version ON version.task_set_id = task_set.id
    WHERE task_set.tenant_id = grant.tenant_id
      AND task_set.id = grant.task_set_id
      AND task_set.management_mode = 'system_managed'
      AND version.version = grant.task_set_version
      AND version.status = 'active'
      AND version.catalog_version = 'admin-agent-access-v9'
  )
  AND NOT EXISTS (
    SELECT 1 FROM admin_audit_log existing
    WHERE existing.id = 'audit_stale_self_service_snapshot_' || grant.id
  );

UPDATE agent_consents
SET revoked_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    revoked_reason = 'grant_updated',
    last_mutation_id = 'migration_029:' || grant_id
WHERE revoked_at IS NULL
  AND grant_id IN (
    SELECT grant.id
    FROM admin_agent_grants grant
    WHERE grant.status = 'active'
      AND grant.purpose = 'interactive_self_service'
      AND grant.management_mode = 'system_managed'
      AND NOT EXISTS (
        SELECT 1
        FROM agent_task_sets task_set
        JOIN agent_task_set_versions version ON version.task_set_id = task_set.id
        WHERE task_set.tenant_id = grant.tenant_id
          AND task_set.id = grant.task_set_id
          AND task_set.management_mode = 'system_managed'
          AND version.version = grant.task_set_version
          AND version.status = 'active'
          AND version.catalog_version = 'admin-agent-access-v9'
      )
  );

UPDATE admin_agent_token_families
SET status = 'revocation_pending',
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    revocation_outbox_id = 'migration_029_revoke_' || grant_id
WHERE status IN ('pending_finalization', 'active', 'revocation_pending')
  AND grant_id IN (
    SELECT grant.id
    FROM admin_agent_grants grant
    WHERE grant.status = 'active'
      AND grant.purpose = 'interactive_self_service'
      AND grant.management_mode = 'system_managed'
      AND NOT EXISTS (
        SELECT 1
        FROM agent_task_sets task_set
        JOIN agent_task_set_versions version ON version.task_set_id = task_set.id
        WHERE task_set.tenant_id = grant.tenant_id
          AND task_set.id = grant.task_set_id
          AND task_set.management_mode = 'system_managed'
          AND version.version = grant.task_set_version
          AND version.status = 'active'
          AND version.catalog_version = 'admin-agent-access-v9'
      )
  );

INSERT INTO admin_agent_token_revocation_outbox (
  id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
  status, attempt_count, processing_fence, next_attempt_at, created_at
)
SELECT
  'migration_029_revoke_' || grant.id,
  grant.tenant_id,
  grant.id,
  grant.generation,
  grant.client_id,
  'revoke_grant_families',
  json_object(
    'family_ids', json(COALESCE((SELECT json_group_array(family_id) FROM (
      SELECT family_id FROM admin_agent_token_families
      WHERE tenant_id = grant.tenant_id
        AND revocation_outbox_id = 'migration_029_revoke_' || grant.id
      ORDER BY family_id
    )), '[]')),
    'family_jtis', json(COALESCE((SELECT json_group_array(family_jti) FROM (
      SELECT family_jti FROM admin_agent_token_families
      WHERE tenant_id = grant.tenant_id
        AND revocation_outbox_id = 'migration_029_revoke_' || grant.id
      ORDER BY family_id
    )), '[]')),
    'reason', 'stale_self_service_tool_catalog'
  ),
  'pending',
  0,
  0,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
FROM admin_agent_grants grant
WHERE grant.status = 'active'
  AND grant.purpose = 'interactive_self_service'
  AND grant.management_mode = 'system_managed'
  AND NOT EXISTS (
    SELECT 1
    FROM agent_task_sets task_set
    JOIN agent_task_set_versions version ON version.task_set_id = task_set.id
    WHERE task_set.tenant_id = grant.tenant_id
      AND task_set.id = grant.task_set_id
      AND task_set.management_mode = 'system_managed'
      AND version.version = grant.task_set_version
      AND version.status = 'active'
      AND version.catalog_version = 'admin-agent-access-v9'
  )
  AND EXISTS (
    SELECT 1 FROM admin_agent_token_families family
    WHERE family.tenant_id = grant.tenant_id
      AND family.revocation_outbox_id = 'migration_029_revoke_' || grant.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM admin_agent_token_revocation_outbox existing
    WHERE existing.id = 'migration_029_revoke_' || grant.id
  );

UPDATE admin_agent_grants
SET status = 'suspended',
    active_uniqueness_key = id,
    generation = generation + 1,
    consent_version = consent_version + 1,
    updated_at = __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
    last_mutation_id = 'migration_029:' || id
WHERE status = 'active'
  AND purpose = 'interactive_self_service'
  AND management_mode = 'system_managed'
  AND NOT EXISTS (
    SELECT 1
    FROM agent_task_sets task_set
    JOIN agent_task_set_versions version ON version.task_set_id = task_set.id
    WHERE task_set.tenant_id = admin_agent_grants.tenant_id
      AND task_set.id = admin_agent_grants.task_set_id
      AND task_set.management_mode = 'system_managed'
      AND version.version = admin_agent_grants.task_set_version
      AND version.status = 'active'
      AND version.catalog_version = 'admin-agent-access-v9'
  );
