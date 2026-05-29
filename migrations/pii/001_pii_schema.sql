-- =============================================================================
-- Authrim PII Baseline Schema
-- Consolidated for fresh Authrim installs from pii/001_pii_initial.sql, pii/002_pii_log_tables.sql, pii/003_tombstone_timestamps.sql, pii/004_cleanup_admin_from_pii.sql, pii/005_tenant_scope_linked_identities.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: pii/001_pii_initial.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: PII Database Initial Schema (D1_PII)
-- =============================================================================
-- Created: 2025-12-17
-- Description: Initial schema for PII (Personal Identifiable Information) database.
--              Part of PII/Non-PII database separation architecture.
--
-- IMPORTANT: This migration is for D1_PII (separate from main D1_CORE).
--            Apply to the PII-specific D1 database.
--
-- Tables:
-- - users_pii: Personal information (email, name, address, etc.)
-- - subject_identifiers: Pairwise Subject Identifiers
-- - linked_identities: External IdP linking
-- - audit_log_pii: PII access audit trail
-- - users_pii_tombstone: GDPR deletion tracking
--
-- PII Sensitivity Classes:
-- - IDENTITY_CORE: email, phone (required for auth)
-- - PROFILE: name, picture (OIDC standard claims)
-- - DEMOGRAPHIC: gender, birthdate (GDPR Art.9 sensitive)
-- - LOCATION: address claims
-- - HIGH_RISK: gov-id, biometrics (future)
-- =============================================================================

-- =============================================================================
-- Migration Management (same structure as D1_CORE)
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  execution_time_ms INTEGER,
  rollback_sql TEXT
);

CREATE TABLE IF NOT EXISTS migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);

INSERT INTO migration_metadata (id, current_version, environment)
SELECT 'global', 0, 'development'
WHERE NOT EXISTS (
  SELECT 1
  FROM migration_metadata
  WHERE id = 'global'
);

-- =============================================================================
-- users_pii Table (PII Data)
-- =============================================================================
-- Personal information stored in D1_PII database.
-- Contains all OIDC standard claims that constitute PII.
--
-- Design decisions:
-- - id: Same as users_core.id (logical FK, no SQL FK since separate DB)
-- - email_blind_index: For searching without storing plaintext in indexes
-- - pii_class: Sensitivity classification for access control
-- - declared_residence: User-declared country (trusted for partition routing)
-- =============================================================================

