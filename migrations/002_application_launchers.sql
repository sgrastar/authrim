-- Migration: 002_application_launchers.sql
-- Description: Add tenant launcher definitions and per-account favorites

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE application_launchers (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX idx_application_launchers_updated
  ON application_launchers (tenant_id, updated_at, id);

CREATE TABLE launcher_favorites (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  launcher_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, launcher_id)
);

CREATE INDEX idx_launcher_favorites_user
  ON launcher_favorites (tenant_id, user_id, created_at, launcher_id);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP TABLE launcher_favorites;
-- DROP TABLE application_launchers;
-- DELETE FROM schema_migrations WHERE version = 2;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 002
-- =============================================================================
