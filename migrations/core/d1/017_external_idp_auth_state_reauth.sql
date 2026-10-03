-- A sign-in at an external IdP that answers an Authrim re-authentication: the re-authentication
-- challenge it answers, and when Authrim asked the IdP for a new login (milliseconds, Authrim's
-- clock), so the callback can require that the IdP authenticated the user again after it.
ALTER TABLE external_idp_auth_states ADD COLUMN reauth_challenge_id TEXT;
ALTER TABLE external_idp_auth_states ADD COLUMN reauth_requested_at INTEGER;
