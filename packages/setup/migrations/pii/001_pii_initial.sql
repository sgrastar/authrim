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

INSERT OR IGNORE INTO migration_metadata (id, current_version, environment)
VALUES ('global', 0, 'development');

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

-- Unique constraint: one link per provider per provider_user_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_ids_provider
  ON linked_identities(provider_id, provider_user_id);

-- User lookup (find all linked IdPs for a user)
CREATE INDEX IF NOT EXISTS idx_linked_ids_user
  ON linked_identities(user_id);

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
--    wrangler d1 execute authrim-pii --file=migrations/pii/001_pii_initial.sql
--
-- 3. Add binding to wrangler.toml:
--    [[d1_databases]]
--    binding = "DB_PII"
--    database_name = "authrim-pii"
--
-- 4. Deploy and verify
-- =============================================================================
