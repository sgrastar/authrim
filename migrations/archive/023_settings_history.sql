-- =============================================================================
-- Migration: Settings History for Configuration Rollback
-- =============================================================================
-- Created: 2025-12-29
-- Description: Creates settings_history table to track configuration changes
--              and enable rollback to previous versions.
--
-- Features:
-- - Automatic version numbering per category
-- - Full snapshot storage for easy rollback
-- - Change diff for audit trail
-- - Actor tracking for accountability
-- - Configurable retention policy
--
-- Usage:
-- 1. GET /api/admin/settings/:category/history - List version history
-- 2. GET /api/admin/settings/:category/history/:version - Get specific version
-- 3. POST /api/admin/settings/:category/rollback - Rollback to previous version
-- =============================================================================

-- Settings history table
CREATE TABLE IF NOT EXISTS settings_history (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Category (oauth, rate_limit, logout, webhook, feature_flags, etc.)
  category TEXT NOT NULL,

  -- Version number (auto-incremented per tenant+category)
  version INTEGER NOT NULL,

  -- Full configuration snapshot (JSON)
  -- This allows complete restoration without dependencies
  snapshot TEXT NOT NULL,

  -- Change summary (JSON)
  -- { "added": [...], "removed": [...], "modified": [...] }
  changes TEXT NOT NULL,

  -- Actor who made the change
  actor_id TEXT,           -- User ID or 'system'
  actor_type TEXT,         -- 'user', 'admin', 'system', 'api'

  -- Change metadata
  change_reason TEXT,      -- Optional reason for the change
  change_source TEXT,      -- 'admin_api', 'settings_ui', 'migration', 'rollback'

  -- Timestamps
  created_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, category, version)
);

-- Index for listing history by category (most common query)
CREATE INDEX IF NOT EXISTS idx_settings_history_category ON settings_history(
  tenant_id,
  category,
  version DESC
);

-- Index for finding changes by actor
CREATE INDEX IF NOT EXISTS idx_settings_history_actor ON settings_history(
  actor_id,
  created_at DESC
);

-- Index for retention cleanup
CREATE INDEX IF NOT EXISTS idx_settings_history_cleanup ON settings_history(
  tenant_id,
  category,
  created_at
);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Deploy this migration to D1_CORE database
-- 2. Settings changes will automatically create history entries
-- 3. Use Admin API to view history and perform rollbacks
-- 4. Configure retention policy via KV (settings_history_max_versions, settings_history_retention_days)
-- =============================================================================
