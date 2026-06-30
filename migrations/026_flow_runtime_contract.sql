-- New Flow runtime contract storage.
-- Extends the legacy flows table and adds published versions, assignments,
-- runtime interaction state, and Flow-specific audit events.

ALTER TABLE flows ADD COLUMN slug TEXT;
ALTER TABLE flows ADD COLUMN display_name TEXT;
ALTER TABLE flows ADD COLUMN kind TEXT NOT NULL DEFAULT 'login';
ALTER TABLE flows ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE flows ADD COLUMN draft_editor_json TEXT;
ALTER TABLE flows ADD COLUMN draft_runtime_base_json TEXT;
ALTER TABLE flows ADD COLUMN published_version_id TEXT;
ALTER TABLE flows ADD COLUMN deleted_at INTEGER;

UPDATE flows
SET
  slug = COALESCE(slug, id),
  display_name = COALESCE(display_name, name),
  draft_editor_json = COALESCE(draft_editor_json, graph_definition),
  draft_runtime_base_json = COALESCE(draft_runtime_base_json, compiled_plan);

CREATE TABLE flow_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  runtime_snapshot_json TEXT NOT NULL,
  editor_snapshot_json TEXT,
  validation_result_json TEXT NOT NULL,
  published_by TEXT,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, flow_id, version_number)
);

CREATE TABLE flow_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  target_type TEXT NOT NULL CHECK (target_type IN ('tenant', 'oidc_client', 'saml_sp')),
  target_id TEXT,
  flow_kind TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL)
    OR (target_type IN ('oidc_client', 'saml_sp') AND target_id IS NOT NULL)
  ),
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
);

CREATE TABLE flow_interactions (
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
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  FOREIGN KEY (flow_version_id) REFERENCES flow_versions(id) ON DELETE CASCADE
);

CREATE TABLE flow_interaction_steps (
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (interaction_id) REFERENCES flow_interactions(id) ON DELETE CASCADE
);

CREATE TABLE flow_audit_events (
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
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_flows_runtime_slug
  ON flows(tenant_id, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_flows_runtime_kind_status
  ON flows(tenant_id, kind, status);

CREATE INDEX idx_flow_versions_lookup
  ON flow_versions(tenant_id, flow_id, version_number);

CREATE INDEX idx_flow_versions_published
  ON flow_versions(tenant_id, flow_id, published_at);

CREATE UNIQUE INDEX idx_flow_assignments_tenant_default
  ON flow_assignments(tenant_id, flow_kind)
  WHERE target_type = 'tenant' AND target_id IS NULL;

CREATE UNIQUE INDEX idx_flow_assignments_target
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind)
  WHERE target_id IS NOT NULL;

CREATE INDEX idx_flow_assignments_flow
  ON flow_assignments(tenant_id, flow_id);

CREATE INDEX idx_flow_interactions_lookup
  ON flow_interactions(tenant_id, id);

CREATE INDEX idx_flow_interactions_expiration
  ON flow_interactions(tenant_id, expires_at);

CREATE INDEX idx_flow_interactions_state_expiration
  ON flow_interactions(tenant_id, state, expires_at);

CREATE INDEX idx_flow_interaction_steps_node
  ON flow_interaction_steps(tenant_id, interaction_id, node_id);

CREATE INDEX idx_flow_interaction_steps_state
  ON flow_interaction_steps(tenant_id, interaction_id, state);

CREATE INDEX idx_flow_audit_events_interaction
  ON flow_audit_events(tenant_id, interaction_id, created_at);

CREATE INDEX idx_flow_audit_events_flow
  ON flow_audit_events(tenant_id, flow_id, flow_version_id, created_at);
