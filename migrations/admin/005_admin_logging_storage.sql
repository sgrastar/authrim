-- =============================================================================
-- Authrim Admin Baseline: Logging Storage
-- Consolidated for fresh Authrim installs from admin/026_logging_storage_foundation.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/026_logging_storage_foundation.sql
-- -----------------------------------------------------------------------------

-- Logging / storage control-plane foundation.
-- This schema supports shared destinations and immutable R2 log chunks.

CREATE TABLE IF NOT EXISTS admin_destinations (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant', 'shared')),
  scope_id TEXT NOT NULL,
  destination_kind TEXT NOT NULL CHECK (
    destination_kind IN ('object_storage', 'http_sink', 'external_collector', 'database', 'custom')
  ),
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'disabled', 'deleted')),
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'failing', 'unreachable')),
  rotation_status TEXT NOT NULL DEFAULT 'none'
    CHECK (rotation_status IN ('none', 'testing', 'ready', 'active', 'retiring', 'failed')),
  provider_config TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT,
  credential_version INTEGER NOT NULL DEFAULT 0,
  next_credential_ref TEXT,
  next_credential_version INTEGER,
  previous_credential_ref TEXT,
  previous_credential_retire_after INTEGER,
  allowed_tenant_ids TEXT,
  allowed_log_types TEXT,
  allowed_planes TEXT,
  region TEXT,
  critical_allowed INTEGER NOT NULL DEFAULT 0 CHECK (critical_allowed IN (0, 1)),
  default_fallback_eligible INTEGER NOT NULL DEFAULT 0 CHECK (default_fallback_eligible IN (0, 1)),
  retention_days INTEGER,
  encryption_mode TEXT NOT NULL DEFAULT 'platform_managed'
    CHECK (encryption_mode IN ('platform_managed', 'external_managed', 'none')),
  last_health_check_at INTEGER,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_admin_destinations_scope_name_active
  ON admin_destinations(scope_type, scope_id, name, deleted_at);

