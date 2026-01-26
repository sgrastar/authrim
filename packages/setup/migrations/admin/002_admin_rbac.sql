-- =============================================================================
-- Migration: Admin RBAC (D1_ADMIN)
-- =============================================================================
-- Created: 2025-01-22
-- Description: Creates admin_roles and admin_role_assignments tables.
--              Implements Role-Based Access Control for Admin users.
--
-- IMPORTANT: This migration is for D1_ADMIN (dedicated Admin database).
--            Separate from EndUser RBAC in D1_CORE.
--
-- Architecture:
-- - admin_roles: Role definitions with permission sets
-- - admin_role_assignments: Links admin users to roles
--
-- Hierarchy levels (higher = more privilege):
-- - super_admin: 100 (full system access)
-- - security_admin: 90 (security settings, audit logs)
-- - admin: 80 (user/client management)
-- - support: 40 (read + limited write for support tasks)
-- - viewer: 20 (read-only access)
-- =============================================================================

-- =============================================================================
-- admin_roles Table
-- =============================================================================
-- Role definitions for Admin RBAC.
-- Each role has a set of permissions (stored as JSON array).
--
-- Role types:
-- - system: Built-in system roles (cannot be modified/deleted)
-- - builtin: Default roles (can be modified but not deleted)
-- - custom: User-created roles (fully customizable)
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_roles (
  -- Role ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Role identification
  name TEXT NOT NULL,  -- Machine-readable name (e.g., 'super_admin')
  display_name TEXT,  -- Human-readable name (e.g., 'Super Administrator')
  description TEXT,

  -- Permissions (JSON array of permission strings)
  -- Format: ["admin:users:read", "admin:users:write", "admin:clients:*"]
  permissions_json TEXT NOT NULL DEFAULT '[]',

  -- Hierarchy level (for permission inheritance and delegation)
  -- Higher level = more privilege
  -- Users can only assign roles with lower hierarchy level
  hierarchy_level INTEGER DEFAULT 0,

  -- Role type
  role_type TEXT NOT NULL DEFAULT 'custom',  -- system | builtin | custom

  -- System role flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for role name per tenant
  UNIQUE(tenant_id, name)
);

-- =============================================================================
-- Indexes for admin_roles
-- =============================================================================

-- Tenant-scoped role lookup
CREATE INDEX IF NOT EXISTS idx_admin_roles_tenant ON admin_roles(tenant_id);

-- Role name lookup
CREATE INDEX IF NOT EXISTS idx_admin_roles_name ON admin_roles(tenant_id, name);

-- Role type filter
CREATE INDEX IF NOT EXISTS idx_admin_roles_type ON admin_roles(role_type);

-- Hierarchy level (for delegation checks)
CREATE INDEX IF NOT EXISTS idx_admin_roles_hierarchy ON admin_roles(hierarchy_level);

-- =============================================================================
-- admin_role_assignments Table
-- =============================================================================
-- Links admin users to roles.
-- Supports scoped assignments (global, tenant, organization).
--
-- Scope types:
-- - global: Role applies to all tenants (super_admin only)
-- - tenant: Role applies to specific tenant
-- - org: Role applies to specific organization within tenant
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_role_assignments (
  -- Assignment ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- References
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  admin_role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,

  -- Scope of this assignment
  scope_type TEXT NOT NULL DEFAULT 'tenant',  -- global | tenant | org
  scope_id TEXT,  -- org_id if scope_type = 'org', null otherwise

  -- Expiration (for temporary assignments)
  expires_at INTEGER,  -- UNIX timestamp, null for permanent

  -- Audit fields
  assigned_by TEXT,  -- Admin user ID who made this assignment
  created_at INTEGER NOT NULL,

  -- Unique constraint: one role per user per scope
  UNIQUE(admin_user_id, admin_role_id, scope_type, scope_id)
);

-- =============================================================================
-- Indexes for admin_role_assignments
-- =============================================================================

-- User's role lookup (primary query for authorization)
CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_user ON admin_role_assignments(admin_user_id);

-- Role assignment lookup
CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_role ON admin_role_assignments(admin_role_id);

-- Tenant-scoped assignments
CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_tenant ON admin_role_assignments(tenant_id);

-- Scope-based filtering
CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_scope ON admin_role_assignments(scope_type, scope_id);

-- Expiration tracking (for cleanup jobs)
CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_expires ON admin_role_assignments(expires_at);

-- =============================================================================
-- Default Roles (System Roles)
-- =============================================================================
-- Insert default roles with predefined permissions.
-- These are system roles that cannot be modified or deleted.
-- =============================================================================

-- super_admin: Full system access (hierarchy: 100)
INSERT OR IGNORE INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) VALUES (
  'role_super_admin',
  'default',
  'super_admin',
  'Super Administrator',
  'Full system access - all permissions granted',
  '["*"]',
  100,
  'system',
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- security_admin: Security and audit management (hierarchy: 90)
INSERT OR IGNORE INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) VALUES (
  'role_security_admin',
  'default',
  'security_admin',
  'Security Administrator',
  'Security settings, audit logs, IP restrictions',
  '["admin:audit:*", "admin:security:*", "admin:ip_allowlist:*", "admin:sessions:read", "admin:sessions:revoke", "admin:users:read"]',
  90,
  'system',
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- admin: User and client management (hierarchy: 80)
INSERT OR IGNORE INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) VALUES (
  'role_admin',
  'default',
  'admin',
  'Administrator',
  'User and client management, basic operations',
  '["admin:users:*", "admin:clients:*", "admin:scopes:*", "admin:roles:read", "admin:settings:read", "admin:audit:read"]',
  80,
  'system',
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- support: Support operations (hierarchy: 40)
INSERT OR IGNORE INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) VALUES (
  'role_support',
  'default',
  'support',
  'Support',
  'Read access with limited write for support tasks',
  '["admin:users:read", "admin:users:unlock", "admin:sessions:read", "admin:sessions:revoke", "admin:clients:read", "admin:audit:read"]',
  40,
  'system',
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- viewer: Read-only access (hierarchy: 20)
INSERT OR IGNORE INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) VALUES (
  'role_viewer',
  'default',
  'viewer',
  'Viewer',
  'Read-only access to admin dashboard',
  '["admin:users:read", "admin:clients:read", "admin:roles:read", "admin:settings:read"]',
  20,
  'system',
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Permission format: admin:<resource>:<action>
-- Resources: users, clients, roles, scopes, settings, audit, security, ip_allowlist, sessions
-- Actions: read, write, delete, * (all)
-- Special: "*" grants all permissions
--
-- Next steps:
-- 1. Apply 003_admin_audit.sql for audit logging
-- 2. Apply 004_admin_security.sql for IP allowlist
-- =============================================================================
