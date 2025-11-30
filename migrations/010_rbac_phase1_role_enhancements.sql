-- Migration: 010_rbac_phase1_role_enhancements.sql
-- Description: Enhance roles table with type, hierarchy, and add default roles
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Enhance roles table with new columns
-- =============================================================================

-- role_type: system (internal), builtin (default roles), custom (user-defined)
ALTER TABLE roles ADD COLUMN role_type TEXT NOT NULL DEFAULT 'custom';

-- hierarchy_level: 0-100, higher = more privileged
ALTER TABLE roles ADD COLUMN hierarchy_level INTEGER DEFAULT 0;

-- is_assignable: whether this role can be assigned to users
ALTER TABLE roles ADD COLUMN is_assignable INTEGER DEFAULT 1;

-- parent_role_id: for role inheritance (optional)
ALTER TABLE roles ADD COLUMN parent_role_id TEXT REFERENCES roles(id);

-- =============================================================================
-- 2. Update existing default roles to system type
-- =============================================================================

UPDATE roles SET role_type = 'system', hierarchy_level = 100, is_assignable = 1
WHERE name = 'admin' OR name = 'super_admin' OR id = 'role_super_admin';

UPDATE roles SET role_type = 'system', hierarchy_level = 80, is_assignable = 1
WHERE name = 'viewer' OR id = 'role_viewer';

UPDATE roles SET role_type = 'system', hierarchy_level = 60, is_assignable = 1
WHERE name = 'support' OR id = 'role_support';

-- =============================================================================
-- 3. Add new default roles for RBAC Phase 1
-- =============================================================================

-- System Admin: Full system access (highest level)
INSERT OR IGNORE INTO roles (id, tenant_id, name, description, permissions_json, role_type, hierarchy_level, is_assignable, created_at)
VALUES (
  'role_system_admin',
  'default',
  'system_admin',
  'Full system access - manages all tenants and system configuration',
  '["*"]',
  'system',
  100,
  1,
  strftime('%s', 'now')
);

-- Distributor Admin: Can manage assigned customer organizations
INSERT OR IGNORE INTO roles (id, tenant_id, name, description, permissions_json, role_type, hierarchy_level, is_assignable, created_at)
VALUES (
  'role_distributor_admin',
  'default',
  'distributor_admin',
  'Distributor administrator - manages assigned customer organizations',
  '["users:read", "users:create", "users:update", "organizations:read", "organizations:update", "clients:read"]',
  'builtin',
  50,
  1,
  strftime('%s', 'now')
);

-- Organization Admin: Can manage users within their organization
INSERT OR IGNORE INTO roles (id, tenant_id, name, description, permissions_json, role_type, hierarchy_level, is_assignable, created_at)
VALUES (
  'role_org_admin',
  'default',
  'org_admin',
  'Organization administrator - manages users within their organization',
  '["users:read", "users:update", "organization:read"]',
  'builtin',
  30,
  1,
  strftime('%s', 'now')
);

-- End User: Basic user with self-management permissions
INSERT OR IGNORE INTO roles (id, tenant_id, name, description, permissions_json, role_type, hierarchy_level, is_assignable, created_at)
VALUES (
  'role_end_user',
  'default',
  'end_user',
  'Basic end user - can manage their own profile',
  '["profile:read", "profile:update"]',
  'builtin',
  0,
  1,
  strftime('%s', 'now')
);

-- =============================================================================
-- 4. Add indexes for new columns
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_roles_role_type ON roles(role_type);
CREATE INDEX IF NOT EXISTS idx_roles_hierarchy_level ON roles(hierarchy_level);
CREATE INDEX IF NOT EXISTS idx_roles_parent_role_id ON roles(parent_role_id);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 010
-- =============================================================================
