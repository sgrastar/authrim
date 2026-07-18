-- RFC 7523 private_key_jwt client authentication signing preference.
-- Kept separate from migration 022 because applied migration files are immutable.
ALTER TABLE oauth_clients ADD COLUMN token_endpoint_auth_signing_alg TEXT;
