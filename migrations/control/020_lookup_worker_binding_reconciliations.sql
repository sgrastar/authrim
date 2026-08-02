CREATE TABLE control_worker_binding_reconciliations_v2 (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup')),
  residency_partition TEXT NOT NULL,
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  provider_database_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'settings_patched', 'smoke_verifying', 'stabilizing',
      'succeeded', 'rollback_required', 'rolled_back', 'blocked')),
  expected_source_version_id TEXT,
  previous_deployment_id TEXT,
  patch_result_version_id TEXT,
  patch_result_deployment_id TEXT,
  previous_restore_settings_json TEXT
    CHECK (previous_restore_settings_json IS NULL OR json_valid(previous_restore_settings_json)),
  smoke_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (smoke_attempt_count >= 0),
  consecutive_smoke_successes INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_smoke_successes BETWEEN 0 AND 3),
  stabilization_not_before INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (operation_id, worker_script_name, binding_ref),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name) ON DELETE CASCADE,
  CHECK ((state = 'succeeded' AND completed_at IS NOT NULL) OR state <> 'succeeded'),
  CHECK ((state IN ('settings_patched', 'smoke_verifying', 'stabilizing', 'succeeded',
                    'rollback_required', 'rolled_back', 'blocked')
          AND expected_source_version_id IS NOT NULL
          AND previous_restore_settings_json IS NOT NULL)
         OR state = 'pending')
);

INSERT INTO control_worker_binding_reconciliations_v2
SELECT * FROM control_worker_binding_reconciliations;

DROP TABLE control_worker_binding_reconciliations;
ALTER TABLE control_worker_binding_reconciliations_v2
  RENAME TO control_worker_binding_reconciliations;

CREATE INDEX idx_control_worker_binding_reconciliation_due
  ON control_worker_binding_reconciliations(state, stabilization_not_before, updated_at);

CREATE TRIGGER trg_control_worker_binding_inventory_insert
BEFORE INSERT ON control_worker_binding_reconciliations
WHEN NOT (
  (NEW.data_role = 'lookup' AND EXISTS (
    SELECT 1 FROM control_lookup_physical_shards lookup
     WHERE lookup.lookup_shard_id = NEW.shard_id
       AND lookup.environment_id = NEW.environment_id
       AND lookup.binding_ref = NEW.binding_ref
  )) OR
  (NEW.data_role <> 'lookup' AND EXISTS (
    SELECT 1 FROM control_tenant_shards shard
     WHERE shard.shard_id = NEW.shard_id
       AND shard.environment_id = NEW.environment_id
       AND shard.data_role = NEW.data_role
       AND shard.binding_ref = NEW.binding_ref
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_worker_binding_inventory_mismatch');
END;

CREATE TRIGGER trg_control_worker_binding_inventory_update
BEFORE UPDATE OF environment_id, shard_id, binding_ref, data_role
ON control_worker_binding_reconciliations
WHEN NOT (
  (NEW.data_role = 'lookup' AND EXISTS (
    SELECT 1 FROM control_lookup_physical_shards lookup
     WHERE lookup.lookup_shard_id = NEW.shard_id
       AND lookup.environment_id = NEW.environment_id
       AND lookup.binding_ref = NEW.binding_ref
  )) OR
  (NEW.data_role <> 'lookup' AND EXISTS (
    SELECT 1 FROM control_tenant_shards shard
     WHERE shard.shard_id = NEW.shard_id
       AND shard.environment_id = NEW.environment_id
       AND shard.data_role = NEW.data_role
       AND shard.binding_ref = NEW.binding_ref
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_worker_binding_inventory_mismatch');
END;
