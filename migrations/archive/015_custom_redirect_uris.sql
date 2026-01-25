-- =============================================================================
-- Migration 015: Custom Redirect URIs Support
-- =============================================================================
-- Description: Add support for custom redirect URIs during authorization flow
-- Created: 2025-12-23
-- Phase: Custom UX Enhancement (Authrim Extension)
--
-- Changes:
-- 1. Add allowed_redirect_origins field to oauth_clients table
--
-- Security Notes:
-- - allowed_redirect_origins stores JSON array of allowed origins
-- - Origins are validated for HTTPS (localhost excepted)
-- - Parse failure results in empty array (strict mode)
-- - This is an Authrim extension, not OIDC standard
-- =============================================================================

-- allowed_redirect_origins: JSON array of allowed origins for custom redirects
-- When error_uri, cancel_uri are from a different origin than redirect_uri,
-- they must be listed here to be accepted.
--
-- Format: '["https://app.example.com", "https://admin.example.com"]'
--
-- Same-origin with redirect_uri is always allowed without registration.
ALTER TABLE oauth_clients ADD COLUMN allowed_redirect_origins TEXT;

-- =============================================================================
-- Migration Complete
-- =============================================================================
