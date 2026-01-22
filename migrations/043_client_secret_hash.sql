-- =============================================================================
-- Migration 043: Rename client_secret to client_secret_hash
-- =============================================================================
-- Security improvement: Store client secrets as SHA-256 hashes instead of
-- plain text. This prevents exposure of secrets if the database is compromised.
--
-- Migration approach:
-- 1. Add new client_secret_hash column
-- 2. Run migration script to convert existing secrets to hashes
-- 3. Drop old client_secret column (in separate migration after verification)
--
-- IMPORTANT: After applying this migration, run the data conversion script:
--   pnpm run migrate:client-secrets
-- =============================================================================

-- Step 1: Add new column for hashed secrets
-- This allows both columns to exist during migration period
ALTER TABLE oauth_clients ADD COLUMN client_secret_hash TEXT;

-- Step 2: Create index for faster lookups (optional, hash lookups are by client_id)
-- No index needed since we always look up by client_id first

-- Note: The actual data migration (hashing existing secrets) must be done
-- via application code since SHA-256 is not available in SQLite.
-- See scripts/migrate-client-secrets.ts
