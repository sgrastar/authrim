-- When, and with which passkey, an Admin session last verified a passkey (user verification
-- required): at sign-in, and again at each in-session re-authentication. Fresh-auth checks read
-- these instead of the session's creation or MFA flag time.
ALTER TABLE admin_sessions ADD COLUMN passkey_verified_at INTEGER;
ALTER TABLE admin_sessions ADD COLUMN passkey_credential_id TEXT;
