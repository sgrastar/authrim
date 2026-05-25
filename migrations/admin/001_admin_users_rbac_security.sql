-- =============================================================================
-- Authrim Admin Baseline: Users, RBAC, Audit, and Security
-- Consolidated for fresh Authrim installs from admin/001_admin_users.sql, admin/002_admin_rbac.sql, admin/003_admin_audit.sql, admin/004_admin_security.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/001_admin_users.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin Users and Sessions (D1_ADMIN)
-- =============================================================================
-- Created: 2025-01-22
-- Description: Creates admin_users, admin_sessions, and admin_passkeys tables.
--              Part of Admin/EndUser separation architecture.
--
-- IMPORTANT: This migration is for D1_ADMIN (dedicated Admin database).
--            Completely separate from D1_CORE (EndUser data).
--
-- Architecture:
-- - admin_users: Admin user accounts (GDPR exempt - no PII separation needed)
-- - admin_sessions: Admin session management
-- - admin_passkeys: WebAuthn/Passkey credentials for Admin users
-- =============================================================================

-- =============================================================================
-- admin_users Table
-- =============================================================================
-- Admin user accounts stored in D1_ADMIN database.
-- Contains authentication and profile data for admin users.
-- GDPR exempt - no PII separation required.
--
-- Status values:
-- - active: Normal active account
-- - suspended: Temporarily suspended (can be reactivated)
-- - locked: Locked due to failed login attempts (auto-unlock possible)
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_users (
  -- Primary key (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Admin user profile
  email TEXT NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,

  -- Authentication
  password_hash TEXT,

  -- Account status
  is_active INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',  -- active | suspended | locked

  -- MFA settings
  mfa_enabled INTEGER DEFAULT 0,
  mfa_method TEXT,  -- totp | passkey | both | null
  totp_secret_encrypted TEXT,

  -- Login tracking
  last_login_at INTEGER,
  last_login_ip TEXT,
  failed_login_count INTEGER DEFAULT 0,
  locked_until INTEGER,  -- UNIX timestamp, null if not locked

  -- Audit fields
  created_by TEXT,  -- Admin user ID who created this account
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for email per tenant
  UNIQUE(tenant_id, email)
);

-- =============================================================================
-- Indexes for admin_users
-- =============================================================================

-- Tenant-scoped email lookup (primary auth query)
CREATE INDEX IF NOT EXISTS idx_admin_users_tenant_email ON admin_users(tenant_id, email);

-- Active users filter
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(tenant_id, is_active);

-- Status filter (for admin dashboard)
CREATE INDEX IF NOT EXISTS idx_admin_users_status ON admin_users(tenant_id, status);

-- Last login tracking (for security audit)
CREATE INDEX IF NOT EXISTS idx_admin_users_last_login ON admin_users(last_login_at);

-- =============================================================================
-- admin_sessions Table
-- =============================================================================
-- Admin session management stored in D1_ADMIN database.
-- Separate from EndUser sessions in SessionStore Durable Object.
--
-- Unlike EndUser sessions (stored in Durable Objects for horizontal scaling),
-- Admin sessions are stored in D1 for:
-- - Simpler management (fewer admin users)
-- - Direct SQL queries for security monitoring
-- - Easy invalidation of all sessions for a user
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_sessions (
  -- Session ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- Client information
  ip_address TEXT,
  user_agent TEXT,

  -- Session lifecycle
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_activity_at INTEGER,

  -- MFA status for this session
  mfa_verified INTEGER DEFAULT 0,
  mfa_verified_at INTEGER
);

-- =============================================================================
-- Indexes for admin_sessions
-- =============================================================================

-- User's active sessions lookup
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(admin_user_id);

-- Tenant-scoped session lookup
CREATE INDEX IF NOT EXISTS idx_admin_sessions_tenant ON admin_sessions(tenant_id);

-- Expired session cleanup
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

-- Activity monitoring
CREATE INDEX IF NOT EXISTS idx_admin_sessions_activity ON admin_sessions(last_activity_at);

-- =============================================================================
-- admin_passkeys Table
-- =============================================================================
-- WebAuthn/Passkey credentials for Admin users.
-- Enables passwordless authentication for admin accounts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_passkeys (
  -- Passkey ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- WebAuthn credential data
  credential_id TEXT UNIQUE NOT NULL,  -- Base64url-encoded credential ID
  public_key TEXT NOT NULL,  -- COSE public key (Base64url-encoded)
  counter INTEGER DEFAULT 0,  -- Signature counter for replay protection

  -- User-friendly name for this passkey
  device_name TEXT,

  -- Transports (json array: usb, ble, nfc, internal, hybrid)
  transports_json TEXT,

  -- Attestation data (optional, for enterprise requirements)
  attestation_type TEXT,  -- none | indirect | direct | enterprise
  aaguid TEXT,  -- Authenticator Attestation GUID

  -- Lifecycle
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- =============================================================================
-- Indexes for admin_passkeys
-- =============================================================================

-- User's passkeys lookup
CREATE INDEX IF NOT EXISTS idx_admin_passkeys_user ON admin_passkeys(admin_user_id);

-- Credential ID lookup (for authentication)
CREATE INDEX IF NOT EXISTS idx_admin_passkeys_credential ON admin_passkeys(credential_id);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Apply 002_admin_rbac.sql for role management
-- 2. Apply 003_admin_audit.sql for audit logging
-- 3. Apply 004_admin_security.sql for IP allowlist
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/002_admin_rbac.sql
-- -----------------------------------------------------------------------------

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
INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) SELECT
  'role_super_admin',
  'default',
  'super_admin',
  'Super Administrator',
  'Full system access - all permissions granted',
  '["*"]',
  100,
  'system',
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_roles
  WHERE id = 'role_super_admin'
);

