-- =============================================================================
-- Migration: Admin Setup Tokens (D1_ADMIN)
-- =============================================================================
-- Created: 2025-01-25
-- Description: Creates admin_setup_tokens table for secure Admin UI passkey
--              registration during initial setup.
--
-- IMPORTANT: This migration is for D1_ADMIN (dedicated Admin database).
--
-- Use Case:
-- - After initial setup on Router, redirect to Admin UI with a setup token
-- - Admin UI verifies the token and allows passkey registration
-- - Token is single-use and time-limited for security
-- =============================================================================

-- =============================================================================
-- admin_setup_tokens Table
-- =============================================================================
-- Stores one-time setup tokens for Admin UI passkey registration.
-- These tokens allow secure passkey registration after initial setup.
--
-- Lifecycle:
-- 1. Created during initial setup (or via CLI for recovery)
-- 2. Used when admin visits Admin UI /setup/complete?token=xxx
-- 3. Invalidated after successful passkey registration
-- 4. Auto-expires after 24 hours
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_setup_tokens (
  -- Token ID (the actual token value, UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- Token status
  -- pending: Created, waiting for use
  -- used: Successfully used for passkey registration
  -- expired: Expired without use
  -- revoked: Manually revoked
  status TEXT NOT NULL DEFAULT 'pending',

  -- Expiration (UNIX timestamp in milliseconds)
  expires_at INTEGER NOT NULL,

  -- Usage tracking
  used_at INTEGER,  -- When the token was used
  used_ip TEXT,     -- IP address that used the token

  -- Audit fields
  created_at INTEGER NOT NULL,
  created_by TEXT  -- 'initial_setup' | 'cli' | admin_user_id
);

-- =============================================================================
-- Indexes for admin_setup_tokens
-- =============================================================================

-- User's tokens lookup (for checking existing tokens)
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_user ON admin_setup_tokens(admin_user_id);

-- Tenant-scoped lookup
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_tenant ON admin_setup_tokens(tenant_id);

-- Status filter (for cleanup jobs)
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_status ON admin_setup_tokens(status);

-- Expiration lookup (for cleanup jobs)
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at);

-- =============================================================================
-- admin_users: Add passkey_setup_completed column
-- =============================================================================
-- Track whether the admin user has completed passkey setup on Admin UI.
-- This is separate from having passkeys - it tracks the initial setup flow.
-- =============================================================================

ALTER TABLE admin_users ADD COLUMN passkey_setup_completed INTEGER DEFAULT 0;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Usage:
-- 1. Router creates token during initial setup
-- 2. Admin visits Admin UI with token
-- 3. Admin UI verifies token and registers passkey
-- 4. Token is marked as 'used' and passkey_setup_completed is set to 1
-- =============================================================================
