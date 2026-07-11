-- =============================================================================
-- Authrim External Postgres Migration 005: Directory Authentication
-- Consolidated for fresh Authrim installs from migrations/external/postgres/005_external_directory_identity_links.sql, migrations/external/postgres/006_external_directory_connector_fleet.sql, migrations/external/postgres/007_external_directory_connector_release_channel.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/005_external_directory_identity_links.sql
-- -----------------------------------------------------------------------------

-- Directory identity links and JIT pending users for external Postgres deployments.

CREATE TABLE IF NOT EXISTS directory_identity_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  latest_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_login_at BIGINT,
  UNIQUE (tenant_id, connector_id, directory_subject)
);

CREATE INDEX IF NOT EXISTS idx_directory_identity_links_user
  ON directory_identity_links (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS directory_jit_pending_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  login_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'linked')),
  directory_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  decided_at BIGINT,
  decided_by TEXT,
  decision_reason TEXT,
  linked_user_id TEXT,
  UNIQUE (tenant_id, connector_id, directory_subject)
);

CREATE INDEX IF NOT EXISTS idx_directory_jit_pending_users_status
  ON directory_jit_pending_users (tenant_id, status, updated_at);

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/006_external_directory_connector_fleet.sql
-- -----------------------------------------------------------------------------

-- Directory connector fleet inventory and status episodes for external Postgres deployments.

CREATE TABLE IF NOT EXISTS directory_connector_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT,
  transport TEXT NOT NULL,
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'disconnected', 'stale', 'version_mismatch', 'unhealthy', 'deactivated')),
  health_status TEXT NOT NULL,
  health_summary_json TEXT NOT NULL DEFAULT '{}',
  config_fingerprint TEXT NOT NULL,
  config_categories_json TEXT NOT NULL DEFAULT '[]',
  drift_severity TEXT NOT NULL DEFAULT 'none'
    CHECK (drift_severity IN ('none', 'warning', 'critical')),
  deactivated_at BIGINT,
  deactivated_by TEXT,
  deactivation_reason TEXT,
  updated_at BIGINT NOT NULL,
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
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  last_seen_at BIGINT NOT NULL,
  reason TEXT,
  acknowledged_at BIGINT,
  acknowledged_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_directory_connector_status_episodes_current
  ON directory_connector_status_episodes (tenant_id, connector_id, instance_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_directory_connector_status_episodes_recent
  ON directory_connector_status_episodes (tenant_id, connector_id, started_at);

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/007_external_directory_connector_release_channel.sql
-- -----------------------------------------------------------------------------

-- Add release channel metadata to Wordwarden connector fleet inventory.

ALTER TABLE directory_connector_instances
  ADD COLUMN IF NOT EXISTS release_channel TEXT NOT NULL DEFAULT 'stable';
