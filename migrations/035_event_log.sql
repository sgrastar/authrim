-- Migration: 035_event_log
-- Purpose: Create event_log table for audit logging (non-PII)
-- Date: 2024-01-02
--
-- This table stores audit events without PII for compliance and debugging.
-- Detailed data is stored in R2 if > 2KB (referenced via details_r2_key).
--
-- Time units: All timestamps are epoch milliseconds.

-- =============================================================================
-- Event Log Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS event_log (
  -- Primary key
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,

  -- Search axes (indexed columns)
  event_type TEXT NOT NULL,         -- e.g., 'auth.login', 'token.issued', 'user.pii_purge_started'
  event_category TEXT NOT NULL,     -- 'auth', 'token', 'consent', 'user', 'client', 'admin', 'security', 'system', 'audit'
  result TEXT NOT NULL,             -- 'success' | 'failure' | 'partial'
  error_code TEXT,                  -- Error code if result is 'failure' (e.g., 'invalid_grant')
  error_message TEXT,               -- Sanitized error message (max 1024 chars)
  severity TEXT NOT NULL DEFAULT 'info', -- 'debug', 'info', 'warn', 'error', 'critical'

  -- Correlation IDs
  anonymized_user_id TEXT,          -- Random UUID from user_anonymization_map (not real user ID!)
  client_id TEXT,                   -- OAuth client ID
  session_id TEXT,                  -- Session ID for correlation
  request_id TEXT,                  -- Request ID for correlation

  -- Performance metrics
  duration_ms INTEGER,              -- Operation duration in milliseconds

  -- Details storage (R2 or inline)
  details_r2_key TEXT,              -- R2 key if details > 2KB: 'event-details/{tenantId}/{date}/{entryId}.json'
  details_json TEXT,                -- Inline JSON if details <= 2KB

  -- Retention management
  retention_until INTEGER,          -- Expiry timestamp (epoch milliseconds)

  -- Timestamps (epoch milliseconds)
  created_at INTEGER NOT NULL
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Primary query: Filter by tenant and time range
CREATE INDEX IF NOT EXISTS idx_event_log_tenant_time
  ON event_log(tenant_id, created_at DESC);

-- Filter by event type
CREATE INDEX IF NOT EXISTS idx_event_log_type
  ON event_log(event_type);

-- Filter by anonymized user ID (for user activity timeline)
CREATE INDEX IF NOT EXISTS idx_event_log_anon_user
  ON event_log(anonymized_user_id);

-- Filter by request ID (for request correlation)
CREATE INDEX IF NOT EXISTS idx_event_log_request_id
  ON event_log(request_id);

-- Filter by result (for failure analysis)
CREATE INDEX IF NOT EXISTS idx_event_log_result
  ON event_log(result);

-- Filter by severity (for alerting)
CREATE INDEX IF NOT EXISTS idx_event_log_severity
  ON event_log(severity);

-- Cleanup: Find expired entries
CREATE INDEX IF NOT EXISTS idx_event_log_retention
  ON event_log(retention_until);

-- =============================================================================
-- Comments
-- =============================================================================

-- Note: All time values are epoch milliseconds:
--   - created_at: When the event occurred
--   - retention_until: When this record should be deleted
--
-- Note: anonymized_user_id is NOT the real user ID.
-- It's a random UUID from user_anonymization_map table in D1_PII.
-- When the user is deleted, the mapping is removed, making the events truly anonymous.
--
-- Note: details_json should be sanitized to remove:
--   1. PII fields as defined in tenant config
--   2. Secret fields (authorization, cookie, token, password, etc.)
--   3. Query strings from request paths
