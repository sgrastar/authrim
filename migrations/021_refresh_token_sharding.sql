-- Migration: 021_refresh_token_sharding.sql
-- Description: Add tables for RefreshTokenRotator sharding support (Phase 6.5: High RPS Optimization)
-- Author: Claude
-- Date: 2025-12-04

-- =============================================================================
-- 1. User Token Families Table (Slimmed for High RPS)
-- =============================================================================
-- Purpose: Index table for user-wide token revocation
-- Optimized for high RPS: NO D1 access during token rotation
--
-- D1 Access Pattern:
--   INSERT: Token issuance only
--   UPDATE: Token revocation only (is_revoked = 1)
--   SELECT: User-wide revocation (get all families for a user)
--   ROTATION: No D1 access (DO storage only)

CREATE TABLE IF NOT EXISTS user_token_families (
  jti TEXT PRIMARY KEY,               -- JTI as primary key (v{gen}_{shard}_{random})
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,              -- References users(id)
  client_id TEXT NOT NULL,            -- References clients(id)
  generation INTEGER NOT NULL,        -- Shard generation (0 = legacy)
  expires_at INTEGER NOT NULL,        -- Token expiration timestamp (ms)
  is_revoked INTEGER DEFAULT 0,       -- 0 = active, 1 = revoked

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Note: Removed columns for high RPS optimization:
--   - shard_index: Calculated from JTI (v1_3_... -> shard=3)
--   - created_at: Not needed (audit_log handles this)
--   - last_rotated_at: Not needed (rotation doesn't touch D1)
--   - revoked_at: Not needed (audit_log handles this)
--   - revoke_reason: Not needed (audit_log handles this)

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_utf_tenant_user
  ON user_token_families(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_utf_tenant_client
  ON user_token_families(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_utf_user_client
  ON user_token_families(user_id, client_id);
CREATE INDEX IF NOT EXISTS idx_utf_expires
  ON user_token_families(expires_at);
CREATE INDEX IF NOT EXISTS idx_utf_generation
  ON user_token_families(generation);
CREATE INDEX IF NOT EXISTS idx_utf_active_tokens
  ON user_token_families(user_id, client_id, is_revoked)
  WHERE is_revoked = 0;

-- =============================================================================
-- 2. Refresh Token Shard Configs Table (Audit)
-- =============================================================================
-- Purpose: Track shard configuration history for audit purposes
-- Primary configuration is stored in KV for fast access

CREATE TABLE IF NOT EXISTS refresh_token_shard_configs (
  id TEXT PRIMARY KEY,                -- UUID
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,                     -- NULL = global config
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,      -- When this config was activated (ms)
  deprecated_at INTEGER,              -- When this config was deprecated (ms)
  created_by TEXT,                    -- Admin user who created this config
  notes TEXT,                         -- Human-readable notes

  UNIQUE(tenant_id, client_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_rtsc_tenant_client
  ON refresh_token_shard_configs(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_rtsc_generation
  ON refresh_token_shard_configs(generation);
CREATE INDEX IF NOT EXISTS idx_rtsc_activated_at
  ON refresh_token_shard_configs(activated_at);

-- =============================================================================
-- 3. Seed Default Global Configuration
-- =============================================================================
-- Initial configuration: generation=1, 8 shards (production default)

INSERT INTO refresh_token_shard_configs (
  id,
  tenant_id,
  client_id,
  generation,
  shard_count,
  activated_at,
  created_by,
  notes
) VALUES (
  'seed-default-v1',
  'default',
  NULL,  -- Global config
  1,
  8,
  unixepoch() * 1000,
  'migration',
  'Initial default configuration: 8 shards for production use'
);

-- =============================================================================
-- Migration Notes
-- =============================================================================
--
-- After applying this migration:
--
-- 1. Initialize KV configuration:
--    ```
--    wrangler kv:key put --binding=KV "refresh-token-shards:__global__" \
--      '{"currentGeneration":1,"currentShardCount":8,"previousGenerations":[],"updatedAt":...}'
--    ```
--
-- 2. For load testing with 32 shards:
--    ```
--    PUT /api/admin/refresh-token-sharding/config
--    { "shardCount": 32, "notes": "Load testing configuration" }
--    ```
--
-- 3. Legacy tokens (generation=0) will continue to work with existing DO instances.
--
-- 4. New tokens will use generation=1+ with sharded DO instances.
--
