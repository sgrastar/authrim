-- Migration: 017_external_passkey_routing_authority.sql
-- Description: Persist the WebAuthn RP ID used as passkey routing authority

ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS rp_id TEXT;

CREATE INDEX IF NOT EXISTS idx_passkeys_routing_authority
  ON passkeys(tenant_id, created_at, id)
  WHERE rp_id IS NOT NULL;
