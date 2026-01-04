-- =============================================================================
-- Migration: NIST SP 800-63-4 Identity Assurance Level (IAL) Support
-- =============================================================================
-- Created: 2026-01-04
-- Description: Adds Identity Assurance Level columns to users_core table
--              for NIST SP 800-63C Revision 4 compliance.
--
-- NIST SP 800-63-4 Identity Assurance Levels:
-- - IAL1: No identity proofing required
-- - IAL2: Remote or in-person identity proofing
-- - IAL3: In-person identity proofing with physical verification
--
-- These columns track the level of identity proofing performed for each user,
-- which is used to determine access to resources requiring specific assurance.
-- =============================================================================

-- =============================================================================
-- Add IAL columns to users_core
-- =============================================================================
-- ial: Current Identity Assurance Level (IAL1, IAL2, IAL3)
-- ial_verified_at: When the IAL was last verified/established
-- ial_evidence_type: Type of evidence used for verification
-- ial_verifier_id: ID of the verifier/process that performed proofing
-- =============================================================================

-- IAL column: Identity Assurance Level
-- Values: 'IAL1' (default), 'IAL2', 'IAL3'
ALTER TABLE users_core ADD COLUMN ial TEXT DEFAULT 'IAL1';

-- When the IAL was established/verified
-- NULL means never explicitly verified (default IAL1 assumed)
ALTER TABLE users_core ADD COLUMN ial_verified_at TEXT;

-- Type of evidence used for identity proofing
-- Examples: 'none', 'remote_document', 'remote_video', 'in_person', 'in_person_biometric'
ALTER TABLE users_core ADD COLUMN ial_evidence_type TEXT;

-- ID of the verifier or verification process (for audit trail)
-- Can be a user ID of admin who performed verification, or external service ID
ALTER TABLE users_core ADD COLUMN ial_verifier_id TEXT;

-- =============================================================================
-- Index for IAL-based queries
-- =============================================================================
-- Supports queries like "find all users with IAL2 or higher"
CREATE INDEX IF NOT EXISTS idx_users_core_ial ON users_core(tenant_id, ial);

-- =============================================================================
-- IAL History Table (for audit trail)
-- =============================================================================
-- Tracks all IAL changes for compliance and audit purposes.
-- GDPR/SOX compliance requires maintaining history of identity verification.
CREATE TABLE IF NOT EXISTS ial_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- User reference
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- IAL change details
  old_ial TEXT,
  new_ial TEXT NOT NULL,

  -- Evidence and verification details
  evidence_type TEXT,
  verifier_id TEXT,
  verification_method TEXT, -- 'manual_review', 'automated', 'external_service'

  -- Metadata
  reason TEXT, -- Why the IAL was changed
  notes TEXT,  -- Additional notes from verifier

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),

  -- Foreign key (no enforcement in D1, but documented)
  -- FOREIGN KEY (user_id) REFERENCES users_core(id)
  CONSTRAINT fk_ial_history_user CHECK (user_id IS NOT NULL)
);

-- Indexes for ial_history
CREATE INDEX IF NOT EXISTS idx_ial_history_user ON ial_history(user_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_ial_history_created ON ial_history(tenant_id, created_at DESC);
