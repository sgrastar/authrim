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
