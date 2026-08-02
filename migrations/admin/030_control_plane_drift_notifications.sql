-- Add Control Worker inventory drift to the durable Admin notification queue.
-- SQLite cannot alter a CHECK constraint, so rebuild the parent table while
-- preserving all existing rows and indexes.

CREATE TABLE internal_notification_events_with_control_drift (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'storage_registry_security',
      'storage_registry_health',
      'tenant_database_stats',
      'tenant_database_health',
      'control_plane_drift',
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

INSERT INTO internal_notification_events_with_control_drift (
  id,
  tenant_id,
  category,
  event_type,
  severity,
  status,
  deduplication_key,
  payload_json,
  attempts,
  last_error,
  next_attempt_at,
  created_at,
  updated_at,
  delivered_at
)
SELECT
  id,
  tenant_id,
  category,
  event_type,
  severity,
  status,
  deduplication_key,
  payload_json,
  attempts,
  last_error,
  next_attempt_at,
  created_at,
  updated_at,
  delivered_at
FROM internal_notification_events;

DROP TABLE internal_notification_events;
ALTER TABLE internal_notification_events_with_control_drift RENAME TO internal_notification_events;

CREATE UNIQUE INDEX idx_internal_notification_events_dedup
  ON internal_notification_events(deduplication_key);

CREATE INDEX idx_internal_notification_events_pending
  ON internal_notification_events(status, severity, created_at);

CREATE INDEX idx_internal_notification_events_tenant_created
  ON internal_notification_events(tenant_id, created_at DESC);
