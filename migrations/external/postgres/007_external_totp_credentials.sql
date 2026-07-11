-- =============================================================================
-- Authrim External Postgres Migration 007: TOTP Credentials
-- Consolidated for fresh Authrim installs from migrations/external/postgres/017_external_totp_credentials.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/017_external_totp_credentials.sql
-- -----------------------------------------------------------------------------

-- Migration: 017_external_totp_credentials
-- Description: Add TOTP authenticators and single-use backup codes for external durable core storage.

CREATE TABLE IF NOT EXISTS totp_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  secret_key_version BIGINT NOT NULL DEFAULT 1,
  label TEXT,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits BIGINT NOT NULL DEFAULT 6,
  period BIGINT NOT NULL DEFAULT 30,
  window BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  last_used_time_step BIGINT,
  created_at BIGINT NOT NULL,
  activated_at BIGINT,
  last_used_at BIGINT,
  CHECK (algorithm IN ('SHA1', 'SHA256')),
  CHECK (digits IN (6, 8)),
  CHECK (period BETWEEN 15 AND 300),
  CHECK (window BETWEEN 0 AND 2),
  CHECK (status IN ('pending', 'active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_totp_credentials_tenant_user
  ON totp_credentials(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_totp_credentials_active_user
  ON totp_credentials(tenant_id, user_id, status);

CREATE TABLE IF NOT EXISTS totp_backup_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  credential_id TEXT,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  used_at BIGINT,
  UNIQUE (tenant_id, user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_user
  ON totp_backup_codes(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_unused
  ON totp_backup_codes(tenant_id, user_id, used_at);
