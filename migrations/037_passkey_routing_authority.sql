-- Migration: 037_passkey_routing_authority.sql
-- Description: Persist the WebAuthn RP ID used as passkey routing authority
-- Date: 2026-07-30

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE passkeys ADD COLUMN rp_id TEXT;

CREATE INDEX IF NOT EXISTS idx_passkeys_routing_authority
  ON passkeys(tenant_id, created_at, id);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP INDEX IF EXISTS idx_passkeys_routing_authority;
-- ALTER TABLE passkeys DROP COLUMN rp_id;
-- DELETE FROM schema_migrations WHERE version = 37;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 037
-- =============================================================================
