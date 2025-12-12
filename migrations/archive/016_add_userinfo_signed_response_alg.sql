-- Migration 016: Add userinfo_signed_response_alg to OAuth Clients
-- Created: 2025-11-30
-- Description: Add userinfo_signed_response_alg column to oauth_clients table
--              to support signed UserInfo responses (OIDC Core 5.3.3)
-- =============================================================================

-- Add userinfo_signed_response_alg column
-- Stores the algorithm for signing UserInfo responses (e.g., 'RS256', 'none')
ALTER TABLE oauth_clients ADD COLUMN userinfo_signed_response_alg TEXT;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 016
-- =============================================================================
