-- Keep one Flow assignment for each target and Flow kind.
-- If duplicate rows already exist, retain the most recently updated row before adding uniqueness.

DELETE FROM flow_assignments
WHERE EXISTS (
  SELECT 1
  FROM flow_assignments newer
  WHERE newer.tenant_id = flow_assignments.tenant_id
    AND newer.target_type = flow_assignments.target_type
    AND (
      (newer.target_id IS NULL AND flow_assignments.target_id IS NULL)
      OR newer.target_id = flow_assignments.target_id
    )
    AND newer.flow_kind = flow_assignments.flow_kind
    AND (
      newer.updated_at > flow_assignments.updated_at
      OR (
        newer.updated_at = flow_assignments.updated_at
        AND newer.created_at > flow_assignments.created_at
      )
      OR (
        newer.updated_at = flow_assignments.updated_at
        AND newer.created_at = flow_assignments.created_at
        AND newer.id > flow_assignments.id
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_assignments_tenant_default_unique
  ON flow_assignments(tenant_id, flow_kind)
  WHERE target_type = 'tenant' AND target_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_assignments_target_unique
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind)
  WHERE target_id IS NOT NULL;
