-- Allow consent records to use canonical runtime user IDs.
--
-- Runtime users are represented by identity_accounts.legacy_user_id. Consent tables store that
-- stable runtime user ID and must not require a legacy users_core row to exist.

ALTER TABLE oauth_client_consents
  DROP CONSTRAINT IF EXISTS oauth_client_consents_user_fk;

ALTER TABLE user_consent_records
  DROP CONSTRAINT IF EXISTS user_consent_records_user_fk;
