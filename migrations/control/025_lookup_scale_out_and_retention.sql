-- Durable Lookup scale-out planning and fail-closed retention projections.

ALTER TABLE control_lookup_physical_shards
  ADD COLUMN capacity_weight REAL NOT NULL DEFAULT 1 CHECK (capacity_weight > 0);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN lookup_rebalance_concurrency INTEGER NOT NULL DEFAULT 1
    CHECK (lookup_rebalance_concurrency BETWEEN 1 AND 4);

ALTER TABLE control_environment_resource_policies
  ADD COLUMN lookup_forecast_horizon_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (lookup_forecast_horizon_seconds BETWEEN 300 AND 2592000);

CREATE TABLE IF NOT EXISTS control_lookup_retention_policy_projections (
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  source_operation_id TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  projected_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, tenant_id),
  UNIQUE (environment_id, source_operation_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK (projected_at >= source_updated_at)
);

CREATE TRIGGER IF NOT EXISTS trg_control_lookup_retention_policy_projection_monotonic
BEFORE UPDATE ON control_lookup_retention_policy_projections
WHEN NEW.policy_generation <= OLD.policy_generation OR
     NEW.source_updated_at < OLD.source_updated_at
BEGIN
  SELECT RAISE(ABORT, 'control_lookup_retention_policy_projection_stale');
END;

CREATE TABLE IF NOT EXISTS control_account_legal_hold_projections (
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_state TEXT NOT NULL CHECK (projection_state IN ('active', 'inactive')),
  source_operation_id TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  projected_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, tenant_id, account_id),
  UNIQUE (environment_id, source_operation_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK (projected_at >= source_updated_at)
);

CREATE INDEX IF NOT EXISTS idx_control_account_legal_hold_active
  ON control_account_legal_hold_projections(environment_id, projection_state, tenant_id, account_id);

CREATE TRIGGER IF NOT EXISTS trg_control_account_legal_hold_projection_monotonic
BEFORE UPDATE ON control_account_legal_hold_projections
WHEN NEW.projection_generation <= OLD.projection_generation OR
     NEW.source_updated_at < OLD.source_updated_at
BEGIN
  SELECT RAISE(ABORT, 'control_account_legal_hold_projection_stale');
END;

CREATE TABLE IF NOT EXISTS control_lookup_rebalance_batches (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN (
      'queued', 'dual_write', 'exact_verifying', 'registry_pending', 'grace',
      'source_cleanup', 'completed', 'blocked'
    )),
  planner_version INTEGER NOT NULL DEFAULT 1 CHECK (planner_version >= 1),
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  load_snapshot_digest TEXT NOT NULL
    CHECK (length(load_snapshot_digest) = 64 AND load_snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  binding_readiness_generation INTEGER NOT NULL CHECK (binding_readiness_generation >= 1),
  registry_generation_before INTEGER NOT NULL CHECK (registry_generation_before >= 1),
  registry_generation_after INTEGER CHECK (registry_generation_after IS NULL OR registry_generation_after >= 1),
  registry_serialized_bytes INTEGER CHECK (registry_serialized_bytes IS NULL OR registry_serialized_bytes >= 1),
  concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit BETWEEN 1 AND 4),
  grace_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  CHECK ((state = 'completed' AND completed_at IS NOT NULL) OR state <> 'completed'),
  CHECK ((state IN ('grace', 'source_cleanup', 'completed') AND
          registry_generation_after IS NOT NULL AND grace_expires_at IS NOT NULL) OR
         state NOT IN ('grace', 'source_cleanup', 'completed'))
);

CREATE INDEX IF NOT EXISTS idx_control_lookup_rebalance_batch_state
  ON control_lookup_rebalance_batches(environment_id, state, operation_id);

CREATE TRIGGER IF NOT EXISTS trg_control_lookup_rebalance_one_active_insert
BEFORE INSERT ON control_lookup_rebalance_batches
WHEN NEW.state NOT IN ('completed', 'blocked') AND EXISTS (
  SELECT 1 FROM control_lookup_rebalance_batches batch
   WHERE batch.environment_id = NEW.environment_id
     AND batch.state NOT IN ('completed', 'blocked')
     AND batch.operation_id <> NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'control_lookup_rebalance_active_conflict');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_lookup_rebalance_one_active_update