-- security_admin: Security and audit management (hierarchy: 90)
INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) SELECT
  'role_security_admin',
  'default',
  'security_admin',
  'Security Administrator',
  'Security settings, audit logs, IP restrictions',
  '["admin:audit:*", "admin:security:*", "admin:ip_allowlist:*", "admin:sessions:read", "admin:sessions:revoke", "admin:users:read"]',
  90,
  'system',
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_roles
  WHERE id = 'role_security_admin'
);

-- admin: User and client management (hierarchy: 80)
INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) SELECT
  'role_admin',
  'default',
  'admin',
  'Administrator',
  'User and client management, basic operations',
  '["admin:users:*", "admin:clients:*", "admin:scopes:*", "admin:roles:read", "admin:settings:read", "admin:audit:read"]',
  80,
  'system',
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_roles
  WHERE id = 'role_admin'
);

-- support: Support operations (hierarchy: 40)
INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) SELECT
  'role_support',
  'default',
  'support',
  'Support',
  'Read access with limited write for support tasks',
  '["admin:users:read", "admin:users:unlock", "admin:sessions:read", "admin:sessions:revoke", "admin:clients:read", "admin:audit:read"]',
  40,
  'system',
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_roles
  WHERE id = 'role_support'
);

-- viewer: Read-only access (hierarchy: 20)
INSERT INTO admin_roles (
  id, tenant_id, name, display_name, description,
  permissions_json, hierarchy_level, role_type, is_system,
  created_at, updated_at
) SELECT
  'role_viewer',
  'default',
  'viewer',
  'Viewer',
  'Read-only access to admin dashboard',
  '["admin:users:read", "admin:clients:read", "admin:roles:read", "admin:settings:read"]',
  20,
  'system',
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_roles
  WHERE id = 'role_viewer'
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

-- -----------------------------------------------------------------------------
-- Source: admin/003_admin_audit.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin Audit Log (D1_ADMIN)
-- =============================================================================
-- Created: 2025-01-22
-- Description: Creates admin_audit_log table for Admin operations auditing.
--              Separate from EndUser audit logs.
--
-- IMPORTANT: This migration is for D1_ADMIN (dedicated Admin database).
--            Provides complete audit trail for Admin operations.
--
-- Architecture:
-- - admin_audit_log: All admin actions with before/after state
-- - Supports filtering by action, user, resource, severity
-- - Designed for compliance and security monitoring
--
-- Retention: Default 7 years (configurable via settings)
-- =============================================================================

