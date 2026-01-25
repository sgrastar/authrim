-- =============================================================================
-- Migration: 021_anonymous_users
-- Description: Anonymous Authentication support (architecture-decisions.md §17)
-- =============================================================================
-- This migration adds support for device-based anonymous authentication with
-- upgrade capability to registered users.
--
-- Key features:
-- - Device-to-user mapping with hashed identifiers
-- - Upgrade history tracking for audit
-- - No DEFAULT on tenant_id (multi-tenant safety)
-- =============================================================================

-- Anonymous device mapping table
-- Stores device identifiers separately from users_core for security
-- Device IDs are stored as HMAC-SHA256 hashes, never in plaintext
CREATE TABLE IF NOT EXISTS anonymous_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,  -- No DEFAULT: enforced at application layer
  user_id TEXT NOT NULL,

  -- Device identifiers (all hashed with HMAC-SHA256)
  device_id_hash TEXT NOT NULL,         -- Primary device identifier
  installation_id_hash TEXT,            -- App installation ID (optional)
  fingerprint_hash TEXT,                -- Browser fingerprint (optional)

  -- Device metadata
  device_platform TEXT,                 -- 'ios' | 'android' | 'web' | 'other'
  device_stability TEXT NOT NULL DEFAULT 'installation',  -- 'session' | 'installation' | 'device'

  -- Lifecycle
  expires_at INTEGER,                   -- Client-configured expiration (null = never)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  is_active INTEGER DEFAULT 1,          -- Soft delete flag

  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

-- Indexes for anonymous_devices
CREATE INDEX IF NOT EXISTS idx_anon_devices_tenant ON anonymous_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_anon_devices_device_hash ON anonymous_devices(tenant_id, device_id_hash);
CREATE INDEX IF NOT EXISTS idx_anon_devices_user ON anonymous_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_anon_devices_expires ON anonymous_devices(expires_at) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_anon_devices_last_used ON anonymous_devices(last_used_at) WHERE is_active = 1;

-- Upgrade history table
-- Records upgrade history for analytics, audit, and rollback support
CREATE TABLE IF NOT EXISTS user_upgrades (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,  -- No DEFAULT: enforced at application layer

  -- User references
  anonymous_user_id TEXT NOT NULL,      -- Original anonymous user ID
  upgraded_user_id TEXT NOT NULL,       -- New user ID (same if preserve_sub=true)

  -- Upgrade details
  upgrade_method TEXT NOT NULL,         -- 'email' | 'passkey' | 'social' | 'phone'
  provider_id TEXT,                     -- For social login (e.g., 'google', 'github')

  -- Options used
  preserve_sub INTEGER DEFAULT 1,       -- Whether sub was preserved

  -- Lifecycle
  upgraded_at INTEGER NOT NULL,
  data_migrated INTEGER DEFAULT 0,      -- Whether app_data was migrated

  FOREIGN KEY (anonymous_user_id) REFERENCES users_core(id)
);

-- Indexes for user_upgrades
CREATE INDEX IF NOT EXISTS idx_upgrades_tenant ON user_upgrades(tenant_id);
CREATE INDEX IF NOT EXISTS idx_upgrades_anon ON user_upgrades(anonymous_user_id);
CREATE INDEX IF NOT EXISTS idx_upgrades_upgraded ON user_upgrades(upgraded_user_id);
CREATE INDEX IF NOT EXISTS idx_upgrades_method ON user_upgrades(tenant_id, upgrade_method);
CREATE INDEX IF NOT EXISTS idx_upgrades_time ON user_upgrades(tenant_id, upgraded_at);
