-- Fresh-install Control Plane topology contract for logging/storage message jobs.
-- Existing topology rows are intentionally not migrated because this architecture does not provide
-- an in-place upgrade path.

DROP TABLE IF EXISTS logging_message_jobs;

CREATE TABLE logging_message_jobs (
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
    topology_type IN ('platform', 'control_plane_d1', 'external_db', 'unknown')
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

CREATE INDEX idx_logging_message_jobs_due
  ON logging_message_jobs(status, not_before, priority, created_at);

CREATE INDEX idx_logging_message_jobs_claimed
  ON logging_message_jobs(status, claimed_until, lane, priority);

CREATE INDEX idx_logging_message_jobs_scope_status
  ON logging_message_jobs(scope_key, status, created_at);

CREATE INDEX idx_logging_message_jobs_tenant
  ON logging_message_jobs(tenant_key, kind, status, created_at);

CREATE INDEX idx_logging_message_jobs_source
  ON logging_message_jobs(source_type, source_id);

CREATE INDEX idx_logging_message_jobs_chain
  ON logging_message_jobs(root_job_id, parent_job_id, depth);
