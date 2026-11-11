-- Named session profiles: how long a person stays signed in, whether a session can be extended,
-- and whether single sign-on is on. The built-in "default" profile is the tenant's session
-- settings (and oauth.sso_enabled); these rows are the tenant's own, chosen by service flows.
CREATE TABLE session_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_session_profiles_tenant_name
  ON session_profiles(tenant_id, name_key);
CREATE INDEX idx_session_profiles_tenant_updated
  ON session_profiles(tenant_id, updated_at DESC);
