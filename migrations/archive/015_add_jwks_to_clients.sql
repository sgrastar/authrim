-- Migration 015: Add JWKS and JWKS URI to OAuth Clients
-- Created: 2025-11-30
-- Description: Add jwks and jwks_uri columns to oauth_clients table
--              to support private_key_jwt client authentication (RFC 7523)
-- =============================================================================

-- Add jwks column (embedded JWKS for static key storage)
-- Stores JSON Web Key Set as JSON string
ALTER TABLE oauth_clients ADD COLUMN jwks TEXT;

-- Add jwks_uri column (URI to fetch JWKS dynamically)
-- Allows clients to rotate keys without re-registration
ALTER TABLE oauth_clients ADD COLUMN jwks_uri TEXT;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 015
-- =============================================================================
