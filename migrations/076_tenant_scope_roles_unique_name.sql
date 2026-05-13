-- Migration: 076_tenant_scope_roles_unique_name.sql
-- Description: Replace global role-name uniqueness with tenant-scoped uniqueness.

PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_roles_hierarchy_level;
DROP INDEX IF EXISTS idx_roles_name;
DROP INDEX IF EXISTS idx_roles_parent_role_id;
DROP INDEX IF EXISTS idx_roles_role_type;
DROP INDEX IF EXISTS idx_roles_tenant_id;

CREATE TABLE roles_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'custom',
  hierarchy_level INTEGER DEFAULT 0,
  is_assignable INTEGER DEFAULT 1,
  parent_role_id TEXT REFERENCES roles(id),
  display_name TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  UNIQUE(tenant_id, name)
);

INSERT INTO roles_new (
  id,
  tenant_id,
  name,
  description,
  permissions_json,
  created_at,
  role_type,
  hierarchy_level,
  is_assignable,
  parent_role_id,
  display_name,
  is_system,
  updated_at
)
SELECT
  id,
  COALESCE(NULLIF(tenant_id, ''), 'default'),
  name,
  description,
  permissions_json,
  created_at,
  COALESCE(role_type, 'custom'),
  COALESCE(hierarchy_level, 0),
  COALESCE(is_assignable, 1),
  parent_role_id,
  display_name,
  COALESCE(is_system, 0),
  updated_at
FROM roles;

DROP TABLE roles;
ALTER TABLE roles_new RENAME TO roles;

CREATE INDEX idx_roles_hierarchy_level ON roles(hierarchy_level);
CREATE INDEX idx_roles_name ON roles(tenant_id, name);
CREATE INDEX idx_roles_parent_role_id ON roles(tenant_id, parent_role_id);
CREATE INDEX idx_roles_role_type ON roles(role_type);
CREATE INDEX idx_roles_tenant_id ON roles(tenant_id);

PRAGMA foreign_keys = ON;
