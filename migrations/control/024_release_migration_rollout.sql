-- Durable release migration handoff from setup to Control.
--
-- Setup creates one immutable rollout operation after publishing the pinned release artifact.
-- Control snapshots the managed D1 inventory once, then reconciles only that frozen target set.

CREATE TABLE IF NOT EXISTS control_release_migration_rollouts (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  source_version TEXT,
  target_version TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  manifest_r2_object_key TEXT NOT NULL,
  database_execution TEXT NOT NULL CHECK (database_execution = 'setup_then_control'),
  worker_activation TEXT NOT NULL CHECK (worker_activation = 'after_required_databases'),
  admin_mutation_mode TEXT NOT NULL CHECK (admin_mutation_mode IN ('available', 'read_only')),
  handoff_state TEXT NOT NULL DEFAULT 'requested'
    CHECK (handoff_state IN (
      'requested', 'database_rollout', 'awaiting_setup', 'verifying', 'completed', 'blocked'
    )),
  active_environment_key TEXT NOT NULL,
  target_snapshot_at INTEGER,
  setup_resumed_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, active_environment_key),
  UNIQUE (operation_id, environment_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  CHECK (
    manifest_r2_object_key =
      'releases/' || release_id || '/' || manifest_digest || '/manifest.json'
  ),
  CHECK (
    (handoff_state = 'completed' AND completed_at IS NOT NULL AND
      active_environment_key = 'completed:' || operation_id) OR
    (handoff_state <> 'completed' AND completed_at IS NULL AND
      active_environment_key = environment_id)
  )
);

CREATE TRIGGER IF NOT EXISTS trg_control_release_migration_rollout_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, source_version, target_version, release_id,
  manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
  admin_mutation_mode, created_at
ON control_release_migration_rollouts
BEGIN
  SELECT RAISE(ABORT, 'control_release_migration_rollout_immutable');
END;

CREATE TABLE IF NOT EXISTS control_release_migration_targets (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('tenant_shard', 'lookup_shard')),
  shard_id TEXT NOT NULL,
  desired_resource_id TEXT NOT NULL,
  provider_database_id TEXT,
  binding_ref TEXT NOT NULL,
  stream_id TEXT NOT NULL CHECK (stream_id IN ('d1-core', 'd1-pii', 'd1-lookup')),
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'waiting_retry', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_budget_started_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  expected_file_count INTEGER CHECK (expected_file_count IS NULL OR expected_file_count >= 0),
  applied_file_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_file_count >= 0),
  skipped_file_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_file_count >= 0),
  response_loss_recoveries INTEGER NOT NULL DEFAULT 0
    CHECK (response_loss_recoveries >= 0),
  last_filename TEXT,
  last_error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, target_id),
  UNIQUE (operation_id, desired_resource_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_release_migration_rollouts(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, stream_id)
    REFERENCES control_operation_release_pins(operation_id, stream_id),
  FOREIGN KEY (desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id),
  CHECK (applied_file_count <= COALESCE(expected_file_count, applied_file_count)),
  CHECK (
    (state = 'succeeded' AND provider_database_id IS NOT NULL AND completed_at IS NOT NULL AND
      expected_file_count IS NOT NULL AND
      applied_file_count + skipped_file_count = expected_file_count) OR
    state <> 'succeeded'
  ),
  CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    state <> 'running'
  )
);

CREATE INDEX IF NOT EXISTS idx_control_release_migration_targets_runnable
  ON control_release_migration_targets(state, next_attempt_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_control_release_migration_targets_operation
  ON control_release_migration_targets(operation_id, state, target_id);

CREATE TRIGGER IF NOT EXISTS trg_control_release_migration_target_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, target_id, target_kind, shard_id,
  desired_resource_id, binding_ref, stream_id, release_id,
  manifest_digest, created_at
ON control_release_migration_targets
BEGIN
  SELECT RAISE(ABORT, 'control_release_migration_target_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_release_migration_target_provider_immutable
BEFORE UPDATE OF provider_database_id ON control_release_migration_targets
WHEN OLD.provider_database_id IS NOT NULL AND NEW.provider_database_id IS NOT OLD.provider_database_id
BEGIN
  SELECT RAISE(ABORT, 'control_release_migration_target_provider_immutable');
END;
