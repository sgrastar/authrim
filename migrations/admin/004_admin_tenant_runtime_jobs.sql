-- =============================================================================
-- Authrim Admin Baseline: Tenant Runtime and Jobs
-- Consolidated for fresh Authrim installs from admin/017_external_token_refresh_runs.sql, admin/018_tenant_database_registry.sql, admin/019_tenant_database_stats.sql, admin/020_tenant_discovery_and_runtime_registry.sql, admin/021_internal_notification_events.sql, admin/022_tenant_database_migration_jobs.sql, admin/023_admin_jobs.sql, admin/024_tenant_database_slots.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/017_external_token_refresh_runs.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Admin External Token Refresh Runs
-- =============================================================================
-- Description:
--   Stores operational summaries for external IdP token refresh scheduled and
--   manual runs. Detailed payloads may be stored in R2 and referenced through
--   object_catalog.

CREATE TABLE IF NOT EXISTS admin_external_token_refresh_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_tenant_id TEXT,
  actor_type TEXT,
  actor_id TEXT,
  config_json TEXT NOT NULL,
  selected_tenants_count INTEGER NOT NULL DEFAULT 0,
  processed_tenants INTEGER NOT NULL DEFAULT 0,
  failed_tenants INTEGER NOT NULL DEFAULT 0,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  cursor_before TEXT,
  cursor_after TEXT,
  detail_object_catalog_id TEXT,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (trigger_type IN ('scheduled', 'manual_tenant')),
  CHECK (status IN ('running', 'completed', 'partial_failure', 'failed'))
);

CREATE TABLE IF NOT EXISTS admin_external_token_refresh_tenant_runs (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, tenant_id),
  FOREIGN KEY (run_id) REFERENCES admin_external_token_refresh_runs(id) ON DELETE CASCADE,
  CHECK (status IN ('completed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_external_token_refresh_runs_started
  ON admin_external_token_refresh_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_token_refresh_runs_requested_tenant
  ON admin_external_token_refresh_runs(requested_tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_token_refresh_tenant_runs_tenant
  ON admin_external_token_refresh_tenant_runs(tenant_id, completed_at DESC);

-- -----------------------------------------------------------------------------
-- Source: admin/018_tenant_database_registry.sql
-- -----------------------------------------------------------------------------

-- Tenant database registry for deployment-level tenant-d1 / external-durable storage routing.
-- The control DB is the source of truth; runtime snapshots and generated bindings are derived.

CREATE TABLE IF NOT EXISTS tenant_database_registry (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL DEFAULT 1,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL CHECK (
    provider IN ('d1', 'hyperdrive', 'postgres', 'mysql', 'custom')
  ),
  database_id TEXT,
  database_name TEXT,
  binding_ref TEXT,
  connection_ref TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (
    status IN (
      'requested',
      'provisioning',
      'ready',
      'active',
      'degraded',
      'degraded_pending_snapshot',
      'restored_pending',
      'failed',
      'disabled',
      'retired',
      'deleting',
      'deleted'
    )
  ),
  shard_count INTEGER NOT NULL DEFAULT 1,
  shard_key_strategy TEXT NOT NULL DEFAULT 'none',
  worker_shard TEXT,
  deployment_target TEXT,
  region_hint TEXT,
  jurisdiction TEXT,
  signature TEXT,
  signature_key_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT,
  PRIMARY KEY (tenant_id, role, generation, shard_group, shard_index)
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_registry_status
  ON tenant_database_registry(status, provider, role);

CREATE INDEX IF NOT EXISTS idx_tenant_database_registry_binding_ref
  ON tenant_database_registry(binding_ref);

CREATE INDEX IF NOT EXISTS idx_tenant_database_registry_deployment_target
  ON tenant_database_registry(deployment_target, worker_shard);

CREATE TABLE IF NOT EXISTS tenant_database_active_pointers (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  shard_group TEXT NOT NULL DEFAULT 'default',
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL DEFAULT 1,
  shard_key_strategy TEXT NOT NULL DEFAULT 'none',
  runtime_generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'degraded_pending_snapshot', 'disabled')
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, role, shard_group)
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_active_pointers_generation
  ON tenant_database_active_pointers(tenant_id, generation);

CREATE TABLE IF NOT EXISTS tenant_database_migration_state (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  migration_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'applied', 'failed', 'skipped')
  ),
  started_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    tenant_id,
    role,
    generation,
    shard_group,
    shard_index,
    migration_version
  )
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_migration_state_status
  ON tenant_database_migration_state(status, role, migration_version);

-- -----------------------------------------------------------------------------
-- Source: admin/019_tenant_database_stats.sql
-- -----------------------------------------------------------------------------

-- Tenant database size/account statistics for tenant-d1 capacity warnings.
-- Stats are generated by scheduled/operator jobs and are not on the auth hot path.

CREATE TABLE IF NOT EXISTS tenant_database_stats (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  account_count INTEGER,
  active_user_count INTEGER,
  active_pending_user_count INTEGER,
  d1_file_size_bytes INTEGER,
  d1_file_size_checked_at TEXT,
  d1_file_size_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    d1_file_size_status IN ('fresh', 'stale', 'unknown', 'unavailable')
  ),
  table_size_estimate_json TEXT,
  row_count_estimate_json TEXT,
  warning_state TEXT NOT NULL DEFAULT 'ok' CHECK (
    warning_state IN ('ok', 'warning', 'strong_warning')
  ),
  warning_reasons_json TEXT,
  stats_checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, role, generation, shard_group, shard_index)
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_stats_warning
  ON tenant_database_stats(warning_state, role);

