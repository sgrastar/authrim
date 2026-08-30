-- Serialize Worker binding reconciliation per environment. The target-level deployment lease
-- still fences individual Worker mutations; this lease prevents overlapping scheduled runs from
-- repeatedly taking over those leases while a previous run is still making progress.
CREATE TABLE control_worker_binding_reconciler_leases (
  environment_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

-- Rollback (fresh test environments only before 1.0):
-- DROP TABLE control_worker_binding_reconciler_leases;
