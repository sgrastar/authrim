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
