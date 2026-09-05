-- Authrim 0.4.0 semantic fresh-install baseline.
-- Logical stream: d1-control.
-- Generated from the final database state; do not append historical migration SQL here.
-- Fresh-install baselines must never be applied to upgrade an existing database.
PRAGMA foreign_keys = OFF;

CREATE TABLE control_environments (
  environment_id TEXT PRIMARY KEY,
  environment_name TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL UNIQUE,
  lifecycle_state TEXT NOT NULL DEFAULT 'creating'
    CHECK (lifecycle_state IN ('creating', 'active', 'quarantining', 'quarantined', 'disabled')),
  lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation >= 1),
  quarantine_deny_generation INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_deny_generation >= 0),
  runtime_registry_generation INTEGER NOT NULL DEFAULT 0 CHECK (runtime_registry_generation >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, automatic_provisioning_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (automatic_provisioning_enabled IN (0, 1)), provisioning_token_ownership TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_token_ownership IN ('none', 'user', 'account')), provisioning_capability_state TEXT NOT NULL DEFAULT 'disabled'
  CHECK (provisioning_capability_state IN ('disabled', 'pending', 'ready', 'blocked')), provisioning_capability_checked_at INTEGER, provisioning_bootstrap_phase TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_bootstrap_phase IN ('none', 'pending_revocation', 'cutover_verified')), provisioning_bootstrap_token_ownership TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_bootstrap_token_ownership IN ('none', 'user', 'account')), provisioning_bootstrap_token_id TEXT
  CHECK (provisioning_bootstrap_token_id IS NULL OR (
    length(provisioning_bootstrap_token_id) = 32
    AND provisioning_bootstrap_token_id NOT GLOB '*[^0-9a-f]*'
  )), provisioning_bootstrap_token_fingerprint TEXT
  CHECK (provisioning_bootstrap_token_fingerprint IS NULL OR (
    length(provisioning_bootstrap_token_fingerprint) = 64
    AND provisioning_bootstrap_token_fingerprint NOT GLOB '*[^0-9a-f]*'
  )), provisioning_child_tokens_json TEXT
  CHECK (provisioning_child_tokens_json IS NULL OR (
    json_valid(provisioning_child_tokens_json)
    AND json_type(provisioning_child_tokens_json) = 'array'
  )), provisioning_token_management TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_token_management IN ('none', 'setup', 'operator')), provisioning_secret_generation_deployment_id TEXT
  CHECK (provisioning_secret_generation_deployment_id IS NULL OR (
    length(provisioning_secret_generation_deployment_id) BETWEEN 1 AND 128
    AND instr(provisioning_secret_generation_deployment_id, char(0)) = 0
    AND provisioning_secret_generation_deployment_id GLOB '[A-Za-z0-9]*'
    AND provisioning_secret_generation_deployment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  )), provisioning_secret_generation_version_id TEXT
  CHECK (provisioning_secret_generation_version_id IS NULL OR (
    length(provisioning_secret_generation_version_id) BETWEEN 1 AND 128
    AND instr(provisioning_secret_generation_version_id, char(0)) = 0
    AND provisioning_secret_generation_version_id GLOB '[A-Za-z0-9]*'
    AND provisioning_secret_generation_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  )),
  CHECK (issuer = 'urn:authrim:control:' || environment_id)
);
CREATE TABLE control_operations (
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
  updated_at INTEGER NOT NULL, retry_budget_started_at INTEGER,
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (operation_id, environment_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK ((status IN ('succeeded', 'canceled') AND completed_at IS NOT NULL) OR status NOT IN ('succeeded', 'canceled')),
  CHECK ((release_id IS NULL AND release_stream_id IS NULL AND release_manifest_digest IS NULL) OR
         (release_id IS NOT NULL AND release_stream_id IS NOT NULL AND release_manifest_digest IS NOT NULL))
);
CREATE TABLE control_operation_steps (
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
CREATE TABLE control_desired_resources (
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
  updated_at INTEGER NOT NULL, provider_create_state TEXT NOT NULL DEFAULT 'not_started'
    CHECK (provider_create_state IN ('not_started', 'issued', 'identified')), provider_resource_id TEXT, provider_identity_checkpointed_at INTEGER,
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
CREATE TABLE control_observed_resources (
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
CREATE TABLE control_migration_release_catalog (
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
CREATE TABLE control_operation_release_pins (
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
CREATE TABLE control_tenant_database_migration_state (
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
CREATE TABLE control_worker_deployment_leases (
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
  updated_at INTEGER NOT NULL, mutation_started_at INTEGER,
  PRIMARY KEY (environment_id, worker_script_name),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id)
);
CREATE TABLE control_bootstrap_handoffs (
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
CREATE TABLE control_directory_rewrite_leases (
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
CREATE TABLE control_environment_resource_policies (
  environment_id TEXT PRIMARY KEY,
  max_concurrent_provisioning INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent_provisioning BETWEEN 1 AND 32),
  max_ready_spares INTEGER NOT NULL DEFAULT 2 CHECK (max_ready_spares BETWEEN 0 AND 32),
  max_d1_resources INTEGER NOT NULL DEFAULT 1000 CHECK (max_d1_resources >= 1),
  daily_d1_create_budget INTEGER NOT NULL DEFAULT 20 CHECK (daily_d1_create_budget >= 0),
  target_account_count INTEGER NOT NULL DEFAULT 100000 CHECK (target_account_count >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, lookup_rebalance_concurrency INTEGER NOT NULL DEFAULT 1
    CHECK (lookup_rebalance_concurrency BETWEEN 1 AND 4), lookup_forecast_horizon_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (lookup_forecast_horizon_seconds BETWEEN 300 AND 2592000), lookup_target_active_route_count INTEGER NOT NULL DEFAULT 100000
    CHECK (lookup_target_active_route_count >= 1), lookup_scale_out_headroom_bps INTEGER NOT NULL DEFAULT 2000
    CHECK (lookup_scale_out_headroom_bps BETWEEN 0 AND 9000), lookup_registration_ewma_alpha_bps INTEGER NOT NULL DEFAULT 2500
    CHECK (lookup_registration_ewma_alpha_bps BETWEEN 1 AND 10000), lookup_scale_out_policy_generation INTEGER NOT NULL DEFAULT 1
    CHECK (lookup_scale_out_policy_generation >= 1), account_forecast_horizon_seconds INTEGER NOT NULL DEFAULT 900
    CHECK (account_forecast_horizon_seconds BETWEEN 60 AND 2592000), account_scale_out_headroom_bps INTEGER NOT NULL DEFAULT 2000
    CHECK (account_scale_out_headroom_bps BETWEEN 0 AND 9000), account_registration_ewma_alpha_bps INTEGER NOT NULL DEFAULT 5000
    CHECK (account_registration_ewma_alpha_bps BETWEEN 1 AND 10000), account_scale_out_policy_generation INTEGER NOT NULL DEFAULT 1
    CHECK (account_scale_out_policy_generation >= 1),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);
CREATE TABLE control_d1_create_budget_reservations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  budget_day INTEGER NOT NULL CHECK (budget_day >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (environment_id, operation_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE
);
CREATE TABLE control_residency_partitions (
  environment_id TEXT NOT NULL,
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  jurisdiction TEXT CHECK (jurisdiction IN ('eu', 'fedramp')),
  location_hint TEXT CHECK (location_hint IN ('wnam', 'enam', 'weur', 'eeur', 'apac', 'oc')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, lookup_capacity_domain_id TEXT
    CHECK (lookup_capacity_domain_id IS NULL OR
           (length(lookup_capacity_domain_id) BETWEEN 1 AND 128)),
  PRIMARY KEY (environment_id, residency_policy_id, residency_partition),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK (jurisdiction IS NULL OR location_hint IS NULL)
);
CREATE TABLE control_tenant_shards (
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
  updated_at INTEGER NOT NULL, replication_checked_at INTEGER, replication_error_code TEXT, allocation_scope TEXT NOT NULL DEFAULT 'shared_pool'
  CHECK (allocation_scope IN ('shared_pool', 'tenant_exclusive')), owner_tenant_id TEXT
  CHECK (
    (allocation_scope = 'shared_pool' AND owner_tenant_id IS NULL) OR
    (allocation_scope = 'tenant_exclusive' AND owner_tenant_id IS NOT NULL)
  ), quarantine_state TEXT NOT NULL DEFAULT 'none'
  CHECK (quarantine_state IN ('none', 'quarantining', 'quarantined')), quarantine_operation_id TEXT, quarantine_started_at INTEGER, quarantined_at INTEGER,
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
CREATE TABLE control_shard_capacity (
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
CREATE TABLE control_tenant_shard_allocations (
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
CREATE TABLE control_read_replication_policies (
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
CREATE TABLE control_read_replication_rollouts (
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
CREATE TABLE control_lookup_physical_shards (
  lookup_shard_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  d1_desired_resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'provisioning', 'ready', 'active', 'draining', 'retired', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, read_replication_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (read_replication_mode IN ('disabled', 'enabled')), consistency_policy_version INTEGER NOT NULL DEFAULT 1
    CHECK (consistency_policy_version >= 1), observed_replication_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (observed_replication_state IN ('unknown', 'disabled', 'enabling', 'enabled', 'failed')), replication_checked_at INTEGER, replication_error_code TEXT, capacity_weight REAL NOT NULL DEFAULT 1 CHECK (capacity_weight > 0),
  UNIQUE (environment_id, residency_partition, binding_ref),
  UNIQUE (lookup_shard_id, environment_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (d1_desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id)
);
CREATE TABLE control_lookup_bucket_assignments (
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
CREATE TABLE control_lookup_registry_publications (
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
CREATE TABLE control_hmac_rotation_operations (
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
CREATE TABLE control_route_projection_migrations (
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
CREATE TABLE control_signing_key_metadata (
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
CREATE TABLE control_runtime_registry_publications (
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
CREATE TABLE control_runtime_registry_routes (
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
CREATE TABLE control_desired_worker_inventory (
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
CREATE TABLE control_worker_inventory_change_events (
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
CREATE TABLE control_worker_required_data_roles (
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
CREATE TABLE control_worker_observed_bindings (
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
CREATE TABLE control_worker_inventory_drift_findings (
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
CREATE TABLE control_external_capability_sources (
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
CREATE TABLE control_external_capability_bindings (
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
CREATE TABLE control_plugin_desired_resources (
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
  updated_at INTEGER NOT NULL, lifecycle_generation INTEGER NOT NULL DEFAULT 1
    CHECK (lifecycle_generation >= 1), provider_create_state TEXT NOT NULL DEFAULT 'not_started'
    CHECK (provider_create_state IN ('not_started', 'issued', 'identified', 'legacy_unverified')), provider_creation_date TEXT, provider_ownership_marker_key TEXT, provider_ownership_id TEXT, provider_identity_checkpointed_at INTEGER,
  UNIQUE (environment_id, plugin_installation_id, tenant_id, logical_resource_id),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK ((provider_resource_id IS NULL) = (provider_name IS NULL)),
  CHECK (lifecycle_mode <> 'existing' OR provider_resource_id IS NOT NULL)
);
CREATE TABLE control_plugin_resource_migration_state (
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
CREATE TABLE control_plugin_resource_binding_reconciliations (
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
CREATE TABLE control_plugin_dynamic_worker_bindings (
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
CREATE TABLE control_audit_events (
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
CREATE TABLE control_plugin_runner_registry_publications (
  environment_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  inventory_digest TEXT NOT NULL
    CHECK (inventory_digest NOT GLOB '*[^0-9a-f]*' AND length(inventory_digest) = 64),
  snapshot_jws TEXT NOT NULL CHECK (length(snapshot_jws) BETWEEN 64 AND 1048576),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  status TEXT NOT NULL CHECK (status IN ('publishing', 'active')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);
CREATE TABLE control_lookup_bucket_migrations (
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
CREATE TABLE control_lookup_hmac_key_states (
  environment_id TEXT PRIMARY KEY,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  rotation_state TEXT NOT NULL
    CHECK (rotation_state IN (
      'stable', 'activation_dual_write', 'dual_read', 'reindexing',
      'verifying', 'grace', 'blocked'
    )),
  write_mode TEXT NOT NULL CHECK (write_mode IN ('current_only', 'dual_write')),
  current_key_generation INTEGER NOT NULL CHECK (current_key_generation >= 1),
  current_key_id TEXT NOT NULL,
  current_key_slot TEXT NOT NULL CHECK (current_key_slot IN ('A', 'B')),
  current_key_fingerprint TEXT NOT NULL
    CHECK (length(current_key_fingerprint) = 64 AND
           current_key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  previous_key_generation INTEGER,
  previous_key_id TEXT,
  previous_key_slot TEXT CHECK (previous_key_slot IN ('A', 'B')),
  previous_key_fingerprint TEXT
    CHECK (previous_key_fingerprint IS NULL OR
           (length(previous_key_fingerprint) = 64 AND
            previous_key_fingerprint NOT GLOB '*[^0-9a-f]*')),
  operation_id TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (
    (previous_key_generation IS NULL AND previous_key_id IS NULL AND
     previous_key_slot IS NULL AND previous_key_fingerprint IS NULL) OR
    (previous_key_generation IS NOT NULL AND previous_key_id IS NOT NULL AND
     previous_key_slot IS NOT NULL AND previous_key_fingerprint IS NOT NULL)
  ),
  CHECK (write_mode <> 'dual_write' OR previous_key_generation IS NOT NULL),
  CHECK (rotation_state <> 'activation_dual_write' OR write_mode = 'dual_write'),
  CHECK (rotation_state <> 'stable' OR
         (write_mode = 'current_only' AND previous_key_generation IS NULL)),
  CHECK (previous_key_generation IS NULL OR
         (previous_key_generation <> current_key_generation AND
          previous_key_id <> current_key_id AND
          previous_key_slot <> current_key_slot AND
          previous_key_fingerprint <> current_key_fingerprint))
);
CREATE TABLE control_lookup_hmac_key_state_publications (
  environment_id TEXT PRIMARY KEY,
  publication_generation INTEGER NOT NULL CHECK (publication_generation >= 1),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  state_digest TEXT NOT NULL
    CHECK (length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  snapshot_jws TEXT NOT NULL CHECK (length(snapshot_jws) BETWEEN 64 AND 16384),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  status TEXT NOT NULL CHECK (status IN ('publishing', 'active')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_lookup_hmac_key_states(environment_id)
    ON DELETE CASCADE
);
CREATE TABLE control_lookup_hmac_rotation_sources (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('account_id', 'email_exact', 'external_subject')),
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/users', 'tenant_pii')),
  shard_id TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  cutoff_at INTEGER NOT NULL CHECK (cutoff_at >= 1),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'complete', 'blocked')),
  cursor_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(cursor_json) AND length(cursor_json) <= 4096),
  source_row_count INTEGER NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, source_kind, shard_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_hmac_rotation_operations(operation_id, environment_id) ON DELETE CASCADE,
  CHECK ((source_kind = 'account_id' AND data_role = 'tenant_core/users') OR
         (source_kind = 'email_exact' AND data_role = 'tenant_pii') OR
         (source_kind = 'external_subject' AND
          data_role IN ('tenant_core/users', 'tenant_pii'))),
  CHECK ((state = 'complete' AND completed_at IS NOT NULL) OR state <> 'complete')
);
CREATE TABLE control_lookup_hmac_rotation_verification_shards (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  lookup_shard_id TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'complete', 'blocked')),
  cursor_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(cursor_json) AND length(cursor_json) <= 4096),
  current_row_count INTEGER NOT NULL DEFAULT 0 CHECK (current_row_count >= 0),
  current_rows_valid INTEGER NOT NULL DEFAULT 1 CHECK (current_rows_valid IN (0, 1)),
  reservations_valid INTEGER NOT NULL DEFAULT 1 CHECK (reservations_valid IN (0, 1)),
  route_references_valid INTEGER NOT NULL DEFAULT 1 CHECK (route_references_valid IN (0, 1)),
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, lookup_shard_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_hmac_rotation_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (lookup_shard_id, environment_id)
    REFERENCES control_lookup_physical_shards(lookup_shard_id, environment_id),
  CHECK ((state = 'complete' AND completed_at IS NOT NULL) OR state <> 'complete')
);
CREATE TABLE control_read_replication_rollout_targets (
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
CREATE TABLE control_tenant_default_allocations (
  allocation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  selected_shard_id TEXT NOT NULL,
  reservation_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (reservation_state IN ('reserved', 'committed', 'released')),
  idempotency_key TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  capacity_counted_at INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  released_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, tenant_id, residency_partition),
  UNIQUE (environment_id, idempotency_key),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (selected_shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  FOREIGN KEY (environment_id, residency_policy_id, residency_partition)
    REFERENCES control_residency_partitions(environment_id, residency_policy_id, residency_partition),
  CHECK ((reservation_state = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL) OR
         (reservation_state = 'released' AND released_at IS NOT NULL) OR
         (reservation_state = 'reserved' AND committed_at IS NULL AND released_at IS NULL))
);
CREATE TABLE control_signing_key_verifications (
  environment_id TEXT NOT NULL,
  key_purpose TEXT NOT NULL CHECK (key_purpose IN ('runtime_registry', 'smoke_rpc')),
  key_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  worker_script_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error_code TEXT,
  verified_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, key_purpose, key_id, worker_script_name),
  FOREIGN KEY (environment_id, key_purpose, key_id)
    REFERENCES control_signing_key_metadata(environment_id, key_purpose, key_id)
    ON DELETE CASCADE,
  CHECK ((status = 'succeeded' AND verified_at IS NOT NULL AND last_error_code IS NULL) OR
         (status = 'failed' AND verified_at IS NULL AND last_error_code IS NOT NULL))
);
CREATE TABLE control_lookup_hmac_candidate_verifications (
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  verification_phase TEXT NOT NULL CHECK (verification_phase IN ('distribution', 'generation')),
  worker_script_name TEXT NOT NULL,
  current_digest TEXT,
  candidate_digest TEXT,
  observed_state_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error_code TEXT,
  verified_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, operation_id, verification_phase, worker_script_name),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_hmac_rotation_operations(operation_id, environment_id)
    ON DELETE CASCADE,
  CHECK (
    (status = 'succeeded' AND verification_phase = 'distribution' AND
     length(current_digest) = 64 AND current_digest NOT GLOB '*[^0-9a-f]*' AND
     length(candidate_digest) = 64 AND candidate_digest NOT GLOB '*[^0-9a-f]*' AND
     observed_state_revision IS NULL AND last_error_code IS NULL AND verified_at IS NOT NULL) OR
    (status = 'succeeded' AND verification_phase = 'generation' AND
     current_digest IS NULL AND candidate_digest IS NULL AND
     observed_state_revision >= 1 AND last_error_code IS NULL AND verified_at IS NOT NULL) OR
    (status = 'failed' AND current_digest IS NULL AND candidate_digest IS NULL AND
     observed_state_revision IS NULL AND last_error_code IS NOT NULL AND verified_at IS NULL)
  )
);
CREATE TABLE control_bootstrap_worker_evidence (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  expected_deployment_id TEXT NOT NULL,
  expected_version_id TEXT NOT NULL,
  expected_settings_digest TEXT NOT NULL
    CHECK (length(expected_settings_digest) = 64
      AND expected_settings_digest NOT GLOB '*[^0-9a-f]*'),
  observed_settings_digest TEXT
    CHECK (observed_settings_digest IS NULL OR (
      length(observed_settings_digest) = 64
      AND observed_settings_digest NOT GLOB '*[^0-9a-f]*'
    )),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'verified', 'blocked')),
  verification_error_code TEXT,
  observed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name),
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name)
      ON DELETE CASCADE,
  CHECK ((state = 'verified' AND observed_settings_digest = expected_settings_digest
    AND observed_at IS NOT NULL AND verification_error_code IS NULL) OR state <> 'verified'),
  CHECK ((state = 'blocked' AND verification_error_code IS NOT NULL) OR state <> 'blocked')
);
CREATE TABLE control_tenant_placement_policies (
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  isolation_policy TEXT NOT NULL
    CHECK (isolation_policy IN ('shared_pool', 'tenant_exclusive')),
  policy_generation INTEGER NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  policy_state TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (policy_state IN ('provisioning', 'active', 'migrating', 'retired')),
  pending_isolation_policy TEXT
    CHECK (pending_isolation_policy IS NULL OR pending_isolation_policy = 'tenant_exclusive'),
  pending_policy_generation INTEGER,
  migration_operation_id TEXT,
  source_operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, tenant_id),
  UNIQUE (environment_id, idempotency_key),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK (
    (pending_isolation_policy IS NULL AND pending_policy_generation IS NULL
      AND migration_operation_id IS NULL) OR
    (isolation_policy = 'shared_pool' AND pending_isolation_policy = 'tenant_exclusive'
      AND pending_policy_generation = policy_generation + 1
      AND migration_operation_id IS NOT NULL AND policy_state = 'migrating')
  ),
  CHECK ((policy_state IN ('active', 'migrating') AND activated_at IS NOT NULL)
    OR policy_state IN ('provisioning', 'retired'))
);
CREATE TABLE control_tenant_shard_assignments (
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  assignment_state TEXT NOT NULL DEFAULT 'active'
    CHECK (assignment_state IN ('pending', 'active', 'retired', 'quarantined')),
  source_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, tenant_id, data_role, residency_partition, shard_id),
  UNIQUE (environment_id, tenant_id, data_role, residency_partition, assignment_generation),
  FOREIGN KEY (environment_id, tenant_id)
    REFERENCES control_tenant_placement_policies(environment_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  FOREIGN KEY (environment_id, residency_policy_id, residency_partition)
    REFERENCES control_residency_partitions(environment_id, residency_policy_id, residency_partition),
  CHECK ((assignment_state = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL) OR
         (assignment_state IN ('retired', 'quarantined') AND retired_at IS NOT NULL) OR
         assignment_state = 'pending')
);
CREATE TABLE control_tenant_placement_migrations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  source_policy_generation INTEGER NOT NULL CHECK (source_policy_generation >= 1),
  target_policy_generation INTEGER NOT NULL CHECK (target_policy_generation = source_policy_generation + 1),
  source_isolation_policy TEXT NOT NULL CHECK (source_isolation_policy = 'shared_pool'),
  target_isolation_policy TEXT NOT NULL CHECK (target_isolation_policy = 'tenant_exclusive'),
  migration_state TEXT NOT NULL DEFAULT 'planning' CHECK (migration_state IN (
    'planning',
    'targets_provisioning',
    'inventory_verifying',
    'capture_installing',
    'backfilling',
    'catching_up',
    'verifying',
    'write_fencing',
    'cutover_ready',
    'cutover_committed',
    'source_quarantined',
    'purge_pending',
    'complete',
    'canceled',
    'blocked'
  )),
  active_operation_key TEXT CHECK (active_operation_key IS NULL OR active_operation_key = 'active'),
  idempotency_key TEXT NOT NULL,
  inventory_digest TEXT,
  inventory_verified_at INTEGER,
  write_fence_state TEXT NOT NULL DEFAULT 'inactive'
    CHECK (write_fence_state IN ('inactive', 'requested', 'active', 'released')),
  write_fence_started_at INTEGER,
  write_fence_released_at INTEGER,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at INTEGER,
  cancel_requested_at INTEGER,
  canceled_at INTEGER,
  cutover_committed_at INTEGER,
  source_quarantined_at INTEGER,
  source_retention_expires_at INTEGER,
  purge_approved_by TEXT,
  purge_approved_at INTEGER,
  completed_at INTEGER,
  last_error_code TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, tenant_id)
    REFERENCES control_tenant_placement_policies(environment_id, tenant_id),
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (environment_id, tenant_id, active_operation_key),
  CHECK (
    (migration_state IN ('complete', 'canceled') AND active_operation_key IS NULL) OR
    (migration_state NOT IN ('complete', 'canceled') AND active_operation_key = 'active')
  ),
  CHECK ((inventory_verified_at IS NULL AND inventory_digest IS NULL) OR
         (inventory_verified_at IS NOT NULL AND length(inventory_digest) = 64)),
  CHECK ((write_fence_state IN ('requested', 'active', 'released')
          AND write_fence_started_at IS NOT NULL) OR write_fence_state = 'inactive'),
  CHECK ((write_fence_state = 'released' AND write_fence_released_at IS NOT NULL)
         OR write_fence_state <> 'released'),
  CHECK ((migration_state IN (
           'cutover_committed', 'source_quarantined', 'purge_pending', 'complete'
         ) AND cutover_committed_at IS NOT NULL) OR
         migration_state NOT IN ('cutover_committed', 'source_quarantined', 'purge_pending', 'complete')),
  CHECK ((migration_state = 'canceled' AND canceled_at IS NOT NULL) OR migration_state <> 'canceled'),
  CHECK ((migration_state = 'complete' AND completed_at IS NOT NULL) OR migration_state <> 'complete')
);
CREATE TABLE control_tenant_placement_migration_shards (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  source_assignment_generation INTEGER NOT NULL CHECK (source_assignment_generation >= 1),
  target_shard_id TEXT,
  target_assignment_generation INTEGER CHECK (target_assignment_generation >= 1),
  shard_state TEXT NOT NULL DEFAULT 'target_pending' CHECK (shard_state IN (
    'target_pending', 'inventory_pending', 'capture_pending', 'backfilling', 'catching_up', 'verifying',
    'verified', 'write_fenced', 'cutover_committed', 'quarantined', 'purged', 'blocked'
  )),
  table_cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(table_cursor_json)),
  source_row_count INTEGER CHECK (source_row_count IS NULL OR source_row_count >= 0),
  target_row_count INTEGER CHECK (target_row_count IS NULL OR target_row_count >= 0),
  source_checksum TEXT CHECK (source_checksum IS NULL OR length(source_checksum) = 64),
  target_checksum TEXT CHECK (target_checksum IS NULL OR length(target_checksum) = 64),
  last_observed_source_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (last_observed_source_sequence >= 0),
  last_applied_source_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (last_applied_source_sequence >= 0),
  capture_fencing_token INTEGER CHECK (capture_fencing_token IS NULL OR capture_fencing_token >= 1),
  inventory_table_count INTEGER CHECK (inventory_table_count IS NULL OR inventory_table_count >= 1),
  inventory_verified_at INTEGER,
  capture_installed_at INTEGER,
  backfill_completed_at INTEGER,
  verified_at INTEGER,
  write_fenced_at INTEGER,
  cutover_committed_at INTEGER,
  quarantined_at INTEGER,
  purged_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, source_shard_id),
  UNIQUE (operation_id, target_shard_id),
  FOREIGN KEY (operation_id)
    REFERENCES control_tenant_placement_migrations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (source_shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  FOREIGN KEY (target_shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  CHECK (target_shard_id IS NULL OR source_shard_id <> target_shard_id),
  CHECK ((target_shard_id IS NULL AND target_assignment_generation IS NULL
          AND shard_state = 'target_pending') OR
         (target_shard_id IS NOT NULL AND target_assignment_generation IS NOT NULL)),
  CHECK (last_applied_source_sequence <= last_observed_source_sequence),
  CHECK ((shard_state IN ('verified', 'write_fenced', 'cutover_committed', 'quarantined', 'purged')
          AND verified_at IS NOT NULL AND source_row_count = target_row_count
          AND source_checksum = target_checksum) OR
         shard_state NOT IN ('verified', 'write_fenced', 'cutover_committed', 'quarantined', 'purged'))
);
CREATE TABLE control_tenant_placement_migration_inventory (
  operation_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN (
    'tenant_column', 'tenant_row', 'tenant_key', 'tenant_or_key', 'tenant_scope',
    'parent', 'shard_local', 'global_reference'
  )),
  disposition TEXT NOT NULL CHECK (disposition IN ('migrate', 'retain_target_local')),
  primary_key_json TEXT NOT NULL CHECK (json_valid(primary_key_json)),
  columns_json TEXT NOT NULL CHECK (json_valid(columns_json)),
  foreign_keys_json TEXT NOT NULL CHECK (json_valid(foreign_keys_json)),
  ownership_json TEXT NOT NULL CHECK (json_valid(ownership_json)),
  columns_digest TEXT NOT NULL CHECK (length(columns_digest) = 64),
  inventory_state TEXT NOT NULL CHECK (inventory_state IN ('verified', 'blocked')),
  error_code TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, source_shard_id, table_name),
  FOREIGN KEY (operation_id, source_shard_id)
    REFERENCES control_tenant_placement_migration_shards(operation_id, source_shard_id)
      ON DELETE CASCADE,
  CHECK ((inventory_state = 'blocked' AND error_code IS NOT NULL) OR
         (inventory_state = 'verified' AND error_code IS NULL))
);
CREATE TABLE control_shard_quarantine_operations (
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
CREATE TABLE control_shard_quarantine_tenants (
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
CREATE TABLE control_shard_cleanup_operations (
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
CREATE TABLE control_shard_cleanup_bindings (
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
CREATE TABLE IF NOT EXISTS "control_worker_desired_bindings" (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  binding_kind TEXT NOT NULL
    CHECK (binding_kind IN ('d1', 'kv_namespace', 'r2_bucket', 'service', 'dispatch_namespace',
      'worker_loader', 'durable_object_namespace', 'queue', 'send_email', 'hyperdrive',
      'version_metadata', 'secret', 'binding', 'plugin_interface')),
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
CREATE TABLE control_plugin_resource_cleanup_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  source_operation_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 1),
  reason TEXT NOT NULL CHECK (reason IN ('uninstall', 'canceled_pre_activation')),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'removing_bindings', 'quarantined',
      'deleting_resources', 'verifying_absence', 'succeeded', 'blocked')),
  worker_script_name TEXT,
  binding_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(binding_names_json)),
  binding_presence_required INTEGER NOT NULL DEFAULT 0
    CHECK (binding_presence_required IN (0, 1)),
  expected_source_version_id TEXT,
  previous_deployment_id TEXT,
  previous_restore_settings_json TEXT
    CHECK (previous_restore_settings_json IS NULL OR json_valid(previous_restore_settings_json)),
  drain_not_before INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (environment_id, plugin_installation_id, lifecycle_generation),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (source_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK ((state IN ('quarantined', 'deleting_resources', 'verifying_absence', 'succeeded')
          AND drain_not_before IS NOT NULL) OR
         state NOT IN ('quarantined', 'deleting_resources', 'verifying_absence', 'succeeded')),
  CHECK ((state = 'succeeded' AND completed_at IS NOT NULL) OR state <> 'succeeded'),
  CHECK (binding_presence_required = 0 OR worker_script_name IS NOT NULL)
);
CREATE TABLE control_plugin_resource_cleanup_items (
  operation_id TEXT NOT NULL,
  plugin_resource_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv_namespace', 'r2_bucket')),
  lifecycle_mode TEXT NOT NULL CHECK (lifecycle_mode IN ('managed', 'existing')),
  provider_resource_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  ownership_fingerprint TEXT NOT NULL
    CHECK (length(ownership_fingerprint) = 64 AND
           ownership_fingerprint NOT GLOB '*[^0-9a-f]*'),
  delete_provider_resource INTEGER NOT NULL CHECK (delete_provider_resource IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'quarantined', 'deleting', 'deleted', 'detached', 'blocked')),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (operation_id, plugin_resource_id),
  FOREIGN KEY (operation_id)
    REFERENCES control_plugin_resource_cleanup_operations(operation_id) ON DELETE CASCADE,
  CHECK ((lifecycle_mode = 'managed' AND delete_provider_resource = 1) OR
         (lifecycle_mode = 'existing' AND delete_provider_resource = 0)),
  CHECK ((state IN ('deleted', 'detached') AND completed_at IS NOT NULL) OR
         state NOT IN ('deleted', 'detached'))
);
CREATE TABLE control_tenant_disaster_recovery_operations (
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
  completed_at INTEGER, restore_idempotency_key TEXT, reactivation_idempotency_key TEXT, cancel_idempotency_key TEXT, cancel_requested_by TEXT,
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
CREATE TABLE control_tenant_disaster_recovery_targets (
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
CREATE TABLE IF NOT EXISTS "control_worker_binding_reconciliations" (
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
CREATE TABLE control_bootstrap_accelerator_proofs (
  environment_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, jti),
  FOREIGN KEY (environment_id)
    REFERENCES control_bootstrap_handoffs(environment_id) ON DELETE CASCADE
);
CREATE TABLE control_bootstrap_accelerator_leases (
  environment_id TEXT PRIMARY KEY,
  owner_jti TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id, owner_jti)
    REFERENCES control_bootstrap_accelerator_proofs(environment_id, jti) ON DELETE CASCADE,
  FOREIGN KEY (environment_id)
    REFERENCES control_bootstrap_handoffs(environment_id) ON DELETE CASCADE
);
CREATE TABLE control_release_migration_rollouts (
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
CREATE TABLE control_release_migration_targets (
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
CREATE TABLE control_lookup_retention_policy_projections (
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
CREATE TABLE control_account_legal_hold_projections (
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
CREATE TABLE control_lookup_rebalance_batches (
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
CREATE TABLE control_lookup_rebalance_bucket_targets (
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
CREATE TABLE control_lookup_retention_operations (
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
CREATE TABLE control_lookup_retention_targets (
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
CREATE TABLE control_r2_bucket_metric_reports (
  environment_id TEXT NOT NULL,
  binding TEXT NOT NULL CHECK (binding IN (
    'MIGRATION_RELEASES', 'PLUGIN_BUNDLES', 'PUBLIC_ASSETS', 'DIAGNOSTIC_LOGS',
    'AUDIT_ARCHIVE', 'IMPORT_ARTIFACTS', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS'
  )),
  owner_worker TEXT NOT NULL CHECK (owner_worker IN (
    'ar-control', 'ar-management', 'ar-plugin-runner'
  )),
  object_count INTEGER NOT NULL CHECK (object_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  oldest_object_at INTEGER,
  encryption_methods_json TEXT NOT NULL,
  retention_overdue_objects INTEGER,
  retention_policy TEXT NOT NULL,
  scan_complete INTEGER NOT NULL CHECK (scan_complete IN (0, 1)),
  measured_at INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, binding),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);
CREATE TABLE control_r2_metric_scan_state (
  environment_id TEXT NOT NULL,
  binding TEXT NOT NULL CHECK (binding = 'MIGRATION_RELEASES'),
  accumulator_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, binding),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);
CREATE TABLE control_lookup_scale_out_forecasts (
  environment_id TEXT NOT NULL,
  lookup_capacity_domain_id TEXT NOT NULL
    CHECK (length(lookup_capacity_domain_id) BETWEEN 1 AND 128),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 1),
  observed_active_route_count INTEGER NOT NULL CHECK (observed_active_route_count >= 0),
  observed_successful_publication_count INTEGER NOT NULL
    CHECK (observed_successful_publication_count >= 0),
  sample_interval_seconds INTEGER NOT NULL CHECK (sample_interval_seconds >= 0),
  sample_rate_microrows_per_second INTEGER NOT NULL
    CHECK (sample_rate_microrows_per_second >= 0),
  ewma_rate_microrows_per_second INTEGER NOT NULL
    CHECK (ewma_rate_microrows_per_second >= 0),
  forecast_horizon_seconds INTEGER NOT NULL
    CHECK (forecast_horizon_seconds BETWEEN 300 AND 2592000),
  forecast_new_route_count INTEGER NOT NULL CHECK (forecast_new_route_count >= 0),
  projected_active_route_count INTEGER NOT NULL CHECK (projected_active_route_count >= 0),
  usable_capacity_route_count INTEGER NOT NULL CHECK (usable_capacity_route_count >= 0),
  capacity_unit_count INTEGER NOT NULL CHECK (capacity_unit_count >= 0),
  decision_generation INTEGER NOT NULL CHECK (decision_generation >= 0),
  decision_state TEXT NOT NULL
    CHECK (decision_state IN ('warming', 'stable', 'provisioning', 'blocked')),
  snapshot_digest TEXT NOT NULL
    CHECK (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  capacity_request_idempotency_key TEXT
    CHECK (capacity_request_idempotency_key IS NULL OR
           (length(capacity_request_idempotency_key) BETWEEN 1 AND 128)),
  requested_operation_id TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, lookup_capacity_domain_id),
  FOREIGN KEY (environment_id)
    REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (requested_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (projected_active_route_count >= observed_active_route_count),
  CHECK ((decision_state IN ('warming', 'stable') AND requested_operation_id IS NULL) OR
         decision_state NOT IN ('warming', 'stable'))
);
CREATE TABLE control_worker_binding_reconciler_leases (
  environment_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);
CREATE TABLE control_account_scale_out_forecasts (
  environment_id TEXT NOT NULL,
  allocation_scope TEXT NOT NULL
    CHECK (allocation_scope IN ('shared_pool', 'tenant_exclusive')),
  owner_tenant_key TEXT NOT NULL CHECK (length(owner_tenant_key) <= 128),
  owner_tenant_id TEXT,
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/users', 'tenant_pii')),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  successful_allocation_count INTEGER NOT NULL DEFAULT 0
    CHECK (successful_allocation_count >= 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 1),
  observed_successful_allocation_count INTEGER NOT NULL DEFAULT 0
    CHECK (observed_successful_allocation_count >= 0),
  sample_interval_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (sample_interval_seconds >= 0),
  sample_rate_microaccounts_per_second INTEGER NOT NULL DEFAULT 0
    CHECK (sample_rate_microaccounts_per_second >= 0),
  ewma_rate_microaccounts_per_second INTEGER NOT NULL DEFAULT 0
    CHECK (ewma_rate_microaccounts_per_second >= 0),
  forecast_horizon_seconds INTEGER NOT NULL
    CHECK (forecast_horizon_seconds BETWEEN 60 AND 2592000),
  forecast_new_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (forecast_new_account_count >= 0),
  observed_allocated_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (observed_allocated_account_count >= 0),
  projected_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (projected_account_count >= 0),
  usable_capacity_account_count INTEGER NOT NULL DEFAULT 0
    CHECK (usable_capacity_account_count >= 0),
  capacity_unit_count INTEGER NOT NULL DEFAULT 0
    CHECK (capacity_unit_count >= 0),
  decision_generation INTEGER NOT NULL DEFAULT 0 CHECK (decision_generation >= 0),
  decision_state TEXT NOT NULL DEFAULT 'warming'
    CHECK (decision_state IN ('warming', 'stable', 'provisioning', 'blocked')),
  snapshot_digest TEXT NOT NULL
    CHECK (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  capacity_request_idempotency_key TEXT
    CHECK (capacity_request_idempotency_key IS NULL OR
           length(capacity_request_idempotency_key) BETWEEN 1 AND 128),
  requested_operation_id TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    environment_id, allocation_scope, owner_tenant_key, data_role,
    residency_policy_id, residency_partition
  ),
  FOREIGN KEY (environment_id)
    REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (requested_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (
    (allocation_scope = 'shared_pool' AND owner_tenant_key = '' AND owner_tenant_id IS NULL) OR
    (allocation_scope = 'tenant_exclusive' AND owner_tenant_key = owner_tenant_id AND
     owner_tenant_id IS NOT NULL)
  ),
  CHECK (observed_successful_allocation_count <= successful_allocation_count),
  CHECK (projected_account_count >= observed_allocated_account_count),
  CHECK ((decision_state IN ('warming', 'stable') AND requested_operation_id IS NULL) OR
         decision_state NOT IN ('warming', 'stable'))
);
CREATE TABLE control_provider_identity_projection_assertions (
  assertion_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  desired_resource_id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (desired_resource_id, environment_id)
    REFERENCES control_desired_resources(desired_resource_id, environment_id) ON DELETE CASCADE
);
CREATE TABLE control_operation_transition_assertions (
  assertion_id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE TABLE control_plugin_provider_projection_assertions (
  assertion_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  plugin_resource_id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_resource_id)
    REFERENCES control_plugin_desired_resources(plugin_resource_id) ON DELETE CASCADE
);
CREATE VIEW control_generated_lock_resources AS
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
CREATE VIEW control_desired_worker_binding_export AS
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
  AND s.status NOT IN ('retired', 'deleting', 'deleted')
UNION ALL
SELECT
  i.environment_id,
  i.worker_script_name,
  i.package_name,
  i.capability_manifest_digest,
  l.binding_ref AS binding_name,
  'd1' AS binding_kind,
  r.data_role,
  l.d1_desired_resource_id AS logical_resource_id,
  NULL AS secret_capability,
  NULL AS plugin_dynamic_capability,
  json_object(
    'lookup_shard_id', l.lookup_shard_id,
    'residency_partition', l.residency_partition,
    'status', l.status
  ) AS desired_spec_json
FROM control_desired_worker_inventory i
JOIN control_worker_required_data_roles r
  ON r.environment_id = i.environment_id AND r.worker_script_name = i.worker_script_name
JOIN control_lookup_physical_shards l
  ON l.environment_id = r.environment_id
WHERE i.status = 'active'
  AND r.data_role = 'lookup'
  AND l.status <> 'retired'
  AND NOT EXISTS (
    SELECT 1
      FROM control_worker_desired_bindings b
     WHERE b.environment_id = i.environment_id
       AND b.worker_script_name = i.worker_script_name
       AND b.binding_name = l.binding_ref
  );
CREATE TRIGGER trg_control_operation_status_transition
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
CREATE TRIGGER trg_control_operation_step_status_transition
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
CREATE TRIGGER trg_control_release_catalog_immutable
BEFORE UPDATE OF environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key
ON control_migration_release_catalog
BEGIN
  SELECT RAISE(ABORT, 'control_release_catalog_immutable');
END;
CREATE TRIGGER trg_control_release_catalog_conflicting_insert
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
CREATE TRIGGER trg_control_operation_release_pin_immutable
BEFORE UPDATE ON control_operation_release_pins
BEGIN
  SELECT RAISE(ABORT, 'control_operation_release_pin_immutable');
END;
CREATE TRIGGER trg_control_tenant_database_migration_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, stream_id, release_id, manifest_digest
ON control_tenant_database_migration_state
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_database_migration_pin_immutable');
END;
CREATE TRIGGER trg_control_directory_rewrite_cross_operation_takeover
BEFORE UPDATE OF operation_id ON control_directory_rewrite_leases
WHEN OLD.operation_id <> NEW.operation_id AND
     (OLD.mutation_started = 1 OR OLD.lease_expires_at > unixepoch())
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_takeover_forbidden');
END;
CREATE TRIGGER trg_control_directory_rewrite_fencing
BEFORE UPDATE OF operation_id, owner_id, fencing_token ON control_directory_rewrite_leases
WHEN (OLD.operation_id <> NEW.operation_id OR OLD.owner_id <> NEW.owner_id) AND
     NEW.fencing_token <= OLD.fencing_token
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_stale_fencing_token');
END;
CREATE TRIGGER trg_control_directory_rewrite_mutation_reset
BEFORE UPDATE OF mutation_started ON control_directory_rewrite_leases
WHEN OLD.mutation_started = 1 AND NEW.mutation_started = 0 AND NEW.rollback_verified_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_rollback_verification_required');
END;
CREATE TRIGGER trg_control_d1_resource_limit
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
CREATE TRIGGER trg_control_desired_worker_inventory_source_ownership
BEFORE UPDATE OF source_kind, package_name ON control_desired_worker_inventory
WHEN OLD.source_kind <> NEW.source_kind OR OLD.package_name <> NEW.package_name
BEGIN
  SELECT RAISE(ABORT, 'control_worker_inventory_source_ownership_immutable');
END;
CREATE TRIGGER trg_control_plugin_resource_migration_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, stream_id, release_id, manifest_digest
ON control_plugin_resource_migration_state
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_resource_migration_pin_immutable');
END;
CREATE TRIGGER trg_control_lookup_bucket_migration_transition
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
CREATE TRIGGER trg_control_read_replication_target_transition
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
CREATE TRIGGER trg_control_tenant_placement_policy_identity_immutable
BEFORE UPDATE OF environment_id, tenant_id, source_operation_id, idempotency_key
ON control_tenant_placement_policies
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_identity_immutable');
END;
CREATE TRIGGER trg_control_tenant_placement_policy_no_scope_weakening
BEFORE UPDATE OF isolation_policy ON control_tenant_placement_policies
WHEN OLD.isolation_policy = 'tenant_exclusive' AND NEW.isolation_policy <> 'tenant_exclusive'
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_scope_weakening');
END;
CREATE TRIGGER trg_control_tenant_placement_policy_cutover_guard
BEFORE UPDATE OF isolation_policy ON control_tenant_placement_policies
WHEN OLD.isolation_policy <> NEW.isolation_policy AND NOT (
  OLD.isolation_policy = 'shared_pool'
  AND OLD.pending_isolation_policy = 'tenant_exclusive'
  AND OLD.pending_policy_generation = OLD.policy_generation + 1
  AND OLD.migration_operation_id IS NOT NULL
  AND OLD.policy_state = 'migrating'
  AND NEW.isolation_policy = 'tenant_exclusive'
  AND NEW.policy_generation = OLD.pending_policy_generation
  AND NEW.pending_isolation_policy IS NULL
  AND NEW.pending_policy_generation IS NULL
  AND NEW.migration_operation_id IS NULL
  AND NEW.policy_state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_cutover_invalid');
END;
CREATE TRIGGER trg_control_tenant_shard_owner_policy_insert
BEFORE INSERT ON control_tenant_shards
WHEN NEW.allocation_scope = 'tenant_exclusive' AND NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.owner_tenant_id
     AND (
       policy.isolation_policy = 'tenant_exclusive' OR
       (policy.pending_isolation_policy = 'tenant_exclusive' AND policy.policy_state = 'migrating')
     )
     AND policy.policy_state IN ('provisioning', 'active', 'migrating')
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_owner_policy_invalid');
END;
CREATE TRIGGER trg_control_tenant_shard_owner_immutable
BEFORE UPDATE OF allocation_scope, owner_tenant_id ON control_tenant_shards
WHEN OLD.allocation_scope <> NEW.allocation_scope
  OR OLD.owner_tenant_id IS NOT NEW.owner_tenant_id
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_owner_immutable');
END;
CREATE TRIGGER trg_control_tenant_shard_assignment_scope_insert
BEFORE INSERT ON control_tenant_shard_assignments
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shards shard
      ON shard.shard_id = NEW.shard_id AND shard.environment_id = NEW.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND policy.policy_state IN ('provisioning', 'active', 'migrating')
     AND shard.data_role = NEW.data_role
     AND shard.residency_policy_id = NEW.residency_policy_id
     AND shard.residency_partition = NEW.residency_partition
     AND shard.status IN ('ready', 'active')
     AND (
       (NEW.assignment_state = 'active'
        AND policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool'
        AND shard.owner_tenant_id IS NULL) OR
       (NEW.assignment_state = 'active'
        AND policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id) OR
       (NEW.assignment_state = 'pending'
        AND policy.isolation_policy = 'shared_pool'
        AND policy.pending_isolation_policy = 'tenant_exclusive'
        AND policy.policy_state = 'migrating'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_assignment_scope_mismatch');
END;
CREATE TRIGGER trg_control_tenant_shard_assignment_identity_immutable
BEFORE UPDATE OF environment_id, tenant_id, data_role, residency_policy_id,
                 residency_partition, shard_id, assignment_generation, source_operation_id
ON control_tenant_shard_assignments
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_assignment_immutable');
END;
CREATE TRIGGER trg_control_account_allocation_assignment_insert
BEFORE INSERT ON control_tenant_shard_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = NEW.data_role
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND policy.policy_state IN ('provisioning', 'active', 'migrating')
     AND shard.generation = NEW.route_generation
     AND shard.data_role = NEW.data_role
     AND shard.residency_partition = NEW.residency_partition
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_account_allocation_assignment_mismatch');
END;
CREATE TRIGGER trg_control_account_allocation_assignment_update
BEFORE UPDATE OF tenant_id, data_role, residency_partition, selected_shard_id, route_generation
ON control_tenant_shard_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = NEW.data_role
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND shard.generation = NEW.route_generation
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_account_allocation_assignment_mismatch');
END;
CREATE TRIGGER trg_control_tenant_default_assignment_insert
BEFORE INSERT ON control_tenant_default_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = 'tenant_core/default'
     AND assignment.residency_policy_id = NEW.residency_policy_id
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND shard.generation = NEW.route_generation
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_default_assignment_mismatch');
END;
CREATE TRIGGER trg_control_tenant_default_assignment_update
BEFORE UPDATE OF tenant_id, residency_policy_id, residency_partition,
                 selected_shard_id, route_generation
ON control_tenant_default_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = 'tenant_core/default'
     AND assignment.residency_policy_id = NEW.residency_policy_id
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND shard.generation = NEW.route_generation
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_default_assignment_mismatch');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, source_policy_generation,
                 target_policy_generation, source_isolation_policy, target_isolation_policy,
                 idempotency_key, created_by, created_at
ON control_tenant_placement_migrations
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_identity_immutable');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_transition_guard
BEFORE UPDATE OF migration_state ON control_tenant_placement_migrations
WHEN NOT (
  OLD.migration_state = NEW.migration_state OR
  (OLD.migration_state = 'planning' AND NEW.migration_state IN (
    'targets_provisioning', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'targets_provisioning' AND NEW.migration_state IN (
    'inventory_verifying', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'inventory_verifying' AND NEW.migration_state IN (
    'capture_installing', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'capture_installing' AND NEW.migration_state IN (
    'backfilling', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'backfilling' AND NEW.migration_state IN (
    'catching_up', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'catching_up' AND NEW.migration_state IN (
    'verifying', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'verifying' AND NEW.migration_state IN (
    'write_fencing', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'write_fencing' AND NEW.migration_state IN (
    'cutover_ready', 'verifying', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'cutover_ready' AND NEW.migration_state IN (
    'cutover_committed', 'write_fencing', 'blocked'
  )) OR
  (OLD.migration_state = 'cutover_committed' AND NEW.migration_state IN (
    'source_quarantined', 'blocked'
  )) OR
  (OLD.migration_state = 'source_quarantined' AND NEW.migration_state IN (
    'purge_pending', 'complete', 'blocked'
  )) OR
  (OLD.migration_state = 'purge_pending' AND NEW.migration_state IN ('complete', 'blocked')) OR
  (OLD.migration_state = 'blocked' AND NEW.migration_state IN (
    'targets_provisioning', 'inventory_verifying', 'capture_installing', 'backfilling',
    'catching_up', 'verifying', 'write_fencing', 'cutover_ready', 'cutover_committed',
    'source_quarantined', 'purge_pending', 'complete', 'canceled'
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_transition_invalid');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_insert_guard
BEFORE INSERT ON control_tenant_placement_migrations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND policy.isolation_policy = 'shared_pool'
     AND policy.policy_generation = NEW.source_policy_generation
     AND policy.policy_state = 'active'
     AND policy.pending_isolation_policy IS NULL
     AND policy.migration_operation_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_source_invalid');
END;
CREATE TRIGGER trg_control_tenant_placement_policy_migration_start_guard
BEFORE UPDATE OF pending_isolation_policy, pending_policy_generation,
                 migration_operation_id, policy_state
ON control_tenant_placement_policies
WHEN OLD.pending_isolation_policy IS NULL AND NEW.pending_isolation_policy = 'tenant_exclusive'
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_migrations migration
     WHERE migration.operation_id = NEW.migration_operation_id
       AND migration.environment_id = NEW.environment_id
       AND migration.tenant_id = NEW.tenant_id
       AND migration.source_policy_generation = OLD.policy_generation
       AND migration.target_policy_generation = NEW.pending_policy_generation
       AND migration.migration_state IN ('planning', 'targets_provisioning')
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_start_invalid');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_shard_insert_guard
BEFORE INSERT ON control_tenant_placement_migration_shards
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_migrations migration
    JOIN control_tenant_shard_assignments source_assignment
      ON source_assignment.environment_id = migration.environment_id
     AND source_assignment.tenant_id = migration.tenant_id
     AND source_assignment.data_role = NEW.data_role
     AND source_assignment.residency_policy_id = NEW.residency_policy_id
     AND source_assignment.residency_partition = NEW.residency_partition
     AND source_assignment.shard_id = NEW.source_shard_id
     AND source_assignment.assignment_generation = NEW.source_assignment_generation
     AND source_assignment.assignment_state = 'active'
    JOIN control_tenant_shards source
      ON source.environment_id = migration.environment_id
     AND source.shard_id = source_assignment.shard_id
     AND source.allocation_scope = 'shared_pool'
     AND source.owner_tenant_id IS NULL
   WHERE migration.operation_id = NEW.operation_id
     AND migration.environment_id = NEW.environment_id
     AND migration.tenant_id = NEW.tenant_id
     AND migration.migration_state NOT IN ('cutover_committed', 'source_quarantined',
                                            'purge_pending', 'complete', 'canceled')
     AND (
       (NEW.target_shard_id IS NULL AND NEW.target_assignment_generation IS NULL
        AND NEW.shard_state = 'target_pending') OR
       EXISTS (
         SELECT 1
           FROM control_tenant_shard_assignments target_assignment
           JOIN control_tenant_shards target
             ON target.environment_id = target_assignment.environment_id
            AND target.shard_id = target_assignment.shard_id
          WHERE target_assignment.environment_id = migration.environment_id
            AND target_assignment.tenant_id = migration.tenant_id
            AND target_assignment.data_role = NEW.data_role
            AND target_assignment.residency_policy_id = NEW.residency_policy_id
            AND target_assignment.residency_partition = NEW.residency_partition
            AND target_assignment.shard_id = NEW.target_shard_id
            AND target_assignment.assignment_generation = NEW.target_assignment_generation
            AND target_assignment.assignment_state = 'pending'
            AND target.allocation_scope = 'tenant_exclusive'
            AND target.owner_tenant_id = migration.tenant_id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_shard_invalid');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_shard_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, data_role, residency_policy_id,
                 residency_partition, source_shard_id, source_assignment_generation, created_at
ON control_tenant_placement_migration_shards
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_shard_identity_immutable');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_target_update_guard
BEFORE UPDATE OF target_shard_id, target_assignment_generation, shard_state
ON control_tenant_placement_migration_shards
WHEN OLD.target_shard_id IS NULL AND NEW.target_shard_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_migrations migration
      JOIN control_tenant_shard_assignments target_assignment
        ON target_assignment.environment_id = migration.environment_id
       AND target_assignment.tenant_id = migration.tenant_id
       AND target_assignment.data_role = NEW.data_role
       AND target_assignment.residency_policy_id = NEW.residency_policy_id
       AND target_assignment.residency_partition = NEW.residency_partition
       AND target_assignment.shard_id = NEW.target_shard_id
       AND target_assignment.assignment_generation = NEW.target_assignment_generation
       AND target_assignment.assignment_state = 'pending'
      JOIN control_tenant_shards target
        ON target.environment_id = target_assignment.environment_id
       AND target.shard_id = target_assignment.shard_id
       AND target.allocation_scope = 'tenant_exclusive'
       AND target.owner_tenant_id = migration.tenant_id
     WHERE migration.operation_id = NEW.operation_id
       AND migration.environment_id = NEW.environment_id
       AND migration.tenant_id = NEW.tenant_id
       AND NEW.shard_state = 'inventory_pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_target_invalid');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_target_immutable
BEFORE UPDATE OF target_shard_id, target_assignment_generation
ON control_tenant_placement_migration_shards
WHEN OLD.target_shard_id IS NOT NULL
  AND (OLD.target_shard_id IS NOT NEW.target_shard_id OR
       OLD.target_assignment_generation IS NOT NEW.target_assignment_generation)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_target_immutable');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_inventory_immutable
BEFORE UPDATE ON control_tenant_placement_migration_inventory
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_inventory_immutable');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_inventory_no_delete
BEFORE DELETE ON control_tenant_placement_migration_inventory
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_inventory_immutable');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_shard_inventory_guard
BEFORE UPDATE OF shard_state ON control_tenant_placement_migration_shards
WHEN NEW.shard_state IN (
  'capture_pending', 'backfilling', 'catching_up', 'verifying', 'verified',
  'write_fenced', 'cutover_committed', 'quarantined', 'purged'
) AND (
  NEW.inventory_verified_at IS NULL OR NEW.inventory_table_count IS NULL OR
  (SELECT COUNT(*)
     FROM control_tenant_placement_migration_inventory inventory
    WHERE inventory.operation_id = NEW.operation_id
      AND inventory.source_shard_id = NEW.source_shard_id
      AND inventory.inventory_state = 'verified') <> NEW.inventory_table_count OR
  EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_inventory inventory
     WHERE inventory.operation_id = NEW.operation_id
       AND inventory.source_shard_id = NEW.source_shard_id
       AND inventory.inventory_state = 'blocked'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_inventory_incomplete');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_cutover_ready_guard
BEFORE UPDATE OF migration_state ON control_tenant_placement_migrations
WHEN NEW.migration_state = 'cutover_ready' AND (
  NEW.inventory_verified_at IS NULL OR NEW.inventory_digest IS NULL OR
  NEW.write_fence_state <> 'active' OR NEW.write_fence_started_at IS NULL OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
  ) OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.data_role = 'tenant_core/default'
  ) OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.data_role = 'tenant_core/users'
  ) OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.data_role = 'tenant_pii'
  ) OR
  EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND (
         shard.shard_state <> 'write_fenced' OR
         shard.last_applied_source_sequence <> shard.last_observed_source_sequence
       )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_cutover_not_ready');
END;
CREATE TRIGGER trg_control_tenant_placement_policy_migration_cutover_guard
BEFORE UPDATE OF isolation_policy ON control_tenant_placement_policies
WHEN OLD.isolation_policy = 'shared_pool' AND NEW.isolation_policy = 'tenant_exclusive'
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_migrations migration
     WHERE migration.operation_id = OLD.migration_operation_id
       AND migration.environment_id = OLD.environment_id
       AND migration.tenant_id = OLD.tenant_id
       AND migration.source_policy_generation = OLD.policy_generation
       AND migration.target_policy_generation = NEW.policy_generation
       AND migration.migration_state = 'cutover_ready'
       AND migration.write_fence_state = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_migration_not_ready');
END;
CREATE TRIGGER trg_control_tenant_placement_migration_cutover_commit_guard
BEFORE UPDATE OF migration_state ON control_tenant_placement_migrations
WHEN NEW.migration_state = 'cutover_committed' AND (
  NEW.write_fence_state <> 'active' OR NEW.cutover_committed_at IS NULL OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_policies policy
     WHERE policy.environment_id = NEW.environment_id
       AND policy.tenant_id = NEW.tenant_id
       AND policy.isolation_policy = 'tenant_exclusive'
       AND policy.policy_generation = NEW.target_policy_generation
       AND policy.policy_state = 'active'
       AND policy.pending_isolation_policy IS NULL
       AND policy.migration_operation_id IS NULL
  ) OR
  EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.shard_state <> 'cutover_committed'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_cutover_commit_invalid');
END;
CREATE TRIGGER trg_control_directory_rewrite_delete
BEFORE DELETE ON control_directory_rewrite_leases
WHEN OLD.mutation_started = 1
 AND NOT EXISTS (
   SELECT 1 FROM control_operations operation
    WHERE operation.operation_id = OLD.operation_id AND operation.status = 'succeeded'
 )
 AND NOT (
   OLD.operation_kind = 'tenant_placement_migration'
   AND EXISTS (
     SELECT 1 FROM control_tenant_placement_migrations migration
      WHERE migration.environment_id = OLD.environment_id
        AND migration.operation_id = OLD.operation_id
        AND migration.migration_state IN ('source_quarantined', 'purge_pending', 'complete')
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_delete_forbidden_after_mutation');
END;
CREATE TRIGGER trg_control_tenant_shard_assignment_activation_guard
BEFORE UPDATE OF assignment_state ON control_tenant_shard_assignments
WHEN OLD.assignment_state = 'pending' AND NEW.assignment_state = 'active'
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_policies policy
      JOIN control_tenant_shards shard
        ON shard.environment_id = NEW.environment_id
       AND shard.shard_id = NEW.shard_id
     WHERE policy.environment_id = NEW.environment_id
       AND policy.tenant_id = NEW.tenant_id
       AND policy.policy_state = 'active'
       AND policy.isolation_policy = 'tenant_exclusive'
       AND shard.allocation_scope = 'tenant_exclusive'
       AND shard.owner_tenant_id = NEW.tenant_id
       AND shard.data_role = NEW.data_role
       AND shard.residency_policy_id = NEW.residency_policy_id
       AND shard.residency_partition = NEW.residency_partition
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_assignment_activation_invalid');
END;
CREATE TRIGGER trg_control_shard_quarantine_state_transition
BEFORE UPDATE OF state ON control_shard_quarantine_operations
WHEN OLD.state <> NEW.state AND NOT (
  (OLD.state = 'draining' AND NEW.state IN ('ready_for_cleanup', 'blocked', 'canceled')) OR
  (OLD.state = 'blocked' AND NEW.state = 'draining')
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_transition_invalid');
END;
CREATE TRIGGER trg_control_shard_quarantine_ready_evidence_guard
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
CREATE TRIGGER trg_control_shard_cleanup_state_transition
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
CREATE TRIGGER trg_control_shard_quarantine_blocks_assignment_insert
BEFORE INSERT ON control_tenant_shard_assignments
WHEN NEW.assignment_state IN ('pending', 'active') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;
CREATE TRIGGER trg_control_shard_quarantine_blocks_assignment_update
BEFORE UPDATE OF shard_id, assignment_state ON control_tenant_shard_assignments
WHEN NEW.assignment_state IN ('pending', 'active') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;
CREATE TRIGGER trg_control_shard_quarantine_blocks_account_allocation_insert
BEFORE INSERT ON control_tenant_shard_allocations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;
CREATE TRIGGER trg_control_shard_quarantine_blocks_account_allocation_update
BEFORE UPDATE OF selected_shard_id, reservation_state ON control_tenant_shard_allocations
WHEN NEW.reservation_state IN ('reserved', 'committed') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;
CREATE TRIGGER trg_control_shard_quarantine_blocks_default_allocation_insert
BEFORE INSERT ON control_tenant_default_allocations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;
CREATE TRIGGER trg_control_shard_quarantine_blocks_default_allocation_update
BEFORE UPDATE OF selected_shard_id, reservation_state ON control_tenant_default_allocations
WHEN NEW.reservation_state IN ('reserved', 'committed') AND EXISTS (
  SELECT 1 FROM control_tenant_shards shard
   WHERE shard.shard_id = NEW.selected_shard_id AND shard.environment_id = NEW.environment_id
     AND shard.quarantine_state <> 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_allocation_forbidden');
END;
CREATE TRIGGER trg_control_shard_quarantine_blocks_runtime_route_insert
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
CREATE TRIGGER trg_control_shard_quarantine_blocks_runtime_route_update
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
CREATE TRIGGER trg_control_shard_quarantine_identity_guard
BEFORE UPDATE OF quarantine_operation_id, quarantine_started_at ON control_tenant_shards
WHEN OLD.quarantine_operation_id IS NOT NULL AND (
  OLD.quarantine_operation_id IS NOT NEW.quarantine_operation_id OR
  OLD.quarantine_started_at IS NOT NEW.quarantine_started_at
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_identity_immutable');
END;
CREATE TRIGGER trg_control_bootstrap_worker_evidence_expectations_immutable
BEFORE UPDATE OF expected_deployment_id, expected_version_id, expected_settings_digest
ON control_bootstrap_worker_evidence
WHEN (
  OLD.expected_deployment_id <> NEW.expected_deployment_id OR
  OLD.expected_version_id <> NEW.expected_version_id OR
  OLD.expected_settings_digest <> NEW.expected_settings_digest
) AND NOT EXISTS (
  SELECT 1
    FROM control_bootstrap_handoffs handoff
   WHERE handoff.environment_id = OLD.environment_id
     AND (
       handoff.state IN ('creating', 'pending_verification') OR
       (handoff.state = 'blocked'
        AND handoff.verification_error_code GLOB 'control_bootstrap_worker_*')
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_bootstrap_worker_evidence_immutable');
END;
CREATE TRIGGER trg_control_shard_quarantine_insert_guard
BEFORE INSERT ON control_shard_quarantine_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_shards shard
    JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
   WHERE shard.shard_id = NEW.shard_id
     AND shard.environment_id = NEW.environment_id
     AND shard.status IN ('failed', 'retired')
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
CREATE TRIGGER trg_control_shard_cleanup_insert_guard
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
     AND shard.status IN ('failed', 'retired')
     AND shard.quarantine_state = 'quarantined'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_cleanup_quarantine_required');
END;
CREATE TRIGGER trg_control_plugin_resource_cleanup_generation_match
BEFORE INSERT ON control_plugin_resource_cleanup_items
WHEN NOT EXISTS (
  SELECT 1
    FROM control_plugin_resource_cleanup_operations cleanup
    JOIN control_plugin_desired_resources resource
      ON resource.plugin_resource_id = NEW.plugin_resource_id
     AND resource.environment_id = cleanup.environment_id
     AND resource.plugin_installation_id = cleanup.plugin_installation_id
     AND resource.tenant_id = cleanup.tenant_id
     AND resource.lifecycle_generation = cleanup.lifecycle_generation
   WHERE cleanup.operation_id = NEW.operation_id
     AND resource.provider_resource_id = NEW.provider_resource_id
     AND resource.provider_name = NEW.provider_name
     AND resource.resource_kind = NEW.resource_kind
     AND resource.lifecycle_mode = NEW.lifecycle_mode
)
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_cleanup_resource_mismatch');
END;
CREATE TRIGGER trg_control_plugin_resource_cleanup_no_active_duplicate
BEFORE INSERT ON control_plugin_resource_cleanup_operations
WHEN EXISTS (
  SELECT 1 FROM control_plugin_resource_cleanup_operations cleanup
   WHERE cleanup.environment_id = NEW.environment_id
     AND cleanup.plugin_installation_id = NEW.plugin_installation_id
     AND cleanup.state <> 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_cleanup_already_active');
END;
CREATE TRIGGER trg_control_tenant_dr_topology_guard
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
CREATE TRIGGER trg_control_tenant_dr_blocks_bucket_migration
BEFORE INSERT ON control_lookup_bucket_migrations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_lookup_topology_locked');
END;
CREATE TRIGGER trg_control_tenant_dr_blocks_hmac_rotation
BEFORE INSERT ON control_hmac_rotation_operations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_lookup_topology_locked');
END;
CREATE TRIGGER trg_control_tenant_dr_blocks_route_projection_migration
BEFORE INSERT ON control_route_projection_migrations
WHEN EXISTS (
  SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
   WHERE recovery.environment_id = NEW.environment_id
     AND recovery.active_operation_key = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_lookup_topology_locked');
END;
CREATE TRIGGER trg_control_tenant_dr_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, pinned_route_generation,
                 idempotency_key, requested_by_id, created_at
ON control_tenant_disaster_recovery_operations
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_identity_immutable');
END;
CREATE TRIGGER trg_control_tenant_dr_reprojection_stage_transition
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
CREATE TRIGGER trg_control_tenant_dr_target_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, shard_id, data_role,
                 residency_partition, assignment_generation, shard_generation, binding_ref,
                 provider_database_id, migration_stream_id, release_id, manifest_digest, created_at
ON control_tenant_disaster_recovery_targets
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_target_identity_immutable');
END;
CREATE TRIGGER trg_control_tenant_dr_state_transition
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
CREATE TRIGGER trg_control_tenant_dr_cancel_guard
BEFORE UPDATE OF recovery_state ON control_tenant_disaster_recovery_operations
WHEN NEW.recovery_state = 'canceled'
  AND (OLD.recovery_state <> 'publishing_deny' OR OLD.deny_observed_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_cancel_after_deny_forbidden');
END;
CREATE TRIGGER trg_control_tenant_dr_target_insert_guard
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
CREATE TRIGGER trg_control_tenant_dr_allocation_guard
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
CREATE TRIGGER trg_control_tenant_dr_default_allocation_guard
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
CREATE TRIGGER trg_control_tenant_dr_command_idempotency_write_once
BEFORE UPDATE OF restore_idempotency_key, restore_confirmed_by,
  reactivation_idempotency_key, reactivation_requested_by,
  cancel_idempotency_key, cancel_requested_by
ON control_tenant_disaster_recovery_operations
WHEN (OLD.restore_idempotency_key IS NOT NULL AND
      NEW.restore_idempotency_key IS NOT OLD.restore_idempotency_key) OR
     (OLD.restore_confirmed_by IS NOT NULL AND
      NEW.restore_confirmed_by IS NOT OLD.restore_confirmed_by) OR
     (OLD.reactivation_idempotency_key IS NOT NULL AND
      NEW.reactivation_idempotency_key IS NOT OLD.reactivation_idempotency_key) OR
     (OLD.reactivation_requested_by IS NOT NULL AND
      NEW.reactivation_requested_by IS NOT OLD.reactivation_requested_by) OR
     (OLD.cancel_idempotency_key IS NOT NULL AND
      NEW.cancel_idempotency_key IS NOT OLD.cancel_idempotency_key) OR
     (OLD.cancel_requested_by IS NOT NULL AND
      NEW.cancel_requested_by IS NOT OLD.cancel_requested_by)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_command_idempotency_immutable');
END;
CREATE TRIGGER trg_control_release_migration_rollout_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, source_version, target_version, release_id,
  manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
  admin_mutation_mode, created_at
ON control_release_migration_rollouts
BEGIN
  SELECT RAISE(ABORT, 'control_release_migration_rollout_immutable');
END;
CREATE TRIGGER trg_control_release_migration_target_pin_immutable
BEFORE UPDATE OF operation_id, environment_id, target_id, target_kind, shard_id,
  desired_resource_id, binding_ref, stream_id, release_id,
  manifest_digest, created_at
ON control_release_migration_targets
BEGIN
  SELECT RAISE(ABORT, 'control_release_migration_target_immutable');
END;
CREATE TRIGGER trg_control_release_migration_target_provider_immutable
BEFORE UPDATE OF provider_database_id ON control_release_migration_targets
WHEN OLD.provider_database_id IS NOT NULL AND NEW.provider_database_id IS NOT OLD.provider_database_id
BEGIN
  SELECT RAISE(ABORT, 'control_release_migration_target_provider_immutable');
END;
CREATE TRIGGER trg_control_lookup_retention_policy_projection_monotonic
BEFORE UPDATE ON control_lookup_retention_policy_projections
WHEN NEW.policy_generation <= OLD.policy_generation OR
     NEW.source_updated_at < OLD.source_updated_at
BEGIN
  SELECT RAISE(ABORT, 'control_lookup_retention_policy_projection_stale');
END;
CREATE TRIGGER trg_control_account_legal_hold_projection_monotonic
BEFORE UPDATE ON control_account_legal_hold_projections
WHEN NEW.projection_generation <= OLD.projection_generation OR
     NEW.source_updated_at < OLD.source_updated_at
BEGIN
  SELECT RAISE(ABORT, 'control_account_legal_hold_projection_stale');
END;
CREATE TRIGGER trg_control_lookup_rebalance_one_active_insert
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
CREATE TRIGGER trg_control_lookup_rebalance_one_active_update
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
CREATE TRIGGER trg_control_account_capacity_assigns_ready_spare
AFTER UPDATE OF allocated_account_count ON control_shard_capacity
WHEN NEW.allocated_account_count > OLD.allocated_account_count
 AND NEW.shard_id IN (
   SELECT shard.shard_id
     FROM control_tenant_shards shard
    WHERE shard.data_role IN ('tenant_core/users', 'tenant_pii')
 )
 AND (NEW.target_account_count - NEW.allocated_account_count) * 5 < NEW.target_account_count
BEGIN
  INSERT OR IGNORE INTO control_tenant_shard_assignments (
    environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
    shard_id, assignment_generation, assignment_state, source_operation_id,
    created_at, activated_at, updated_at
  )
  SELECT source.environment_id, source.tenant_id, source.data_role,
         source.residency_policy_id, source.residency_partition, spare.shard_id,
         COALESCE((
           SELECT MAX(existing.assignment_generation) + 1
             FROM control_tenant_shard_assignments existing
            WHERE existing.environment_id = source.environment_id
              AND existing.tenant_id = source.tenant_id
              AND existing.data_role = source.data_role
              AND existing.residency_partition = source.residency_partition
         ), 1),
         'active', desired.origin_operation_id,
         NEW.updated_at, NEW.updated_at, NEW.updated_at
    FROM control_tenant_shard_assignments source
    JOIN control_tenant_shard_allocations pending_allocation
      ON pending_allocation.environment_id = source.environment_id
     AND pending_allocation.tenant_id = source.tenant_id
     AND pending_allocation.data_role = source.data_role
     AND pending_allocation.residency_partition = source.residency_partition
     AND pending_allocation.selected_shard_id = source.shard_id
     AND pending_allocation.reservation_state IN ('reserved', 'committed')
     AND pending_allocation.capacity_counted_at IS NULL
    JOIN control_tenant_placement_policies placement
      ON placement.environment_id = source.environment_id
     AND placement.tenant_id = source.tenant_id
     AND placement.policy_state IN ('provisioning', 'active', 'migrating')
    JOIN control_tenant_shards current_shard
      ON current_shard.environment_id = source.environment_id
     AND current_shard.shard_id = source.shard_id
     AND current_shard.status = 'active'
    JOIN control_tenant_shards spare
      ON spare.environment_id = source.environment_id
     AND spare.data_role = source.data_role
     AND spare.residency_policy_id = source.residency_policy_id
     AND spare.residency_partition = source.residency_partition
     AND spare.status = 'active'
     AND spare.quarantine_state = 'none'
     AND spare.shard_id <> source.shard_id
    JOIN control_shard_capacity spare_capacity
      ON spare_capacity.shard_id = spare.shard_id
     AND spare_capacity.health_status = 'healthy'
     AND spare_capacity.allocation_status = 'eligible'
     AND spare_capacity.allocated_account_count < spare_capacity.target_account_count
    JOIN control_desired_resources desired
      ON desired.environment_id = spare.environment_id
     AND desired.desired_resource_id = spare.d1_desired_resource_id
     AND desired.desired_state = 'present'
     AND desired.provisioning_state = 'ready'
   WHERE source.shard_id = NEW.shard_id
     AND source.assignment_state = 'active'
     AND current_shard.data_role = source.data_role
     AND current_shard.residency_policy_id = source.residency_policy_id
     AND current_shard.residency_partition = source.residency_partition
     AND (
       (placement.isolation_policy = 'shared_pool'
        AND current_shard.allocation_scope = 'shared_pool'
        AND current_shard.owner_tenant_id IS NULL
        AND spare.allocation_scope = 'shared_pool'
        AND spare.owner_tenant_id IS NULL) OR
       (placement.isolation_policy = 'tenant_exclusive'
        AND current_shard.allocation_scope = 'tenant_exclusive'
        AND current_shard.owner_tenant_id = source.tenant_id
        AND spare.allocation_scope = 'tenant_exclusive'
        AND spare.owner_tenant_id = source.tenant_id)
     )
     AND NOT EXISTS (
       SELECT 1
         FROM control_tenant_shard_assignments existing_spare
        WHERE existing_spare.environment_id = source.environment_id
          AND existing_spare.tenant_id = source.tenant_id
          AND existing_spare.data_role = source.data_role
          AND existing_spare.residency_partition = source.residency_partition
          AND existing_spare.shard_id = spare.shard_id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM control_tenant_shard_assignments assigned
         JOIN control_tenant_shards assigned_shard
           ON assigned_shard.environment_id = assigned.environment_id
          AND assigned_shard.shard_id = assigned.shard_id
         JOIN control_shard_capacity assigned_capacity
           ON assigned_capacity.shard_id = assigned.shard_id
        WHERE assigned.environment_id = source.environment_id
          AND assigned.tenant_id = source.tenant_id
          AND assigned.data_role = source.data_role
          AND assigned.residency_policy_id = source.residency_policy_id
          AND assigned.residency_partition = source.residency_partition
          AND assigned.assignment_state = 'active'
          AND assigned.shard_id <> source.shard_id
          AND assigned_shard.status = 'active'
          AND assigned_shard.quarantine_state = 'none'
          AND assigned_capacity.health_status = 'healthy'
          AND assigned_capacity.allocation_status = 'eligible'
          AND (assigned_capacity.target_account_count -
               assigned_capacity.allocated_account_count) * 5 >=
              assigned_capacity.target_account_count
     )
     AND spare.shard_id = (
       SELECT candidate.shard_id
         FROM control_tenant_shards candidate
         JOIN control_shard_capacity candidate_capacity
           ON candidate_capacity.shard_id = candidate.shard_id
         JOIN control_desired_resources candidate_desired
           ON candidate_desired.environment_id = candidate.environment_id
          AND candidate_desired.desired_resource_id = candidate.d1_desired_resource_id
        WHERE candidate.environment_id = source.environment_id
          AND candidate.data_role = source.data_role
          AND candidate.residency_policy_id = source.residency_policy_id
          AND candidate.residency_partition = source.residency_partition
          AND candidate.status = 'active'
          AND candidate.quarantine_state = 'none'
          AND candidate_capacity.health_status = 'healthy'
          AND candidate_capacity.allocation_status = 'eligible'
          AND candidate_capacity.allocated_account_count < candidate_capacity.target_account_count
          AND candidate_desired.desired_state = 'present'
          AND candidate_desired.provisioning_state = 'ready'
          AND (
            (placement.isolation_policy = 'shared_pool'
             AND candidate.allocation_scope = 'shared_pool'
             AND candidate.owner_tenant_id IS NULL) OR
            (placement.isolation_policy = 'tenant_exclusive'
             AND candidate.allocation_scope = 'tenant_exclusive'
             AND candidate.owner_tenant_id = source.tenant_id)
          )
          AND NOT EXISTS (
            SELECT 1
              FROM control_tenant_shard_assignments existing_candidate
             WHERE existing_candidate.environment_id = source.environment_id
               AND existing_candidate.tenant_id = source.tenant_id
               AND existing_candidate.data_role = source.data_role
               AND existing_candidate.residency_partition = source.residency_partition
               AND existing_candidate.shard_id = candidate.shard_id
          )
        ORDER BY (1.0 * candidate_capacity.allocated_account_count /
                  candidate_capacity.target_account_count),
                 candidate_capacity.allocated_account_count,
                 candidate.shard_id
        LIMIT 1
     );
END;
CREATE TRIGGER trg_control_environment_provisioning_authority_insert
BEFORE INSERT ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled'
    AND NEW.provisioning_token_management = 'none'
    AND NEW.provisioning_bootstrap_phase = 'none'
    AND NEW.provisioning_bootstrap_token_ownership = 'none'
    AND NEW.provisioning_bootstrap_token_id IS NULL
    AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
    AND NEW.provisioning_child_tokens_json IS NULL
    AND NEW.provisioning_secret_generation_deployment_id IS NULL
    AND NEW.provisioning_secret_generation_version_id IS NULL)
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
      OR
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'setup'
        AND NEW.provisioning_bootstrap_phase IN ('pending_revocation', 'cutover_verified')
        AND NEW.provisioning_bootstrap_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_token_id IS NOT NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NOT NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'ready'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management IN ('setup', 'operator')
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'blocked'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;
CREATE TRIGGER trg_control_environment_provisioning_authority_update
BEFORE UPDATE OF automatic_provisioning_enabled, provisioning_token_ownership,
  provisioning_capability_state, provisioning_token_management, provisioning_bootstrap_phase,
  provisioning_bootstrap_token_ownership, provisioning_bootstrap_token_id,
  provisioning_bootstrap_token_fingerprint, provisioning_child_tokens_json,
  provisioning_secret_generation_deployment_id, provisioning_secret_generation_version_id
ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled'
    AND NEW.provisioning_token_management = 'none'
    AND NEW.provisioning_bootstrap_phase = 'none'
    AND NEW.provisioning_bootstrap_token_ownership = 'none'
    AND NEW.provisioning_bootstrap_token_id IS NULL
    AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
    AND NEW.provisioning_child_tokens_json IS NULL
    AND NEW.provisioning_secret_generation_deployment_id IS NULL
    AND NEW.provisioning_secret_generation_version_id IS NULL)
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
      OR
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'setup'
        AND NEW.provisioning_bootstrap_phase IN ('pending_revocation', 'cutover_verified')
        AND NEW.provisioning_bootstrap_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_token_id IS NOT NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NOT NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'ready'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management IN ('setup', 'operator')
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'blocked'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;
CREATE TRIGGER trg_control_provider_identity_projection_assertion
BEFORE INSERT ON control_provider_identity_projection_assertions
WHEN NEW.valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'control_d1_provider_identity_projection_mismatch');
END;
CREATE TRIGGER trg_control_operation_transition_assertion
BEFORE INSERT ON control_operation_transition_assertions
WHEN NEW.valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'control_operation_transition_mismatch');
END;
CREATE TRIGGER trg_control_desired_resources_provider_identity_insert
BEFORE INSERT ON control_desired_resources
WHEN (NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.resource_kind = 'd1' AND NEW.provisioning_state IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.provider_create_state = 'not_started' AND NEW.observed_resource_id IS NOT NULL AND
        EXISTS (
          SELECT 1 FROM control_observed_resources observed
           WHERE observed.observed_resource_id = NEW.observed_resource_id
             AND observed.desired_resource_id = NEW.desired_resource_id
             AND observed.environment_id = NEW.environment_id
             AND observed.provider_resource_id IS NOT NULL
        )
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_desired_resource_provider_identity_invalid');
END;
CREATE TRIGGER trg_control_desired_resources_provider_identity_update
BEFORE UPDATE OF provider_create_state, provider_resource_id,
  provider_identity_checkpointed_at, provisioning_state ON control_desired_resources
WHEN (NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (OLD.provider_create_state = 'identified' AND
      (NEW.provider_create_state <> 'identified' OR
       NEW.provider_resource_id <> OLD.provider_resource_id OR
       NEW.provider_identity_checkpointed_at <> OLD.provider_identity_checkpointed_at))
  OR (OLD.provider_create_state <> 'issued' AND OLD.provider_create_state <> 'identified' AND
      NEW.provider_create_state = 'identified' AND NOT EXISTS (
        SELECT 1 FROM control_observed_resources observed
         WHERE observed.observed_resource_id = NEW.observed_resource_id
           AND observed.desired_resource_id = NEW.desired_resource_id
           AND observed.environment_id = NEW.environment_id
           AND observed.provider_resource_id = NEW.provider_resource_id
      ))
  OR (OLD.provider_create_state <> 'not_started' AND NEW.provider_create_state = 'issued')
  OR (NEW.resource_kind = 'd1' AND NEW.provisioning_state IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.provider_create_state = 'not_started' AND NEW.observed_resource_id IS NOT NULL AND
        EXISTS (
          SELECT 1 FROM control_observed_resources observed
           WHERE observed.observed_resource_id = NEW.observed_resource_id
             AND observed.desired_resource_id = NEW.desired_resource_id
             AND observed.environment_id = NEW.environment_id
             AND observed.provider_resource_id IS NOT NULL
        )
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_desired_resource_provider_identity_invalid');
END;
CREATE TRIGGER trg_control_desired_resources_provider_identity_from_observed
AFTER UPDATE OF observed_resource_id ON control_desired_resources
WHEN NEW.provider_create_state = 'not_started' AND NEW.observed_resource_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM control_observed_resources observed
     WHERE observed.observed_resource_id = NEW.observed_resource_id
       AND observed.desired_resource_id = NEW.desired_resource_id
       AND observed.environment_id = NEW.environment_id
       AND observed.provider_resource_id IS NOT NULL
  )
BEGIN
  UPDATE control_desired_resources
     SET provider_create_state = 'identified',
         provider_resource_id = (
           SELECT observed.provider_resource_id
             FROM control_observed_resources observed
            WHERE observed.observed_resource_id = NEW.observed_resource_id
              AND observed.desired_resource_id = NEW.desired_resource_id
              AND observed.environment_id = NEW.environment_id
         ),
         provider_identity_checkpointed_at = NEW.updated_at
   WHERE desired_resource_id = NEW.desired_resource_id
     AND environment_id = NEW.environment_id
     AND provider_create_state = 'not_started';
END;
CREATE TRIGGER trg_control_plugin_provider_projection_assertion
BEFORE INSERT ON control_plugin_provider_projection_assertions
WHEN NEW.valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'plugin_resource_provider_projection_mismatch');
END;
CREATE TRIGGER trg_control_plugin_resources_provider_identity_insert
BEFORE INSERT ON control_plugin_desired_resources
WHEN (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_name IS NOT NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'issued' AND
      ((NEW.provider_ownership_marker_key IS NULL) <> (NEW.provider_ownership_id IS NULL)))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'identified' AND
      (NEW.provider_creation_date IS NULL OR NEW.provider_ownership_marker_key IS NULL OR
       NEW.provider_ownership_id IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind <> 'r2_bucket' AND
      (NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'legacy_unverified' AND
      (NEW.resource_kind <> 'r2_bucket' OR NEW.status <> 'failed' OR
       NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.status IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.resource_kind IN ('d1', 'kv_namespace') AND
        NEW.provider_create_state = 'not_started' AND
        NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_resource_provider_identity_invalid');
END;
CREATE TRIGGER trg_control_plugin_resources_provider_identity_update
BEFORE UPDATE OF provider_create_state, provider_resource_id, provider_name,
  provider_creation_date, provider_ownership_marker_key, provider_ownership_id,
  provider_identity_checkpointed_at, status ON control_plugin_desired_resources
WHEN (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'identified' AND
      (NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_identity_checkpointed_at IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'issued' AND
      (NEW.provider_resource_id IS NOT NULL OR NEW.provider_name IS NOT NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'issued' AND
      ((NEW.provider_ownership_marker_key IS NULL) <> (NEW.provider_ownership_id IS NULL)))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind = 'r2_bucket' AND
      NEW.provider_create_state = 'identified' AND
      (NEW.provider_creation_date IS NULL OR NEW.provider_ownership_marker_key IS NULL OR
       NEW.provider_ownership_id IS NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.resource_kind <> 'r2_bucket' AND
      (NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.provider_create_state = 'legacy_unverified' AND
      (NEW.resource_kind <> 'r2_bucket' OR NEW.status <> 'failed' OR
       NEW.provider_resource_id IS NULL OR NEW.provider_name IS NULL OR
       NEW.provider_creation_date IS NOT NULL OR NEW.provider_ownership_marker_key IS NOT NULL OR
       NEW.provider_ownership_id IS NOT NULL OR NEW.provider_identity_checkpointed_at IS NOT NULL))
  OR (OLD.lifecycle_mode = 'managed' AND OLD.provider_create_state = 'identified' AND
      (NEW.provider_create_state <> 'identified' OR
       NEW.provider_resource_id <> OLD.provider_resource_id OR
       NEW.provider_name <> OLD.provider_name OR
       COALESCE(NEW.provider_creation_date, '') <> COALESCE(OLD.provider_creation_date, '') OR
       COALESCE(NEW.provider_ownership_marker_key, '') <>
         COALESCE(OLD.provider_ownership_marker_key, '') OR
       COALESCE(NEW.provider_ownership_id, '') <> COALESCE(OLD.provider_ownership_id, '') OR
       NEW.provider_identity_checkpointed_at <> OLD.provider_identity_checkpointed_at))
  OR (NEW.lifecycle_mode = 'managed' AND NEW.status IN ('ready', 'active') AND
      NEW.provider_create_state <> 'identified' AND NOT (
        NEW.resource_kind IN ('d1', 'kv_namespace') AND
        NEW.provider_create_state = 'not_started' AND
        NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
      ))
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_resource_provider_identity_invalid');
END;
CREATE TRIGGER trg_control_plugin_resources_provider_identity_from_old_insert
AFTER INSERT ON control_plugin_desired_resources
WHEN NEW.lifecycle_mode = 'managed' AND NEW.resource_kind IN ('d1', 'kv_namespace')
  AND NEW.provider_create_state = 'not_started'
  AND NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
BEGIN
  UPDATE control_plugin_desired_resources
     SET provider_create_state = 'identified',
         provider_identity_checkpointed_at = NEW.updated_at
   WHERE plugin_resource_id = NEW.plugin_resource_id
     AND environment_id = NEW.environment_id
     AND provider_create_state = 'not_started';
END;
CREATE TRIGGER trg_control_plugin_resources_provider_identity_from_old_update
AFTER UPDATE OF provider_resource_id, provider_name ON control_plugin_desired_resources
WHEN NEW.lifecycle_mode = 'managed' AND NEW.resource_kind IN ('d1', 'kv_namespace')
  AND NEW.provider_create_state = 'not_started'
  AND NEW.provider_resource_id IS NOT NULL AND NEW.provider_name IS NOT NULL
BEGIN
  UPDATE control_plugin_desired_resources
     SET provider_create_state = 'identified',
         provider_identity_checkpointed_at = NEW.updated_at
   WHERE plugin_resource_id = NEW.plugin_resource_id
     AND environment_id = NEW.environment_id
     AND provider_create_state = 'not_started';
END;
CREATE INDEX idx_control_operations_runnable
  ON control_operations(status, next_attempt_at, created_at);
CREATE INDEX idx_control_operations_environment
  ON control_operations(environment_id, created_at DESC);
CREATE INDEX idx_control_operation_steps_status
  ON control_operation_steps(status, next_attempt_at, updated_at);
CREATE UNIQUE INDEX idx_control_release_one_active_stream
  ON control_migration_release_catalog(environment_id, stream_id, active_stream_key);
CREATE INDEX idx_control_tenant_database_migration_runnable
  ON control_tenant_database_migration_state(state, updated_at);
CREATE INDEX idx_control_d1_create_budget_day
  ON control_d1_create_budget_reservations(environment_id, budget_day);
CREATE UNIQUE INDEX idx_control_hmac_rotation_active
  ON control_hmac_rotation_operations(environment_id, active_operation_key);
CREATE UNIQUE INDEX idx_control_route_projection_active
  ON control_route_projection_migrations(environment_id, active_operation_key);
CREATE UNIQUE INDEX idx_control_signing_key_one_active
  ON control_signing_key_metadata(environment_id, key_purpose, active_key_guard);
CREATE INDEX idx_control_runtime_registry_routes_publication
  ON control_runtime_registry_routes(environment_id, registry_publication_generation, route_status);
CREATE INDEX idx_control_worker_inventory_drift_notification
  ON control_worker_inventory_drift_findings(environment_id, notification_state, severity, last_observed_at);
CREATE INDEX idx_control_external_capability_review
  ON control_external_capability_sources(environment_id, status, review_state, source_kind);
CREATE INDEX idx_control_plugin_resources_operation
  ON control_plugin_desired_resources(environment_id, operation_id, status, updated_at);
CREATE INDEX idx_control_plugin_resource_migration_runnable
  ON control_plugin_resource_migration_state(environment_id, state, updated_at);
CREATE INDEX idx_control_plugin_resource_binding_due
  ON control_plugin_resource_binding_reconciliations(state, stabilization_not_before, updated_at);
CREATE INDEX idx_control_plugin_runner_registry_due
  ON control_plugin_runner_registry_publications(status, expires_at, environment_id);
CREATE UNIQUE INDEX idx_control_lookup_bucket_migration_active
  ON control_lookup_bucket_migrations(environment_id, virtual_bucket, active_operation_key);
CREATE INDEX idx_control_lookup_bucket_migration_runnable
  ON control_lookup_bucket_migrations(state, updated_at, environment_id, virtual_bucket);
CREATE INDEX idx_control_lookup_hmac_key_state_publication_due
  ON control_lookup_hmac_key_state_publications(status, expires_at, updated_at);
CREATE INDEX idx_control_lookup_hmac_rotation_source_due
  ON control_lookup_hmac_rotation_sources(environment_id, operation_id, state, source_kind, shard_id);
CREATE INDEX idx_control_lookup_hmac_rotation_verification_due
  ON control_lookup_hmac_rotation_verification_shards(
    environment_id, operation_id, state, lookup_shard_id
  );
CREATE UNIQUE INDEX idx_control_read_replication_rollouts_environment
  ON control_read_replication_rollouts(operation_id, environment_id);
CREATE UNIQUE INDEX idx_control_read_replication_rollouts_one_active
  ON control_read_replication_rollouts(environment_id)
  WHERE status IN ('queued', 'applying', 'verifying');
CREATE INDEX idx_control_read_replication_targets_runnable
  ON control_read_replication_rollout_targets(status, next_attempt_at, lock_expires_at, updated_at);
CREATE INDEX idx_control_read_replication_targets_policy
  ON control_read_replication_rollout_targets(
    operation_id,
    data_role,
    residency_partition,
    status
  );
CREATE INDEX idx_control_tenant_default_allocations_shard
  ON control_tenant_default_allocations(selected_shard_id, reservation_state, updated_at);
CREATE INDEX idx_control_signing_key_verifications_pending
  ON control_signing_key_verifications(environment_id, key_purpose, key_id, status, updated_at);
CREATE INDEX idx_control_lookup_hmac_candidate_verifications_status
  ON control_lookup_hmac_candidate_verifications(
    environment_id, operation_id, verification_phase, status, updated_at
  );
CREATE INDEX idx_control_bootstrap_worker_evidence_state
  ON control_bootstrap_worker_evidence(environment_id, state, worker_script_name);
CREATE INDEX idx_control_tenant_shards_scope_owner
  ON control_tenant_shards(
    environment_id, allocation_scope, owner_tenant_id, data_role,
    residency_policy_id, residency_partition, status
  );
CREATE INDEX idx_control_tenant_shard_assignment_candidates
  ON control_tenant_shard_assignments(
    environment_id, tenant_id, data_role, residency_partition, assignment_state, shard_id
  );
CREATE UNIQUE INDEX idx_control_tenant_default_one_active_assignment
  ON control_tenant_shard_assignments(environment_id, tenant_id, data_role, residency_partition)
  WHERE data_role = 'tenant_core/default' AND assignment_state = 'active';
CREATE UNIQUE INDEX idx_control_tenant_default_one_pending_assignment
  ON control_tenant_shard_assignments(environment_id, tenant_id, data_role, residency_partition)
  WHERE data_role = 'tenant_core/default' AND assignment_state = 'pending';
CREATE INDEX idx_control_tenant_placement_migrations_due
  ON control_tenant_placement_migrations(
    environment_id, migration_state, lease_expires_at, updated_at
  );
CREATE INDEX idx_control_tenant_placement_migration_shards_state
  ON control_tenant_placement_migration_shards(operation_id, shard_state, data_role);
CREATE INDEX idx_control_shard_quarantine_due
  ON control_shard_quarantine_operations(state, drain_not_before, updated_at);
CREATE INDEX idx_control_shard_cleanup_due
  ON control_shard_cleanup_operations(state, updated_at);
CREATE INDEX idx_control_plugin_resource_cleanup_due
  ON control_plugin_resource_cleanup_operations(environment_id, state, drain_not_before, updated_at);
CREATE INDEX idx_control_tenant_dr_due
  ON control_tenant_disaster_recovery_operations(
    environment_id, recovery_state, drain_not_before, updated_at
  );
CREATE INDEX idx_control_worker_binding_reconciliation_due
  ON control_worker_binding_reconciliations(state, stabilization_not_before, updated_at);
CREATE INDEX idx_control_bootstrap_accelerator_proofs_expiry
  ON control_bootstrap_accelerator_proofs(environment_id, expires_at);
CREATE INDEX idx_control_release_migration_targets_runnable
  ON control_release_migration_targets(state, next_attempt_at, updated_at);
CREATE INDEX idx_control_release_migration_targets_operation
  ON control_release_migration_targets(operation_id, state, target_id);
CREATE INDEX idx_control_account_legal_hold_active
  ON control_account_legal_hold_projections(environment_id, projection_state, tenant_id, account_id);
CREATE INDEX idx_control_lookup_rebalance_batch_state
  ON control_lookup_rebalance_batches(environment_id, state, operation_id);
CREATE INDEX idx_control_lookup_rebalance_bucket_runnable
  ON control_lookup_rebalance_bucket_targets(state, updated_at, operation_id, virtual_bucket);
CREATE INDEX idx_control_lookup_retention_target_runnable
  ON control_lookup_retention_targets(state, lease_expires_at, updated_at, operation_id);
CREATE INDEX idx_control_lookup_scale_out_forecasts_state
  ON control_lookup_scale_out_forecasts(environment_id, decision_state, updated_at);
CREATE INDEX idx_control_account_scale_out_forecasts_state
  ON control_account_scale_out_forecasts(environment_id, decision_state, updated_at);
CREATE INDEX idx_control_account_allocations_pending_capacity
  ON control_tenant_shard_allocations(
    selected_shard_id, capacity_counted_at, tenant_id, data_role, residency_partition
  )
  WHERE capacity_counted_at IS NULL
    AND reservation_state IN ('reserved', 'committed');
CREATE INDEX idx_control_desired_resources_provider_create_state
  ON control_desired_resources(environment_id, provider_create_state, updated_at);
CREATE INDEX idx_control_plugin_resources_provider_create_state
  ON control_plugin_desired_resources(environment_id, provider_create_state, updated_at);

PRAGMA foreign_keys = ON;
