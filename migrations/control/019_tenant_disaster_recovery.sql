-- Durable active-tenant disaster-recovery workflow. Cloudflare D1 Time Travel remains a
-- manual operator action; only secret-free evidence and pinned resource identity are stored.

CREATE TABLE IF NOT EXISTS control_tenant_disaster_recovery_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  recovery_state TEXT NOT NULL DEFAULT 'publishing_deny' CHECK (recovery_state IN (
    'publishing_deny',
    'draining',
    'operator_restore_required',
    'verifying_restore',
    'reprojecting_lookup',
    'smoke_verifying',
    'ready_for_reactivation',
    'reactivating',
    'succeeded',
    'blocked',
    'canceled'
  )),
  active_operation_key TEXT CHECK (active_operation_key IS NULL OR active_operation_key = 'active'),
  pinned_route_generation INTEGER NOT NULL CHECK (pinned_route_generation >= 1),
  deny_runtime_generation INTEGER CHECK (deny_runtime_generation IS NULL OR deny_runtime_generation >= 1),
  deny_registry_generation INTEGER CHECK (deny_registry_generation IS NULL OR deny_registry_generation >= 1),
  deny_observed_at INTEGER,
  drain_not_before INTEGER,
  restore_reference_digest TEXT CHECK (
    restore_reference_digest IS NULL OR
    (length(restore_reference_digest) = 64 AND restore_reference_digest NOT GLOB '*[^0-9a-f]*')
  ),
  restored_at INTEGER,
  restore_confirmed_by TEXT,
  migration_verified_at INTEGER,
  lookup_reprojected_at INTEGER,
  lookup_reprojection_registry_digest TEXT CHECK (
    lookup_reprojection_registry_digest IS NULL OR
    (length(lookup_reprojection_registry_digest) = 64 AND
     lookup_reprojection_registry_digest NOT GLOB '*[^0-9a-f]*')
  ),
  lookup_reprojection_shard_count INTEGER CHECK (
    lookup_reprojection_shard_count IS NULL OR lookup_reprojection_shard_count BETWEEN 1 AND 4096
  ),
  lookup_reprojection_stage TEXT NOT NULL DEFAULT 'cleanup' CHECK (
    lookup_reprojection_stage IN (
      'cleanup', 'account_id', 'email_exact', 'external_core', 'external_pii', 'verify'
    )
  ),
  lookup_reprojection_target_index INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_reprojection_target_index >= 0),
  lookup_reprojection_after_created_at INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_reprojection_after_created_at >= 0),
  lookup_reprojection_after_id TEXT NOT NULL DEFAULT '',
  lookup_reprojection_after_row_id INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_reprojection_after_row_id >= 0),
  lookup_reprojection_projected_rows INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_reprojection_projected_rows >= 0),
  lookup_reprojection_verified_rows INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_reprojection_verified_rows >= 0),
  lookup_reprojection_lease_owner TEXT,
  lookup_reprojection_fencing_token INTEGER NOT NULL DEFAULT 0
    CHECK (lookup_reprojection_fencing_token >= 0),
  lookup_reprojection_lease_expires_at INTEGER,
  binding_smoke_verified_at INTEGER,
  reactivation_requested_by TEXT,
  reactivated_runtime_generation INTEGER CHECK (
    reactivated_runtime_generation IS NULL OR reactivated_runtime_generation >= 1
  ),
  reactivated_at INTEGER,
  last_error_code TEXT,
  idempotency_key TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, tenant_id)
    REFERENCES control_tenant_placement_policies(environment_id, tenant_id),
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (operation_id, environment_id),
  UNIQUE (environment_id, tenant_id, active_operation_key),
  CHECK (
    (recovery_state IN ('succeeded', 'canceled') AND active_operation_key IS NULL
      AND completed_at IS NOT NULL) OR
    (recovery_state NOT IN ('succeeded', 'canceled') AND active_operation_key = 'active'
      AND completed_at IS NULL)
  ),
  CHECK (
    (deny_runtime_generation IS NULL AND deny_registry_generation IS NULL
      AND deny_observed_at IS NULL AND drain_not_before IS NULL) OR
    (deny_runtime_generation IS NOT NULL AND deny_registry_generation IS NOT NULL
      AND deny_observed_at IS NOT NULL AND drain_not_before = deny_observed_at + 1800)
  ),
  CHECK (
    (restore_reference_digest IS NULL AND restored_at IS NULL AND restore_confirmed_by IS NULL) OR
    (restore_reference_digest IS NOT NULL AND restored_at IS NOT NULL
      AND restore_confirmed_by IS NOT NULL)
  ),
  CHECK (
    (lookup_reprojection_lease_owner IS NULL AND
     lookup_reprojection_lease_expires_at IS NULL) OR
    (lookup_reprojection_lease_owner IS NOT NULL AND
     lookup_reprojection_lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (lookup_reprojection_registry_digest IS NULL AND lookup_reprojection_shard_count IS NULL) OR
    (lookup_reprojection_registry_digest IS NOT NULL AND lookup_reprojection_shard_count IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_control_tenant_dr_due
  ON control_tenant_disaster_recovery_operations(
    environment_id, recovery_state, drain_not_before, updated_at
  );

-- Lookup topology and key material must remain stable from deny publication through reactivation.
-- The reciprocal INSERT guards close the race between independent Control Worker requests.
CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_topology_guard
BEFORE INSERT ON control_tenant_disaster_recovery_operations
WHEN EXISTS (
  SELECT 1 FROM control_lookup_bucket_migrations migration
   WHERE migration.environment_id = NEW.environment_id
     AND migration.state NOT IN ('complete', 'blocked')
) OR EXISTS (
  SELECT 1 FROM control_hmac_rotation_operations rotation
   WHERE rotation.environment_id = NEW.environment_id
     AND rotation.state NOT IN ('complete', 'blocked')
) OR EXISTS (
  SELECT 1 FROM control_route_projection_migrations migration
   WHERE migration.environment_id = NEW.environment_id
     AND migration.state NOT IN ('complete', 'blocked')
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_lookup_topology_busy');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_blocks_bucket_migration
BEFORE INSERT ON control_lookup_bucket_migrations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_lookup_topology_locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_blocks_hmac_rotation
BEFORE INSERT ON control_hmac_rotation_operations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_lookup_topology_locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_blocks_route_projection_migration
BEFORE INSERT ON control_route_projection_migrations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_lookup_topology_locked');
END;

CREATE TABLE IF NOT EXISTS control_tenant_disaster_recovery_targets (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_partition TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  shard_generation INTEGER NOT NULL CHECK (shard_generation >= 1),
  binding_ref TEXT NOT NULL CHECK (
    length(binding_ref) BETWEEN 1 AND 128 AND binding_ref NOT GLOB '*[^A-Z0-9_]*'
  ),
  provider_database_id TEXT NOT NULL,
  migration_stream_id TEXT NOT NULL CHECK (migration_stream_id IN ('d1-core', 'd1-pii')),
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  restore_confirmed_at INTEGER,
  migration_verified_at INTEGER,
  lookup_reprojected_at INTEGER,
  binding_smoke_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, shard_id),
  UNIQUE (operation_id, data_role, residency_partition, shard_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_tenant_disaster_recovery_operations(operation_id, environment_id)
      ON DELETE CASCADE,
  FOREIGN KEY (shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  CHECK (migration_stream_id = CASE WHEN data_role = 'tenant_pii' THEN 'd1-pii' ELSE 'd1-core' END)
);

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, pinned_route_generation,
                 idempotency_key, requested_by_id, created_at
ON control_tenant_disaster_recovery_operations
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_reprojection_stage_transition
BEFORE UPDATE OF lookup_reprojection_stage ON control_tenant_disaster_recovery_operations
WHEN OLD.lookup_reprojection_stage <> NEW.lookup_reprojection_stage AND NOT (
  (OLD.lookup_reprojection_stage = 'cleanup' AND NEW.lookup_reprojection_stage = 'account_id') OR
  (OLD.lookup_reprojection_stage = 'account_id' AND NEW.lookup_reprojection_stage = 'email_exact') OR
  (OLD.lookup_reprojection_stage = 'email_exact' AND NEW.lookup_reprojection_stage = 'external_core') OR
  (OLD.lookup_reprojection_stage = 'external_core' AND NEW.lookup_reprojection_stage = 'external_pii') OR
  (OLD.lookup_reprojection_stage = 'external_pii' AND NEW.lookup_reprojection_stage = 'verify')
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_reprojection_stage_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_target_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, shard_id, data_role,
                 residency_partition, assignment_generation, shard_generation, binding_ref,
                 provider_database_id, migration_stream_id, release_id, manifest_digest, created_at
ON control_tenant_disaster_recovery_targets
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_target_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_state_transition
BEFORE UPDATE OF recovery_state ON control_tenant_disaster_recovery_operations
WHEN NOT (
  OLD.recovery_state = NEW.recovery_state OR
  (OLD.recovery_state = 'publishing_deny' AND NEW.recovery_state IN ('draining', 'blocked', 'canceled')) OR
  (OLD.recovery_state = 'draining' AND NEW.recovery_state IN ('operator_restore_required', 'blocked')) OR
  (OLD.recovery_state = 'operator_restore_required' AND NEW.recovery_state IN ('verifying_restore', 'blocked')) OR
  (OLD.recovery_state = 'verifying_restore' AND NEW.recovery_state IN ('reprojecting_lookup', 'blocked')) OR
  (OLD.recovery_state = 'reprojecting_lookup' AND NEW.recovery_state IN ('smoke_verifying', 'blocked')) OR
  (OLD.recovery_state = 'smoke_verifying' AND NEW.recovery_state IN ('ready_for_reactivation', 'blocked')) OR
  (OLD.recovery_state = 'ready_for_reactivation' AND NEW.recovery_state IN ('reactivating', 'blocked')) OR
  (OLD.recovery_state = 'reactivating' AND NEW.recovery_state IN ('succeeded', 'blocked')) OR
  (OLD.recovery_state = 'blocked' AND NEW.recovery_state IN (
    'publishing_deny', 'draining', 'operator_restore_required', 'verifying_restore',
    'reprojecting_lookup', 'smoke_verifying', 'ready_for_reactivation', 'reactivating'
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_state_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_cancel_guard
BEFORE UPDATE OF recovery_state ON control_tenant_disaster_recovery_operations
WHEN NEW.recovery_state = 'canceled'
  AND (OLD.recovery_state <> 'publishing_deny' OR OLD.deny_observed_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_cancel_after_deny_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_target_insert_guard
BEFORE INSERT ON control_tenant_disaster_recovery_targets
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_disaster_recovery_operations recovery
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = recovery.environment_id
     AND assignment.tenant_id = recovery.tenant_id
     AND assignment.shard_id = NEW.shard_id
     AND assignment.data_role = NEW.data_role
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.assignment_generation = NEW.assignment_generation
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.environment_id = assignment.environment_id
     AND shard.shard_id = assignment.shard_id
     AND shard.generation = NEW.shard_generation
     AND shard.binding_ref = NEW.binding_ref
     AND shard.status IN ('ready', 'active', 'degraded')
    JOIN control_observed_resources observed
      ON observed.environment_id = shard.environment_id
     AND observed.desired_resource_id = shard.d1_desired_resource_id
     AND observed.resource_kind = 'd1'
     AND observed.provider_resource_id = NEW.provider_database_id
     AND observed.observed_state = 'present'
   WHERE recovery.operation_id = NEW.operation_id
     AND recovery.environment_id = NEW.environment_id
     AND recovery.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_target_identity_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_allocation_guard
BEFORE INSERT ON control_tenant_shard_allocations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.tenant_id = NEW.tenant_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_allocation_blocked');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_default_allocation_guard
BEFORE INSERT ON control_tenant_default_allocations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.tenant_id = NEW.tenant_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_allocation_blocked');
END;
