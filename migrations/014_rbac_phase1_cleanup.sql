-- Migration: 014_rbac_phase1_cleanup.sql
-- Description: Clean up parent_user_id index after migration to relationships table
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Drop parent_user_id index
-- =============================================================================
-- The parent_user_id column is deprecated in favor of the relationships table.
-- We drop the index but keep the column for backwards compatibility.
-- The column can be removed in a future migration after all code is updated.

DROP INDEX IF EXISTS idx_users_parent_user_id;

-- =============================================================================
-- 2. Note: parent_user_id column is NOT dropped
-- =============================================================================
-- SQLite has limitations on ALTER TABLE DROP COLUMN in older versions.
-- More importantly, keeping the column ensures backwards compatibility
-- during the transition period.
--
-- To remove the column in the future:
-- 1. Ensure no code references parent_user_id
-- 2. Create a new users table without the column
-- 3. Copy data from old table to new table
-- 4. Drop old table and rename new table
--
-- For now, the column remains but should not be used for new records.

-- =============================================================================
-- 3. Verification query (commented out, for manual verification)
-- =============================================================================
-- Run this query to verify all parent_user_id values have been migrated:
--
-- SELECT u.id, u.parent_user_id
-- FROM users u
-- WHERE u.parent_user_id IS NOT NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM relationships r
--     WHERE r.from_id = u.parent_user_id
--       AND r.to_id = u.id
--       AND r.relationship_type = 'parent_child'
--   );
--
-- This query should return 0 rows if migration was successful.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 014
-- =============================================================================