CREATE INDEX IF NOT EXISTS idx_tenant_database_stats_checked_at
  ON tenant_database_stats(stats_checked_at);

-- -----------------------------------------------------------------------------
-- Source: admin/020_tenant_discovery_and_runtime_registry.sql
-- -----------------------------------------------------------------------------

-- Control-plane tables for tenant discovery indexes and runtime registry cache metadata.
-- These tables intentionally store hashed/blind-indexed routing identifiers only.

CREATE TABLE IF NOT EXISTS tenant_discovery_indexes (
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (
    index_kind IN (
      'email_domain',
      'email_exact',
      'external_subject',
      'global_subject'
    )
  ),
  index_value TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1,
  key_version INTEGER NOT NULL DEFAULT 1,
  source_updated_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'stale', 'rotating', 'disabled', 'deleted')
  ),
  metadata_json TEXT,
  PRIMARY KEY (
    index_kind,
    index_value,
    tenant_id,
    subject_id,
    index_version,
    key_version
  )
);

CREATE INDEX IF NOT EXISTS idx_tenant_discovery_indexes_subject
  ON tenant_discovery_indexes(tenant_id, subject_id, index_kind);

CREATE INDEX IF NOT EXISTS idx_tenant_discovery_indexes_freshness
  ON tenant_discovery_indexes(status, indexed_at, source_updated_at);

CREATE TABLE IF NOT EXISTS tenant_runtime_cache_generations (
  tenant_id TEXT NOT NULL,
  cache_namespace TEXT NOT NULL CHECK (
    cache_namespace IN (
      'settings',
      'policy',
      'runtime_registry',
      'users_core',
      'users_pii',
      'clients',
      'consent',
      'rebac'
    )
  ),
  generation INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, cache_namespace)
);

CREATE TABLE IF NOT EXISTS tenant_runtime_registry_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (
    snapshot_scope IN ('tenant', 'deployment_target')
  ),
  deployment_target TEXT NOT NULL DEFAULT 'default',
  runtime_generation INTEGER NOT NULL,
  storage_profile_id TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'superseded', 'expired', 'invalid')
  ),
  object_ref TEXT,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  signature TEXT,
  signature_key_id TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, snapshot_scope, deployment_target, runtime_generation)
);

CREATE INDEX IF NOT EXISTS idx_tenant_runtime_registry_snapshots_active
  ON tenant_runtime_registry_snapshots(status, expires_at, storage_profile_id);

