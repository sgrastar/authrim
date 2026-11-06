-- Saved Login UI themes: named sets of appearance settings that an admin can keep, edit and apply
-- to the tenant's Login UI. A theme only holds values; the live Login UI is the tenant's
-- login-ui settings document, which "apply" writes.
CREATE TABLE login_ui_themes (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- The name, lower-cased: names are unique per tenant regardless of case
  name_key TEXT NOT NULL,
  -- JSON object keyed by login-ui setting key (an allowlist of appearance keys)
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_login_ui_themes_tenant_name ON login_ui_themes(tenant_id, name_key);
CREATE INDEX idx_login_ui_themes_tenant_updated ON login_ui_themes(tenant_id, updated_at DESC);
