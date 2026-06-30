-- New Flow runtime contract storage for external durable PostgreSQL backends.

CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  profile_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  graph_definition TEXT,
  compiled_plan TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_by TEXT,
  updated_at BIGINT NOT NULL,
  slug TEXT,
  display_name TEXT,
  kind TEXT NOT NULL DEFAULT 'login',
  status TEXT NOT NULL DEFAULT 'draft',
  draft_editor_json TEXT,
  draft_runtime_base_json TEXT,
  published_version_id TEXT,
  deleted_at BIGINT
);

ALTER TABLE flows ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS created_at BIGINT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS updated_at BIGINT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS profile_id TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS graph_definition TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS compiled_plan TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'login';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS draft_editor_json TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS draft_runtime_base_json TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS published_version_id TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

UPDATE flows
SET
  slug = COALESCE(slug, id),
  display_name = COALESCE(display_name, name),
  draft_editor_json = COALESCE(draft_editor_json, graph_definition),
  draft_runtime_base_json = COALESCE(draft_runtime_base_json, compiled_plan);

CREATE TABLE IF NOT EXISTS flow_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  runtime_snapshot_json TEXT NOT NULL,
  editor_snapshot_json TEXT,
  validation_result_json TEXT NOT NULL,
  published_by TEXT,
  published_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  CONSTRAINT flow_versions_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  CONSTRAINT flow_versions_unique_version UNIQUE (tenant_id, flow_id, version_number)
);

CREATE TABLE IF NOT EXISTS flow_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  target_type TEXT NOT NULL CHECK (target_type IN ('tenant', 'oidc_client', 'saml_sp')),
  target_id TEXT,
  flow_kind TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL)
    OR (target_type IN ('oidc_client', 'saml_sp') AND target_id IS NOT NULL)
  ),
  CONSTRAINT flow_assignments_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS flow_interactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'active', 'completed', 'expired', 'failed')),
  current_node_id TEXT,
  current_step_id TEXT,
  contract_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  CONSTRAINT flow_interactions_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  CONSTRAINT flow_interactions_version_fk
    FOREIGN KEY (flow_version_id) REFERENCES flow_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS flow_interaction_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'waiting_input', 'processing', 'completed', 'skipped', 'failed')
  ),
  selected_handle TEXT,
  state_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT flow_interaction_steps_interaction_fk
    FOREIGN KEY (interaction_id) REFERENCES flow_interactions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS flow_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  node_id TEXT,
  branch_handle_id TEXT,
  event_type TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  contract_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flows_runtime_slug
  ON flows(tenant_id, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flows_runtime_kind_status
  ON flows(tenant_id, kind, status);

CREATE INDEX IF NOT EXISTS idx_flow_versions_lookup
  ON flow_versions(tenant_id, flow_id, version_number);

CREATE INDEX IF NOT EXISTS idx_flow_versions_published
  ON flow_versions(tenant_id, flow_id, published_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_assignments_tenant_default
  ON flow_assignments(tenant_id, flow_kind)
  WHERE target_type = 'tenant' AND target_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_assignments_target
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind)
  WHERE target_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flow_assignments_flow
  ON flow_assignments(tenant_id, flow_id);

CREATE INDEX IF NOT EXISTS idx_flow_interactions_lookup
  ON flow_interactions(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_flow_interactions_expiration
  ON flow_interactions(tenant_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_flow_interactions_state_expiration
  ON flow_interactions(tenant_id, state, expires_at);

CREATE INDEX IF NOT EXISTS idx_flow_interaction_steps_node
  ON flow_interaction_steps(tenant_id, interaction_id, node_id);

CREATE INDEX IF NOT EXISTS idx_flow_interaction_steps_state
  ON flow_interaction_steps(tenant_id, interaction_id, state);

CREATE INDEX IF NOT EXISTS idx_flow_audit_events_interaction
  ON flow_audit_events(tenant_id, interaction_id, created_at);

CREATE INDEX IF NOT EXISTS idx_flow_audit_events_flow
  ON flow_audit_events(tenant_id, flow_id, flow_version_id, created_at);
