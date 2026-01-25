-- =============================================================================
-- Migration: Domain Verification Support
-- =============================================================================
-- Created: 2025-12-29
-- Description: Adds columns for DNS TXT record-based domain ownership verification.
--
-- Features:
-- - verification_token: Unique token for DNS TXT record
-- - verification_status: Track verification state
-- - verification_expires_at: Token expiration timestamp
-- - verification_method: Support multiple verification methods
--
-- Usage:
-- 1. Admin initiates verification via POST /api/admin/org-domain-mappings/verify
-- 2. System generates verification token and instructs admin to create DNS TXT record
-- 3. Admin confirms via POST /api/admin/org-domain-mappings/verify/confirm
-- 4. System queries DNS to verify TXT record contains token
-- =============================================================================

-- Add verification columns to org_domain_mappings
ALTER TABLE org_domain_mappings ADD COLUMN verification_token TEXT;
ALTER TABLE org_domain_mappings ADD COLUMN verification_status TEXT DEFAULT 'unverified';
ALTER TABLE org_domain_mappings ADD COLUMN verification_expires_at INTEGER;
ALTER TABLE org_domain_mappings ADD COLUMN verification_method TEXT;

-- Index for finding pending verifications
CREATE INDEX IF NOT EXISTS idx_odm_verification_status ON org_domain_mappings(
  verification_status,
  verification_expires_at
);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Deploy this migration to D1_CORE database
-- 2. Use POST /api/admin/org-domain-mappings/verify to initiate DNS verification
-- 3. Create DNS TXT record: _authrim-verify.{domain} with value authrim-domain-verify={token}
-- 4. Confirm via POST /api/admin/org-domain-mappings/verify/confirm
-- =============================================================================
