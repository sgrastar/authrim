-- Admin async job state for DB_ADMIN-backed management operations.
-- The core schema historically had admin_jobs; split-admin deployments need the
-- same table in DB_ADMIN because management jobs execute against the admin plane.

CREATE TABLE IF NOT EXISTS admin_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT,
  config TEXT,
  input_r2_key TEXT,
  result_r2_key TEXT,
  object_catalog_id TEXT,
  result TEXT,
  error_code TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  estimated_completion INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  dead_lettered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_cleanup
  ON admin_jobs(status, completed_at);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_status
  ON admin_jobs(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_tenant
  ON admin_jobs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_type
  ON admin_jobs(tenant_id, job_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_next_run
  ON admin_jobs(status, next_run_at, updated_at);
