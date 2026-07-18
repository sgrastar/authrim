-- Phase 2C: immutable multi-tenant Bulk Plans, baselines, exceptions, and template copies.
CREATE TABLE IF NOT EXISTS agent_bulk_plans (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  control_tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  client_id TEXT NOT NULL,
  definition_json TEXT,
  definition_digest TEXT NOT NULL,
  target_snapshot_json TEXT,
  target_snapshot_digest TEXT NOT NULL,
  canary_tenant_ids_json TEXT,
  canary_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'running', 'paused', 'completed')),
  stage TEXT NOT NULL CHECK (stage IN ('validate', 'apply', 'verify')),
  canary_size INTEGER NOT NULL CHECK (canary_size >= 1),
  wave_size INTEGER NOT NULL CHECK (wave_size >= 1),
  wave_failure_threshold_bps INTEGER NOT NULL CHECK (
    wave_failure_threshold_bps >= 0 AND wave_failure_threshold_bps <= 500
  ),
  current_wave INTEGER NOT NULL DEFAULT 0 CHECK (current_wave >= 0),
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  indeterminate_count INTEGER NOT NULL DEFAULT 0 CHECK (indeterminate_count >= 0),
  pause_reason TEXT,
  last_transition_id TEXT,
  expires_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT,
  payload_purge_at INTEGER NOT NULL,
  payload_purged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(id, version),
  FOREIGN KEY(grant_id) REFERENCES admin_agent_grants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_bulk_plans_transition
  ON agent_bulk_plans(last_transition_id);
CREATE INDEX IF NOT EXISTS idx_agent_bulk_plans_control
  ON agent_bulk_plans(control_tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_bulk_plans_retention
  ON agent_bulk_plans(payload_purge_at, payload_purged_at);

CREATE TABLE IF NOT EXISTS agent_bulk_tenant_executions (
  id TEXT PRIMARY KEY,
  bulk_plan_id TEXT NOT NULL,
  bulk_plan_version INTEGER NOT NULL,
  target_tenant_id TEXT NOT NULL,
  target_sequence INTEGER NOT NULL CHECK (target_sequence >= 0),
  is_canary INTEGER NOT NULL CHECK (is_canary IN (0, 1)),
  wave_number INTEGER CHECK (wave_number IS NULL OR wave_number >= 1),
  stage TEXT NOT NULL CHECK (stage IN ('validate', 'apply', 'verify')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'indeterminate')),
  plan_digest TEXT NOT NULL,
  child_capability_digest TEXT,
  precondition_snapshot_digest TEXT,
  execution_attempt INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0),
  execution_fence INTEGER NOT NULL DEFAULT 0 CHECK (execution_fence >= 0),
  execution_owner_id TEXT,
  execution_lease_expires_at INTEGER,
  idempotency_key TEXT NOT NULL,
  result_json TEXT,
  result_digest TEXT,
  failure_kind TEXT,
  last_transition_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(bulk_plan_id, bulk_plan_version, target_tenant_id),
  UNIQUE(bulk_plan_id, bulk_plan_version, target_sequence),
  FOREIGN KEY(bulk_plan_id, bulk_plan_version) REFERENCES agent_bulk_plans(id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_bulk_tenant_transition
  ON agent_bulk_tenant_executions(last_transition_id);
CREATE INDEX IF NOT EXISTS idx_agent_bulk_tenant_claim
  ON agent_bulk_tenant_executions(bulk_plan_id, bulk_plan_version, status, is_canary, wave_number);
CREATE INDEX IF NOT EXISTS idx_agent_bulk_tenant_lease
  ON agent_bulk_tenant_executions(status, execution_lease_expires_at);

CREATE TABLE IF NOT EXISTS agent_configuration_templates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  source_tenant_id TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('task_set', 'scope_policy')),
  source_object_id TEXT NOT NULL,
  source_object_version INTEGER NOT NULL CHECK (source_object_version >= 1),
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY(id, version)
);

CREATE TABLE IF NOT EXISTS agent_template_copies (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  target_tenant_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  target_object_version INTEGER NOT NULL,
  target_object_status TEXT NOT NULL CHECK (target_object_status = 'inactive'),
  bulk_plan_id TEXT NOT NULL,
  copied_by TEXT NOT NULL,
  copied_at INTEGER NOT NULL,
  UNIQUE(template_id, template_version, target_tenant_id)
);

CREATE TABLE IF NOT EXISTS agent_baselines (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  control_tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('one_time', 'managed')),
  enforcement TEXT NOT NULL CHECK (enforcement IN ('report_only', 'standard_auto_remediation')),
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(id, version)
);

CREATE TABLE IF NOT EXISTS agent_baseline_assignments (
  id TEXT PRIMARY KEY,
  baseline_id TEXT NOT NULL,
  baseline_version INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  source_bulk_plan_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  last_evaluated_at INTEGER,
  drift_status TEXT CHECK (drift_status IN ('in_sync', 'drifted', 'unknown')),
  drift_digest TEXT,
  remediation_bulk_plan_id TEXT,
  remediation_bulk_plan_version INTEGER,
  remediation_drift_digest TEXT,
  remediation_requested_at INTEGER,
  last_transition_id TEXT,
  UNIQUE(baseline_id, baseline_version, tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_baseline_assignments_transition
  ON agent_baseline_assignments(last_transition_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_baseline_assignments_remediation_plan
  ON agent_baseline_assignments(remediation_bulk_plan_id, remediation_bulk_plan_version);

CREATE TABLE IF NOT EXISTS agent_baseline_exceptions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(assignment_id) REFERENCES agent_baseline_assignments(id)
);
