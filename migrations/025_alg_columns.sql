-- Migration 025: Add missing algorithm columns
--
-- These columns are used for OIDC signed response configuration:
-- - id_token_signed_response_alg: Algorithm for signing ID tokens
-- - request_object_signing_alg: Algorithm for request object signature verification
--
-- Reference: OpenID Connect Core 1.0 Section 2 (Client Metadata)

-- ID Token signing algorithm preference
ALTER TABLE oauth_clients ADD COLUMN id_token_signed_response_alg TEXT;

-- Request Object signing algorithm
ALTER TABLE oauth_clients ADD COLUMN request_object_signing_alg TEXT;
