-- Migration: Add created_at and updated_at columns to users_pii_tombstone
-- Purpose: Fix schema mismatch with TombstoneRepository

-- Add created_at column
ALTER TABLE users_pii_tombstone ADD COLUMN created_at INTEGER;

-- Add updated_at column
ALTER TABLE users_pii_tombstone ADD COLUMN updated_at INTEGER;

-- Set default values for existing rows
UPDATE users_pii_tombstone SET created_at = deleted_at WHERE created_at IS NULL;
UPDATE users_pii_tombstone SET updated_at = deleted_at WHERE updated_at IS NULL;
