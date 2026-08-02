-- Management-owned orchestration state for shared-pool to tenant-exclusive online cutover.
-- Provider credentials, raw identifiers, and route projections must not be stored here.

CREATE TABLE IF NOT EXISTS tenant_placement_migration_jobs (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  control_operation_id TEXT NOT NULL,
  target_isolation_policy TEXT NOT NULL DEFAULT 'tenant_exclusive'
    CHECK (target_isolation_policy = 'tenant_exclusive'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_retry', 'blocked', 'succeeded', 'canceled')),
  active_job_key TEXT DEFAULT 'active'
    CHECK (active_job_key IS NULL OR active_job_key = 'active'),
  current_step TEXT NOT NULL DEFAULT 'wait_control' CHECK (current_step IN (
    'wait_control',
    'begin_route_cutover',
    'prepare_lookup',
    'prepare_alias',
    'commit_control',
    'publish_registry',
    'activate_alias',
    'activate_lookup',
    'verify_routes',
    'finalize_source',
    'complete'
  )),
  lookup_cursor_json TEXT CHECK (
    lookup_cursor_json IS NULL OR
    (json_valid(lookup_cursor_json) AND length(lookup_cursor_json) <= 2048)
  ),
  lookup_prepared_row_count INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_prepared_row_count >= 0),
  lookup_activated_row_count INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_activated_row_count >= 0),
  lookup_verified_row_count INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_verified_row_count >= 0),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_budget_started_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (environment_id, tenant_id, active_job_key),
  UNIQUE (environment_id, control_operation_id),
  CHECK ((status IN ('succeeded', 'canceled') AND completed_at IS NOT NULL)
         OR status NOT IN ('succeeded', 'canceled')),
  CHECK ((status = 'succeeded' AND current_step = 'complete') OR status <> 'succeeded'),
  CHECK ((status IN ('succeeded', 'canceled') AND active_job_key IS NULL)
          OR (status NOT IN ('succeeded', 'canceled') AND active_job_key = 'active'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_placement_migration_jobs_runnable
  ON tenant_placement_migration_jobs(status, next_attempt_at, lease_expires_at, created_at);

CREATE TRIGGER IF NOT EXISTS trg_tenant_placement_migration_job_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, control_operation_id,
                 target_isolation_policy, request_hash, idempotency_key,
                 retry_budget_started_at, requested_by, created_at
ON tenant_placement_migration_jobs
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_placement_migration_job_status_transition
BEFORE UPDATE OF status ON tenant_placement_migration_jobs
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('running', 'blocked', 'canceled')) OR
  (OLD.status = 'running' AND NEW.status IN ('waiting_retry', 'blocked', 'succeeded', 'canceled')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('running', 'blocked', 'canceled')) OR
  (OLD.status = 'blocked' AND NEW.status IN ('running', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_status_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_placement_migration_job_step_transition
BEFORE UPDATE OF current_step ON tenant_placement_migration_jobs
WHEN OLD.current_step <> NEW.current_step AND NOT (
  (OLD.current_step = 'wait_control' AND NEW.current_step = 'begin_route_cutover') OR
  (OLD.current_step = 'begin_route_cutover' AND NEW.current_step = 'prepare_lookup') OR
  (OLD.current_step = 'prepare_lookup' AND NEW.current_step = 'prepare_alias') OR
  (OLD.current_step = 'prepare_alias' AND NEW.current_step = 'commit_control') OR
  (OLD.current_step = 'commit_control' AND NEW.current_step = 'publish_registry') OR
  (OLD.current_step = 'publish_registry' AND NEW.current_step = 'activate_alias') OR
  (OLD.current_step = 'activate_alias' AND NEW.current_step = 'activate_lookup') OR
  (OLD.current_step = 'activate_lookup' AND NEW.current_step = 'verify_routes') OR
  (OLD.current_step = 'verify_routes' AND NEW.current_step = 'finalize_source') OR
  (OLD.current_step = 'finalize_source' AND NEW.current_step = 'complete')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_step_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_tenant_placement_migration_job_fencing
BEFORE UPDATE ON tenant_placement_migration_jobs
WHEN OLD.lease_owner IS NOT NULL AND (
  NEW.lease_owner IS NULL OR
  NEW.lease_owner <> OLD.lease_owner OR
  NEW.fencing_token <> OLD.fencing_token
)
AND NEW.status NOT IN ('waiting_retry', 'blocked', 'succeeded', 'canceled')
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_job_stale_lease');
END;
