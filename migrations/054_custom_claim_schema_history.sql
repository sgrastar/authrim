-- Custom Claim Schema History
-- Tracks all changes to custom_claim_schemas for auditing and rollback
-- Pattern reference: settings_history (023_settings_history.sql)

CREATE TABLE custom_claim_schema_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  schema_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete','rename','toggle_active')),
  snapshot TEXT NOT NULL,      -- Full schema JSON after change
  changes TEXT NOT NULL,       -- JSON diff: {added:[], removed:[], modified:[]}
  actor_id TEXT,
  actor_type TEXT CHECK(actor_type IN ('user','admin','system','api')),
  change_source TEXT CHECK(change_source IN ('admin_api','admin_ui','migration','rollback')),
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, schema_id, version)
);

CREATE INDEX idx_ccsh_schema ON custom_claim_schema_history(tenant_id, schema_id, version DESC);
CREATE INDEX idx_ccsh_cleanup ON custom_claim_schema_history(tenant_id, created_at);
