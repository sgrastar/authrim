-- Migration: 003_screen_responses.sql
-- Description: Response records of login screens: a signed-in person's answers to the parts kept
--              off the profile whose answers go to the record (`answer_targets` includes
--              `record`). One row per visit of a Flow screen step, in the person's PII database;
--              deleted with the account and with the tenant.
-- Author: @authrim
-- Date: 2026-11-07
-- Issue: Admin console screens (answer storage)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE screen_responses (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  screen_key TEXT NOT NULL,
  flow_id TEXT,
  flow_version_id TEXT,
  interaction_id TEXT,
  step_id TEXT,
  -- The answers by part field: { [field]: string | boolean }.
  answers_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- A screen's responses, newest first (the Admin API pages through them).
CREATE INDEX idx_screen_responses_screen
  ON screen_responses (tenant_id, screen_id, created_at, id);
-- A person's responses (account deletion and export).
CREATE INDEX idx_screen_responses_user
  ON screen_responses (tenant_id, user_id, created_at);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP INDEX idx_screen_responses_user;
-- DROP INDEX idx_screen_responses_screen;
-- DROP TABLE screen_responses;
-- DELETE FROM schema_migrations WHERE version = 3;
