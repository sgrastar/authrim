-- =============================================================================
-- Migration 036: Add severity column to audit_log table
-- =============================================================================
-- Note: tenant_id column was already added in a previous migration.
-- This migration adds only the severity column for audit log filtering.
-- =============================================================================

-- Add severity column (info, warning, critical)
-- Using IF NOT EXISTS pattern via checking if column exists first
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so this may error
-- if already applied - that's expected behavior
ALTER TABLE audit_log ADD COLUMN severity TEXT DEFAULT 'info';

-- Add index for severity-based filtering
CREATE INDEX IF NOT EXISTS idx_audit_log_severity ON audit_log(severity);
