-- Migration: 029_account_page_customization.sql
-- Description: Allow account-management screen presets in the reusable screens table
-- Author: Authrim
-- Date: 2026-07-22

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- SQLite/D1 cannot alter CHECK constraints in place, so rebuild the table.
CREATE TABLE screens_account_page_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  screen_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  screen_kind TEXT NOT NULL CHECK (
    screen_kind IN (
      'registration',
      'profile_completion',
      'login',
      'consent',
      'code_input',
      'account',
      'custom'
    )
  ),
  fields_json TEXT NOT NULL,
  localizations_json TEXT,
  settings_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, screen_key)
);

INSERT INTO screens_account_page_new
  (id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
   localizations_json, settings_json, is_active, is_system, created_at, updated_at)
SELECT
  id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
  localizations_json, settings_json, is_active, is_system, created_at, updated_at
FROM screens;

DROP TABLE screens;
ALTER TABLE screens_account_page_new RENAME TO screens;

CREATE INDEX IF NOT EXISTS idx_screens_kind
  ON screens(tenant_id, screen_kind, is_active);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- Rebuild screens with the pre-029 screen_kind CHECK constraint after removing
-- account screen rows from every tenant.
-- DELETE FROM schema_migrations WHERE version = 29;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 029
-- =============================================================================
