-- =============================================================================
-- Migration 057: Add tenants table
-- =============================================================================

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,           -- slug format: ^[a-z0-9-]+$, max 63chars
  name        TEXT NOT NULL,              -- display name
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1, -- 0=disabled, 1=enabled
  is_default  INTEGER NOT NULL DEFAULT 0, -- default tenant (only one)
  default_tenant_guard TEXT,              -- 'default' when is_default=1, NULL otherwise
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Portable uniqueness: only the default tenant materializes a shared sentinel
CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard);

-- Seed the existing 'default' tenant; skip if it already exists
INSERT INTO tenants (id, name, is_active, is_default, default_tenant_guard, created_at, updated_at)
SELECT 'default', 'Default', 1, 1, 'default',
       __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM tenants
  WHERE id = 'default'
);