-- =============================================================================
-- admin_audit_log Table
-- =============================================================================
-- Comprehensive audit log for all Admin operations.
-- Captures who did what, when, from where, and the before/after state.
--
-- Severity levels:
-- - debug: Detailed debugging info (usually filtered in production)
-- - info: Normal operations (login, view actions)
-- - warn: Potentially concerning actions (failed auth, permission denied)
-- - error: Errors that need attention
-- - critical: Security-sensitive actions (role changes, IP allowlist changes)
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
  -- Audit entry ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Who performed the action
  admin_user_id TEXT,  -- May be null for system actions or failed auth
  admin_email TEXT,  -- Denormalized for easier querying

  -- What action was performed
  action TEXT NOT NULL,  -- e.g., 'admin.login', 'user.create', 'client.update'

  -- Target resource
  resource_type TEXT,  -- e.g., 'admin_user', 'client', 'role', 'settings'
  resource_id TEXT,  -- ID of the affected resource

  -- Result
  result TEXT NOT NULL,  -- 'success' | 'failure' | 'error'
  error_code TEXT,  -- Error code if result is 'failure' or 'error'
  error_message TEXT,  -- Error details

  -- Severity level
  severity TEXT NOT NULL DEFAULT 'info',  -- debug | info | warn | error | critical

  -- Request context
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,  -- Correlation ID for request tracing
  session_id TEXT,  -- Admin session ID

  -- State changes
  before_json TEXT,  -- JSON snapshot before change (null for create/read)
  after_json TEXT,  -- JSON snapshot after change (null for delete/read)

  -- Additional metadata
  metadata_json TEXT,  -- Additional context (e.g., affected fields, reason)

  -- Timestamp
  created_at INTEGER NOT NULL
);

-- =============================================================================
-- Indexes for admin_audit_log
-- =============================================================================

-- Time-based queries (most common pattern)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at DESC);

-- Tenant-scoped time queries
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_tenant_time ON admin_audit_log(tenant_id, created_at DESC);

-- User activity lookup
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_user ON admin_audit_log(admin_user_id, created_at DESC);

-- Action type filtering
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log(action, created_at DESC);

-- Resource tracking
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_resource ON admin_audit_log(resource_type, resource_id, created_at DESC);

-- Severity filtering (for alerts and monitoring)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_severity ON admin_audit_log(severity, created_at DESC);

-- Result filtering (for error tracking)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_result ON admin_audit_log(result, created_at DESC);

-- IP address tracking (for security investigation)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_ip ON admin_audit_log(ip_address, created_at DESC);

-- Request correlation
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_request ON admin_audit_log(request_id);

-- =============================================================================
-- Standard Action Types
-- =============================================================================
-- These are the standard action types for audit logging.
-- Format: <category>.<action>
--
-- Authentication:
-- - admin.login.success
-- - admin.login.failure
-- - admin.logout
-- - admin.mfa.setup
-- - admin.mfa.verify
-- - admin.passkey.register
-- - admin.passkey.authenticate
--
-- Admin User Management:
-- - admin_user.create
-- - admin_user.read
-- - admin_user.update
-- - admin_user.delete
-- - admin_user.suspend
-- - admin_user.activate
-- - admin_user.unlock
-- - admin_user.password.reset
--
-- Role Management:
-- - admin_role.create
-- - admin_role.update
-- - admin_role.delete
-- - admin_role.assign
-- - admin_role.revoke
--
-- Security:
-- - ip_allowlist.add
-- - ip_allowlist.remove
-- - ip_allowlist.update
-- - session.revoke
-- - session.revoke_all
--
-- Settings:
-- - settings.update
-- - settings.read
--
-- EndUser Management (actions on EndUsers from Admin):
-- - user.create
-- - user.read
-- - user.update
-- - user.delete
-- - user.suspend
-- - user.activate
--
-- Client Management:
-- - client.create
-- - client.read
-- - client.update
-- - client.delete
-- - client.secret.rotate
-- =============================================================================

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Audit log is now ready for use.
-- All admin operations should write to this table.
--
-- Next steps:
-- 1. Apply 004_admin_security.sql for IP allowlist
-- 2. Implement admin audit log writer utility
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/004_admin_security.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin Security - IP Allowlist (D1_ADMIN)
-- =============================================================================
-- Created: 2025-01-22
-- Description: Creates admin_ip_allowlist table for IP-based access control.
--              Provides network-level security for Admin access.
--
-- IMPORTANT: This migration is for D1_ADMIN (dedicated Admin database).
--            Implements IP restriction for Admin panel access.
--
-- Architecture:
-- - admin_ip_allowlist: IP addresses/ranges allowed to access Admin
-- - Empty list = all IPs allowed (default behavior)
-- - Supports CIDR notation (192.168.1.0/24) and single IPs (10.0.0.1)
-- =============================================================================

