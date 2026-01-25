-- =============================================================================
-- Migration: 017_native_sso_device_secrets.sql
-- Description: Add OIDC Native SSO 1.0 (draft-07) support
-- =============================================================================

-- =============================================================================
-- 1. Device Secrets Table (Non-PII: only secret_hash, no personal information)
-- =============================================================================
-- Purpose: Store device secrets for Native SSO Token Exchange
-- Data Classification: Non-PII (secret_hash is one-way hash, no PII content)
-- Storage Strategy: D1 Database (no Durable Object required)

CREATE TABLE IF NOT EXISTS device_secrets (
  -- Primary key (UUID)
  id TEXT PRIMARY KEY,

  -- Tenant support (multi-tenancy)
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- User this device_secret belongs to
  user_id TEXT NOT NULL,

  -- Session binding (required for logout propagation)
  -- When session is deleted, device_secrets should be invalidated
  session_id TEXT NOT NULL,

  -- Device secret value (SHA-256 hashed for storage)
  -- Raw secret is returned only once during initial issuance
  -- validateAndUse() accepts raw secret and hashes internally
  secret_hash TEXT NOT NULL,

  -- Device identification (optional, for admin visibility)
  device_name TEXT,
  device_platform TEXT,  -- 'ios', 'android', 'macos', 'windows', 'other'

  -- Audit timestamps (BaseRepository pattern)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Expiration (configurable via Feature Flag, default: 30 days)
  expires_at INTEGER NOT NULL,

  -- Usage tracking (for anomaly detection)
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,

  -- Revocation (soft delete alternative for explicit revocation tracking)
  revoked_at INTEGER,
  revoke_reason TEXT,

  -- Soft delete flag (BaseRepository pattern)
  is_active INTEGER NOT NULL DEFAULT 1,

  -- Foreign keys
  -- Note: CASCADE on user deletion, but sessions may be deleted without CASCADE
  -- Session deletion should trigger device_secret revocation via application logic
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for efficient queries
-- Primary lookup: by secret_hash (Token Exchange validation)
CREATE INDEX IF NOT EXISTS idx_device_secrets_secret_hash
  ON device_secrets(secret_hash);

-- Tenant + user lookup: for listing user's device secrets (Admin API)
CREATE INDEX IF NOT EXISTS idx_device_secrets_tenant_user
  ON device_secrets(tenant_id, user_id);

-- Session lookup: for logout propagation (revoke by session)
CREATE INDEX IF NOT EXISTS idx_device_secrets_session_id
  ON device_secrets(session_id);

-- Expiration cleanup: for background job to cleanup expired secrets
CREATE INDEX IF NOT EXISTS idx_device_secrets_expires
  ON device_secrets(expires_at) WHERE is_active = 1;

-- =============================================================================
-- 2. OAuth Clients Extension for Native SSO
-- =============================================================================
-- Add columns to control Native SSO behavior per client

-- Enable Native SSO for this client
-- When true, Authorization Code Grant will return device_secret
ALTER TABLE oauth_clients ADD COLUMN native_sso_enabled INTEGER DEFAULT 0;

-- Allow cross-client Native SSO (Token Exchange from different client_id)
-- When true, this client can accept Token Exchange requests where
-- the ID Token was issued to a different client_id
-- Default: false (more secure, same client only)
ALTER TABLE oauth_clients ADD COLUMN allow_cross_client_native_sso INTEGER DEFAULT 0;
