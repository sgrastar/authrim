-- Migration: Add post_logout_redirect_uris column to oauth_clients table
-- Created: 2025-12-07
-- Description: Required for OIDC RP-Initiated Logout 1.0 (OpenID Connect RP-Initiated Logout 1.0)
-- Reference: https://openid.net/specs/openid-connect-rpinitiated-1_0.html

-- =============================================================================
-- Add post_logout_redirect_uris column
-- =============================================================================
-- This column stores a JSON array of URIs that the client can use as
-- post_logout_redirect_uri parameter when initiating logout.
-- Per OIDC RP-Initiated Logout 1.0, the OP MUST validate the post_logout_redirect_uri
-- against the registered URIs.
-- =============================================================================

ALTER TABLE oauth_clients ADD COLUMN post_logout_redirect_uris TEXT;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Column added: post_logout_redirect_uris (TEXT, nullable)
-- The column stores JSON array of strings (e.g., '["https://example.com/logout", "https://example.com/signout"]')
-- Version: 022
-- =============================================================================
