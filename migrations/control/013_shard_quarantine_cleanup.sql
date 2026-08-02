-- Retired tenant-shard quarantine and explicitly approved destructive cleanup.
-- Quarantine and cleanup are separate operations. Provider deletion is also gated by
-- CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED in the Control Worker at execution time.

ALTER TABLE control_tenant_shards ADD COLUMN quarantine_state TEXT NOT NULL DEFAULT 'none'
  CHECK (quarantine_state IN ('none', 'quarantining', 'quarantined'));
ALTER TABLE control_tenant_shards ADD COLUMN quarantine_operation_id TEXT;
ALTER TABLE control_tenant_shards ADD COLUMN quarantine_started_at INTEGER;
ALTER TABLE control_tenant_shards ADD COLUMN quarantined_at INTEGER;

CREATE TABLE IF NOT EXISTS control_shard_quarantine_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  shard_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'draining'
    CHECK (state IN ('draining', 'ready_for_cleanup', 'blocked', 'canceled')),
  deny_registry_generation INTEGER NOT NULL CHECK (deny_registry_generation >= 0),
  snapshot_ttl_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (snapshot_ttl_seconds = 1800),
  drain_not_before INTEGER NOT NULL,
  registry_verified_at INTEGER,
  references_verified_at INTEGER,
  requested_by_id TEXT NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (operation_id, environment_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  CHECK (drain_not_before >= created_at + snapshot_ttl_seconds),
  CHECK ((state = 'ready_for_cleanup' AND registry_verified_at IS NOT NULL
          AND references_verified_at IS NOT NULL AND completed_at IS NOT NULL)
         OR state <> 'ready_for_cleanup')
);

CREATE INDEX IF NOT EXISTS idx_control_shard_quarantine_due
  ON control_shard_quarantine_operations(state, drain_not_before, updated_at);

