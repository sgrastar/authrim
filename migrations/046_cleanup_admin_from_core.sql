-- =============================================================================
-- Migration: 046_cleanup_admin_from_core.sql
-- =============================================================================
-- Description: Remove Admin users from D1_CORE as part of Admin/EndUser separation.
--              Admin users are now stored in DB_ADMIN database.
--
-- IMPORTANT: Run this migration ONLY after:
--   1. DB_ADMIN is fully operational
--   2. All Admin users have been migrated/recreated in DB_ADMIN
--   3. Admin authentication is working via DB_ADMIN
--
-- What this migration does:
--   1. Delete all users with user_type='admin' from users_core
--   2. Cascade deletes: role_assignments (ON DELETE CASCADE)
--   3. Note: users_pii cleanup is separate (different database)
--
-- This is a DESTRUCTIVE migration. Ensure backups are in place.
-- =============================================================================

-- =============================================================================
-- Pre-flight check: Count Admin users to be deleted
-- =============================================================================
-- Run this query first to see how many records will be affected:
-- SELECT COUNT(*) FROM users_core WHERE user_type = 'admin';

-- =============================================================================
-- 1. Delete Admin users from users_core
-- =============================================================================
-- role_assignments will be automatically deleted due to ON DELETE CASCADE
-- Other related records (passkeys, sessions via Durable Objects) are already
-- handled by DB_ADMIN.

DELETE FROM users_core WHERE user_type = 'admin';

-- =============================================================================
-- 2. Clean up any orphaned role_assignments (safety measure)
-- =============================================================================
-- This handles any role_assignments that might have been missed by CASCADE

DELETE FROM role_assignments
WHERE subject_id NOT IN (SELECT id FROM users_core);

-- =============================================================================
-- 3. Update user_type column comment (documentation)
-- =============================================================================
-- The 'admin' value is now deprecated. Valid values are:
--   - end_user: Regular end user (default)
--   - m2m: Machine-to-machine client
--   - anonymous: Anonymous/guest user
--
-- Note: SQLite doesn't support ALTER COLUMN for comments, so this is just
-- documentation. The column remains unchanged for backward compatibility.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- After running this migration:
--   1. Verify no admin users remain: SELECT COUNT(*) FROM users_core WHERE user_type = 'admin';
--   2. Run users_pii cleanup migration on D1_PII database
--   3. Update any code that references user_type='admin' in D1_CORE
-- =============================================================================
