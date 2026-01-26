-- Migration: pii/002_pii_log_tables
-- Purpose: Create pii_log and user_anonymization_map tables for PII audit logging
-- Date: 2024-01-02
--
-- This migration adds:
--   1. pii_log: Encrypted log of PII changes (GDPR compliance)
--   2. user_anonymization_map: Mapping between real user IDs and anonymous IDs
--
-- Time units: All timestamps are epoch milliseconds.
-- Encryption: AES-256-GCM with per-entry IV, key rotation supported via encryption_key_id

-- =============================================================================
-- User Anonymization Mapping Table
-- =============================================================================
-- Maps real user IDs to random anonymous UUIDs.
-- When user exercises "right to be forgotten", this mapping is deleted,
-- making event_log entries truly anonymous.

CREATE TABLE IF NOT EXISTS user_anonymization_map (
  -- Primary key
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,

  -- Mapping
  user_id TEXT NOT NULL,            -- Real user ID
  anonymized_user_id TEXT NOT NULL, -- Random UUID (used in event_log.anonymized_user_id)

  -- Timestamps (epoch milliseconds)
  created_at INTEGER NOT NULL,

  -- Unique constraint: One mapping per user per tenant
  UNIQUE(tenant_id, user_id)
);

-- Lookup by tenant + user (primary query for getAnonymizedUserId)
CREATE INDEX IF NOT EXISTS idx_anon_map_tenant_user
  ON user_anonymization_map(tenant_id, user_id);

-- Reverse lookup by anonymized ID (for admin queries)
CREATE INDEX IF NOT EXISTS idx_anon_map_anon_id
  ON user_anonymization_map(anonymized_user_id);

-- =============================================================================
-- PII Log Table
-- =============================================================================
-- Stores encrypted records of PII changes for audit compliance.
-- Each entry records what was changed, by whom, and the legal basis.

CREATE TABLE IF NOT EXISTS pii_log (
  -- Primary key
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,

  -- User identifiers
  user_id TEXT NOT NULL,              -- Real user ID (this IS the PII)
  anonymized_user_id TEXT NOT NULL,   -- For correlation with event_log

  -- Change metadata
  change_type TEXT NOT NULL,          -- 'create', 'update', 'delete', 'view', 'export'
  affected_fields TEXT NOT NULL,      -- JSON array: ["email", "name"]

  -- Encrypted data storage (R2 or inline)
  values_r2_key TEXT,                 -- R2 key if > 4KB: 'pii-values/{tenantId}/{date}/{entryId}.json'
  values_encrypted TEXT,              -- Inline encrypted JSON if <= 4KB

  -- Encryption metadata (required for decryption)
  encryption_key_id TEXT NOT NULL,    -- Which key was used (for rotation)
  encryption_iv TEXT NOT NULL,        -- 12-byte nonce as Base64 (AES-GCM)
  -- Note: AAD is NOT stored. Regenerate from: `${tenantId}:${sortedAffectedFields.join(',')}`

  -- Actor information
  actor_user_id TEXT,                 -- Who made the change (null for system)
  actor_type TEXT NOT NULL,           -- 'user', 'admin', 'system', 'api'
  request_id TEXT,                    -- For correlation with event_log

  -- Legal basis (GDPR Article 6)
  legal_basis TEXT,                   -- 'consent', 'contract', 'legal_obligation', etc.
  consent_reference TEXT,             -- Consent record ID if applicable

  -- Retention management
  retention_until INTEGER NOT NULL,   -- Expiry timestamp (epoch milliseconds)

  -- Timestamps (epoch milliseconds)
  created_at INTEGER NOT NULL
);

-- =============================================================================
-- PII Log Indexes
-- =============================================================================

-- Primary query: Find PII history for a user
CREATE INDEX IF NOT EXISTS idx_pii_log_tenant_user
  ON pii_log(tenant_id, user_id);

-- Correlation with event_log via anonymized ID
CREATE INDEX IF NOT EXISTS idx_pii_log_anon_user
  ON pii_log(anonymized_user_id);

-- Request correlation
CREATE INDEX IF NOT EXISTS idx_pii_log_request_id
  ON pii_log(request_id);

-- Filter by change type (for compliance reports)
CREATE INDEX IF NOT EXISTS idx_pii_log_change_type
  ON pii_log(change_type);

-- Cleanup: Find expired entries
CREATE INDEX IF NOT EXISTS idx_pii_log_retention
  ON pii_log(retention_until);

-- Actor queries (who made changes)
CREATE INDEX IF NOT EXISTS idx_pii_log_actor
  ON pii_log(actor_user_id);

-- =============================================================================
-- Comments
-- =============================================================================

-- Encryption Notes:
--   - Algorithm: AES-256-GCM
--   - IV: 12-byte random nonce, stored as Base64 in encryption_iv
--   - AAD: Regenerated as `${tenantId}:${sortedAffectedFields.join(',')}`
--   - Key Rotation: encryption_key_id identifies which key was used
--     - Old keys kept for 90 days for decryption
--     - New entries use current key
--
-- GDPR Compliance:
--   - pii_log records what was changed, when, by whom, and why
--   - user_anonymization_map enables "right to be forgotten"
--     - Delete mapping → event_log becomes truly anonymous
--     - Delete pii_log entries → PII is removed
--   - legal_basis documents lawful processing ground
--
-- Purge Workflow (2-stage logging):
--   1. Log 'user.pii_purge_started' in event_log
--   2. DELETE FROM pii_log WHERE tenant_id = ? AND user_id = ?
--   3. DELETE FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?
--   4a. On success: Log 'user.pii_purge_completed' in event_log
--   4b. On failure: Log 'user.pii_purge_failed' in event_log
