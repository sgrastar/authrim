-- Phase 2C hardening: bind Bulk Plans and child executions to authenticated Agent context.
ALTER TABLE agent_bulk_plans ADD COLUMN delegator_id TEXT;
ALTER TABLE agent_bulk_plans ADD COLUMN actor_mode TEXT;
ALTER TABLE agent_bulk_plans ADD COLUMN actor_assurance TEXT;
ALTER TABLE agent_bulk_plans ADD COLUMN token_binding TEXT;
ALTER TABLE agent_bulk_plans ADD COLUMN machine_principal_id TEXT;
ALTER TABLE agent_bulk_plans ADD COLUMN machine_credential_id TEXT;
ALTER TABLE agent_bulk_plans ADD COLUMN grant_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_bulk_plans ADD COLUMN consent_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_bulk_plans ADD COLUMN approved_by TEXT;
ALTER TABLE agent_bulk_plans ADD COLUMN approved_at INTEGER;
ALTER TABLE agent_bulk_plans ADD COLUMN approval_digest TEXT;

ALTER TABLE agent_bulk_tenant_executions ADD COLUMN child_capability_expires_at INTEGER;

ALTER TABLE agent_template_copies ADD COLUMN bulk_plan_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_baseline_assignments ADD COLUMN source_bulk_plan_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_agent_bulk_plans_actor
  ON agent_bulk_plans(control_tenant_id, grant_id, actor_sub, status);
CREATE INDEX IF NOT EXISTS idx_agent_bulk_children_capability
  ON agent_bulk_tenant_executions(
    bulk_plan_id, bulk_plan_version, target_tenant_id,
    execution_attempt, execution_fence, child_capability_digest
  );
