-- Migration: 032_user_status_columns
-- Description: Add user status columns for suspend/lock functionality
-- Date: 2026-01-04

-- =============================================================================
-- Add status columns to users table
-- =============================================================================
-- Required for suspend/lock API functionality (Phase 1 Admin SDK)
-- Status: 'active' (default) | 'suspended' | 'locked'

-- Add status column with default value
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked'));

-- Add suspension tracking columns
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
ALTER TABLE users ADD COLUMN suspended_until INTEGER;

-- Add lock tracking columns
ALTER TABLE users ADD COLUMN locked_at INTEGER;

-- Note: locked_until already exists in original schema (line 129 of 001_consolidated_schema.sql)

-- Create index for status-based queries
CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users(tenant_id, status);

-- =============================================================================
-- Fix operational_logs table schema mismatch
-- =============================================================================
-- The code expects different column names than what was defined in 031_security_and_operational.sql
-- Need to recreate the table with correct column names

-- Drop the incorrectly defined table and recreate with correct schema
DROP TABLE IF EXISTS operational_logs;

CREATE TABLE IF NOT EXISTS operational_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,  -- Code expects: 'user', 'client', 'session'
    subject_id TEXT NOT NULL,    -- Code expects this name, not 'resource_id'
    actor_id TEXT NOT NULL,      -- Who performed the operation
    action TEXT NOT NULL,        -- 'user.suspend', 'user.lock', etc.
    reason_detail_encrypted TEXT,-- AES-GCM encrypted reason_detail
    encryption_key_version INTEGER NOT NULL DEFAULT 1, -- Code expects this column
    request_id TEXT,             -- X-Request-ID header value
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, -- When this log should be deleted

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Recreate indexes for operational logs
CREATE INDEX IF NOT EXISTS idx_operational_logs_tenant_created
    ON operational_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_logs_subject
    ON operational_logs(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_operational_logs_expires
    ON operational_logs(expires_at);
CREATE INDEX IF NOT EXISTS idx_operational_logs_actor
    ON operational_logs(actor_id);

-- =============================================================================
-- Update users_core table (for PII-separated architecture)
-- =============================================================================
-- Also add status columns to users_core for consistency

ALTER TABLE users_core ADD COLUMN status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked'));
ALTER TABLE users_core ADD COLUMN suspended_at INTEGER;
ALTER TABLE users_core ADD COLUMN suspended_until INTEGER;
ALTER TABLE users_core ADD COLUMN locked_at INTEGER;
ALTER TABLE users_core ADD COLUMN locked_until INTEGER;

-- Index for status queries on users_core
CREATE INDEX IF NOT EXISTS idx_users_core_status ON users_core(tenant_id, status);
