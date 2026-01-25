-- Phase 8.3: Check API Migration
--
-- Creates tables for:
-- 1. check_api_keys - API Key management for Check API authentication
-- 2. permission_check_audit - Audit log for permission checks

-- =============================================================================
-- Check API Keys Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS check_api_keys (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,                    -- SHA-256 hash of the API key
    key_prefix TEXT NOT NULL,                  -- First 8 chars (chk_xxxx) for identification
    allowed_operations TEXT DEFAULT '["check"]', -- JSON array: check, batch, subscribe
    rate_limit_tier TEXT DEFAULT 'moderate',   -- strict, moderate, lenient
    is_active INTEGER DEFAULT 1,
    expires_at INTEGER,                        -- Unix timestamp, NULL = no expiry
    created_by TEXT,                           -- User ID who created this key
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Index for key lookup by prefix (for identifying which key is being used)
CREATE INDEX IF NOT EXISTS idx_check_api_keys_prefix
    ON check_api_keys(key_prefix);

-- Unique index on key_hash to ensure no duplicate keys
CREATE UNIQUE INDEX IF NOT EXISTS idx_check_api_keys_hash
    ON check_api_keys(key_hash);

-- Index for listing active keys by tenant
CREATE INDEX IF NOT EXISTS idx_check_api_keys_tenant_active
    ON check_api_keys(tenant_id, is_active);

-- Index for listing keys by client
CREATE INDEX IF NOT EXISTS idx_check_api_keys_client
    ON check_api_keys(client_id);

-- =============================================================================
-- Permission Check Audit Log Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS permission_check_audit (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    subject_id TEXT NOT NULL,
    permission TEXT NOT NULL,                  -- Original permission string
    permission_json TEXT,                      -- Structured permission (if provided)
    allowed INTEGER NOT NULL,                  -- 1 = allowed, 0 = denied
    resolved_via_json TEXT NOT NULL,           -- JSON array: ["role", "rebac"]
    final_decision TEXT NOT NULL,              -- 'allow' | 'deny'
    reason TEXT,                               -- Denial reason (when denied)
    api_key_id TEXT,                           -- Which API key was used (if any)
    client_id TEXT,                            -- Client ID (from API key or token)
    checked_at INTEGER NOT NULL                -- Unix timestamp
);

-- Index for querying by tenant and subject
CREATE INDEX IF NOT EXISTS idx_pca_tenant_subject
    ON permission_check_audit(tenant_id, subject_id);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_pca_checked_at
    ON permission_check_audit(checked_at);

-- Partial index for denied checks (security monitoring)
CREATE INDEX IF NOT EXISTS idx_pca_denied
    ON permission_check_audit(tenant_id, final_decision)
    WHERE final_decision = 'deny';

-- Index for API key audit trail
CREATE INDEX IF NOT EXISTS idx_pca_api_key
    ON permission_check_audit(api_key_id)
    WHERE api_key_id IS NOT NULL;

-- =============================================================================
-- WebSocket Subscriptions Table (for DO recovery)
-- =============================================================================

CREATE TABLE IF NOT EXISTS websocket_subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    connection_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    watched_subjects TEXT DEFAULT '[]',        -- JSON array of subject IDs to watch
    watched_resources TEXT DEFAULT '[]',       -- JSON array of resource patterns
    watched_relations TEXT DEFAULT '[]',       -- JSON array of relation types
    connected_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1
);

-- Index for active subscriptions
CREATE INDEX IF NOT EXISTS idx_ws_subs_active
    ON websocket_subscriptions(is_active)
    WHERE is_active = 1;

-- Index for subject-based subscriptions
CREATE INDEX IF NOT EXISTS idx_ws_subs_subject
    ON websocket_subscriptions(subject_id, is_active);

-- Index for connection cleanup
CREATE INDEX IF NOT EXISTS idx_ws_subs_connection
    ON websocket_subscriptions(connection_id);

-- =============================================================================
-- Permission Change Audit Log Table (for PermissionChangeNotifier)
-- =============================================================================

CREATE TABLE IF NOT EXISTS permission_change_audit (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    event_type TEXT NOT NULL,                  -- 'grant', 'revoke', 'modify'
    subject_id TEXT NOT NULL,
    resource TEXT,                             -- Resource affected (optional)
    relation TEXT,                             -- Relation affected (optional)
    permission TEXT,                           -- Permission affected (optional)
    timestamp INTEGER NOT NULL,                -- Event timestamp (Unix milliseconds)
    created_at INTEGER NOT NULL                -- Record creation time (Unix seconds)
);

-- Index for querying by tenant and subject
CREATE INDEX IF NOT EXISTS idx_pcaudit_tenant_subject
    ON permission_change_audit(tenant_id, subject_id);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_pcaudit_timestamp
    ON permission_change_audit(timestamp);

-- Index for event type queries
CREATE INDEX IF NOT EXISTS idx_pcaudit_event_type
    ON permission_change_audit(tenant_id, event_type);
