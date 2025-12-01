-- Migration: 019_vc_did_abstraction.sql
-- Description: Create abstraction tables for future VC/DID integration
-- Author: @authrim
-- Date: 2025-12-01
-- Issue: Phase 3 - ReBAC + RBAC + ABAC Implementation (VC/DID abstraction layer)

-- =============================================================================
-- Purpose: Prepare for VC/DID Integration (Phase 4+)
-- =============================================================================
-- These tables are created now but mostly empty in Phase 3.
-- When VC/DID is implemented in Phase 4+, these tables will be populated
-- without requiring changes to the Policy Engine or ReBAC service.
--
-- Abstraction approach:
--   1. verified_attributes: Generic attribute store (VC claims write here)
--   2. subject_identifiers: Extensible identity lookup (DID mapping here)
--   3. relationships.evidence_*: VC-sourced relationship provenance
-- =============================================================================

-- =============================================================================
-- 1. Create subject_identifiers Table
-- =============================================================================
-- Maps various identifiers (email, DID, etc.) to user accounts.
-- Phase 3: email / userId only
-- Phase 4+: did:web, did:key, did:ion, did:ethr added here

CREATE TABLE subject_identifiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- User this identifier belongs to
  subject_id TEXT NOT NULL,         -- References users(id)
  -- Identifier details
  identifier_type TEXT NOT NULL,    -- 'email', 'did', 'phone', 'username'
  identifier_value TEXT NOT NULL,   -- 'user@example.com', 'did:key:z6Mk...'
  -- Flags
  is_primary INTEGER DEFAULT 0,     -- Whether this is the primary identifier
  -- Verification
  verified_at INTEGER,              -- When the identifier was verified
  verification_method TEXT,         -- 'email_verification', 'did_auth', 'phone_sms'
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 2. Indexes for subject_identifiers
-- =============================================================================

-- Lookup by subject
CREATE INDEX idx_subject_identifiers_tenant_subject
  ON subject_identifiers(tenant_id, subject_id);

-- Lookup by identifier (e.g., find user by DID)
CREATE INDEX idx_subject_identifiers_lookup
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

-- Unique constraint: one identifier per type per tenant
CREATE UNIQUE INDEX idx_subject_identifiers_unique
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

-- Primary identifier lookup
CREATE INDEX idx_subject_identifiers_primary
  ON subject_identifiers(tenant_id, subject_id, is_primary);

-- =============================================================================
-- 3. Create verified_attributes Table
-- =============================================================================
-- Stores verified attributes from various sources (VC, KYC, manual).
-- Policy Engine reads this table for ABAC conditions (attribute_equals, etc.).
-- Phase 3: Table exists but is mostly empty (used for manual attributes)
-- Phase 4+: VC/JWT-SD parsers write extracted claims here

CREATE TABLE verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Subject this attribute belongs to
  subject_id TEXT NOT NULL,         -- References users(id)
  -- Attribute details
  attribute_name TEXT NOT NULL,     -- 'age_over_18', 'medical_license', 'subscription_tier'
  attribute_value TEXT,             -- 'true', 'MD12345', 'premium'
  -- Source information (for auditing and trust evaluation)
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual', 'vc', 'jwt_sd', 'kyc_provider'
  issuer TEXT,                      -- Issuer DID or URL (Phase 4+)
  credential_id TEXT,               -- VC ID for traceability (Phase 4+)
  -- Validity
  verified_at INTEGER NOT NULL,     -- When the attribute was verified/extracted
  expires_at INTEGER,               -- When the attribute expires (from VC exp)
  revoked_at INTEGER,               -- When the attribute was revoked
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 4. Indexes for verified_attributes
-- =============================================================================

-- Lookup by subject
CREATE INDEX idx_verified_attributes_tenant_subject
  ON verified_attributes(tenant_id, subject_id);

-- Attribute lookup for Policy Engine
CREATE INDEX idx_verified_attributes_lookup
  ON verified_attributes(tenant_id, subject_id, attribute_name);

-- Source filtering (e.g., find all VC-sourced attributes)
CREATE INDEX idx_verified_attributes_source
  ON verified_attributes(tenant_id, source);

-- Expiration check
CREATE INDEX idx_verified_attributes_expires
  ON verified_attributes(tenant_id, expires_at);

-- Unique constraint: one attribute value per name per subject
-- (allows multiple sources for the same attribute name)
CREATE INDEX idx_verified_attributes_unique_check
  ON verified_attributes(tenant_id, subject_id, attribute_name, source);

-- =============================================================================
-- 5. Add evidence columns to relationships table
-- =============================================================================
-- Track the provenance of relationships (manual vs VC-sourced)
-- Phase 3: All values are 'manual'
-- Phase 4+: VC-derived relationships set evidence_type = 'vc'

ALTER TABLE relationships ADD COLUMN evidence_type TEXT DEFAULT 'manual';
-- Values: 'manual', 'vc', 'external_assertion', 'system_derived'

ALTER TABLE relationships ADD COLUMN evidence_ref TEXT;
-- Reference to the evidence (VC credential_id, external system ID, etc.)

-- Index for filtering by evidence type
CREATE INDEX idx_relationships_evidence_type
  ON relationships(tenant_id, evidence_type);

-- =============================================================================
-- 6. Seed existing users' email as subject_identifiers
-- =============================================================================
-- Migrate existing user emails to subject_identifiers for unified lookup

INSERT INTO subject_identifiers (
  id,
  tenant_id,
  subject_id,
  identifier_type,
  identifier_value,
  is_primary,
  verified_at,
  verification_method,
  created_at,
  updated_at
)
SELECT
  'sid_' || lower(hex(randomblob(16))) as id,
  u.tenant_id,
  u.id as subject_id,
  'email' as identifier_type,
  u.email as identifier_value,
  1 as is_primary,
  CASE WHEN u.email_verified = 1 THEN u.created_at ELSE NULL END as verified_at,
  CASE WHEN u.email_verified = 1 THEN 'email_verification' ELSE NULL END as verification_method,
  strftime('%s', 'now') as created_at,
  strftime('%s', 'now') as updated_at
FROM users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM subject_identifiers si
    WHERE si.tenant_id = u.tenant_id
      AND si.identifier_type = 'email'
      AND si.identifier_value = u.email
  );

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 019
-- =============================================================================
