-- Migration: 018_external_anonymous_device_routing_authority.sql
-- Description: Add authoritative anonymous-device records to tenant users shards

CREATE TABLE IF NOT EXISTS anonymous_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id_hash TEXT NOT NULL CHECK (length(device_id_hash) = 64),
  installation_id_hash TEXT CHECK (installation_id_hash IS NULL OR length(installation_id_hash) = 64),
  fingerprint_hash TEXT CHECK (fingerprint_hash IS NULL OR length(fingerprint_hash) = 64),
  device_platform TEXT CHECK (device_platform IS NULL OR device_platform IN ('ios', 'android', 'web', 'other')),
  device_stability TEXT NOT NULL CHECK (device_stability IN ('session', 'installation', 'device')),
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_anonymous_devices_active_digest
  ON anonymous_devices(tenant_id, device_id_hash)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_anonymous_devices_user
  ON anonymous_devices(tenant_id, user_id, is_active, last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_anonymous_devices_expiry
  ON anonymous_devices(tenant_id, is_active, expires_at)
  WHERE expires_at IS NOT NULL;
