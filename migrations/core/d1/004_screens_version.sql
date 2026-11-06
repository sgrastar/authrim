-- Migration: 004_screens_version.sql
-- Description: Optimistic-concurrency version on screens: a change names the version it was made
--              from (If-Match) and raises it by one, so two admins cannot overwrite each other.
-- Author: @authrim
-- Date: 2026-11-06
-- Issue: Admin console screens (list and screen builder)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- Existing screens start at version 1, as new ones do.
ALTER TABLE screens ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- ALTER TABLE screens DROP COLUMN version;
-- DELETE FROM schema_migrations WHERE version = 4;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 004
-- =============================================================================
