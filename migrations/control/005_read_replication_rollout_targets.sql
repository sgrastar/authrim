-- Resumable environment-wide D1 read replication rollout targets.

ALTER TABLE control_lookup_physical_shards
  ADD COLUMN read_replication_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (read_replication_mode IN ('disabled', 'enabled'));

ALTER TABLE control_lookup_physical_shards
  ADD COLUMN consistency_policy_version INTEGER NOT NULL DEFAULT 1
    CHECK (consistency_policy_version >= 1);

ALTER TABLE control_lookup_physical_shards
  ADD COLUMN observed_replication_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (observed_replication_state IN ('unknown', 'disabled', 'enabling', 'enabled', 'failed'));

ALTER TABLE control_lookup_physical_shards
  ADD COLUMN replication_checked_at INTEGER;

ALTER TABLE control_lookup_physical_shards
  ADD COLUMN replication_error_code TEXT;

ALTER TABLE control_tenant_shards
  ADD COLUMN replication_checked_at INTEGER;

ALTER TABLE control_tenant_shards
  ADD COLUMN replication_error_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_read_replication_rollouts_environment
  ON control_read_replication_rollouts(operation_id, environment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_read_replication_rollouts_one_active
  ON control_read_replication_rollouts(environment_id)
  WHERE status IN ('queued', 'applying', 'verifying');

CREATE TABLE IF NOT EXISTS control_read_replication_rollout_targets (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  desired_resource_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('lookup', 'tenant')),
  shard_id TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('lookup', 'tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_partition TEXT NOT NULL,
  desired_mode TEXT NOT NULL CHECK (desired_mode IN ('disabled', 'enabled')),
  provider_database_id TEXT,
  observed_provider_mode TEXT CHECK (observed_provider_mode IN ('auto', 'disabled')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'applying', 'verifying', 'waiting_retry', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  retry_budget_expires_at INTEGER NOT NULL,
  lock_owner TEXT,
  lock_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, desired_resource_id),
  UNIQUE (operation_id, target_kind, shard_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_read_replication_rollouts(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id),
  CHECK (retry_budget_expires_at >= created_at),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded'),
  CHECK ((status IN ('applying', 'verifying') AND lock_owner IS NOT NULL AND lock_expires_at IS NOT NULL) OR
         (status NOT IN ('applying', 'verifying') AND lock_owner IS NULL AND lock_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_control_read_replication_targets_runnable
  ON control_read_replication_rollout_targets(status, next_attempt_at, lock_expires_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_control_read_replication_targets_policy
  ON control_read_replication_rollout_targets(
    operation_id,
    data_role,
    residency_partition,
    status
  );

CREATE TRIGGER IF NOT EXISTS trg_control_read_replication_target_transition
BEFORE UPDATE OF status ON control_read_replication_rollout_targets
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('applying', 'blocked')) OR
  (OLD.status = 'applying' AND NEW.status IN ('verifying', 'waiting_retry', 'blocked')) OR
  (OLD.status = 'verifying' AND NEW.status IN ('applying', 'succeeded', 'waiting_retry', 'blocked')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('applying', 'blocked')) OR
  (OLD.status = 'blocked' AND NEW.status = 'applying')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_read_replication_target_transition');
END;
