-- Migration: 007_account_registration_pending.sql
-- Description: An account a sign-up created before the person proved anything (a code sent, a
--              passkey's ceremony begun), until that sign-up completes. The account is made at the
--              start so the code or the ceremony has an account to belong to; one never completed
--              is left behind. This record marks it, with when it may be cleaned up; completing
--              the sign-up removes it. It holds no personal data.
-- Author: @authrim
-- Date: 2026-11-08
-- Issue: Abandoned sign-up clean-up (lite Login UI PR6b)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_registration_pending (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- The sign-up that made the account: email_code or passkey.
  flow TEXT NOT NULL CHECK (flow IN ('email_code', 'passkey')),
  -- Epoch seconds.
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  CHECK (expires_at >= created_at)
);

-- The clean-up reads a tenant's expired ones in order.
CREATE INDEX IF NOT EXISTS idx_account_registration_pending_expires
  ON account_registration_pending (tenant_id, expires_at, user_id);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP INDEX IF EXISTS idx_account_registration_pending_expires;
-- DROP TABLE IF EXISTS account_registration_pending;

-- =============================================================================
-- Migration Complete
-- =============================================================================
