-- =============================================================================
-- Migration: 004_cleanup_admin_from_pii.sql (D1_PII)
-- =============================================================================
-- Description: Remove Admin user PII data as part of Admin/EndUser separation.
--              This migration works in conjunction with the cleanup script.
--
-- IMPORTANT: This file contains a TEMPLATE.
--            Use scripts/cleanup-admin-from-core.sh to execute properly.
--
-- The cleanup script will:
--   1. Query D1_CORE for admin user IDs
--   2. Generate DELETE statements with those IDs
--   3. Execute against D1_PII
--
-- Manual execution example:
--   DELETE FROM users_pii WHERE id IN ('admin-user-id-1', 'admin-user-id-2');
--   DELETE FROM linked_identities WHERE user_id IN ('admin-user-id-1', 'admin-user-id-2');
--   DELETE FROM subject_identifiers WHERE user_id IN ('admin-user-id-1', 'admin-user-id-2');
-- =============================================================================

-- =============================================================================
-- Template: Clean up orphaned PII records
-- =============================================================================
-- After D1_CORE cleanup, users_pii may have orphaned records.
-- These DELETE statements should be run with actual admin user IDs.

-- Placeholder: Replace {ADMIN_USER_IDS} with actual IDs from D1_CORE
-- DELETE FROM users_pii WHERE id IN ({ADMIN_USER_IDS});
-- DELETE FROM linked_identities WHERE user_id IN ({ADMIN_USER_IDS});
-- DELETE FROM subject_identifiers WHERE user_id IN ({ADMIN_USER_IDS});

-- =============================================================================
-- Alternative: Clean up orphaned records (generic approach)
-- =============================================================================
-- If you have access to both databases and can verify orphaned records,
-- you can use this approach to clean up any PII records that no longer
-- have a corresponding users_core record.
--
-- WARNING: This requires confirmation that D1_CORE cleanup has completed.

-- After cleanup is complete, verify no admin records remain:
-- SELECT COUNT(*) FROM users_pii WHERE id LIKE 'admin-%';

-- =============================================================================
-- Note on GDPR Compliance
-- =============================================================================
-- Admin users are NOT subject to GDPR user data requirements.
-- Admin PII can be deleted without tombstone records.
-- If needed for audit, create audit_log_pii entries before deletion.
-- =============================================================================
