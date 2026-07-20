-- Add the OAuth/OIDC linked-identity fields used by ar-bridge to the dedicated PII schema.
-- Existing PII columns remain available to the canonical linked-identity repository.
ALTER TABLE linked_identities ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE linked_identities ADD COLUMN access_token_encrypted TEXT;
ALTER TABLE linked_identities ADD COLUMN refresh_token_encrypted TEXT;
ALTER TABLE linked_identities ADD COLUMN token_expires_at INTEGER;
ALTER TABLE linked_identities ADD COLUMN raw_claims TEXT;
ALTER TABLE linked_identities ADD COLUMN profile_data TEXT;
ALTER TABLE linked_identities ADD COLUMN last_login_at INTEGER;
ALTER TABLE linked_identities ADD COLUMN updated_at INTEGER;

UPDATE linked_identities
SET last_login_at = COALESCE(last_login_at, last_used_at, linked_at),
    updated_at = COALESCE(updated_at, last_used_at, linked_at);
