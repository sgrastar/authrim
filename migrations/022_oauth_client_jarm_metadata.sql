-- RFC 9102 JARM client metadata.
-- These preferences are tenant-scoped as part of the oauth_clients composite key.
ALTER TABLE oauth_clients ADD COLUMN authorization_signed_response_alg TEXT;
ALTER TABLE oauth_clients ADD COLUMN authorization_encrypted_response_alg TEXT;
ALTER TABLE oauth_clients ADD COLUMN authorization_encrypted_response_enc TEXT;