-- -----------------------------------------------------------------------------
-- Source: admin/021_internal_notification_events.sql
-- -----------------------------------------------------------------------------

-- Internal notification event queue for storage/registry/security-critical events.
-- External delivery is configured separately so Notification Center remains the durable
-- operator-visible source of truth even when email/webhook providers fail.

CREATE TABLE IF NOT EXISTS internal_notification_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'storage_registry_security',
      'storage_registry_health',
      'tenant_database_stats',
      'tenant_database_health',
      'logging_destination_health',
      'logging_delivery_failure',
      'logging_fallback_used',
      'logging_dlq_backlog',
      'logging_quota_warning',
      'logging_repair_job_status',
      'notification_delivery_failure'
    )
  ),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'delivered', 'failed', 'dead_letter', 'suppressed')
  ),
  deduplication_key TEXT,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_notification_events_dedup
  ON internal_notification_events(deduplication_key);

CREATE INDEX IF NOT EXISTS idx_internal_notification_events_pending
  ON internal_notification_events(status, severity, created_at);

CREATE INDEX IF NOT EXISTS idx_internal_notification_events_tenant_created
  ON internal_notification_events(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS internal_notification_delivery_routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'platform' CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL DEFAULT 'global',
  provider TEXT NOT NULL CHECK (provider IN ('webhook', 'email', 'slack', 'custom')),
  destination_id TEXT,
  categories_json TEXT,
  severities_json TEXT,
  min_severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (min_severity IN ('critical', 'high', 'medium', 'low', 'info')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  failure_policy TEXT NOT NULL DEFAULT 'retry_until_dead_letter'
    CHECK (failure_policy IN ('best_effort', 'retry_until_dead_letter', 'fail_closed')),
  max_attempts INTEGER NOT NULL DEFAULT 5,
  retry_after_seconds INTEGER NOT NULL DEFAULT 300,
  suppression_key TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_internal_notification_delivery_routes_lookup
  ON internal_notification_delivery_routes(scope_type, scope_id, enabled, provider);

CREATE TABLE IF NOT EXISTS internal_notification_delivery_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  route_id TEXT,
  provider TEXT NOT NULL,
  destination_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed', 'dead_letter', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error_class TEXT,
  error_message TEXT,
  next_attempt_at INTEGER,
  payload_sha256 TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_internal_notification_delivery_attempts_event
  ON internal_notification_delivery_attempts(event_id, provider, status);

CREATE INDEX IF NOT EXISTS idx_internal_notification_delivery_attempts_retry
  ON internal_notification_delivery_attempts(status, next_attempt_at, updated_at);

-- -----------------------------------------------------------------------------
-- Source: admin/022_tenant_database_migration_jobs.sql
-- -----------------------------------------------------------------------------

-- Tenant database profile migration job state.
-- Execution is intentionally deferred; these tables reserve the control-plane state model for
-- shared-d1 -> tenant-d1 and tenant-d1 -> external-durable migration planning.

CREATE TABLE IF NOT EXISTS tenant_database_migration_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_storage_profile_id TEXT NOT NULL,
  target_storage_profile_id TEXT NOT NULL,
  migration_method TEXT NOT NULL CHECK (
    migration_method IN (
      'export_import',
      'batch_copy',
      'dual_write_read_compare',
      'cdc_style'
    )
  ),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (
    status IN (
      'requested',
      'approved',
      'preparing',
      'validating',
      'ready_for_cutover',
      'cutting_over',
      'completed',
      'failed',
      'rolled_back'
    )
  ),
  write_policy TEXT NOT NULL DEFAULT 'maintenance_read_only' CHECK (
    write_policy IN (
      'maintenance_read_only',
      'affected_data_class_freeze',
      'online_dual_write'
    )
  ),
  source_of_truth TEXT NOT NULL DEFAULT 'source_before_cutover' CHECK (
    source_of_truth IN (
      'source_before_cutover',
      'target_after_cutover'
    )
  ),
  scheduled_window_not_before TEXT,
  scheduled_window_not_after TEXT,
  validation_policy_json TEXT,
  validation_result_json TEXT,
  cache_cutover_generation INTEGER,
  rollback_plan_json TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'system_admin_break_glass' CHECK (
    approval_mode IN (
      'system_admin_break_glass',
      'two_person_approval',
      'storage_operator_approval'
    )
  ),
  dangerous_operation_confirmation TEXT,
  break_glass_reason TEXT,
  impact_summary_json TEXT,
  two_person_approval_required INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  approved_by TEXT,
  started_at TEXT,
  cutover_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_migration_jobs_tenant_status
  ON tenant_database_migration_jobs(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_database_migration_jobs_status_window
  ON tenant_database_migration_jobs(status, scheduled_window_not_before, scheduled_window_not_after);

CREATE TABLE IF NOT EXISTS tenant_database_migration_job_targets (
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  source_generation INTEGER,
  target_generation INTEGER,
  source_schema_version INTEGER,
  target_schema_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'copying',
      'validating',
      'ready_for_cutover',
      'cutting_over',
      'completed',
      'failed',
      'rolled_back'
    )
  ),
  row_count_source INTEGER,
  row_count_target INTEGER,
  checksum_sample_json TEXT,
  validation_result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, tenant_id, role, shard_group, shard_index),
  FOREIGN KEY (job_id) REFERENCES tenant_database_migration_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_migration_job_targets_status
  ON tenant_database_migration_job_targets(status, role);

-- -----------------------------------------------------------------------------
-- Source: admin/023_admin_jobs.sql
-- -----------------------------------------------------------------------------

-- Admin async job state for DB_ADMIN-backed management operations.
-- The core schema historically had admin_jobs; split-admin deployments need the
-- same table in DB_ADMIN because management jobs execute against the admin plane.

CREATE TABLE IF NOT EXISTS admin_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT,
  config TEXT,
  input_r2_key TEXT,
  result_r2_key TEXT,
  object_catalog_id TEXT,
  result TEXT,
  error_code TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  estimated_completion INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  dead_lettered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_cleanup
  ON admin_jobs(status, completed_at);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_status
  ON admin_jobs(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_tenant
  ON admin_jobs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_type
  ON admin_jobs(tenant_id, job_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_next_run
  ON admin_jobs(status, next_run_at, updated_at);

-- -----------------------------------------------------------------------------
-- Source: admin/024_tenant_database_slots.sql
-- -----------------------------------------------------------------------------

-- Tenant D1 preallocated slot inventory.
-- tenant_database_slots tracks setup/ar-management capacity and assignment state.
-- tenant_database_registry remains the active runtime source of truth once a slot
-- is assigned to a tenant.

CREATE TABLE IF NOT EXISTS tenant_database_slots (
  slot_id TEXT PRIMARY KEY,
  slot_number INTEGER NOT NULL UNIQUE,
  core_binding_ref TEXT NOT NULL UNIQUE,
  pii_binding_ref TEXT NOT NULL UNIQUE,
  core_database_name TEXT NOT NULL,
  pii_database_name TEXT NOT NULL,
  core_database_id TEXT NOT NULL,
  pii_database_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'available',
      'reserved',
      'assigned',
      'pending_binding',
      'unavailable',
      'reset_required',
      'retired'
    )
  ),
  assigned_tenant_id TEXT,
  reserved_by TEXT,
  reserved_at INTEGER,
  assigned_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slots_state
  ON tenant_database_slots(state, slot_number);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slots_assigned_tenant
  ON tenant_database_slots(assigned_tenant_id);

CREATE TABLE IF NOT EXISTS tenant_database_slot_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  slot_id TEXT,
  stage TEXT NOT NULL,
  actor TEXT,
  result TEXT NOT NULL CHECK (result IN ('started', 'succeeded', 'failed', 'skipped')),
  error_code TEXT,
  request_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slot_audit_tenant
  ON tenant_database_slot_audit_events(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slot_audit_slot
  ON tenant_database_slot_audit_events(slot_id, created_at);
