-- Phase 1: Device secret revoke/introspection caller policy metadata
-- Stores explicit same-client policy and trust-group allowlists for confidential/service callers.

ALTER TABLE oauth_clients ADD COLUMN device_secret_revoke_enabled INTEGER;
ALTER TABLE oauth_clients ADD COLUMN device_secret_revoke_trust_groups TEXT;
ALTER TABLE oauth_clients ADD COLUMN device_secret_introspection_enabled INTEGER;
ALTER TABLE oauth_clients ADD COLUMN device_secret_introspection_trust_groups TEXT;
