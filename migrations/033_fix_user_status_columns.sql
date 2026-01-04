-- Migration: 033_fix_user_status_columns
-- Description: Fix user status columns (SQLite ALTER TABLE doesn't support CHECK constraints)
-- Date: 2026-01-04

-- =============================================================================
-- Fix status columns for users table
-- =============================================================================
-- SQLite limitation: ALTER TABLE ADD COLUMN cannot include CHECK constraints
-- Application-level validation enforces: 'active' | 'suspended' | 'locked'

-- Drop columns if they exist from failed previous migration (ignore errors)
-- Note: SQLite doesn't support DROP COLUMN in older versions, but D1 does

-- Add status column without CHECK constraint
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';

-- Add suspension tracking columns
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
ALTER TABLE users ADD COLUMN suspended_until INTEGER;

-- Add lock tracking columns
ALTER TABLE users ADD COLUMN locked_at INTEGER;

-- Create index for status-based queries
CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users(tenant_id, status);

-- =============================================================================
-- Fix status columns for users_core table (PII-separated architecture)
-- =============================================================================

ALTER TABLE users_core ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE users_core ADD COLUMN suspended_at INTEGER;
ALTER TABLE users_core ADD COLUMN suspended_until INTEGER;
ALTER TABLE users_core ADD COLUMN locked_at INTEGER;
ALTER TABLE users_core ADD COLUMN locked_until INTEGER;

-- Index for status queries on users_core
CREATE INDEX IF NOT EXISTS idx_users_core_status ON users_core(tenant_id, status);
