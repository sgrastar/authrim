-- Migration 026: Add token_endpoint_auth_method column to upstream_providers
--
-- Allows configuring the token endpoint authentication method:
-- - client_secret_basic: Credentials in Authorization header (RFC 6749 Section 2.3.1)
-- - client_secret_post: Credentials in request body (default, RFC 6749 Section 2.3.1)
--
-- Reference: RFC 6749 Section 2.3.1 (Client Password)

ALTER TABLE upstream_providers ADD COLUMN token_endpoint_auth_method TEXT DEFAULT 'client_secret_post';
