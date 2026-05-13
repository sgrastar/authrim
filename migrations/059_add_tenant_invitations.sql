-- Migration 059: Add tenant invitations table
-- Token-based invitation flow for tenant-specific signup routing

CREATE TABLE IF NOT EXISTS tenant_invitations (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,         -- 256-bit entropy token
  tenant_id      TEXT NOT NULL,
  invited_email  TEXT,                         -- NULL=anyone, NON-NULL=specific email only
  invited_by     TEXT NOT NULL,                -- Admin user ID who created the invitation
  role_id        TEXT,                         -- Optional: auto-assign this role on signup
  org_id         TEXT,                         -- Optional: auto-assign to this org on signup
  max_uses       INTEGER NOT NULL DEFAULT 1,   -- -1=unlimited
  use_count      INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_ti_token ON tenant_invitations(token, expires_at);
CREATE INDEX IF NOT EXISTS idx_ti_tenant ON tenant_invitations(tenant_id, created_at DESC);
