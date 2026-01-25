-- Migration 024: OIDC 3rd Party Initiated Login and RFC 7592 Support
--
-- Adds support for:
-- 1. initiate_login_uri - OIDC 3rd Party Initiated Login (OIDC Core Section 4)
-- 2. registration_access_token_hash - RFC 7592 Client Configuration Endpoint
--
-- The registration_access_token is stored as SHA-256 hash for security.
-- The plaintext token is only returned once during initial registration.

-- RFC 7592 Client Configuration Endpoint
-- Stores SHA-256 hash of registration_access_token for secure verification
ALTER TABLE oauth_clients ADD COLUMN registration_access_token_hash TEXT;

-- OIDC 3rd Party Initiated Login (OIDC Core Section 4)
-- URL that a third party can use to initiate a login by the RP
ALTER TABLE oauth_clients ADD COLUMN initiate_login_uri TEXT;
