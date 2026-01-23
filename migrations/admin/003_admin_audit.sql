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
