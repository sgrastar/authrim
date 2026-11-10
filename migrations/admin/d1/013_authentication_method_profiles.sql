-- Named authentication method configurations. The built-in "default" profile continues to
-- use the tenant's authentication-methods settings document; these rows are independent drafts
-- for service flows to select when profile binding is implemented.
CREATE TABLE authentication_method_profiles (
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
CREATE UNIQUE INDEX idx_auth_method_profiles_tenant_name
  ON authentication_method_profiles(tenant_id, name_key);
CREATE INDEX idx_auth_method_profiles_tenant_updated
  ON authentication_method_profiles(tenant_id, updated_at DESC);
