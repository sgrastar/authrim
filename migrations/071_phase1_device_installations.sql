-- Migration: 071_phase1_device_installations.sql
-- Description: Add canonical Phase 1 Native SSO installation inventory records
-- Date: 2026-05-06

CREATE TABLE IF NOT EXISTS device_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT,
  trust_group_id TEXT,
  source_installation_id TEXT,
  source_client_id TEXT,
  linked_device_secret_id TEXT,
  session_id TEXT,
  display_name TEXT,
  device_platform TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

INSERT INTO device_installations (
  id, tenant_id, user_id, client_id, trust_group_id,
  source_installation_id, source_client_id, linked_device_secret_id,
  session_id, display_name, device_platform, created_at, updated_at,
  last_seen_at, revoked_at, revoke_reason, is_active
)
SELECT
  COALESCE(installation_id, id),
  tenant_id,
  user_id,
  client_id,
  trust_group_id,
  source_installation_id,
  source_client_id,
  id,
  session_id,
  device_name,
  device_platform,
  created_at,
  updated_at,
  COALESCE(last_used_at, updated_at, created_at),
  revoked_at,
  revoke_reason,
  is_active
FROM device_secrets
WHERE NOT EXISTS (
  SELECT 1
  FROM device_installations
  WHERE device_installations.id = COALESCE(device_secrets.installation_id, device_secrets.id)
);

CREATE INDEX IF NOT EXISTS idx_device_installations_user
  ON device_installations(tenant_id, user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_device_installations_client
  ON device_installations(tenant_id, client_id, is_active);

CREATE INDEX IF NOT EXISTS idx_device_installations_trust_group
  ON device_installations(tenant_id, trust_group_id, is_active);

CREATE INDEX IF NOT EXISTS idx_device_installations_source
  ON device_installations(tenant_id, source_installation_id, client_id);

CREATE INDEX IF NOT EXISTS idx_device_installations_linked_secret
  ON device_installations(tenant_id, linked_device_secret_id);
