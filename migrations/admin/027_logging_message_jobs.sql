-- Logging/storage message jobs for delivery retry and export build.
-- This is an internal control-plane messaging subsystem, not a general product queue.

CREATE TABLE IF NOT EXISTS logging_message_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('retry_delivery', 'export_build')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'claimed',
      'running',
      'retrying',
      'completed',
      'failed',
      'dlq',
      'cancelled',
      'expired',
      'blocked'
    )
  ),
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  criticality TEXT NOT NULL CHECK (criticality IN ('standard', 'critical')),
  priority INTEGER NOT NULL DEFAULT 0,

  tenant_id TEXT,
  tenant_key TEXT,
  topology_type TEXT NOT NULL CHECK (
    topology_type IN ('platform', 'shared_d1', 'tenant_d1', 'external_db', 'unknown')
  ),
  database_binding_ref TEXT,
  connection_ref TEXT,
  topology_snapshot_version INTEGER,
  topology_resolved_at INTEGER,

  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant', 'shared')),
  scope_id TEXT,
  scope_key TEXT NOT NULL,

  source_type TEXT CHECK (source_type IN ('dlq_item', 'delivery_event', 'payload_object')),
  source_id TEXT,
  root_job_id TEXT,
  parent_job_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,

  payload_object_ref TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  payload_schema_version INTEGER NOT NULL,
  redacted_summary_json TEXT,
  validation_summary_json TEXT,

  idempotency_key TEXT,
  dedupe_until INTEGER NOT NULL,
  not_before INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  attempt_policy_json TEXT,

  claim_token TEXT,
  claimed_at INTEGER,
  claimed_until INTEGER,

  requested_by TEXT,
  reason TEXT,
  error_class TEXT,
  last_error TEXT,
  blocked_reason TEXT,

  cancel_requested_at INTEGER,
  cancelled_by TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logging_message_jobs_due
  ON logging_message_jobs(status, not_before, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_message_jobs_claimed
  ON logging_message_jobs(status, claimed_until, lane, priority);

CREATE INDEX IF NOT EXISTS idx_logging_message_jobs_scope_status
  ON logging_message_jobs(scope_key, status, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_message_jobs_tenant
  ON logging_message_jobs(tenant_key, kind, status, created_at);

CREATE INDEX IF NOT EXISTS idx_logging_message_jobs_source
  ON logging_message_jobs(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_logging_message_jobs_chain
  ON logging_message_jobs(root_job_id, parent_job_id, depth);

CREATE TABLE IF NOT EXISTS logging_message_idempotency_keys (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  message_job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('retry_delivery', 'export_build')),
  target_payload_hash TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('critical', 'default', 'bulk')),
  criticality TEXT NOT NULL CHECK (criticality IN ('standard', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  dedupe_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_logging_message_idempotency_expiry
  ON logging_message_idempotency_keys(status, dedupe_until);

CREATE INDEX IF NOT EXISTS idx_logging_message_idempotency_job
  ON logging_message_idempotency_keys(message_job_id);

CREATE TABLE IF NOT EXISTS logging_message_export_builds (
  id TEXT PRIMARY KEY,
  message_job_id TEXT NOT NULL,
  export_job_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN ('plan', 'build_partition', 'finalize', 'verify_manifest', 'cleanup')
  ),
  partition_strategy TEXT NOT NULL CHECK (
    partition_strategy IN ('time_bucket_shard', 'query_page', 'chunk_index', 'manifest_shard')
  ),
  partition_key TEXT,
  partition_index INTEGER NOT NULL DEFAULT 0,
  partition_count INTEGER NOT NULL DEFAULT 1,
  snapshot_cutoff_at INTEGER NOT NULL,

  part_object_ref TEXT,
  part_checksum_sha256 TEXT,
  part_record_count INTEGER NOT NULL DEFAULT 0,
  part_byte_count INTEGER NOT NULL DEFAULT 0,

  manifest_object_ref TEXT,
  final_checksum_sha256 TEXT,
  final_record_count INTEGER NOT NULL DEFAULT 0,
  final_byte_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  late_arriving_count INTEGER NOT NULL DEFAULT 0,

  cleanup_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
    cleanup_status IN ('not_required', 'queued', 'running', 'completed', 'failed')
  ),
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logging_message_export_builds_job
  ON logging_message_export_builds(message_job_id, phase, partition_index);

CREATE INDEX IF NOT EXISTS idx_logging_message_export_builds_export
  ON logging_message_export_builds(export_job_id, phase, partition_index);

CREATE TABLE IF NOT EXISTS logging_message_repair_findings (
  id TEXT PRIMARY KEY,
  message_job_id TEXT,
  finding_type TEXT NOT NULL CHECK (
    finding_type IN (
      'stuck_claim',
      'expired_queued',
      'expired_retrying',
      'missing_payload_object',
      'missing_export_part',
      'orphan_staging_object',
      'event_job_mismatch',
      'blocked_configuration'
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  status TEXT NOT NULL CHECK (
    status IN ('open', 'safe_repaired', 'dangerous_previewed', 'dangerous_applied', 'ignored')
  ),
  safe_action TEXT,
  dangerous_action TEXT,
  impact_json TEXT,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER,
  applied_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_logging_message_repair_findings_status
  ON logging_message_repair_findings(status, severity, detected_at);

CREATE INDEX IF NOT EXISTS idx_logging_message_repair_findings_job
  ON logging_message_repair_findings(message_job_id, status);
