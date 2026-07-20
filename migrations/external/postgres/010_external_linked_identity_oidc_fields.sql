-- Keep the external PII schema compatible with ar-bridge OAuth/OIDC linked identities.
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT;
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT;
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS token_expires_at BIGINT;
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS raw_claims JSONB;
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS profile_data JSONB;
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS last_login_at BIGINT;
ALTER TABLE linked_identities ADD COLUMN IF NOT EXISTS updated_at BIGINT;

UPDATE linked_identities
SET last_login_at = COALESCE(last_login_at, last_used_at, linked_at),
    updated_at = COALESCE(updated_at, last_used_at, linked_at);
