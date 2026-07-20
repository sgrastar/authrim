-- Index upstream OpenID Connect sessions for Front-Channel Logout by sid.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_provider_sid TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_external_provider_sid
  ON sessions(tenant_id, external_provider_id, external_provider_sid)
  WHERE external_provider_sid IS NOT NULL;