CREATE INDEX IF NOT EXISTS idx_admin_destinations_scope_status
  ON admin_destinations(scope_type, scope_id, lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_admin_destinations_kind_provider
  ON admin_destinations(destination_kind, provider);

CREATE INDEX IF NOT EXISTS idx_admin_destinations_health
  ON admin_destinations(health_status, last_health_check_at);

CREATE TABLE IF NOT EXISTS admin_destination_capabilities (
  destination_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider_default', 'platform_override')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (destination_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_admin_destination_capabilities_lookup
  ON admin_destination_capabilities(capability, enabled);

CREATE TABLE IF NOT EXISTS admin_destination_health_events (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  check_type TEXT NOT NULL CHECK (check_type IN ('quick', 'deep', 'adaptive')),
  previous_health_status TEXT,
  next_health_status TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'partial')),
  error_class TEXT,
  latency_ms INTEGER,
  checked_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_destination_health_events_destination
  ON admin_destination_health_events(destination_id, checked_at);

CREATE INDEX IF NOT EXISTS idx_admin_destination_health_events_status
  ON admin_destination_health_events(next_health_status, checked_at);

CREATE TABLE IF NOT EXISTS credential_secret_metadata (
  credential_ref TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (
    backend IN ('r2_encrypted_object', 'd1_encrypted_table', 'external_secret_manager')
  ),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'next', 'retiring', 'retired', 'deleted')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_credential_secret_metadata_destination
  ON credential_secret_metadata(destination_id, status, version);

CREATE TABLE IF NOT EXISTS credential_secret_bodies (
  credential_ref TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credential_secret_bodies_destination
  ON credential_secret_bodies(destination_id, version);

CREATE TABLE IF NOT EXISTS logging_fallback_policies (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  fallback_destination_id TEXT,
  failure_mode TEXT NOT NULL DEFAULT 'platform_default',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_logging_fallback_policies_scope
  ON logging_fallback_policies(scope_type, scope_id, log_type, plane);

CREATE TABLE IF NOT EXISTS storage_destination_assignments (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  tenant_id TEXT,
  log_type TEXT,
  plane TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_storage_destination_assignments_scope
  ON storage_destination_assignments(
    destination_id,
    COALESCE(tenant_id, '*'),
    COALESCE(log_type, '*'),
    COALESCE(plane, '*'),
    enabled
  );

CREATE INDEX IF NOT EXISTS idx_storage_destination_assignments_tenant
  ON storage_destination_assignments(tenant_id, log_type, plane, enabled);

CREATE TABLE IF NOT EXISTS logging_destination_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  fallback_policy_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  managed_by TEXT NOT NULL CHECK (managed_by IN ('platform', 'tenant')),
  change_protection TEXT NOT NULL DEFAULT 'confirm'
    CHECK (change_protection IN ('confirm', 'approval_required', 'config_only')),
  approval_policy_id TEXT,
  policy_hash TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_logging_destination_overrides_effective
  ON logging_destination_overrides(COALESCE(tenant_id, 'platform'), log_type, plane, enabled);

CREATE INDEX IF NOT EXISTS idx_logging_destination_overrides_destination
  ON logging_destination_overrides(destination_id, enabled, updated_at);

CREATE TABLE IF NOT EXISTS logging_destination_override_history (
  id TEXT PRIMARY KEY,
  override_id TEXT NOT NULL,
  tenant_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  previous_destination_id TEXT,
  next_destination_id TEXT,
  previous_fallback_policy_id TEXT,
  next_fallback_policy_id TEXT,
  previous_enabled INTEGER CHECK (previous_enabled IN (0, 1)),
  next_enabled INTEGER CHECK (next_enabled IN (0, 1)),
  previous_change_protection TEXT,
  next_change_protection TEXT,
  previous_approval_policy_id TEXT,
  next_approval_policy_id TEXT,
  previous_policy_hash TEXT,
  next_policy_hash TEXT,
  previous_version INTEGER,
  next_version INTEGER NOT NULL,
  changed_by TEXT,
  changed_at INTEGER NOT NULL,
  change_reason TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_destination_override_history_override
  ON logging_destination_override_history(override_id, changed_at);

CREATE INDEX IF NOT EXISTS idx_logging_destination_override_history_scope
  ON logging_destination_override_history(COALESCE(tenant_id, 'platform'), log_type, plane, changed_at);

CREATE TABLE IF NOT EXISTS logging_policy_snapshots (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  policy_hash TEXT NOT NULL,
  object_ref TEXT,
  snapshot_json TEXT,
  published_by TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_logging_policy_snapshots_scope_version
  ON logging_policy_snapshots(scope_type, scope_id, version);

CREATE INDEX IF NOT EXISTS idx_logging_policy_snapshots_status
  ON logging_policy_snapshots(scope_type, scope_id, status, version);

CREATE TABLE IF NOT EXISTS log_object_catalog (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('chunk', 'manifest', 'dlq_payload', 'export_artifact')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'orphan_candidate', 'deleted')),
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  compression TEXT CHECK (compression IN ('none', 'gzip_block')),
  encryption_scope TEXT,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_object_catalog_object_key
  ON log_object_catalog(object_key);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_status
  ON log_object_catalog(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_record_index (
  record_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  line_number INTEGER,
  block_offset INTEGER,
  block_length INTEGER,
  record_offset INTEGER,
  record_length INTEGER,
  event_at INTEGER NOT NULL,
  index_profile TEXT NOT NULL,
  indexed_fields TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_key, log_type, plane, record_id)
);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_time
  ON log_chunk_record_index(tenant_key, log_type, plane, event_at);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_object
  ON log_chunk_record_index(object_catalog_id);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_status
  ON log_chunk_record_index(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_manifests (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  bucket_start_at INTEGER NOT NULL,
  bucket_end_at INTEGER NOT NULL,
  shard TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);

CREATE TABLE IF NOT EXISTS logging_delivery_events (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  destination_id TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'retrying', 'failed', 'dlq')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  object_catalog_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_retry_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_delivery_events_tenant_status
  ON logging_delivery_events(tenant_key, status, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_delivery_events_destination
  ON logging_delivery_events(destination_id, status, created_at);

CREATE TABLE IF NOT EXISTS logging_delivery_event_aggregates (
  bucket_start_at INTEGER NOT NULL,
  bucket_end_at INTEGER NOT NULL,
  bucket_shard TEXT NOT NULL DEFAULT 's0',
  tenant_key TEXT NOT NULL,
  destination_id TEXT NOT NULL DEFAULT '',
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'retrying', 'failed', 'dlq')),
  batch_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  attempt_count_sum INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    bucket_start_at, bucket_shard, tenant_key, destination_id, log_type, plane, lane, status
  )
);

CREATE INDEX IF NOT EXISTS idx_logging_delivery_event_aggregates_summary
  ON logging_delivery_event_aggregates(bucket_start_at, bucket_shard, lane, status);

CREATE INDEX IF NOT EXISTS idx_logging_delivery_event_aggregates_tenant
  ON logging_delivery_event_aggregates(tenant_key, bucket_start_at, bucket_shard, lane, status);

CREATE TABLE IF NOT EXISTS logging_usage_aggregates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL CHECK (
    metric_name IN (
      'delivery_records',
      'delivery_bytes',
      'delivery_batches',
      'dlq_items',
      'catalog_objects',
      'catalog_bytes',
      'sensitive_detail_bytes',
      'message_jobs'
    )
  ),
  window_kind TEXT NOT NULL CHECK (window_kind IN ('hour', 'day')),
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  source_table TEXT NOT NULL,
  metadata_json TEXT,
  refreshed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_logging_usage_aggregates_scope
  ON logging_usage_aggregates(
    COALESCE(tenant_id, ''),
    COALESCE(tenant_key, ''),
    COALESCE(log_type, ''),
    COALESCE(plane, ''),
    COALESCE(lane, ''),
    metric_name,
    window_kind,
    window_start_at
  );

CREATE INDEX IF NOT EXISTS idx_logging_usage_aggregates_window
  ON logging_usage_aggregates(window_kind, window_start_at, metric_name);

CREATE TABLE IF NOT EXISTS logging_quota_policies (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL CHECK (
    metric_name IN (
      'delivery_records',
      'delivery_bytes',
      'delivery_batches',
      'dlq_items',
      'catalog_objects',
      'catalog_bytes',
      'sensitive_detail_bytes',
      'message_jobs'
    )
  ),
  window_kind TEXT NOT NULL DEFAULT 'day' CHECK (window_kind IN ('hour', 'day')),
  soft_limit INTEGER,
  hard_limit INTEGER,
  warning_ratio REAL NOT NULL DEFAULT 0.8,
  enforcement_mode TEXT NOT NULL DEFAULT 'warn_only'
    CHECK (enforcement_mode IN ('disabled', 'observe', 'warn_only', 'soft_limit', 'hard_non_critical')),
  critical_behavior TEXT NOT NULL DEFAULT 'never_block'
    CHECK (critical_behavior IN ('never_block')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_logging_quota_policies_scope
  ON logging_quota_policies(
    scope_type,
    scope_id,
    COALESCE(log_type, ''),
    COALESCE(plane, ''),
    COALESCE(lane, ''),
    metric_name,
    window_kind,
    deleted_at
  );

CREATE INDEX IF NOT EXISTS idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind);

CREATE TABLE IF NOT EXISTS logging_quota_evaluations (
  id TEXT PRIMARY KEY,
  quota_policy_id TEXT NOT NULL,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT,
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  value INTEGER NOT NULL,
  soft_limit INTEGER,
  hard_limit INTEGER,
  state TEXT NOT NULL CHECK (state IN ('ok', 'warning', 'soft_exceeded', 'hard_exceeded')),
  enforcement_action TEXT NOT NULL CHECK (
    enforcement_action IN ('none', 'notify', 'throttle_non_critical', 'block_non_critical')
  ),
  evaluated_at INTEGER NOT NULL,
  notification_event_id TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_quota_evaluations_policy_time
  ON logging_quota_evaluations(quota_policy_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_database_probe_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  generation INTEGER,
  probe_kind TEXT NOT NULL CHECK (probe_kind IN ('dry_run', 'write_read_delete')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  latency_ms INTEGER,
  binding_ref TEXT,
  connection_ref TEXT,
  provider TEXT,
  schema_version INTEGER,
  error_class TEXT,
  error_message TEXT,
  metadata_json TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_database_probe_results_status
  ON tenant_database_probe_results(status, created_at DESC);

CREATE TABLE IF NOT EXISTS logging_dlq_items (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  destination_id TEXT,
  payload_object_ref TEXT NOT NULL,
  error_class TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'replayed', 'deleted', 'purged')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logging_dlq_items_tenant_status
  ON logging_dlq_items(tenant_key, status, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_dlq_items_lane_status
  ON logging_dlq_items(lane, status, created_at);

CREATE TABLE IF NOT EXISTS logging_export_jobs (
  id TEXT PRIMARY KEY,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  format TEXT NOT NULL CHECK (format IN ('jsonl', 'csv', 'zip')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired')),
  artifact_object_ref TEXT,
  manifest_object_ref TEXT,
  checksum_sha256 TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  error_class TEXT,
  filter_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logging_export_jobs_status
  ON logging_export_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_export_jobs_tenant
  ON logging_export_jobs(tenant_key, created_at);

CREATE TABLE IF NOT EXISTS logging_key_registry (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  surface TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  active_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'rotating', 'stale', 'compromised', 'disabled')),
  last_rotated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_logging_key_registry_scope
  ON logging_key_registry(tenant_key, COALESCE(surface, ''), log_type, plane);

CREATE INDEX IF NOT EXISTS idx_logging_key_registry_status
  ON logging_key_registry(status, updated_at);

CREATE TABLE IF NOT EXISTS logging_key_versions (
  key_registry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  backend_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'retired', 'rewrap_required', 'compromised')
  ),
  usage_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY (key_registry_id, version)
);

CREATE INDEX IF NOT EXISTS idx_logging_key_versions_status
  ON logging_key_versions(status, created_at);

CREATE TABLE IF NOT EXISTS logging_key_material_bodies (
  backend_ref TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  surface TEXT,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logging_key_material_bodies_scope
  ON logging_key_material_bodies(tenant_key, COALESCE(surface, ''), log_type, plane, version);

CREATE TABLE IF NOT EXISTS logging_rewrap_jobs (
  id TEXT PRIMARY KEY,
  key_registry_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_rewrap_jobs_queue
  ON logging_rewrap_jobs(status, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_rewrap_jobs_registry
  ON logging_rewrap_jobs(key_registry_id, status);

CREATE TABLE IF NOT EXISTS logging_catalog_repair_jobs (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('scan', 'apply_safe', 'dangerous_preview', 'dangerous_apply')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled')
  ),
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  requested_action TEXT,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  preview_artifact_ref TEXT,
  result_json TEXT,
  error_class TEXT,
  last_error TEXT,
  requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancel_requested_at INTEGER,
  cancel_requested_by TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_catalog_repair_jobs_queue
  ON logging_catalog_repair_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_catalog_repair_jobs_scope
  ON logging_catalog_repair_jobs(COALESCE(tenant_key, ''), COALESCE(log_type, ''), COALESCE(plane, ''), created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_coverage_status (
  operation_id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  required_audit TEXT NOT NULL,
  criticality TEXT NOT NULL CHECK (criticality IN ('normal', 'critical')),
  status TEXT NOT NULL CHECK (
    status IN ('covered', 'gap_detected', 'acknowledged', 'ignored')
  ),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_coverage_status_state
  ON admin_audit_coverage_status(status, criticality, updated_at);

CREATE TABLE IF NOT EXISTS admin_logging_critical_policies (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL UNIQUE,
  destination_id TEXT NOT NULL,
  critical_allowed INTEGER NOT NULL DEFAULT 1 CHECK (critical_allowed IN (0, 1)),
  default_fallback_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (default_fallback_eligible IN (0, 1)),
  failure_mode TEXT NOT NULL DEFAULT 'platform_default',
  change_protection TEXT NOT NULL DEFAULT 'confirm'
    CHECK (change_protection IN ('confirm', 'approval_required', 'config_only')),
  approval_policy_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_admin_logging_critical_policies_status
  ON admin_logging_critical_policies(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_admin_logging_critical_policies_destination
  ON admin_logging_critical_policies(destination_id, status);

CREATE TABLE IF NOT EXISTS admin_logging_sensitive_detail_policies (
  id TEXT PRIMARY KEY,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL DEFAULT 'sensitive_detail',
  destination_id TEXT NOT NULL,
  chunking_enabled INTEGER NOT NULL DEFAULT 1 CHECK (chunking_enabled IN (0, 1)),
  encryption_required INTEGER NOT NULL DEFAULT 1 CHECK (encryption_required IN (0, 1)),
  read_audit_required INTEGER NOT NULL DEFAULT 1 CHECK (read_audit_required IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_admin_logging_sensitive_detail_policy_scope
  ON admin_logging_sensitive_detail_policies(log_type, plane, deleted_at);

CREATE INDEX IF NOT EXISTS idx_admin_logging_sensitive_detail_policy_status
  ON admin_logging_sensitive_detail_policies(status, updated_at);

CREATE TABLE IF NOT EXISTS sensitive_detail_chunk_index (
  catalog_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  object_class TEXT NOT NULL,
  bucket_binding TEXT NOT NULL CHECK (bucket_binding IN ('SENSITIVE_DETAILS')),
  object_key TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT 'gzip' CHECK (content_encoding IN ('gzip', 'none')),
  line_number INTEGER NOT NULL,
  byte_offset INTEGER,
  byte_length INTEGER,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sensitive_detail_chunk_index_tenant_class
  ON sensitive_detail_chunk_index(tenant_id, object_class, created_at);

CREATE INDEX IF NOT EXISTS idx_sensitive_detail_chunk_index_object
  ON sensitive_detail_chunk_index(object_key, line_number);
