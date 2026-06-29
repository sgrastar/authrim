-- Directory connector fleet inventory and status episodes for Wordwarden instances.

CREATE TABLE IF NOT EXISTS directory_connector_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT,
  transport TEXT NOT NULL,
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'disconnected', 'stale', 'version_mismatch', 'unhealthy', 'deactivated')),
  health_status TEXT NOT NULL,
  health_summary_json TEXT NOT NULL DEFAULT '{}',
  config_fingerprint TEXT NOT NULL,
  config_categories_json TEXT NOT NULL DEFAULT '[]',
  drift_severity TEXT NOT NULL DEFAULT 'none'
    CHECK (drift_severity IN ('none', 'warning', 'critical')),
  deactivated_at INTEGER,
  deactivated_by TEXT,
  deactivation_reason TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, connector_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_directory_connector_instances_connector
  ON directory_connector_instances (tenant_id, connector_id, status, last_seen_at);

CREATE TABLE IF NOT EXISTS directory_connector_status_episodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'disconnected', 'stale', 'version_mismatch', 'unhealthy', 'deactivated')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  reason TEXT,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_directory_connector_status_episodes_current
  ON directory_connector_status_episodes (tenant_id, connector_id, instance_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_directory_connector_status_episodes_recent
  ON directory_connector_status_episodes (tenant_id, connector_id, started_at);
