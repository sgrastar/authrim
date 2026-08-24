-- Tenant-wide launcher definitions are read from the tenant metadata Core database. Per-account
-- favorites are stored in the routed account database so they follow account shard placement.

CREATE TABLE application_launchers (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX idx_application_launchers_updated
  ON application_launchers (tenant_id, updated_at, id);

CREATE TABLE launcher_favorites (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  launcher_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, launcher_id)
);

CREATE INDEX idx_launcher_favorites_user
  ON launcher_favorites (tenant_id, user_id, created_at, launcher_id);
