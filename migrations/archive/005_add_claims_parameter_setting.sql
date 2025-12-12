-- Migration 005: Add Claims Parameter Setting
-- Created: 2025-11-21
-- Description: Add allow_claims_without_scope column to oauth_clients table
--              to control whether claims parameter can request claims without corresponding scope
-- =============================================================================

-- Add allow_claims_without_scope column
-- 0 (default) = Strict: Only return claims for granted scopes
-- 1 = Flexible: Return claims requested via claims parameter even without scope
ALTER TABLE oauth_clients ADD COLUMN allow_claims_without_scope INTEGER DEFAULT 0;

-- Create index for fast lookups (optional, since this will be used with client_id primary key)
CREATE INDEX IF NOT EXISTS idx_clients_claims_setting ON oauth_clients(allow_claims_without_scope);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 005
-- =============================================================================
