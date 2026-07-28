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
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled')),
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
  CHECK ((status IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL) OR status NOT IN ('succeeded', 'failed', 'cancelled')),
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
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'blocked', 'skipped', 'rolled_back')),
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
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (origin_operation_id) REFERENCES control_operations(operation_id),
  CHECK ((resource_scope = 'tenant' AND tenant_id IS NOT NULL) OR resource_scope <> 'tenant'),
  CHECK ((resource_scope = 'plugin_install_instance' AND plugin_installation_id IS NOT NULL) OR resource_scope <> 'plugin_install_instance')
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
  FOREIGN KEY (desired_resource_id) REFERENCES control_desired_resources(desired_resource_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS control_migration_release_catalog (
  environment_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  manifest_r2_object_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'registered' CHECK (state IN ('registered', 'active', 'retired', 'blocked')),
  registered_by_operation_id TEXT NOT NULL,
  registered_by_actor_id TEXT,
  registered_at INTEGER NOT NULL,
  activated_at INTEGER,
  PRIMARY KEY (environment_id, stream_id, release_id),
  UNIQUE (environment_id, release_id, manifest_digest),
  UNIQUE (environment_id, stream_id, release_id, manifest_digest),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (registered_by_operation_id) REFERENCES control_operations(operation_id)
);

CREATE TRIGGER IF NOT EXISTS trg_control_release_catalog_immutable
BEFORE UPDATE OF environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key
ON control_migration_release_catalog
BEGIN
  SELECT RAISE(ABORT, 'control_release_catalog_immutable');
END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_release_one_active_stream
  ON control_migration_release_catalog(environment_id, stream_id)
  WHERE state = 'active';

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
  FOREIGN KEY (owner_operation_id) REFERENCES control_operations(operation_id)
);

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
    CHECK (operation_kind IN ('hmac_reindex', 'route_schema_reprojection', 'lookup_bucket_migration')),
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  lease_expires_at INTEGER NOT NULL,
  mutation_started INTEGER NOT NULL DEFAULT 0 CHECK (mutation_started IN (0, 1)),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id)
);

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
    CHECK (status IN ('requested', 'provisioning', 'ready', 'active', 'degraded', 'retired', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, data_role, residency_partition, generation, logical_shard_id),
  UNIQUE (environment_id, binding_ref),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (d1_desired_resource_id) REFERENCES control_desired_resources(desired_resource_id),
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
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, tenant_id, data_role, residency_partition, idempotency_key),
  UNIQUE (environment_id, tenant_id, data_role, residency_partition, account_id_blind_digest),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (selected_shard_id) REFERENCES control_tenant_shards(shard_id)
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
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id)
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
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (d1_desired_resource_id) REFERENCES control_desired_resources(desired_resource_id)
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
  FOREIGN KEY (lookup_shard_id) REFERENCES control_lookup_physical_shards(lookup_shard_id),
  FOREIGN KEY (target_lookup_shard_id) REFERENCES control_lookup_physical_shards(lookup_shard_id),
  CHECK ((state = 'active' AND target_lookup_shard_id IS NULL) OR state <> 'active')
);

CREATE TABLE IF NOT EXISTS control_hmac_rotation_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (index_kind IN ('email_exact', 'external_subject', 'account_id')),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  available_key_generation INTEGER NOT NULL CHECK (available_key_generation >= 1),
  active_key_generation INTEGER NOT NULL CHECK (active_key_generation >= 1),
  previous_key_generation INTEGER,
  state TEXT NOT NULL
    CHECK (state IN ('planned', 'distributing', 'activation_dual_write', 'dual_read', 'reindexing', 'verifying', 'grace', 'complete', 'blocked')),
  authoritative_checkpoint_json TEXT NOT NULL DEFAULT '{}',
  source_row_count INTEGER CHECK (source_row_count IS NULL OR source_row_count >= 0),
  current_row_count INTEGER CHECK (current_row_count IS NULL OR current_row_count >= 0),
  verification_result_json TEXT,
  grace_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_hmac_rotation_active
  ON control_hmac_rotation_operations(environment_id, index_kind)
  WHERE state <> 'complete' AND state <> 'blocked';

CREATE TABLE IF NOT EXISTS control_route_projection_migrations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  current_schema_version INTEGER NOT NULL CHECK (current_schema_version >= 1),
  previous_schema_version INTEGER CHECK (previous_schema_version IS NULL OR previous_schema_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('planned', 'backfilling', 'verifying', 'grace', 'complete', 'blocked')),
  physical_shard_checkpoint_json TEXT NOT NULL DEFAULT '{}',
  version_row_counts_json TEXT NOT NULL DEFAULT '{}',
  route_equivalence_result_json TEXT,
  grace_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_route_projection_active
  ON control_route_projection_migrations(environment_id)
  WHERE state <> 'complete' AND state <> 'blocked';

CREATE TABLE IF NOT EXISTS control_signing_key_metadata (
  environment_id TEXT NOT NULL,
  key_purpose TEXT NOT NULL CHECK (key_purpose IN ('runtime_registry', 'smoke_rpc')),
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  key_id TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'previous', 'retired', 'blocked')),
  activated_at INTEGER,
  retired_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, key_purpose, slot),
  UNIQUE (environment_id, key_purpose, key_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_signing_key_one_active
  ON control_signing_key_metadata(environment_id, key_purpose)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS control_runtime_registry_publications (
  environment_id TEXT PRIMARY KEY,
  active_slot TEXT NOT NULL CHECK (active_slot IN ('a', 'b')),
  active_key_id TEXT NOT NULL,
  previous_key_id TEXT,
  snapshot_ttl_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (snapshot_ttl_seconds = 1800),
  signature_typ TEXT NOT NULL DEFAULT 'authrim-runtime-registry+jws'
    CHECK (signature_typ = 'authrim-runtime-registry+jws'),
  signature_algorithm TEXT NOT NULL DEFAULT 'EdDSA' CHECK (signature_algorithm = 'EdDSA'),
  publication_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (publication_state IN ('pending', 'publishing', 'active', 'failed', 'blocked')),
  operation_id TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id)
);

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
  FOREIGN KEY (registered_by_operation_id) REFERENCES control_operations(operation_id)
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
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id)
);

CREATE TABLE IF NOT EXISTS control_worker_desired_bindings (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  binding_kind TEXT NOT NULL,
  data_role TEXT,
  logical_resource_id TEXT,
  secret_capability TEXT,
  plugin_dynamic_capability TEXT,
  desired_spec_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name, binding_name),
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name) ON DELETE CASCADE,
  CHECK (data_role IS NULL OR data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup', 'control', 'plugin_runner'))
);

CREATE TABLE IF NOT EXISTS control_worker_observed_bindings (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  binding_kind TEXT NOT NULL,
  provider_resource_id TEXT,
  observed_spec_json TEXT NOT NULL DEFAULT '{}',
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
  redacted_details_json TEXT NOT NULL DEFAULT '{}',
  review_state TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (review_state IN ('unreviewed', 'reviewed', 'dismissed', 'resolved')),
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_plugin_desired_resources (
  plugin_resource_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  resource_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (resource_scope = 'tenant'),
  resource_kind TEXT NOT NULL,
  logical_resource_id TEXT NOT NULL,
  encrypted_config_ref TEXT,
  injection_policy_json TEXT NOT NULL DEFAULT '{}',
  desired_spec_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'ready', 'active', 'failed', 'deleting', 'deleted')),
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, plugin_installation_id, tenant_id, logical_resource_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

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
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id) ON DELETE SET NULL
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
WHERE i.status = 'active' AND i.review_state <> 'rejected';