-- =============================================================================
-- admin_ip_allowlist Table
-- =============================================================================
-- IP-based access control for Admin panel.
-- When the table is empty, all IPs are allowed.
-- When entries exist, only matching IPs can access Admin.
--
-- IP formats supported:
-- - Single IPv4: 192.168.1.100
-- - IPv4 CIDR: 192.168.1.0/24
-- - Single IPv6: 2001:db8::1
-- - IPv6 CIDR: 2001:db8::/32
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_ip_allowlist (
  -- Entry ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- IP address or CIDR range
  ip_range TEXT NOT NULL,

  -- IP version for easier filtering
  ip_version INTEGER NOT NULL DEFAULT 4,  -- 4 or 6

  -- Human-readable description
  description TEXT,  -- e.g., 'Office VPN', 'Home IP', 'CI/CD server'

  -- Enable/disable without deleting
  enabled INTEGER DEFAULT 1,

  -- Audit fields
  created_by TEXT,  -- Admin user ID who added this entry
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for IP range per tenant
  UNIQUE(tenant_id, ip_range)
);

-- =============================================================================
-- Indexes for admin_ip_allowlist
-- =============================================================================

-- Tenant-scoped lookup (main query pattern)
CREATE INDEX IF NOT EXISTS idx_admin_ip_allowlist_tenant ON admin_ip_allowlist(tenant_id, enabled);

-- IP version filtering (for IPv4/IPv6 specific queries)
CREATE INDEX IF NOT EXISTS idx_admin_ip_allowlist_version ON admin_ip_allowlist(tenant_id, ip_version, enabled);

-- Enabled entries only (for authorization checks)
CREATE INDEX IF NOT EXISTS idx_admin_ip_allowlist_enabled ON admin_ip_allowlist(enabled, tenant_id);

-- =============================================================================
-- admin_login_attempts Table (Optional - for rate limiting)
-- =============================================================================
-- Tracks failed login attempts for rate limiting and security monitoring.
-- Used to implement progressive delays and account lockout.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  -- Attempt ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Target email (even if user doesn't exist)
  email TEXT NOT NULL,

  -- Request context
  ip_address TEXT NOT NULL,
  user_agent TEXT,

  -- Result
  success INTEGER NOT NULL DEFAULT 0,  -- 0 = failed, 1 = success
  failure_reason TEXT,  -- e.g., 'invalid_password', 'user_not_found', 'account_locked'

  -- Timestamp
  created_at INTEGER NOT NULL
);

-- =============================================================================
-- Indexes for admin_login_attempts
-- =============================================================================

-- Email-based lookup (for rate limiting per email)
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_email ON admin_login_attempts(tenant_id, email, created_at DESC);

-- IP-based lookup (for rate limiting per IP)
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip ON admin_login_attempts(ip_address, created_at DESC);

-- Time-based cleanup
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_time ON admin_login_attempts(created_at);

-- Success tracking (for security monitoring)
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_success ON admin_login_attempts(success, created_at DESC);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- IP allowlist is now ready for use.
--
-- Usage:
-- 1. When admin_ip_allowlist is empty for a tenant, all IPs are allowed
-- 2. When entries exist, only enabled entries are checked
-- 3. Client IP is obtained from CF-Connecting-IP header (Cloudflare)
-- 4. CIDR matching is done in application code
--
-- Security notes:
-- - Always use CF-Connecting-IP for real client IP (not X-Forwarded-For)
-- - Consider adding office VPN and CI/CD IPs before restricting
-- - Keep at least one admin with IP access to prevent lockout
-- =============================================================================