CREATE TABLE IF NOT EXISTS control_shard_quarantine_tenants (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  minimum_runtime_generation INTEGER NOT NULL CHECK (minimum_runtime_generation >= 1),
  observed_runtime_generation INTEGER CHECK (observed_runtime_generation >= 1),
  observed_quarantine_deny_generation INTEGER
    CHECK (observed_quarantine_deny_generation IS NULL OR observed_quarantine_deny_generation >= 0),
  snapshot_published_at INTEGER,
  snapshot_expires_at INTEGER,
  verified_at INTEGER,
  last_error_code TEXT,
  PRIMARY KEY (operation_id, tenant_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_shard_quarantine_operations(operation_id, environment_id) ON DELETE CASCADE,
  CHECK ((verified_at IS NULL AND observed_runtime_generation IS NULL
          AND snapshot_published_at IS NULL AND snapshot_expires_at IS NULL)
         OR (verified_at IS NOT NULL AND observed_runtime_generation IS NOT NULL
             AND snapshot_published_at IS NOT NULL AND snapshot_expires_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control_shard_cleanup_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  shard_id TEXT NOT NULL UNIQUE,
  quarantine_operation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'approved'
    CHECK (state IN ('approved', 'removing_bindings', 'deleting_database',
                     'verifying_absence', 'succeeded', 'blocked')),
  export_mode TEXT NOT NULL CHECK (export_mode IN ('skipped', 'manual_verified')),
  export_evidence_id TEXT,
  delete_database INTEGER NOT NULL DEFAULT 1 CHECK (delete_database = 1),
  approved_by_id TEXT NOT NULL,
  approval_idempotency_key TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  destructive_gate_observed_at INTEGER,
  provider_database_id TEXT NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (operation_id, environment_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (quarantine_operation_id, environment_id)
    REFERENCES control_shard_quarantine_operations(operation_id, environment_id),
  FOREIGN KEY (shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  CHECK ((export_mode = 'manual_verified' AND export_evidence_id IS NOT NULL)
         OR (export_mode = 'skipped' AND export_evidence_id IS NULL)),
  CHECK ((state = 'succeeded' AND completed_at IS NOT NULL) OR state <> 'succeeded')
);

CREATE INDEX IF NOT EXISTS idx_control_shard_cleanup_due
  ON control_shard_cleanup_operations(state, updated_at);

CREATE TABLE IF NOT EXISTS control_shard_cleanup_bindings (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  provider_database_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'removing', 'removed', 'blocked')),
  expected_source_version_id TEXT,
  previous_deployment_id TEXT,
  patch_result_version_id TEXT,
  patch_result_deployment_id TEXT,
  previous_restore_settings_json TEXT
    CHECK (previous_restore_settings_json IS NULL OR json_valid(previous_restore_settings_json)),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, worker_script_name, binding_ref),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_shard_cleanup_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name),
  CHECK ((state IN ('removing', 'removed')
          AND expected_source_version_id IS NOT NULL
          AND previous_deployment_id IS NOT NULL
          AND previous_restore_settings_json IS NOT NULL)
         OR state IN ('pending', 'blocked')),
  CHECK ((state = 'removed' AND patch_result_version_id IS NOT NULL
          AND patch_result_deployment_id IS NOT NULL AND completed_at IS NOT NULL)
         OR state <> 'removed')
);

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_insert_guard
BEFORE INSERT ON control_shard_quarantine_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_shards shard
    JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
   WHERE shard.shard_id = NEW.shard_id
     AND shard.environment_id = NEW.environment_id
     AND shard.status = 'retired'
     AND shard.quarantine_state = 'none'
     AND capacity.allocation_status IN ('draining', 'blocked')
     AND NOT EXISTS (
       SELECT 1 FROM control_tenant_shard_assignments assignment
        WHERE assignment.shard_id = shard.shard_id
          AND assignment.assignment_state IN ('pending', 'active')
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_tenant_shard_allocations allocation
        WHERE allocation.selected_shard_id = shard.shard_id
          AND allocation.reservation_state IN ('reserved', 'committed')
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_tenant_default_allocations allocation
        WHERE allocation.selected_shard_id = shard.shard_id
          AND allocation.reservation_state IN ('reserved', 'committed')
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_runtime_registry_routes route
        WHERE route.environment_id = shard.environment_id
          AND (
            json_extract(route.route_projection_json, '$.target.shardId') = shard.shard_id OR
            EXISTS (
              SELECT 1 FROM json_each(route.route_projection_json, '$.targets') target
               WHERE json_extract(target.value, '$.shardId') = shard.shard_id
            )
          )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_precondition_failed');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_state_transition
BEFORE UPDATE OF state ON control_shard_quarantine_operations
WHEN OLD.state <> NEW.state AND NOT (
  (OLD.state = 'draining' AND NEW.state IN ('ready_for_cleanup', 'blocked', 'canceled')) OR
  (OLD.state = 'blocked' AND NEW.state = 'draining')
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_ready_evidence_guard
BEFORE UPDATE OF state ON control_shard_quarantine_operations
WHEN NEW.state = 'ready_for_cleanup' AND (
  NEW.drain_not_before > NEW.updated_at OR
  NEW.registry_verified_at IS NULL OR
  NEW.references_verified_at IS NULL OR
  EXISTS (
    SELECT 1 FROM control_shard_quarantine_tenants tenant
     WHERE tenant.operation_id = NEW.operation_id
       AND (
         tenant.verified_at IS NULL OR
         tenant.observed_runtime_generation < tenant.minimum_runtime_generation OR
         tenant.snapshot_expires_at IS NULL OR
         tenant.snapshot_expires_at <= NEW.updated_at
       )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_evidence_incomplete');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_cleanup_insert_guard
BEFORE INSERT ON control_shard_cleanup_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_shard_quarantine_operations quarantine
    JOIN control_tenant_shards shard
      ON shard.shard_id = quarantine.shard_id
     AND shard.environment_id = quarantine.environment_id
   WHERE quarantine.operation_id = NEW.quarantine_operation_id
     AND quarantine.environment_id = NEW.environment_id
     AND quarantine.shard_id = NEW.shard_id
     AND quarantine.state = 'ready_for_cleanup'
     AND shard.status = 'retired'
     AND shard.quarantine_state = 'quarantined'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_cleanup_quarantine_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_cleanup_state_transition
BEFORE UPDATE OF state ON control_shard_cleanup_operations
WHEN OLD.state <> NEW.state AND NOT (
  (OLD.state = 'approved' AND NEW.state IN ('removing_bindings', 'deleting_database', 'blocked')) OR
  (OLD.state = 'removing_bindings' AND NEW.state IN ('deleting_database', 'blocked')) OR
  (OLD.state = 'deleting_database' AND NEW.state IN ('verifying_absence', 'blocked')) OR
  (OLD.state = 'verifying_absence' AND NEW.state IN ('succeeded', 'blocked')) OR
  (OLD.state = 'blocked' AND NEW.state IN ('approved', 'removing_bindings',
                                           'deleting_database', 'verifying_absence'))
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_cleanup_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_assignment_insert
BEFORE INSERT ON control_tenant_shard_assignments
WHEN NEW.assignment_state IN ('pending', 'active') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_assignment_update
BEFORE UPDATE OF shard_id, assignment_state ON control_tenant_shard_assignments
WHEN NEW.assignment_state IN ('pending', 'active') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_account_allocation_insert
BEFORE INSERT ON control_tenant_shard_allocations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_account_allocation_update
BEFORE UPDATE OF selected_shard_id, reservation_state ON control_tenant_shard_allocations
WHEN NEW.reservation_state IN ('reserved', 'committed') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_default_allocation_insert
BEFORE INSERT ON control_tenant_default_allocations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_default_allocation_update
BEFORE UPDATE OF selected_shard_id, reservation_state ON control_tenant_default_allocations
WHEN NEW.reservation_state IN ('reserved', 'committed') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_runtime_route_insert
BEFORE INSERT ON control_runtime_registry_routes
WHEN EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
     AND (
       json_extract(NEW.route_projection_json, '$.target.shardId') = shard.shard_id OR
       EXISTS (
         SELECT 1 FROM json_each(NEW.route_projection_json, '$.targets') target
          WHERE json_extract(target.value, '$.shardId') = shard.shard_id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_runtime_route_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_blocks_runtime_route_update
BEFORE UPDATE OF environment_id, route_projection_json ON control_runtime_registry_routes
WHEN EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
     AND (
       json_extract(NEW.route_projection_json, '$.target.shardId') = shard.shard_id OR
       EXISTS (
         SELECT 1 FROM json_each(NEW.route_projection_json, '$.targets') target
          WHERE json_extract(target.value, '$.shardId') = shard.shard_id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_runtime_route_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_shard_quarantine_identity_guard
BEFORE UPDATE OF quarantine_operation_id, quarantine_started_at ON control_tenant_shards
WHEN OLD.quarantine_operation_id IS NOT NULL AND (
  OLD.quarantine_operation_id IS NOT NEW.quarantine_operation_id OR
  OLD.quarantine_started_at IS NOT NEW.quarantine_started_at
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_identity_immutable');
END;
