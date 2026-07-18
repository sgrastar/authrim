-- Phase 2B: versioned Task Sets, Scope Policies, immutable configuration Plans, and secret refs.
ALTER TABLE admin_agent_grants ADD COLUMN task_set_id TEXT;
ALTER TABLE admin_agent_grants ADD COLUMN task_set_version INTEGER;
ALTER TABLE admin_agent_grants ADD COLUMN resolved_tools TEXT;

CREATE TABLE IF NOT EXISTS agent_task_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'custom', 'template_copy')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  source_template_id TEXT,
  source_template_version INTEGER,
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS agent_task_set_versions (
  task_set_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  tool_entries_json TEXT NOT NULL,
  resolved_permissions_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(task_set_id, version),
  FOREIGN KEY(task_set_id) REFERENCES agent_task_sets(id)
);

CREATE TABLE IF NOT EXISTS agent_scope_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'custom', 'template_copy')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  source_template_id TEXT,
  source_template_version INTEGER,
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS agent_scope_policy_versions (
  scope_policy_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  selector_catalog_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  last_transition_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_policy_id, version),
  FOREIGN KEY(scope_policy_id) REFERENCES agent_scope_policies(id)
);

CREATE TABLE IF NOT EXISTS agent_configuration_plans (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_generation INTEGER NOT NULL CHECK (grant_generation >= 1),
  consent_version INTEGER NOT NULL CHECK (consent_version >= 1),
  actor_sub TEXT NOT NULL,
  client_id TEXT NOT NULL,
  definition_json TEXT,
  snapshot_json TEXT,
  diff_json TEXT,
  validation_json TEXT,
  result_json TEXT,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'running', 'completed', 'failed')),
  stage TEXT NOT NULL CHECK (stage IN ('validate', 'apply', 'verify')),
  applied_step_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_step_count >= 0),
  failed_step_id TEXT,
  failure_kind TEXT,
  confirmation_id TEXT,
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

CREATE INDEX IF NOT EXISTS idx_agent_configuration_plans_context
  ON agent_configuration_plans(tenant_id, grant_id, actor_sub, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_configuration_plans_retention
  ON agent_configuration_plans(payload_purge_at, payload_purged_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configuration_plans_transition
  ON agent_configuration_plans(last_transition_id);

CREATE TABLE IF NOT EXISTS agent_configuration_plan_steps (
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  operation TEXT NOT NULL,
  tool_contract_version TEXT NOT NULL,
  input_json TEXT,
  input_digest TEXT NOT NULL,
  resource_precondition TEXT,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'standard', 'high')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'indeterminate')),
  result_json TEXT,
  result_digest TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  PRIMARY KEY(plan_id, plan_version, step_id),
  FOREIGN KEY(plan_id, plan_version) REFERENCES agent_configuration_plans(id, version),
  UNIQUE(plan_id, plan_version, sequence)
);

CREATE TABLE IF NOT EXISTS agent_plan_confirmations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  confirmed_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'consumed', 'denied')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  consumed_at INTEGER,
  last_transition_id TEXT,
  UNIQUE(plan_id, plan_version, plan_digest)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_plan_confirmations_transition
  ON agent_plan_confirmations(last_transition_id);

CREATE TABLE IF NOT EXISTS agent_secret_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  purpose TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  last_transition_id TEXT,
  UNIQUE(tenant_id, provider_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_secret_refs_transition
  ON agent_secret_refs(last_transition_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_sets_transition
  ON agent_task_sets(last_transition_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_scope_policies_transition
  ON agent_scope_policies(last_transition_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_set_versions_transition
  ON agent_task_set_versions(last_transition_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_scope_policy_versions_transition
  ON agent_scope_policy_versions(last_transition_id);
