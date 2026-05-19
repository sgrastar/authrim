-- Internal notification event queue for storage/registry/security-critical events.
-- External webhook/email delivery is intentionally deferred; this table is the first
-- durable delivery target for operator-visible events.

CREATE TABLE IF NOT EXISTS internal_notification_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'storage_registry_security',
      'storage_registry_health',
      'tenant_database_stats',
      'tenant_database_health'
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
