-- Durable global provider configuration reprojection into tenant-scoped Runner installations.

CREATE TABLE IF NOT EXISTS provider_reprojection_jobs (
  job_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  desired_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'superseded')),
  cursor_tenant_id TEXT,
  total_tenants INTEGER NOT NULL DEFAULT 0 CHECK (total_tenants >= 0),
  processed_tenants INTEGER NOT NULL DEFAULT 0 CHECK (processed_tenants >= 0),
  succeeded_tenants INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_tenants >= 0),
  skipped_tenants INTEGER NOT NULL DEFAULT 0 CHECK (skipped_tenants >= 0),
  failed_tenants INTEGER NOT NULL DEFAULT 0 CHECK (failed_tenants >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 100),
  next_run_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (plugin_id, desired_revision),
  CHECK ((status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_provider_reprojection_jobs_due
  ON provider_reprojection_jobs(status, next_run_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_provider_reprojection_jobs_plugin
  ON provider_reprojection_jobs(plugin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_reprojection_tenant_state (
  plugin_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  desired_revision TEXT NOT NULL,
  applied_revision TEXT,
  source_scope TEXT NOT NULL CHECK (source_scope IN ('inherited', 'override')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'skipped', 'failed')),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_reprojection_tenant_status
  ON provider_reprojection_tenant_state(plugin_id, desired_revision, status, tenant_id);