CREATE TABLE IF NOT EXISTS users_pii (
  -- Primary key (same as users_core.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- PII sensitivity classification
  -- IDENTITY_CORE | PROFILE | DEMOGRAPHIC | LOCATION | HIGH_RISK
  pii_class TEXT NOT NULL DEFAULT 'PROFILE',

  -- Email (IDENTITY_CORE)
  email TEXT NOT NULL,

  -- Blind index for email search (HMAC-SHA256 of normalized email)
  -- Allows searching without exposing plaintext in query logs
  email_blind_index TEXT,

  -- Phone (IDENTITY_CORE)
  phone_number TEXT,

  -- Name claims (PROFILE)
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,

  -- Profile URL (PROFILE)
  profile TEXT,
  picture TEXT,
  website TEXT,

  -- Demographic (DEMOGRAPHIC - GDPR Art.9 sensitive)
  gender TEXT,
  birthdate TEXT,

  -- Locale (PROFILE)
  locale TEXT,
  zoneinfo TEXT,

  -- Address claims (LOCATION)
  address_formatted TEXT,
  address_street_address TEXT,
  address_locality TEXT,
  address_region TEXT,
  address_postal_code TEXT,
  address_country TEXT,

  -- User-declared residence (for partition routing, HIGH TRUST)
  declared_residence TEXT,

  -- Custom attributes (JSON)
  custom_attributes_json TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- Indexes for users_pii
-- =============================================================================

-- Email lookup via blind index (unique per tenant)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pii_email
  ON users_pii(tenant_id, email_blind_index);

-- Tenant lookup
CREATE INDEX IF NOT EXISTS idx_users_pii_tenant
  ON users_pii(tenant_id);

-- PII class filter (for access control)
CREATE INDEX IF NOT EXISTS idx_users_pii_class
  ON users_pii(pii_class);

-- =============================================================================
-- subject_identifiers Table (Pairwise Subject Identifier)
-- =============================================================================
-- OIDC Pairwise Subject Identifier storage.
-- Generates different `sub` claim per client/sector.
--
-- Purpose:
-- - Privacy protection: Prevents client-side user correlation
-- - OIDC compliance: RFC 8693 pairwise identifier support
-- =============================================================================

CREATE TABLE IF NOT EXISTS subject_identifiers (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- User reference (logical FK to users_core.id)
  user_id TEXT NOT NULL,

  -- Client ID that requested this subject
  client_id TEXT NOT NULL,

  -- Sector identifier (domain for pairwise calculation)
  sector_identifier TEXT NOT NULL,

  -- The pairwise subject value
  subject TEXT NOT NULL,

  -- Timestamp
  created_at INTEGER NOT NULL
);

-- =============================================================================
-- Indexes for subject_identifiers
-- =============================================================================

-- Unique constraint: one subject per user per sector
CREATE UNIQUE INDEX IF NOT EXISTS idx_subject_ids_unique
  ON subject_identifiers(user_id, sector_identifier);

-- Lookup by subject value
CREATE INDEX IF NOT EXISTS idx_subject_ids_subject
  ON subject_identifiers(subject);

-- Client lookup
CREATE INDEX IF NOT EXISTS idx_subject_ids_client
  ON subject_identifiers(client_id);

-- =============================================================================
-- linked_identities Table (External IdP Linking)
-- =============================================================================
-- Links local users to external Identity Provider accounts.
-- Supports federation scenarios (Google, Microsoft, SAML, etc.)
--
-- Purpose:
-- - Account linking: Multiple IdPs per user
-- - Session management: Track last used IdP
-- - Attribute synchronization: Store IdP-provided claims
-- =============================================================================

CREATE TABLE IF NOT EXISTS linked_identities (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- User reference (logical FK to users_core.id)
  user_id TEXT NOT NULL,

  -- External IdP identifier
  provider_id TEXT NOT NULL,

  -- User ID from the external IdP
  provider_user_id TEXT NOT NULL,

  -- Email from external IdP (may differ from primary email)
  provider_email TEXT,

  -- Name from external IdP
  provider_name TEXT,

  -- Raw attributes from IdP (JSON, for debugging/sync)
  raw_attributes TEXT,

  -- Timestamps
  linked_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- =============================================================================
-- Indexes for linked_identities
-- =============================================================================

-- Unique constraint: one link per tenant/provider/provider_user_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_ids_provider
  ON linked_identities(tenant_id, provider_id, provider_user_id);

-- User lookup (find all linked IdPs for a user)
CREATE INDEX IF NOT EXISTS idx_linked_ids_user
  ON linked_identities(user_id);

-- Tenant-scoped lookup for authentication/linking
CREATE INDEX IF NOT EXISTS idx_linked_ids_tenant_user
  ON linked_identities(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_linked_ids_provider_sub
  ON linked_identities(provider_id, provider_user_id);

-- Provider email lookup (for account matching)
CREATE INDEX IF NOT EXISTS idx_linked_ids_email
  ON linked_identities(provider_email);

-- =============================================================================
-- audit_log_pii Table (PII Access Audit)
-- =============================================================================
-- Tracks all PII access for compliance auditing.
--
-- IMPORTANT: Audit logs have different lifecycle than PII data:
-- - Retention: 1-7 years (vs PII subject to deletion)
-- - Volume: Grows explosively
-- - Export: SIEM integration, compliance reports
--
-- Design decisions:
-- - This table is a "recent buffer"
-- - Periodically export to R2/Logpush/SIEM
-- - exported_at tracks export status
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log_pii (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Actor who accessed PII (user/admin/system)
  user_id TEXT,

  -- Action performed
  -- pii_accessed | pii_created | pii_updated | pii_deleted | pii_exported
  action TEXT NOT NULL,

  -- Target user whose PII was accessed
  target_user_id TEXT,

  -- Action details (JSON)
  details TEXT,

  -- Request context
  ip_address TEXT,
  user_agent TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL,

  -- Export tracking (NULL = not exported yet)
  exported_at INTEGER
);

-- =============================================================================
-- Indexes for audit_log_pii
-- =============================================================================

-- Actor lookup
CREATE INDEX IF NOT EXISTS idx_audit_pii_user
  ON audit_log_pii(user_id);

-- Target user lookup
CREATE INDEX IF NOT EXISTS idx_audit_pii_target
  ON audit_log_pii(target_user_id);

-- Action filter
CREATE INDEX IF NOT EXISTS idx_audit_pii_action
  ON audit_log_pii(action);

-- Export status (find records to export)
CREATE INDEX IF NOT EXISTS idx_audit_pii_exported
  ON audit_log_pii(exported_at);

-- Time-based queries
CREATE INDEX IF NOT EXISTS idx_audit_pii_created
  ON audit_log_pii(created_at DESC);

-- =============================================================================
-- users_pii_tombstone Table (GDPR Deletion Tracking)
-- =============================================================================
-- Tracks PII deletions for GDPR Art.17 "Right to be Forgotten" compliance.
--
-- Purpose:
-- - Audit trail: "When, who, why" deleted
-- - Re-registration prevention: Block deleted emails during retention
-- - Compliance proof: Evidence of deletion
--
-- Design decisions:
-- - NO PII stored (email already deleted)
-- - email_blind_index: For duplicate prevention only
-- - retention_until: Auto-purge date (typically 90 days)
-- =============================================================================

CREATE TABLE IF NOT EXISTS users_pii_tombstone (
  -- Primary key (same as original users_core.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Email blind index (for preventing re-registration)
  email_blind_index TEXT,

  -- Deletion timestamp
  deleted_at INTEGER NOT NULL,

  -- Actor who initiated deletion
  -- user: User requested (GDPR Art.17)
  -- admin: Admin initiated
  -- system: Automated cleanup
  deleted_by TEXT,

  -- Deletion reason
  -- user_request | admin_action | inactivity | account_abuse | data_breach_response | other
  deletion_reason TEXT,

  -- Auto-purge date (typically deleted_at + 90 days)
  retention_until INTEGER NOT NULL,

  -- Additional metadata (JSON)
  -- { request_id, ip_address, consent_reference, ... }
  deletion_metadata TEXT,

  -- Timestamps for BaseRepository compatibility
  created_at INTEGER,
  updated_at INTEGER
);

-- =============================================================================
-- Indexes for users_pii_tombstone
-- =============================================================================

-- Tenant lookup
CREATE INDEX IF NOT EXISTS idx_tombstone_tenant
  ON users_pii_tombstone(tenant_id);

-- Email duplicate check
CREATE INDEX IF NOT EXISTS idx_tombstone_email
  ON users_pii_tombstone(email_blind_index);

-- Cleanup job (find expired tombstones)
CREATE INDEX IF NOT EXISTS idx_tombstone_retention
  ON users_pii_tombstone(retention_until);

-- =============================================================================
-- user_anonymization_map Table (PII ↔ Anonymous ID Mapping)
-- =============================================================================
-- Maps real user IDs to random anonymous UUIDs.
-- When user exercises "right to be forgotten", this mapping is deleted,
-- making event_log entries truly anonymous.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_anonymization_map (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  anonymized_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_anon_map_tenant_user
  ON user_anonymization_map(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_anon_map_anon_id
  ON user_anonymization_map(anonymized_user_id);

-- =============================================================================
-- pii_log Table (Encrypted PII Change Audit)
-- =============================================================================
-- Stores encrypted records of PII changes for GDPR audit compliance.
-- Each entry records what was changed, by whom, and the legal basis.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pii_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  anonymized_user_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  affected_fields TEXT NOT NULL,
  values_r2_key TEXT,
  values_encrypted TEXT,
  encryption_key_id TEXT NOT NULL,
  encryption_iv TEXT NOT NULL,
  actor_user_id TEXT,
  actor_type TEXT NOT NULL,
  request_id TEXT,
  legal_basis TEXT,
  consent_reference TEXT,
  retention_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pii_log_tenant_user
  ON pii_log(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_pii_log_anon_user
  ON pii_log(anonymized_user_id);

CREATE INDEX IF NOT EXISTS idx_pii_log_request_id
  ON pii_log(request_id);

CREATE INDEX IF NOT EXISTS idx_pii_log_change_type
  ON pii_log(change_type);

CREATE INDEX IF NOT EXISTS idx_pii_log_retention
  ON pii_log(retention_until);

CREATE INDEX IF NOT EXISTS idx_pii_log_actor
  ON pii_log(actor_user_id);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- How to apply this migration:
--
-- 1. Create the PII database:
--    wrangler d1 create authrim-pii
--
-- 2. Apply this migration:
--    wrangler d1 execute authrim-pii --file=migrations/pii/001_pii_schema.sql
--
-- 3. Add binding to wrangler.toml:
--    [[d1_databases]]
--    binding = "DB_PII"
--    database_name = "authrim-pii"
--
-- 4. Deploy and verify
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: pii/002_pii_log_tables.sql
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- Source: pii/004_cleanup_admin_from_pii.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: 004_cleanup_admin_from_pii.sql (D1_PII)
-- =============================================================================
-- Description: Remove Admin user PII data as part of Admin/EndUser separation.
--              This migration works in conjunction with the cleanup script.
--
-- IMPORTANT: This file contains a TEMPLATE.
--            Use scripts/cleanup-admin-from-core.sh to execute properly.
--
-- The cleanup script will:
--   1. Query D1_CORE for admin user IDs
--   2. Generate DELETE statements with those IDs
--   3. Execute against D1_PII
--
-- Manual execution example:
--   DELETE FROM users_pii WHERE id IN ('admin-user-id-1', 'admin-user-id-2');
--   DELETE FROM linked_identities WHERE user_id IN ('admin-user-id-1', 'admin-user-id-2');
--   DELETE FROM subject_identifiers WHERE user_id IN ('admin-user-id-1', 'admin-user-id-2');
-- =============================================================================

-- =============================================================================
-- Template: Clean up orphaned PII records
-- =============================================================================
-- After D1_CORE cleanup, users_pii may have orphaned records.
-- These DELETE statements should be run with actual admin user IDs.

-- Placeholder: Replace {ADMIN_USER_IDS} with actual IDs from D1_CORE
-- DELETE FROM users_pii WHERE id IN ({ADMIN_USER_IDS});
-- DELETE FROM linked_identities WHERE user_id IN ({ADMIN_USER_IDS});
-- DELETE FROM subject_identifiers WHERE user_id IN ({ADMIN_USER_IDS});

-- =============================================================================
-- Alternative: Clean up orphaned records (generic approach)
-- =============================================================================
-- If you have access to both databases and can verify orphaned records,
-- you can use this approach to clean up any PII records that no longer
-- have a corresponding users_core record.
--
-- WARNING: This requires confirmation that D1_CORE cleanup has completed.

-- After cleanup is complete, verify no admin records remain:
-- SELECT COUNT(*) FROM users_pii WHERE id LIKE 'admin-%';

-- =============================================================================
-- Note on GDPR Compliance
-- =============================================================================
-- Admin users are NOT subject to GDPR user data requirements.
-- Admin PII can be deleted without tombstone records.
-- If needed for audit, create audit_log_pii entries before deletion.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: pii/005_tenant_scope_linked_identities.sql
-- -----------------------------------------------------------------------------

-- Make PII linked identities tenant-scoped.
CREATE TABLE linked_identities_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_name TEXT,
  raw_attributes TEXT,
  linked_at INTEGER NOT NULL,
  last_used_at INTEGER
);

INSERT INTO linked_identities_new (
  id, tenant_id, user_id, provider_id, provider_user_id,
  provider_email, provider_name, raw_attributes, linked_at, last_used_at
)
SELECT
  id, 'default', user_id, provider_id, provider_user_id,
  provider_email, provider_name, raw_attributes, linked_at, last_used_at
FROM linked_identities;

DROP TABLE linked_identities;
ALTER TABLE linked_identities_new RENAME TO linked_identities;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_ids_provider
  ON linked_identities(tenant_id, provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_user ON linked_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_tenant_user
  ON linked_identities(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_provider_sub
  ON linked_identities(provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_email ON linked_identities(provider_email);

-- -----------------------------------------------------------------------------
-- Source: pii/006_identity_sensitive_values.sql
-- -----------------------------------------------------------------------------

-- Canonical identity sensitive values live in the PII database. Canonical
-- profile/contact tables in the core database store only value_storage_ref values.
CREATE TABLE IF NOT EXISTS identity_sensitive_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  value_key TEXT NOT NULL,
  value_json TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'sensitive',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_type, owner_id, value_key)
);

CREATE INDEX IF NOT EXISTS idx_identity_sensitive_values_owner
  ON identity_sensitive_values(tenant_id, owner_type, owner_id, value_key, lifecycle_state);
