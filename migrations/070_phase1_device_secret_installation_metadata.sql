-- =============================================================================
-- Migration: 070_phase1_device_secret_installation_metadata.sql
-- Description: Add Phase 1 canonical installation metadata to Native SSO device secrets
-- =============================================================================

ALTER TABLE device_secrets ADD COLUMN installation_id TEXT;
ALTER TABLE device_secrets ADD COLUMN client_id TEXT;
ALTER TABLE device_secrets ADD COLUMN trust_group_id TEXT;
ALTER TABLE device_secrets ADD COLUMN source_installation_id TEXT;
ALTER TABLE device_secrets ADD COLUMN source_client_id TEXT;

UPDATE device_secrets
SET installation_id = id
WHERE installation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_secrets_installation
  ON device_secrets(tenant_id, installation_id);

CREATE INDEX IF NOT EXISTS idx_device_secrets_client
  ON device_secrets(tenant_id, client_id);

CREATE INDEX IF NOT EXISTS idx_device_secrets_trust_group
  ON device_secrets(tenant_id, trust_group_id);
