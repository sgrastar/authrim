-- =============================================================================
-- Admin External Token Refresh Runs
-- =============================================================================
-- Description:
--   Stores operational summaries for external IdP token refresh scheduled and
--   manual runs. Detailed payloads may be stored in R2 and referenced through
--   object_catalog.

CREATE TABLE IF NOT EXISTS admin_external_token_refresh_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_tenant_id TEXT,
  actor_type TEXT,
  actor_id TEXT,
  config_json TEXT NOT NULL,
  selected_tenants_count INTEGER NOT NULL DEFAULT 0,
  processed_tenants INTEGER NOT NULL DEFAULT 0,
  failed_tenants INTEGER NOT NULL DEFAULT 0,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  cursor_before TEXT,
  cursor_after TEXT,
  detail_object_catalog_id TEXT,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (trigger_type IN ('scheduled', 'manual_tenant')),
  CHECK (status IN ('running', 'completed', 'partial_failure', 'failed'))
);

CREATE TABLE IF NOT EXISTS admin_external_token_refresh_tenant_runs (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, tenant_id),
  FOREIGN KEY (run_id) REFERENCES admin_external_token_refresh_runs(id) ON DELETE CASCADE,
  CHECK (status IN ('completed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_external_token_refresh_runs_started
  ON admin_external_token_refresh_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_token_refresh_runs_requested_tenant
  ON admin_external_token_refresh_runs(requested_tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_token_refresh_tenant_runs_tenant
  ON admin_external_token_refresh_tenant_runs(tenant_id, completed_at DESC);
