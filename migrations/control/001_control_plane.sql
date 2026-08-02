-- Authrim tenant D1 control-plane schema.
-- This database stores desired state and provider metadata only. It must never store
-- Cloudflare API tokens, blind-index key bodies, raw email addresses, or private JWKs.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS control_environments (
  environment_id TEXT PRIMARY KEY,
  environment_name TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL UNIQUE,
  lifecycle_state TEXT NOT NULL DEFAULT 'creating'
    CHECK (lifecycle_state IN ('creating', 'active', 'quarantining', 'quarantined', 'disabled')),
  lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation >= 1),
  quarantine_deny_generation INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_deny_generation >= 0),
  runtime_registry_generation INTEGER NOT NULL DEFAULT 0 CHECK (runtime_registry_generation >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (issuer = 'urn:authrim:control:' || environment_id)
);

CREATE TABLE IF NOT EXISTS control_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled')),
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('setup', 'admin', 'scheduler', 'reconciler')),
  requested_by_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error_code TEXT,
  last_error_redacted TEXT,
  lock_owner TEXT,
  lock_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  release_id TEXT,
  release_stream_id TEXT,
  release_manifest_digest TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (operation_id, environment_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK ((status IN ('succeeded', 'canceled') AND completed_at IS NOT NULL) OR status NOT IN ('succeeded', 'canceled')),
  CHECK ((release_id IS NULL AND release_stream_id IS NULL AND release_manifest_digest IS NULL) OR
         (release_id IS NOT NULL AND release_stream_id IS NOT NULL AND release_manifest_digest IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_control_operations_runnable
  ON control_operations(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_control_operations_environment
  ON control_operations(environment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS control_operation_steps (
  operation_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  parent_step_key TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled', 'skipped', 'rolled_back')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error_code TEXT,
  last_error_redacted TEXT,
  observed_resource_id TEXT,
  progress_current INTEGER,
  progress_total INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, step_key),
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, parent_step_key)
    REFERENCES control_operation_steps(operation_id, step_key) DEFERRABLE INITIALLY DEFERRED,
  CHECK (progress_current IS NULL OR progress_current >= 0),
  CHECK (progress_total IS NULL OR progress_total >= 0),
  CHECK (progress_current IS NULL OR progress_total IS NULL OR progress_current <= progress_total)
);

CREATE INDEX IF NOT EXISTS idx_control_operation_steps_status
  ON control_operation_steps(status, next_attempt_at, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_control_operation_status_transition
BEFORE UPDATE OF status ON control_operations
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('running', 'blocked', 'canceled')) OR
  (OLD.status = 'running' AND NEW.status IN ('waiting_retry', 'succeeded', 'blocked')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('running', 'blocked', 'succeeded', 'canceled')) OR
  (OLD.status = 'blocked' AND NEW.status IN ('running', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_control_operation_status_transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_operation_step_status_transition
BEFORE UPDATE OF status ON control_operation_steps
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('running', 'blocked', 'canceled', 'skipped')) OR
  (OLD.status = 'running' AND NEW.status IN ('waiting_retry', 'succeeded', 'blocked', 'rolled_back')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('running', 'blocked', 'canceled')) OR
  (OLD.status = 'blocked' AND NEW.status IN ('running', 'canceled', 'rolled_back')) OR
  (OLD.status = 'succeeded' AND NEW.status = 'rolled_back')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_control_operation_step_status_transition');
END;

CREATE TABLE IF NOT EXISTS control_desired_resources (
  desired_resource_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL
    CHECK (resource_kind IN ('d1', 'worker_script', 'kv_namespace', 'r2_bucket', 'dispatch_namespace', 'worker_binding')),
  logical_shard_id TEXT NOT NULL,
  resource_scope TEXT NOT NULL DEFAULT 'platform'
    CHECK (resource_scope IN ('platform', 'tenant', 'plugin_install_instance')),
  tenant_id TEXT,
  plugin_installation_id TEXT,
  deterministic_name TEXT NOT NULL,
  ownership_fingerprint TEXT NOT NULL,
  desired_state TEXT NOT NULL DEFAULT 'present' CHECK (desired_state IN ('present', 'absent')),
  provisioning_state TEXT NOT NULL DEFAULT 'requested'
    CHECK (provisioning_state IN ('requested', 'creating', 'ready', 'active', 'degraded', 'failed', 'deleting', 'deleted')),
  origin_operation_id TEXT NOT NULL,
  create_started_at INTEGER,
  observed_resource_id TEXT,
  desired_spec_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, resource_kind, logical_shard_id),
  UNIQUE (environment_id, deterministic_name),
  UNIQUE (desired_resource_id, environment_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (origin_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK ((resource_scope = 'tenant' AND tenant_id IS NOT NULL) OR resource_scope <> 'tenant'),
  CHECK ((resource_scope = 'plugin_install_instance' AND plugin_installation_id IS NOT NULL) OR resource_scope <> 'plugin_install_instance'),
  CHECK (resource_scope = 'tenant' OR tenant_id IS NULL),
  CHECK (resource_scope = 'plugin_install_instance' OR plugin_installation_id IS NULL)
);

CREATE TABLE IF NOT EXISTS control_observed_resources (
  observed_resource_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  desired_resource_id TEXT,
  provider_resource_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  ownership_fingerprint TEXT,
  observed_state TEXT NOT NULL CHECK (observed_state IN ('present', 'missing', 'drifted', 'unknown')),
  observed_spec_json TEXT NOT NULL DEFAULT '{}',
  observed_at INTEGER NOT NULL,
  UNIQUE (environment_id, resource_kind, provider_resource_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id)
);

CREATE TABLE IF NOT EXISTS control_migration_release_catalog (
  environment_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  manifest_r2_object_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'registered' CHECK (state IN ('registered', 'active', 'retired', 'blocked')),
  active_stream_key TEXT NOT NULL,
  registered_by_operation_id TEXT NOT NULL,
  registered_by_actor_id TEXT,
  registered_at INTEGER NOT NULL,
  activated_at INTEGER,
  PRIMARY KEY (environment_id, stream_id, release_id),
  UNIQUE (environment_id, stream_id, release_id, manifest_digest),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (registered_by_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (
    manifest_r2_object_key =
      'releases/' || release_id || '/' || manifest_digest || '/manifest.json'
  ),
  CHECK ((state = 'active' AND active_stream_key = 'active') OR
         (state <> 'active' AND active_stream_key = 'release:' || release_id))
);

CREATE TRIGGER IF NOT EXISTS trg_control_release_catalog_immutable
BEFORE UPDATE OF environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key
ON control_migration_release_catalog
BEGIN
  SELECT RAISE(ABORT, 'control_release_catalog_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_release_catalog_conflicting_insert
BEFORE INSERT ON control_migration_release_catalog
WHEN EXISTS (
  SELECT 1
  FROM control_migration_release_catalog existing
  WHERE existing.environment_id = NEW.environment_id
    AND existing.stream_id = NEW.stream_id
    AND existing.release_id = NEW.release_id
    AND (
      existing.manifest_digest <> NEW.manifest_digest OR
      existing.manifest_r2_object_key <> NEW.manifest_r2_object_key
    )
)
BEGIN
  SELECT RAISE(ABORT, 'control_release_catalog_immutable');
END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_release_one_active_stream
  ON control_migration_release_catalog(environment_id, stream_id, active_stream_key);

CREATE TABLE IF NOT EXISTS control_operation_release_pins (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, stream_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, stream_id, release_id, manifest_digest)
    REFERENCES control_migration_release_catalog(environment_id, stream_id, release_id, manifest_digest)
);

CREATE TRIGGER IF NOT EXISTS trg_control_operation_release_pin_immutable
BEFORE UPDATE ON control_operation_release_pins
BEGIN
  SELECT RAISE(ABORT, 'control_operation_release_pin_immutable');
END;

CREATE TABLE IF NOT EXISTS control_tenant_database_migration_state (
  desired_resource_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  provider_database_id TEXT,
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'applying', 'waiting_retry', 'ready', 'blocked')),
  expected_file_count INTEGER CHECK (expected_file_count IS NULL OR expected_file_count >= 0),
  applied_file_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_file_count >= 0),
  last_filename TEXT,
  observed_sentinel_json TEXT CHECK (
    observed_sentinel_json IS NULL OR json_valid(observed_sentinel_json)
  ),
  last_error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (desired_resource_id, environment_id),
  FOREIGN KEY (desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, stream_id)
    REFERENCES control_operation_release_pins(operation_id, stream_id),
  CHECK (applied_file_count <= COALESCE(expected_file_count, applied_file_count)),
  CHECK ((state = 'ready' AND provider_database_id IS NOT NULL AND completed_at IS NOT NULL AND
          expected_file_count IS NOT NULL AND applied_file_count = expected_file_count AND
          observed_sentinel_json IS NOT NULL) OR state <> 'ready')
);

CREATE INDEX IF NOT EXISTS idx_control_tenant_database_migration_runnable
  ON control_tenant_database_migration_state(state, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_database_migration_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, stream_id, release_id, manifest_digest
ON control_tenant_database_migration_state
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_database_migration_pin_immutable');
END;

CREATE TABLE IF NOT EXISTS control_worker_deployment_leases (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  owner_operation_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  lease_expires_at INTEGER NOT NULL,
  expected_source_version_id TEXT NOT NULL,
  patch_result_version_id TEXT,
  previous_deployment_id TEXT,
  patch_result_deployment_id TEXT,
  mutation_started INTEGER NOT NULL DEFAULT 0 CHECK (mutation_started IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id)
);

CREATE TABLE IF NOT EXISTS control_worker_binding_reconciliations (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
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
  FOREIGN KEY (shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id) ON DELETE CASCADE,
  CHECK ((state = 'succeeded' AND completed_at IS NOT NULL) OR state <> 'succeeded'),
  CHECK ((state IN ('settings_patched', 'smoke_verifying', 'stabilizing', 'succeeded',
                    'rollback_required', 'rolled_back', 'blocked')
          AND expected_source_version_id IS NOT NULL
          AND previous_restore_settings_json IS NOT NULL)
         OR state = 'pending')
);

CREATE INDEX IF NOT EXISTS idx_control_worker_binding_reconciliation_due
  ON control_worker_binding_reconciliations(state, stabilization_not_before, updated_at);

CREATE TABLE IF NOT EXISTS control_bootstrap_handoffs (
  environment_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'creating'
    CHECK (state IN ('creating', 'pending_verification', 'accepted', 'blocked')),
  ownership_fingerprint TEXT NOT NULL,
  release_manifest_digest TEXT NOT NULL CHECK (length(release_manifest_digest) = 64),
  observed_deployment_id TEXT,
  observed_version_id TEXT,
  verification_error_code TEXT,
  verified_at INTEGER,
  accepted_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK ((state = 'accepted' AND verified_at IS NOT NULL AND accepted_at IS NOT NULL) OR state <> 'accepted')
);

CREATE TABLE IF NOT EXISTS control_directory_rewrite_leases (
  environment_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL
    CHECK (operation_kind IN (
      'hmac_reindex', 'route_schema_reprojection', 'lookup_bucket_migration',
      'tenant_placement_migration'
    )),
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  lease_expires_at INTEGER NOT NULL,
  mutation_started INTEGER NOT NULL DEFAULT 0 CHECK (mutation_started IN (0, 1)),
  rollback_verified_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (rollback_verified_at IS NULL OR mutation_started = 0)
);

CREATE TRIGGER IF NOT EXISTS trg_control_directory_rewrite_cross_operation_takeover
BEFORE UPDATE OF operation_id ON control_directory_rewrite_leases
WHEN OLD.operation_id <> NEW.operation_id AND
     (OLD.mutation_started = 1 OR OLD.lease_expires_at > unixepoch())
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_takeover_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_directory_rewrite_fencing
BEFORE UPDATE OF operation_id, owner_id, fencing_token ON control_directory_rewrite_leases
WHEN (OLD.operation_id <> NEW.operation_id OR OLD.owner_id <> NEW.owner_id) AND
     NEW.fencing_token <= OLD.fencing_token
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_stale_fencing_token');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_directory_rewrite_mutation_reset
BEFORE UPDATE OF mutation_started ON control_directory_rewrite_leases
WHEN OLD.mutation_started = 1 AND NEW.mutation_started = 0 AND NEW.rollback_verified_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_rollback_verification_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_directory_rewrite_delete
BEFORE DELETE ON control_directory_rewrite_leases
WHEN OLD.mutation_started = 1 AND NOT EXISTS (
  SELECT 1 FROM control_operations o
   WHERE o.operation_id = OLD.operation_id AND o.status = 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_delete_forbidden_after_mutation');
END;

CREATE TABLE IF NOT EXISTS control_environment_resource_policies (
  environment_id TEXT PRIMARY KEY,
  max_concurrent_provisioning INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent_provisioning BETWEEN 1 AND 32),
  max_ready_spares INTEGER NOT NULL DEFAULT 2 CHECK (max_ready_spares BETWEEN 0 AND 32),
  max_d1_resources INTEGER NOT NULL DEFAULT 1000 CHECK (max_d1_resources >= 1),
  daily_d1_create_budget INTEGER NOT NULL DEFAULT 20 CHECK (daily_d1_create_budget >= 0),
  target_account_count INTEGER NOT NULL DEFAULT 100000 CHECK (target_account_count >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_d1_create_budget_reservations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  budget_day INTEGER NOT NULL CHECK (budget_day >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (environment_id, operation_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_control_d1_create_budget_day
  ON control_d1_create_budget_reservations(environment_id, budget_day);

CREATE TRIGGER IF NOT EXISTS trg_control_d1_resource_limit
BEFORE INSERT ON control_desired_resources
WHEN NEW.resource_kind = 'd1' AND (
  NOT EXISTS (
    SELECT 1 FROM control_environment_resource_policies p
     WHERE p.environment_id = NEW.environment_id
  ) OR (
    SELECT COUNT(*) FROM control_desired_resources d
     WHERE d.environment_id = NEW.environment_id
       AND d.resource_kind = 'd1'
       AND d.desired_state = 'present'
  ) >= (
    SELECT p.max_d1_resources FROM control_environment_resource_policies p
     WHERE p.environment_id = NEW.environment_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_d1_resource_limit');
END;

CREATE TABLE IF NOT EXISTS control_residency_partitions (
  environment_id TEXT NOT NULL,
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  jurisdiction TEXT CHECK (jurisdiction IN ('eu', 'fedramp')),
  location_hint TEXT CHECK (location_hint IN ('wnam', 'enam', 'weur', 'eeur', 'apac', 'oc')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, residency_policy_id, residency_partition),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK (jurisdiction IS NULL OR location_hint IS NULL)
);

CREATE TABLE IF NOT EXISTS control_tenant_shards (
  shard_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  logical_shard_id TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  d1_desired_resource_id TEXT NOT NULL,
  jurisdiction TEXT CHECK (jurisdiction IN ('eu', 'fedramp')),
  location_hint TEXT CHECK (location_hint IN ('wnam', 'enam', 'weur', 'eeur', 'apac', 'oc')),
  read_replication_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (read_replication_mode IN ('disabled', 'enabled')),
  consistency_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (consistency_policy_version >= 1),
  observed_replication_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (observed_replication_state IN ('unknown', 'disabled', 'enabling', 'enabled', 'failed')),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'provisioning', 'ready', 'active', 'degraded', 'failed', 'retired', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, data_role, residency_partition, generation, logical_shard_id),
  UNIQUE (environment_id, binding_ref),
  UNIQUE (shard_id, environment_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, residency_policy_id, residency_partition)
    REFERENCES control_residency_partitions(environment_id, residency_policy_id, residency_partition),
  FOREIGN KEY (d1_desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id),
  CHECK (jurisdiction IS NULL OR location_hint IS NULL)
);

CREATE TABLE IF NOT EXISTS control_shard_capacity (
  shard_id TEXT PRIMARY KEY,
  target_account_count INTEGER NOT NULL CHECK (target_account_count >= 1),
  allocated_account_count INTEGER NOT NULL DEFAULT 0 CHECK (allocated_account_count >= 0),
  observed_account_count INTEGER CHECK (observed_account_count IS NULL OR observed_account_count >= 0),
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'warning', 'degraded', 'unavailable')),
  allocation_status TEXT NOT NULL DEFAULT 'eligible'
    CHECK (allocation_status IN ('eligible', 'draining', 'full', 'blocked')),
  storage_bytes INTEGER CHECK (storage_bytes IS NULL OR storage_bytes >= 0),
  write_error_rate REAL CHECK (write_error_rate IS NULL OR write_error_rate >= 0),
  write_p95_ms REAL CHECK (write_p95_ms IS NULL OR write_p95_ms >= 0),
  read_p95_ms REAL CHECK (read_p95_ms IS NULL OR read_p95_ms >= 0),
  checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (shard_id) REFERENCES control_tenant_shards(shard_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_tenant_shard_allocations (
  allocation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id_blind_digest TEXT NOT NULL,
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_partition TEXT NOT NULL,
  selected_shard_id TEXT NOT NULL,
  reservation_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (reservation_state IN ('reserved', 'committed', 'released', 'failed')),
  idempotency_key TEXT NOT NULL,
  route_generation INTEGER NOT NULL DEFAULT 1 CHECK (route_generation >= 1),
  capacity_counted_at INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, tenant_id, data_role, residency_partition, idempotency_key),
  UNIQUE (environment_id, tenant_id, data_role, residency_partition, account_id_blind_digest),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (selected_shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id)
);

CREATE TABLE IF NOT EXISTS control_read_replication_policies (
  environment_id TEXT NOT NULL,
  data_role TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  desired_mode TEXT NOT NULL CHECK (desired_mode IN ('disabled', 'enabled')),
  consistency_policy_version INTEGER NOT NULL CHECK (consistency_policy_version >= 1),
  operation_id TEXT,
  operation_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (operation_status IN ('idle', 'pending', 'applying', 'verifying', 'succeeded', 'failed', 'blocked')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, data_role, residency_partition),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id)
);

CREATE TABLE IF NOT EXISTS control_read_replication_rollouts (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  desired_mode TEXT NOT NULL CHECK (desired_mode IN ('disabled', 'enabled')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'applying', 'verifying', 'attention_required', 'succeeded', 'blocked')),
  eligible_policy_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_policy_count >= 0),
  applied_policy_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_policy_count >= 0),
  failed_policy_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_policy_count >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  CHECK (applied_policy_count + failed_policy_count <= eligible_policy_count),
  CHECK ((status = 'succeeded' AND failed_policy_count = 0 AND completed_at IS NOT NULL) OR
         status <> 'succeeded'),
  CHECK ((status = 'attention_required' AND failed_policy_count > 0) OR
         status <> 'attention_required')
);

CREATE TABLE IF NOT EXISTS control_lookup_physical_shards (
  lookup_shard_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  d1_desired_resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'provisioning', 'ready', 'active', 'draining', 'retired', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, residency_partition, binding_ref),
  UNIQUE (lookup_shard_id, environment_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (d1_desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id)
);

CREATE TABLE IF NOT EXISTS control_lookup_bucket_assignments (
  environment_id TEXT NOT NULL,
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  lookup_shard_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'copying', 'verifying', 'cutover_pending', 'blocked')),
  target_lookup_shard_id TEXT,
  backfill_cursor TEXT,
  source_row_count INTEGER CHECK (source_row_count IS NULL OR source_row_count >= 0),
  target_row_count INTEGER CHECK (target_row_count IS NULL OR target_row_count >= 0),
  verification_result_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, virtual_bucket),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (lookup_shard_id, environment_id)
    REFERENCES control_lookup_physical_shards(lookup_shard_id, environment_id),
  FOREIGN KEY (target_lookup_shard_id, environment_id)
    REFERENCES control_lookup_physical_shards(lookup_shard_id, environment_id),
  CHECK ((state = 'active' AND target_lookup_shard_id IS NULL) OR state <> 'active')
);

CREATE TABLE IF NOT EXISTS control_lookup_registry_publications (
  environment_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  mapping_digest TEXT NOT NULL CHECK (mapping_digest NOT GLOB '*[^0-9a-f]*' AND length(mapping_digest) = 64),
  snapshot_jws TEXT NOT NULL CHECK (length(snapshot_jws) BETWEEN 64 AND 524288),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  status TEXT NOT NULL CHECK (status IN ('publishing', 'active')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_hmac_rotation_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  source_key_generation INTEGER NOT NULL CHECK (source_key_generation >= 1),
  source_key_id TEXT NOT NULL,
  source_key_slot TEXT NOT NULL CHECK (source_key_slot IN ('A', 'B')),
  source_key_fingerprint TEXT NOT NULL
    CHECK (length(source_key_fingerprint) = 64 AND
           source_key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  candidate_key_generation INTEGER NOT NULL CHECK (candidate_key_generation >= 1),
  candidate_key_id TEXT NOT NULL,
  candidate_key_slot TEXT NOT NULL CHECK (candidate_key_slot IN ('A', 'B')),
  candidate_key_fingerprint TEXT NOT NULL
    CHECK (length(candidate_key_fingerprint) = 64 AND
           candidate_key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL
    CHECK (state IN ('planned', 'distributing', 'activation_dual_write', 'dual_read', 'reindexing', 'verifying', 'grace', 'complete', 'blocked')),
  active_operation_key TEXT NOT NULL,
  authoritative_checkpoint_json TEXT NOT NULL DEFAULT '{}',
  source_row_count INTEGER CHECK (source_row_count IS NULL OR source_row_count >= 0),
  current_row_count INTEGER CHECK (current_row_count IS NULL OR current_row_count >= 0),
  verification_result_json TEXT,
  verification_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempt_count BETWEEN 0 AND 3),
  grace_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (operation_id, environment_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK (source_key_generation <> candidate_key_generation),
  CHECK (source_key_id <> candidate_key_id),
  CHECK (source_key_slot <> candidate_key_slot),
  CHECK (source_key_fingerprint <> candidate_key_fingerprint),
  CHECK ((state NOT IN ('complete', 'blocked') AND active_operation_key = 'active') OR
         (state IN ('complete', 'blocked') AND active_operation_key = 'operation:' || operation_id))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_hmac_rotation_active
  ON control_hmac_rotation_operations(environment_id, active_operation_key);

CREATE TABLE IF NOT EXISTS control_route_projection_migrations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  current_schema_version INTEGER NOT NULL CHECK (current_schema_version >= 1),
  previous_schema_version INTEGER CHECK (previous_schema_version IS NULL OR previous_schema_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('planned', 'backfilling', 'verifying', 'grace', 'complete', 'blocked')),
  active_operation_key TEXT NOT NULL,
  physical_shard_checkpoint_json TEXT NOT NULL DEFAULT '{}',
  version_row_counts_json TEXT NOT NULL DEFAULT '{}',
  route_equivalence_result_json TEXT,
  grace_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK ((state NOT IN ('complete', 'blocked') AND active_operation_key = 'active') OR
         (state IN ('complete', 'blocked') AND active_operation_key = 'operation:' || operation_id))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_route_projection_active
  ON control_route_projection_migrations(environment_id, active_operation_key);

CREATE TABLE IF NOT EXISTS control_signing_key_metadata (
  environment_id TEXT NOT NULL,
  key_purpose TEXT NOT NULL CHECK (key_purpose IN ('runtime_registry', 'smoke_rpc')),
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  key_id TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL
    CHECK (
      json_valid(public_jwk_json) AND
      json_extract(public_jwk_json, '$.kty') = 'OKP' AND
      json_extract(public_jwk_json, '$.crv') = 'Ed25519' AND
      json_type(public_jwk_json, '$.x') = 'text' AND
      length(json_extract(public_jwk_json, '$.x')) = 43 AND
      json_extract(public_jwk_json, '$.x') NOT GLOB '*[^A-Za-z0-9_-]*' AND
      json_extract(public_jwk_json, '$.d') IS NULL AND
      json_extract(public_jwk_json, '$.k') IS NULL AND
      (json_extract(public_jwk_json, '$.alg') IS NULL OR
       json_extract(public_jwk_json, '$.alg') = 'EdDSA')
    ),
  public_key_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'previous', 'retired', 'blocked')),
  active_key_guard TEXT NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, key_purpose, slot),
  UNIQUE (environment_id, key_purpose, key_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK ((state = 'active' AND active_key_guard = 'active') OR
         (state <> 'active' AND active_key_guard = 'slot:' || slot))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_signing_key_one_active
  ON control_signing_key_metadata(environment_id, key_purpose, active_key_guard);

CREATE TABLE IF NOT EXISTS control_runtime_registry_publications (
  environment_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  previous_generation INTEGER CHECK (previous_generation IS NULL OR previous_generation >= 1),
  active_slot TEXT NOT NULL CHECK (active_slot IN ('a', 'b')),
  active_key_id TEXT NOT NULL,
  previous_key_id TEXT,
  snapshot_digest TEXT CHECK (
    snapshot_digest IS NULL OR
    (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*')
  ),
  kv_object_key TEXT NOT NULL,
  snapshot_ttl_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (snapshot_ttl_seconds = 1800),
  signature_typ TEXT NOT NULL DEFAULT 'authrim-runtime-registry+jws'
    CHECK (signature_typ = 'authrim-runtime-registry+jws'),
  signature_algorithm TEXT NOT NULL DEFAULT 'EdDSA' CHECK (signature_algorithm = 'EdDSA'),
  publication_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (publication_state IN ('pending', 'publishing', 'active', 'failed', 'blocked')),
  operation_id TEXT,
  published_at INTEGER,
  observed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (previous_generation IS NULL OR previous_generation < generation),
  CHECK (publication_state <> 'active' OR
         (snapshot_digest IS NOT NULL AND published_at IS NOT NULL AND observed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control_runtime_registry_routes (
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  tenant_lifecycle_generation INTEGER NOT NULL CHECK (tenant_lifecycle_generation >= 1),
  quarantine_deny_generation INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_deny_generation >= 0),
  registry_publication_generation INTEGER NOT NULL CHECK (registry_publication_generation >= 1),
  tenant_lifecycle_state TEXT NOT NULL
    CHECK (tenant_lifecycle_state IN ('creating', 'active', 'quarantining', 'quarantined', 'disabled')),
  route_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (route_status IN ('pending', 'active', 'quarantining', 'disabled')),
  residency_policy_id TEXT NOT NULL,
  route_projection_json TEXT NOT NULL CHECK (json_valid(route_projection_json)),
  source_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, tenant_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (source_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (route_status <> 'active' OR tenant_lifecycle_state = 'active'),
  CHECK (route_status <> 'quarantining' OR tenant_lifecycle_state IN ('quarantining', 'quarantined'))
);

CREATE INDEX IF NOT EXISTS idx_control_runtime_registry_routes_publication
  ON control_runtime_registry_routes(environment_id, registry_publication_generation, route_status);

CREATE TABLE IF NOT EXISTS control_desired_worker_inventory (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  deployment_target TEXT NOT NULL,
  capability_manifest_digest TEXT NOT NULL,
  source_manifest_path TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  generated_artifact_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('core_manifest', 'extension_manifest', 'plugin_manifest')),
  source_reference TEXT NOT NULL,
  registration_mode TEXT NOT NULL DEFAULT 'auto' CHECK (registration_mode = 'auto'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  review_state TEXT NOT NULL DEFAULT 'auto_registered'
    CHECK (review_state IN ('auto_registered', 'reviewed', 'flagged', 'rejected')),
  registered_by_operation_id TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_note TEXT,
  PRIMARY KEY (environment_id, worker_script_name),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (registered_by_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id)
);

CREATE TABLE IF NOT EXISTS control_worker_inventory_change_events (
  event_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  previous_manifest_hash TEXT,
  next_manifest_hash TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'auto_registered'
    CHECK (review_state IN ('auto_registered', 'reviewed', 'flagged', 'rejected')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id)
);

CREATE TRIGGER IF NOT EXISTS trg_control_desired_worker_inventory_source_ownership
BEFORE UPDATE OF source_kind, package_name ON control_desired_worker_inventory
WHEN OLD.source_kind <> NEW.source_kind OR OLD.package_name <> NEW.package_name
BEGIN
  SELECT RAISE(ABORT, 'control_worker_inventory_source_ownership_immutable');
END;

CREATE TABLE IF NOT EXISTS control_worker_required_data_roles (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup', 'control', 'plugin_runner')),
  source_manifest_hash TEXT NOT NULL
    CHECK (length(source_manifest_hash) = 64 AND source_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name, data_role),
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_worker_desired_bindings (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  binding_kind TEXT NOT NULL
    CHECK (binding_kind IN ('d1', 'kv_namespace', 'r2_bucket', 'service', 'dispatch_namespace',
      'durable_object_namespace', 'queue', 'send_email', 'hyperdrive', 'version_metadata', 'secret', 'binding',
      'plugin_interface')),
  data_role TEXT,
  logical_resource_id TEXT,
  secret_capability TEXT,
  plugin_dynamic_capability TEXT,
  desired_spec_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(desired_spec_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name, binding_name),
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name) ON DELETE CASCADE,
  CHECK (data_role IS NULL OR data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup', 'control', 'plugin_runner')),
  CHECK ((binding_kind = 'secret' AND secret_capability IS NOT NULL
    AND data_role IS NULL AND logical_resource_id IS NULL) OR
    (binding_kind <> 'secret' AND secret_capability IS NULL))
);

CREATE TABLE IF NOT EXISTS control_worker_observed_bindings (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  binding_kind TEXT NOT NULL,
  provider_resource_id TEXT,
  observed_spec_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(observed_spec_json)),
  observed_version_id TEXT NOT NULL,
  observed_deployment_id TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name, binding_name),
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_worker_inventory_drift_findings (
  finding_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  finding_kind TEXT NOT NULL CHECK (finding_kind IN ('actual_only', 'desired_missing', 'binding_mismatch', 'settings_mismatch')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  redacted_details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(redacted_details_json)),
  review_state TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (review_state IN ('unreviewed', 'reviewed', 'dismissed', 'resolved')),
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  resolved_at INTEGER,
  notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending', 'acknowledged', 'resolved')),
  notified_at INTEGER,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  UNIQUE (environment_id, worker_script_name, finding_kind),
  CHECK (last_observed_at >= first_observed_at),
  CHECK ((review_state = 'resolved' AND resolved_at IS NOT NULL AND notification_state = 'resolved') OR
         (review_state <> 'resolved' AND resolved_at IS NULL AND notification_state <> 'resolved')),
  CHECK (notified_at IS NULL OR notified_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS idx_control_worker_inventory_drift_notification
  ON control_worker_inventory_drift_findings(environment_id, notification_state, severity, last_observed_at);

CREATE TABLE IF NOT EXISTS control_external_capability_sources (
  environment_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('extension_manifest', 'plugin_manifest')),
  source_id TEXT NOT NULL,
  source_manifest_path TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL
    CHECK (length(source_manifest_hash) = 64 AND source_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  capability_manifest_digest TEXT NOT NULL
    CHECK (length(capability_manifest_digest) = 64 AND capability_manifest_digest NOT GLOB '*[^0-9a-f]*'),
  aggregate_json TEXT NOT NULL CHECK (json_valid(aggregate_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  review_state TEXT NOT NULL DEFAULT 'auto_registered'
    CHECK (review_state IN ('auto_registered', 'approved', 'flagged', 'rejected')),
  registered_by_operation_id TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_note TEXT,
  PRIMARY KEY (environment_id, source_kind, source_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (registered_by_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK ((review_state = 'auto_registered' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
         (review_state <> 'auto_registered' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control_external_capability_bindings (
  environment_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  worker_reference TEXT NOT NULL,
  worker_script_name TEXT,
  binding_name TEXT NOT NULL,
  binding_kind TEXT NOT NULL
    CHECK (binding_kind IN ('binding', 'service', 'secret', 'plugin_interface')),
  capability TEXT NOT NULL,
  capability_scope TEXT NOT NULL CHECK (capability_scope IN ('platform', 'tenant')),
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, source_kind, source_id, worker_reference, binding_name),
  FOREIGN KEY (environment_id, source_kind, source_id)
    REFERENCES control_external_capability_sources(environment_id, source_kind, source_id)
    ON DELETE CASCADE,
  CHECK ((source_kind = 'extension_manifest' AND worker_script_name IS NOT NULL AND reason IS NOT NULL) OR
         (source_kind = 'plugin_manifest' AND worker_script_name IS NULL AND binding_kind = 'plugin_interface'))
);

CREATE INDEX IF NOT EXISTS idx_control_external_capability_review
  ON control_external_capability_sources(environment_id, status, review_state, source_kind);

CREATE TABLE IF NOT EXISTS control_plugin_desired_resources (
  plugin_resource_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  resource_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (resource_scope = 'tenant'),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv_namespace', 'r2_bucket')),
  logical_resource_id TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  lifecycle_mode TEXT NOT NULL DEFAULT 'managed'
    CHECK (lifecycle_mode IN ('managed', 'existing')),
  provider_resource_id TEXT,
  provider_name TEXT,
  encrypted_config_ref TEXT,
  injection_policy_json TEXT NOT NULL DEFAULT '{}',
  desired_spec_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'ready', 'active', 'failed', 'deleting', 'deleted')),
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, plugin_installation_id, tenant_id, logical_resource_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK ((provider_resource_id IS NULL) = (provider_name IS NULL)),
  CHECK (lifecycle_mode <> 'existing' OR provider_resource_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_control_plugin_resources_operation
  ON control_plugin_desired_resources(environment_id, operation_id, status, updated_at);

CREATE TABLE IF NOT EXISTS control_plugin_resource_migration_state (
  plugin_resource_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  provider_database_id TEXT,
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'applying', 'waiting_retry', 'ready', 'blocked')),
  expected_file_count INTEGER CHECK (expected_file_count IS NULL OR expected_file_count >= 0),
  applied_file_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_file_count >= 0),
  last_filename TEXT,
  last_error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_resource_id) REFERENCES control_plugin_desired_resources(plugin_resource_id)
    ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, stream_id)
    REFERENCES control_operation_release_pins(operation_id, stream_id),
  CHECK (applied_file_count <= COALESCE(expected_file_count, applied_file_count)),
  CHECK ((state = 'ready' AND provider_database_id IS NOT NULL AND completed_at IS NOT NULL AND
          expected_file_count IS NOT NULL AND applied_file_count = expected_file_count)
         OR state <> 'ready')
);

CREATE INDEX IF NOT EXISTS idx_control_plugin_resource_migration_runnable
  ON control_plugin_resource_migration_state(environment_id, state, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_control_plugin_resource_migration_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, stream_id, release_id, manifest_digest
ON control_plugin_resource_migration_state
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_resource_migration_pin_immutable');
END;

CREATE TABLE IF NOT EXISTS control_plugin_resource_binding_reconciliations (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  desired_bindings_json TEXT NOT NULL CHECK (json_valid(desired_bindings_json)),
  resource_map_json TEXT NOT NULL CHECK (json_valid(resource_map_json)),
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
  PRIMARY KEY (operation_id, plugin_installation_id),
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

CREATE INDEX IF NOT EXISTS idx_control_plugin_resource_binding_due
  ON control_plugin_resource_binding_reconciliations(state, stabilization_not_before, updated_at);

CREATE TABLE IF NOT EXISTS control_plugin_dynamic_worker_bindings (
  environment_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  desired_spec_json TEXT NOT NULL,
  observed_spec_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applying', 'active', 'drifted', 'failed', 'deleted')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, plugin_installation_id, tenant_id, binding_name),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_audit_events (
  event_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  operation_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  resource_kind TEXT,
  resource_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('attempted', 'succeeded', 'failed', 'blocked')),
  redacted_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id)
);

CREATE VIEW IF NOT EXISTS control_generated_lock_resources AS
SELECT
  d.environment_id,
  d.resource_kind,
  d.logical_shard_id,
  d.deterministic_name,
  d.ownership_fingerprint,
  d.provisioning_state,
  o.provider_resource_id,
  o.observed_state,
  o.observed_at
FROM control_desired_resources d
LEFT JOIN control_observed_resources o ON o.desired_resource_id = d.desired_resource_id;

CREATE VIEW IF NOT EXISTS control_desired_worker_binding_export AS
SELECT
  i.environment_id,
  i.worker_script_name,
  i.package_name,
  i.capability_manifest_digest,
  b.binding_name,
  b.binding_kind,
  b.data_role,
  b.logical_resource_id,
  b.secret_capability,
  b.plugin_dynamic_capability,
  b.desired_spec_json
FROM control_desired_worker_inventory i
JOIN control_worker_desired_bindings b
  ON b.environment_id = i.environment_id AND b.worker_script_name = i.worker_script_name
WHERE i.status = 'active'
UNION ALL
SELECT
  i.environment_id,
  i.worker_script_name,
  i.package_name,
  i.capability_manifest_digest,
  s.binding_ref AS binding_name,
  'd1' AS binding_kind,
  r.data_role,
  s.d1_desired_resource_id AS logical_resource_id,
  NULL AS secret_capability,
  NULL AS plugin_dynamic_capability,
  json_object(
    'shard_id', s.shard_id,
    'residency_policy_id', s.residency_policy_id,
    'residency_partition', s.residency_partition,
    'generation', s.generation,
    'status', s.status
  ) AS desired_spec_json
FROM control_desired_worker_inventory i
JOIN control_worker_required_data_roles r
  ON r.environment_id = i.environment_id AND r.worker_script_name = i.worker_script_name
JOIN control_tenant_shards s
  ON s.environment_id = r.environment_id AND s.data_role = r.data_role
WHERE i.status = 'active'
  AND r.data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')
  AND s.status NOT IN ('retired', 'deleting', 'deleted');
