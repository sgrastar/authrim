-- Phase 2 cut-over: every Agent Grant must pin one complete Task Set / Scope Policy snapshot.
-- There is deliberately no compatibility path for pre-Phase-2 raw permission/scope Grants.

INSERT INTO admin_audit_log (
  id, tenant_id, admin_user_id, action, resource_type, resource_id,
  result, severity, metadata_json, created_at, actor_type, actor_sub
)
SELECT
  'audit_agent_snapshot_cutover_' || id,
  tenant_id,
  NULL,
  'agent.grant.suspended',
  'admin_agent_grant',
  id,
  'success',
  'critical',
  '{"reason":"phase2_versioned_snapshot_required","source":"migration_017"}',
  CAST(unixepoch('now') AS INTEGER) * 1000,
  'system',
  'migration:017'
FROM admin_agent_grants
WHERE status = 'active'
  AND (
    task_set_id IS NULL OR task_set_version IS NULL OR task_set_version < 1 OR
    scope_policy_id IS NULL OR scope_policy_version IS NULL OR scope_policy_version < 1 OR
    resolved_tools IS NULL OR access_snapshot_hash IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM admin_audit_log existing
    WHERE existing.id = 'audit_agent_snapshot_cutover_' || admin_agent_grants.id
  );

UPDATE agent_consents
SET revoked_at = CAST(unixepoch('now') AS INTEGER) * 1000,
    revoked_reason = 'admin'
WHERE revoked_at IS NULL
  AND grant_id IN (
    SELECT id
    FROM admin_agent_grants
    WHERE task_set_id IS NULL OR task_set_version IS NULL OR task_set_version < 1 OR
      scope_policy_id IS NULL OR scope_policy_version IS NULL OR scope_policy_version < 1 OR
      resolved_tools IS NULL OR access_snapshot_hash IS NULL
  );

UPDATE admin_agent_token_families
SET status = 'revoked',
    updated_at = CAST(unixepoch('now') AS INTEGER) * 1000
WHERE status IN ('pending_finalization', 'active', 'revocation_pending')
  AND grant_id IN (
    SELECT id
    FROM admin_agent_grants
    WHERE task_set_id IS NULL OR task_set_version IS NULL OR task_set_version < 1 OR
      scope_policy_id IS NULL OR scope_policy_version IS NULL OR scope_policy_version < 1 OR
      resolved_tools IS NULL OR access_snapshot_hash IS NULL
  );

UPDATE admin_agent_grants
SET status = 'suspended',
    active_uniqueness_key = id,
    generation = generation + 1,
    consent_version = consent_version + 1,
    updated_at = CAST(unixepoch('now') AS INTEGER) * 1000,
    last_mutation_id = 'migration_017:' || id
WHERE status = 'active'
  AND (
    task_set_id IS NULL OR task_set_version IS NULL OR task_set_version < 1 OR
    scope_policy_id IS NULL OR scope_policy_version IS NULL OR scope_policy_version < 1 OR
    resolved_tools IS NULL OR access_snapshot_hash IS NULL
  );

CREATE TRIGGER IF NOT EXISTS trg_admin_agent_grants_require_snapshot_insert
BEFORE INSERT ON admin_agent_grants
FOR EACH ROW
WHEN CASE
  WHEN NEW.task_set_id IS NULL OR length(trim(NEW.task_set_id)) = 0 THEN 1
  WHEN NEW.task_set_version IS NULL OR NEW.task_set_version < 1 THEN 1
  WHEN NEW.scope_policy_id IS NULL OR length(trim(NEW.scope_policy_id)) = 0 THEN 1
  WHEN NEW.scope_policy_version IS NULL OR NEW.scope_policy_version < 1 THEN 1
  WHEN NEW.resolved_tools IS NULL OR json_valid(NEW.resolved_tools) = 0 THEN 1
  WHEN json_type(NEW.resolved_tools) <> 'array' OR json_array_length(NEW.resolved_tools) < 1 THEN 1
  WHEN NEW.resolved_scope_constraints IS NULL OR json_valid(NEW.resolved_scope_constraints) = 0 THEN 1
  WHEN json_type(NEW.resolved_scope_constraints) <> 'object' THEN 1
  WHEN NEW.access_snapshot_hash IS NULL OR length(NEW.access_snapshot_hash) <> 43 THEN 1
  WHEN NEW.access_snapshot_hash GLOB '*[^A-Za-z0-9_-]*' THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'agent_grant_versioned_snapshot_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_agent_grants_require_snapshot_active_update
BEFORE UPDATE ON admin_agent_grants
FOR EACH ROW
WHEN NEW.status = 'active' AND CASE
  WHEN NEW.task_set_id IS NULL OR length(trim(NEW.task_set_id)) = 0 THEN 1
  WHEN NEW.task_set_version IS NULL OR NEW.task_set_version < 1 THEN 1
  WHEN NEW.scope_policy_id IS NULL OR length(trim(NEW.scope_policy_id)) = 0 THEN 1
  WHEN NEW.scope_policy_version IS NULL OR NEW.scope_policy_version < 1 THEN 1
  WHEN NEW.resolved_tools IS NULL OR json_valid(NEW.resolved_tools) = 0 THEN 1
  WHEN json_type(NEW.resolved_tools) <> 'array' OR json_array_length(NEW.resolved_tools) < 1 THEN 1
  WHEN NEW.resolved_scope_constraints IS NULL OR json_valid(NEW.resolved_scope_constraints) = 0 THEN 1
  WHEN json_type(NEW.resolved_scope_constraints) <> 'object' THEN 1
  WHEN NEW.access_snapshot_hash IS NULL OR length(NEW.access_snapshot_hash) <> 43 THEN 1
  WHEN NEW.access_snapshot_hash GLOB '*[^A-Za-z0-9_-]*' THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'agent_grant_versioned_snapshot_required');
END;
