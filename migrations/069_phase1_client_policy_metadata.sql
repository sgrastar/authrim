-- Phase 1 auth unification: client policy metadata and trust groups.

CREATE TABLE IF NOT EXISTS trust_groups (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_groups_tenant_id
  ON trust_groups(tenant_id, id);

ALTER TABLE oauth_clients ADD COLUMN application_type TEXT DEFAULT 'web';
ALTER TABLE oauth_clients ADD COLUMN trust_group TEXT;
ALTER TABLE oauth_clients ADD COLUMN trust_group_id TEXT;
ALTER TABLE oauth_clients ADD COLUMN browser_public_client_mode TEXT;
ALTER TABLE oauth_clients ADD COLUMN browser_refresh_token_policy TEXT NOT NULL DEFAULT 'disabled';
ALTER TABLE oauth_clients ADD COLUMN native_sso_enabled INTEGER;
ALTER TABLE oauth_clients ADD COLUMN native_channel_allowed INTEGER;
ALTER TABLE oauth_clients ADD COLUMN allowed_channels TEXT;
ALTER TABLE oauth_clients ADD COLUMN default_resource TEXT;

CREATE INDEX IF NOT EXISTS idx_oauth_clients_trust_group
  ON oauth_clients(tenant_id, trust_group);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_application_type
  ON oauth_clients(tenant_id, application_type);