BEFORE UPDATE OF environment_id, state ON control_lookup_rebalance_batches
WHEN NEW.state NOT IN ('completed', 'blocked') AND EXISTS (
  SELECT 1 FROM control_lookup_rebalance_batches batch
   WHERE batch.environment_id = NEW.environment_id
     AND batch.state NOT IN ('completed', 'blocked')
     AND batch.operation_id <> OLD.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'control_lookup_rebalance_active_conflict');
END;

CREATE TABLE IF NOT EXISTS control_lookup_rebalance_bucket_targets (
  operation_id TEXT NOT NULL,
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  source_lookup_shard_id TEXT NOT NULL,
  target_lookup_shard_id TEXT NOT NULL,
  source_assignment_generation INTEGER NOT NULL CHECK (source_assignment_generation >= 1),
  target_assignment_generation INTEGER NOT NULL CHECK (target_assignment_generation >= 2),
  classification TEXT NOT NULL CHECK (classification IN ('empty', 'populated')),
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN (
      'planned', 'dual_write', 'exact_verified', 'copying', 'verifying',
      'publishable', 'published', 'quarantined', 'completed', 'blocked'
    )),
  source_active_row_count INTEGER CHECK (source_active_row_count IS NULL OR source_active_row_count >= 0),
  target_active_row_count INTEGER CHECK (target_active_row_count IS NULL OR target_active_row_count >= 0),
  exact_verification_digest TEXT
    CHECK (exact_verification_digest IS NULL OR
           (length(exact_verification_digest) = 64 AND
            exact_verification_digest NOT GLOB '*[^0-9a-f]*')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, virtual_bucket),
  FOREIGN KEY (operation_id) REFERENCES control_lookup_rebalance_batches(operation_id)
    ON DELETE CASCADE,
  CHECK (source_lookup_shard_id <> target_lookup_shard_id),
  CHECK (target_assignment_generation = source_assignment_generation + 1)
);

CREATE INDEX IF NOT EXISTS idx_control_lookup_rebalance_bucket_runnable
  ON control_lookup_rebalance_bucket_targets(state, updated_at, operation_id, virtual_bucket);

CREATE TABLE IF NOT EXISTS control_lookup_retention_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  policy_source_updated_at INTEGER NOT NULL,
  frozen_inventory_digest TEXT NOT NULL
    CHECK (length(frozen_inventory_digest) = 64 AND
           frozen_inventory_digest NOT GLOB '*[^0-9a-f]*'),
  execution_mode TEXT NOT NULL DEFAULT 'dry_run'
    CHECK (execution_mode IN ('dry_run', 'delete', 'verified_erasure')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'waiting_retry', 'completed', 'blocked', 'canceled')),
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK (attempted_count >= 0),
  deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  held_count INTEGER NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  raced_count INTEGER NOT NULL DEFAULT 0 CHECK (raced_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  CHECK (deleted_count <= attempted_count),
  CHECK ((state = 'completed' AND completed_at IS NOT NULL) OR state <> 'completed')
);

CREATE TABLE IF NOT EXISTS control_lookup_retention_targets (
  operation_id TEXT NOT NULL,
  lookup_shard_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL
    CHECK (artifact_kind IN ('identifier', 'tenant_alias', 'reservation', 'replacement_gate')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'waiting_retry', 'completed', 'blocked')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at INTEGER,
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK (attempted_count >= 0),
  deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  held_count INTEGER NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  raced_count INTEGER NOT NULL DEFAULT 0 CHECK (raced_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (operation_id, lookup_shard_id, artifact_kind),
  FOREIGN KEY (operation_id) REFERENCES control_lookup_retention_operations(operation_id)
    ON DELETE CASCADE,
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (deleted_count <= attempted_count),
  CHECK ((state = 'completed' AND completed_at IS NOT NULL) OR state <> 'completed')
);

CREATE INDEX IF NOT EXISTS idx_control_lookup_retention_target_runnable
  ON control_lookup_retention_targets(state, lease_expires_at, updated_at, operation_id);
