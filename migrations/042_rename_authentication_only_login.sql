-- Migration: 042_rename_authentication_only_login.sql
-- Description: Clarify that the built-in login Flow controls authentication, not protocol consent.
-- Date: 2026-07-31

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

UPDATE flows
SET
  name = 'Authentication-only Login',
  display_name = 'Authentication-only Login',
  updated_by = 'system',
  updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE id = 'flow-default-login-no-consent'
  AND tenant_id = 'default'
  AND slug = 'default-login-no-consent'
  AND deleted_at IS NULL;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- UPDATE flows
-- SET
--   name = 'Login (No consent)',
--   display_name = 'Login (No consent)',
--   updated_by = 'system',
--   updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
-- WHERE id = 'flow-default-login-no-consent'
--   AND tenant_id = 'default'
--   AND slug = 'default-login-no-consent'
--   AND deleted_at IS NULL;
-- DELETE FROM schema_migrations WHERE version = 42;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 042
-- =============================================================================
