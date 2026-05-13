-- Add generic admin job retry/dead-letter scheduling state.

ALTER TABLE admin_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE admin_jobs ADD COLUMN next_run_at INTEGER;
ALTER TABLE admin_jobs ADD COLUMN dead_lettered_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_admin_jobs_next_run
  ON admin_jobs(status, next_run_at, updated_at);
