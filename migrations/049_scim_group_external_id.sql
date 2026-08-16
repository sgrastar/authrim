-- Migration: 049_scim_group_external_id.sql
-- Description: Store the SCIM Group externalId attribute on roles.
-- Author: Authrim
-- Date: 2026-08-15

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE roles ADD COLUMN external_id TEXT;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- ALTER TABLE roles DROP COLUMN external_id;
-- DELETE FROM schema_migrations WHERE version = 49;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 049
-- =============================================================================
