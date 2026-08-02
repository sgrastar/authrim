-- Durable online Lookup bucket movement state. Runtime data remains in Lookup D1 databases;
-- Control stores only routing metadata, bounded progress, and redacted verification evidence.

CREATE TABLE IF NOT EXISTS control_lookup_bucket_migrations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  source_lookup_shard_id TEXT NOT NULL,
  target_lookup_shard_id TEXT NOT NULL,
  source_assignment_generation INTEGER NOT NULL CHECK (source_assignment_generation >= 1),
  target_assignment_generation INTEGER NOT NULL CHECK (target_assignment_generation >= 2),
  state TEXT NOT NULL DEFAULT 'dual_write'
    CHECK (state IN (
      'dual_write',
      'backfilling',
      'verifying',
      'cutover_pending',
      'grace',
      'complete',
      'blocked'
    )),
  active_operation_key TEXT NOT NULL DEFAULT 'active',
  backfill_cursor_json TEXT NOT NULL DEFAULT '{}',
  source_row_count INTEGER CHECK (source_row_count IS NULL OR source_row_count >= 0),
  target_row_count INTEGER CHECK (target_row_count IS NULL OR target_row_count >= 0),
  verification_digest TEXT
    CHECK (verification_digest IS NULL OR
           (length(verification_digest) = 64 AND verification_digest NOT GLOB '*[^0-9a-f]*')),
  verification_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempt_count BETWEEN 0 AND 3),
  cutover_registry_generation INTEGER
    CHECK (cutover_registry_generation IS NULL OR cutover_registry_generation >= 1),
  dual_write_started_at INTEGER NOT NULL,
  cutover_started_at INTEGER,
  grace_expires_at INTEGER,
  completed_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (source_lookup_shard_id, environment_id)
    REFERENCES control_lookup_physical_shards(lookup_shard_id, environment_id),
  FOREIGN KEY (target_lookup_shard_id, environment_id)
    REFERENCES control_lookup_physical_shards(lookup_shard_id, environment_id),
  CHECK (source_lookup_shard_id <> target_lookup_shard_id),
  CHECK (target_assignment_generation = source_assignment_generation + 1),
  CHECK ((state IN ('complete', 'blocked') AND
          active_operation_key = 'operation:' || operation_id) OR
         (state NOT IN ('complete', 'blocked') AND active_operation_key = 'active')),
  CHECK ((state = 'complete' AND completed_at IS NOT NULL) OR state <> 'complete'),
  CHECK ((state IN ('grace', 'complete') AND cutover_started_at IS NOT NULL AND
          grace_expires_at IS NOT NULL AND cutover_registry_generation IS NOT NULL) OR
         state NOT IN ('grace', 'complete'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_lookup_bucket_migration_active
  ON control_lookup_bucket_migrations(environment_id, virtual_bucket, active_operation_key);

CREATE INDEX IF NOT EXISTS idx_control_lookup_bucket_migration_runnable
  ON control_lookup_bucket_migrations(state, updated_at, environment_id, virtual_bucket);

CREATE TRIGGER IF NOT EXISTS trg_control_lookup_bucket_migration_transition
BEFORE UPDATE OF state ON control_lookup_bucket_migrations
WHEN OLD.state <> NEW.state AND NOT (
  (OLD.state = 'dual_write' AND NEW.state IN ('backfilling', 'blocked')) OR
  (OLD.state = 'backfilling' AND NEW.state IN ('verifying', 'blocked')) OR
  (OLD.state = 'verifying' AND NEW.state IN ('backfilling', 'cutover_pending', 'blocked')) OR
  (OLD.state = 'cutover_pending' AND NEW.state IN ('grace', 'blocked')) OR
  (OLD.state = 'grace' AND NEW.state IN ('complete', 'blocked')) OR
  (OLD.state = 'blocked' AND NEW.state IN (
    'dual_write', 'backfilling', 'verifying', 'cutover_pending', 'grace'
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_lookup_bucket_migration_transition');
END;
