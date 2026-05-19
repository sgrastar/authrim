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
