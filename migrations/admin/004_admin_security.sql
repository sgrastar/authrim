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
