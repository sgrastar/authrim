-- Migration 027: Add always_fetch_userinfo column to upstream_providers
--
-- When enabled, the RP will always call the userinfo endpoint even when
-- id_token contains claims. This is required for OIDC RP certification testing.
--
-- Default: 0 (false) - use id_token claims only

ALTER TABLE upstream_providers ADD COLUMN always_fetch_userinfo INTEGER DEFAULT 0;
