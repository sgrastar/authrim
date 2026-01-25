-- =============================================================================
-- Migration 020: Consent Enhancements
-- =============================================================================
-- Adds support for:
-- 1. Consent Policy Versions - Track privacy policy/TOS versions
-- 2. Granular Scopes - Store selected scopes separately
-- 3. Consent History - Audit trail for GDPR compliance
-- 4. Data Export Requests - GDPR data portability
-- =============================================================================

-- =============================================================================
-- 1. Consent Policy Versions Table
-- =============================================================================
-- Tracks versions of privacy policies, terms of service, and other policies
-- that users consent to. Enables re-consent flow when policies are updated.

CREATE TABLE IF NOT EXISTS consent_policy_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL,
  policy_type TEXT NOT NULL,  -- 'privacy_policy' | 'terms_of_service' | 'cookie_policy'
  policy_uri TEXT,
  policy_hash TEXT,           -- SHA-256 hash of policy content for integrity verification
  effective_at INTEGER NOT NULL,  -- Unix timestamp when this version becomes effective
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_type, version)
);

CREATE INDEX IF NOT EXISTS idx_consent_policy_versions_tenant
  ON consent_policy_versions(tenant_id, policy_type);
CREATE INDEX IF NOT EXISTS idx_consent_policy_versions_effective
  ON consent_policy_versions(effective_at);

-- =============================================================================
-- 2. OAuth Client Consents Table Updates
-- =============================================================================
-- Add columns for granular scopes and policy version tracking

-- Granular Scopes: JSON array of user-selected scopes
-- Example: '["openid", "profile", "email"]'
ALTER TABLE oauth_client_consents ADD COLUMN selected_scopes TEXT;

-- Policy Version Tracking: Which policy versions were agreed to
ALTER TABLE oauth_client_consents ADD COLUMN privacy_policy_version TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN tos_version TEXT;

-- Consent Version: Auto-incremented on each consent update
ALTER TABLE oauth_client_consents ADD COLUMN consent_version INTEGER DEFAULT 1;

-- Index for active consent expiration queries
CREATE INDEX IF NOT EXISTS idx_consents_expires_at_active
  ON oauth_client_consents(expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================================
-- 3. Consent History Table (GDPR Audit Trail)
-- =============================================================================
-- Records all consent changes for compliance and data export.
-- Immutable append-only log of consent events.

CREATE TABLE IF NOT EXISTS consent_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'granted' | 'updated' | 'revoked' | 'version_upgraded' | 'expired' | 'scopes_updated'
  scopes_before TEXT,    -- JSON array of previous scopes (null for initial grant)
  scopes_after TEXT,     -- JSON array of new scopes (null for revocation)
  privacy_policy_version TEXT,
  tos_version TEXT,
  ip_address_hash TEXT,  -- Hashed IP for privacy
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,    -- Additional context as JSON
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_consent_history_user
  ON consent_history(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_history_client
  ON consent_history(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_history_tenant
  ON consent_history(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_history_action
  ON consent_history(action, created_at);

-- =============================================================================
-- 4. Data Export Requests Table (GDPR Data Portability)
-- =============================================================================
-- Manages user data export requests for GDPR Article 20 compliance.
-- Supports both synchronous (small data) and asynchronous (large data) exports.

CREATE TABLE IF NOT EXISTS data_export_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed' | 'expired'
  format TEXT NOT NULL DEFAULT 'json',     -- 'json' | 'csv'
  include_sections TEXT NOT NULL,          -- JSON array: ["profile", "consents", "sessions", "audit_log", "passkeys"]
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER,                      -- Download link expiration
  file_path TEXT,                          -- R2 object path (for async exports)
  file_size INTEGER,
  error_message TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_data_export_user
  ON data_export_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_data_export_status
  ON data_export_requests(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_data_export_expires
  ON data_export_requests(expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================================
-- Rollback SQL (for reference)
-- =============================================================================
-- DROP TABLE IF EXISTS data_export_requests;
-- DROP TABLE IF EXISTS consent_history;
-- DROP TABLE IF EXISTS consent_policy_versions;
--
-- -- Remove columns from oauth_client_consents
-- -- Note: SQLite doesn't support DROP COLUMN directly in older versions
-- -- Would need to recreate the table for full rollback
