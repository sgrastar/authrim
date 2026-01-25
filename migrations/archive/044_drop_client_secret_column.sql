-- =============================================================================
-- Migration 044: Drop old client_secret column
-- =============================================================================
-- IMPORTANT: Only run this migration AFTER verifying all secrets have been
-- migrated to client_secret_hash. This is a destructive operation.
--
-- Pre-requisites:
-- 1. Migration 043_client_secret_hash.sql has been applied
-- 2. migrate-client-secrets script has been run successfully
-- 3. Verified: SELECT COUNT(*) FROM oauth_clients WHERE client_secret IS NOT NULL = 0
-- =============================================================================

-- SQLite doesn't support DROP COLUMN directly in older versions.
-- D1 (SQLite 3.35.0+) supports ALTER TABLE DROP COLUMN.
ALTER TABLE oauth_clients DROP COLUMN client_secret;
