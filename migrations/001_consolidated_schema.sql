-- =============================================================================
-- Consolidated Initial Schema
-- =============================================================================
-- This is a consolidated version of migrations 000-022
-- Created: 2025-12-11
-- 
-- Original migrations archived in: migrations/archive/
-- =============================================================================



-- =============================================================================
-- Source: 000_schema_migrations.sql
-- =============================================================================

-- Migration Management Table
-- Created: 2025-11-16
-- Description: Tracks applied migrations for schema version management
-- Issue: #14 - Schema version management

-- =============================================================================
-- Schema Migrations Table
-- =============================================================================
-- This table tracks all applied migrations and enables:
-- - Migration history visibility
-- - Checksum validation (detects file tampering)
-- - Idempotent migrations (safe to run multiple times)
-- - Rollback support
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  -- Migration version (from filename: 001_initial_schema.sql -> version = 1)
  version INTEGER PRIMARY KEY,

  -- Human-readable migration name (from filename: 001_initial_schema.sql -> name = "initial_schema")
  name TEXT NOT NULL,

  -- When the migration was applied (Unix timestamp in seconds)
  applied_at INTEGER NOT NULL,

  -- SHA-256 checksum of the migration SQL file (detects file modifications)
  checksum TEXT NOT NULL,

  -- How long the migration took to execute (milliseconds)
  execution_time_ms INTEGER,

  -- Optional: SQL for rolling back this migration
  rollback_sql TEXT
);

-- Index for querying migration history chronologically
CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations(applied_at DESC);

-- Index for validating checksums
CREATE INDEX IF NOT EXISTS idx_schema_migrations_checksum ON schema_migrations(checksum);

-- =============================================================================
-- Migration Metadata
-- =============================================================================
-- This single-row table stores global migration metadata
-- =============================================================================

CREATE TABLE IF NOT EXISTS migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global',

  -- Current schema version (highest applied migration version)
  current_version INTEGER NOT NULL DEFAULT 0,

  -- Last migration applied timestamp
  last_migration_at INTEGER,

  -- Environment (development, staging, production)
  environment TEXT DEFAULT 'development',

  -- Additional metadata as JSON
  metadata_json TEXT
);

-- Insert initial metadata row
INSERT OR IGNORE INTO migration_metadata (id, current_version, environment)
VALUES ('global', 0, 'development');

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- This migration (000) should be applied before any other migrations
-- It creates the infrastructure needed to track all subsequent migrations
-- =============================================================================

-- =============================================================================
-- Source: 001_initial_schema.sql
-- =============================================================================

-- Authrim Phase 5: Initial Database Schema
-- Created: 2025-11-13
-- Description: Creates all 12 tables for Phase 5 implementation (includes password auth support)
-- Documentation: docs/architecture/database-schema.md

-- =============================================================================
-- 1. Users Core Table (Non-PII data in Core DB)
-- =============================================================================
-- PII Separation Architecture:
-- - users_core: Authentication data, status (Core DB)
-- - users_pii: Personal information (PII DB)
-- =============================================================================
CREATE TABLE users_core (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  -- Verification status (no PII here)
  email_verified INTEGER DEFAULT 0,
  phone_number_verified INTEGER DEFAULT 0,
  -- Blind index for email domain (for domain-based rules, no PII)
  email_domain_hash TEXT,
  -- Password authentication
  password_hash TEXT,
  -- Account status
  is_active INTEGER DEFAULT 1,
  user_type TEXT DEFAULT 'end_user',  -- end_user | admin | m2m | anonymous
  -- PII routing
  pii_partition TEXT DEFAULT 'default',
  pii_status TEXT DEFAULT 'none',  -- none | pending | active | failed | deleted
  -- Suspend/Lock status (Admin SDK)
  status TEXT DEFAULT 'active',  -- active | suspended | locked
  suspended_at INTEGER,
  suspended_until INTEGER,
  locked_at INTEGER,
  locked_until INTEGER,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX idx_users_core_tenant ON users_core(tenant_id);
CREATE INDEX idx_users_core_created_at ON users_core(created_at);
CREATE INDEX idx_users_core_user_type ON users_core(user_type);
CREATE INDEX idx_users_core_pii_status ON users_core(pii_status);
CREATE INDEX idx_users_core_email_domain ON users_core(email_domain_hash);

-- =============================================================================
-- 2. User Custom Fields Table (searchable custom attributes)
-- =============================================================================
CREATE TABLE user_custom_fields (
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT,
  field_type TEXT,
  searchable INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, field_name),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_custom_fields_search ON user_custom_fields(field_name, field_value);

-- =============================================================================
-- 3. Passkeys/WebAuthn Credentials Table
-- =============================================================================
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);
CREATE INDEX idx_passkeys_credential_id ON passkeys(credential_id);

-- =============================================================================
-- 4. Password Reset Tokens Table (optional, for password authentication)
-- =============================================================================
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_token_hash ON password_reset_tokens(token_hash);
CREATE INDEX idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);

-- =============================================================================
-- 5. OAuth Clients Table (RFC 7591 DCR compliant)
-- =============================================================================
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,  -- SHA-256 hash of client_secret
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT,
  logo_uri TEXT,
  client_uri TEXT,
  policy_uri TEXT,
  tos_uri TEXT,
  contacts TEXT,
  subject_type TEXT DEFAULT 'public',
  sector_identifier_uri TEXT,
  token_endpoint_auth_method TEXT DEFAULT 'client_secret_basic',
  -- RFC 8693: Token Exchange settings
  token_exchange_allowed INTEGER DEFAULT 0,
  allowed_subject_token_clients TEXT,  -- JSON array of client IDs
  allowed_token_exchange_resources TEXT,  -- JSON array of resource URIs
  delegation_mode TEXT DEFAULT 'delegation',  -- 'none' | 'delegation' | 'impersonation'
  -- RFC 6749 Section 4.4: Client Credentials settings
  client_credentials_allowed INTEGER DEFAULT 0,
  allowed_scopes TEXT,  -- JSON array of allowed scopes
  default_scope TEXT,  -- Default scope for Client Credentials
  default_audience TEXT,  -- Default audience for Client Credentials
  -- RFC 7591: Dynamic Client Registration
  software_id TEXT,  -- Software identifier (unique per application)
  software_version TEXT,  -- Software version string
  requestable_scopes TEXT,  -- JSON array: scopes this client can request (DCR scope restriction)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_clients_created_at ON oauth_clients(created_at);
CREATE INDEX idx_clients_software_id_tenant ON oauth_clients(software_id, tenant_id);

-- =============================================================================
-- 6. User Sessions Table
-- =============================================================================
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- External provider mapping for backchannel logout (OIDC Back-Channel Logout 1.0)
  external_provider_id TEXT,
  external_provider_sub TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
-- Index for backchannel logout queries by provider and subject
CREATE INDEX idx_sessions_external_provider ON sessions(external_provider_id, external_provider_sub);

-- =============================================================================
-- 7. Roles Table (RBAC)
-- =============================================================================
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT UNIQUE NOT NULL,
  display_name TEXT,
  description TEXT,
  permissions_json TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  role_type TEXT NOT NULL DEFAULT 'custom',  -- system, builtin, custom
  parent_role_id TEXT REFERENCES roles(id),  -- For role inheritance
  hierarchy_level INTEGER DEFAULT 0,         -- Depth in role hierarchy
  is_assignable INTEGER DEFAULT 1,           -- Can this role be assigned to users
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_roles_name ON roles(name);
CREATE INDEX idx_roles_tenant_id ON roles(tenant_id);
CREATE INDEX idx_roles_type ON roles(role_type);

-- =============================================================================
-- 8. User Roles Table (N:M relationship)
-- =============================================================================
CREATE TABLE user_roles (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);

-- =============================================================================
-- 9. Scope Mappings Table (custom scope to claim mapping)
-- =============================================================================
CREATE TABLE scope_mappings (
  scope TEXT NOT NULL,
  claim_name TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_column TEXT NOT NULL,
  transformation TEXT,
  condition TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, claim_name)
);

CREATE INDEX idx_scope_mappings_scope ON scope_mappings(scope);

-- =============================================================================
-- 10. Branding Settings Table (UI customization)
-- =============================================================================
CREATE TABLE branding_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  custom_css TEXT,
  custom_html_header TEXT,
  custom_html_footer TEXT,
  logo_url TEXT,
  background_image_url TEXT,
  primary_color TEXT DEFAULT '#3B82F6',
  secondary_color TEXT DEFAULT '#10B981',
  font_family TEXT DEFAULT 'Inter',
  -- Authentication method settings
  enabled_auth_methods TEXT DEFAULT '["passkey","magic_link"]', -- JSON array
  password_policy_json TEXT, -- Password policy config (if password auth enabled)
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 11. Identity Providers Table (future SAML/LDAP support)
-- =============================================================================
CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type);

-- =============================================================================
-- 12. Audit Log Table
-- =============================================================================
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Total tables created: 12
-- Total indexes created: 23 (added 3 for password_reset_tokens)
-- Version: 001
-- =============================================================================

-- =============================================================================
-- Source: 002_seed_default_data.sql
-- =============================================================================

-- Authrim Phase 5: Seed Default Data
-- Created: 2025-11-13
-- Description: Insert default roles, branding settings, and test data
-- Documentation: docs/architecture/database-schema.md

-- =============================================================================
-- Default Roles (RBAC)
-- =============================================================================

-- Super Admin: Full system access
INSERT INTO roles (id, tenant_id, name, display_name, description, permissions_json, is_system, role_type, created_at, updated_at) VALUES (
  'role_super_admin',
  'default',
  'super_admin',
  'Super Administrator',
  'Super Administrator with full system access',
  '["*"]',
  1,
  'system',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Admin: User and client management
INSERT INTO roles (id, tenant_id, name, display_name, description, permissions_json, is_system, role_type, created_at, updated_at) VALUES (
  'role_admin',
  'default',
  'admin',
  'Administrator',
  'Administrator with user and client management permissions',
  '["users:read","users:write","users:delete","clients:read","clients:write","clients:delete","sessions:read","sessions:revoke","stats:read","audit:read"]',
  1,
  'system',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Viewer: Read-only access
INSERT INTO roles (id, tenant_id, name, display_name, description, permissions_json, is_system, role_type, created_at, updated_at) VALUES (
  'role_viewer',
  'default',
  'viewer',
  'Viewer',
  'Viewer with read-only access to system data',
  '["users:read","clients:read","stats:read","audit:read"]',
  1,
  'builtin',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Support: User support operations
INSERT INTO roles (id, tenant_id, name, display_name, description, permissions_json, is_system, role_type, created_at, updated_at) VALUES (
  'role_support',
  'default',
  'support',
  'Support',
  'Support user with limited user management permissions',
  '["users:read","users:write","sessions:read","sessions:revoke"]',
  1,
  'builtin',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- =============================================================================
-- Default Branding Settings
-- =============================================================================

INSERT INTO branding_settings (id, primary_color, secondary_color, font_family, updated_at) VALUES (
  'default',
  '#3B82F6',
  '#10B981',
  'Inter',
  strftime('%s', 'now')
);

-- =============================================================================
-- Default Scope Mappings (OIDC Standard Claims)
-- =============================================================================

-- Profile scope mappings (PII data from users_pii)
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('profile', 'name', 'users_pii', 'name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'given_name', 'users_pii', 'given_name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'family_name', 'users_pii', 'family_name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'middle_name', 'users_pii', 'middle_name', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'nickname', 'users_pii', 'nickname', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'preferred_username', 'users_pii', 'preferred_username', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'profile', 'users_pii', 'profile', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'picture', 'users_pii', 'picture', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'website', 'users_pii', 'website', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'gender', 'users_pii', 'gender', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'birthdate', 'users_pii', 'birthdate', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'zoneinfo', 'users_pii', 'zoneinfo', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'locale', 'users_pii', 'locale', NULL, NULL, strftime('%s', 'now')),
  ('profile', 'updated_at', 'users_core', 'updated_at', NULL, NULL, strftime('%s', 'now'));

-- Email scope mapping (email from PII, verified status from Core)
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('email', 'email', 'users_pii', 'email', NULL, NULL, strftime('%s', 'now')),
  ('email', 'email_verified', 'users_core', 'email_verified', NULL, NULL, strftime('%s', 'now'));

-- Phone scope mapping (phone from PII, verified status from Core)
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('phone', 'phone_number', 'users_pii', 'phone_number', NULL, NULL, strftime('%s', 'now')),
  ('phone', 'phone_number_verified', 'users_core', 'phone_number_verified', NULL, NULL, strftime('%s', 'now'));

-- Address scope mapping (from PII)
INSERT INTO scope_mappings (scope, claim_name, source_table, source_column, transformation, condition, created_at) VALUES
  ('address', 'address', 'users_pii', 'address_formatted', NULL, NULL, strftime('%s', 'now'));

-- =============================================================================
-- Test Data (Development/Staging Only)
-- NOTE: With PII separation, test users should be created via the setup wizard
--       which handles both Core DB and PII DB insertions.
-- =============================================================================

-- NOTE: Test user data has been removed because it requires PII separation.
-- Use the setup wizard (/admin-init-setup) to create the initial admin user.
-- The wizard will properly insert:
--   - users_core record (Core DB): id, tenant_id, email_verified, etc.
--   - users_pii record (PII DB): id, tenant_id, email, name, etc.
--
-- Role assignments for test users are commented out:
-- INSERT INTO user_roles (user_id, role_id, created_at) VALUES
--   ('user_test_admin', 'role_super_admin', strftime('%s', 'now'));

-- Test OAuth Client (for development)
-- Note: client_secret_hash is SHA-256 of 'test-secret-12345'
INSERT INTO oauth_clients (
  client_id,
  client_secret_hash,
  client_name,
  redirect_uris,
  grant_types,
  response_types,
  scope,
  logo_uri,
  client_uri,
  policy_uri,
  tos_uri,
  subject_type,
  token_endpoint_auth_method,
  created_at,
  updated_at
) VALUES (
  'test_client_app',
  'a7b1f7c9e8d2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8',
  'Test Application',
  '["http://localhost:3000/callback","http://localhost:3000/auth/callback"]',
  '["authorization_code","refresh_token"]',
  '["code"]',
  'openid profile email',
  'https://ui-avatars.com/api/?name=Test+App&background=6366F1&color=fff',
  'http://localhost:3000',
  'http://localhost:3000/privacy',
  'http://localhost:3000/terms',
  'public',
  'client_secret_basic',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Test OAuth Client (SPA - no secret, public client)
INSERT INTO oauth_clients (
  client_id,
  client_secret_hash,
  client_name,
  redirect_uris,
  grant_types,
  response_types,
  scope,
  logo_uri,
  client_uri,
  subject_type,
  token_endpoint_auth_method,
  created_at,
  updated_at
) VALUES (
  'test_spa_app',
  NULL,
  'Test SPA Application',
  '["http://localhost:5173/callback","http://localhost:5173/auth/callback"]',
  '["authorization_code","refresh_token"]',
  '["code"]',
  'openid profile email',
  'https://ui-avatars.com/api/?name=SPA&background=EC4899&color=fff',
  'http://localhost:5173',
  'public',
  'none',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- NOTE: Sample custom fields and audit log entries for test users removed.
-- These will be created when users are added via the setup wizard.

-- =============================================================================
-- Seed Complete
-- =============================================================================
-- Default roles: 4
-- Default scope mappings: 19
-- Test OAuth clients: 2
-- Version: 002 (Updated for PII separation)
-- =============================================================================

-- =============================================================================
-- Source: 003_add_consent_table.sql
-- =============================================================================

-- Migration: Add OAuth Client Consents Table
-- Purpose: Track user consent history for OAuth clients
-- Date: 2025-01-20

CREATE TABLE IF NOT EXISTS oauth_client_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  UNIQUE (user_id, client_id)
);

-- Index for faster lookup by user_id and client_id
CREATE INDEX IF NOT EXISTS idx_consents_user_client ON oauth_client_consents(user_id, client_id);

-- Index for cleanup of expired consents
CREATE INDEX IF NOT EXISTS idx_consents_expires_at ON oauth_client_consents(expires_at);

-- =============================================================================
-- Source: 004_add_client_trust_settings.sql
-- =============================================================================

-- Migration: 004_add_client_trust_settings.sql
-- Description: Add Trusted Client support to enable First-Party clients to skip consent screens
-- Author: @claude
-- Date: 2025-01-20
-- Issue: Trusted Client implementation
-- Spec: packages/op-auth/TRUSTED_CLIENT_SPEC.md

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- Add trusted client flags to oauth_clients table
-- is_trusted: 1 = Trusted (First-Party) Client, 0 = Third-Party Client
-- skip_consent: 1 = Skip consent screen, 0 = Show consent screen
-- Trusted clients can automatically grant consent without user interaction

ALTER TABLE oauth_clients ADD COLUMN is_trusted INTEGER DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN skip_consent INTEGER DEFAULT 0;

-- Index for faster lookup of trusted clients
CREATE INDEX IF NOT EXISTS idx_clients_trusted ON oauth_clients(is_trusted);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- Drop index:
-- DROP INDEX IF EXISTS idx_clients_trusted;

-- Remove columns:
-- ALTER TABLE oauth_clients DROP COLUMN skip_consent;
-- ALTER TABLE oauth_clients DROP COLUMN is_trusted;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 004
-- =============================================================================

-- =============================================================================
-- Source: 005_add_claims_parameter_setting.sql
-- =============================================================================

-- Migration 005: Add Claims Parameter Setting
-- Created: 2025-11-21
-- Description: Add allow_claims_without_scope column to oauth_clients table
--              to control whether claims parameter can request claims without corresponding scope
-- =============================================================================

-- Add allow_claims_without_scope column
-- 0 (default) = Strict: Only return claims for granted scopes
-- 1 = Flexible: Return claims requested via claims parameter even without scope
ALTER TABLE oauth_clients ADD COLUMN allow_claims_without_scope INTEGER DEFAULT 0;

-- Create index for fast lookups (optional, since this will be used with client_id primary key)
CREATE INDEX IF NOT EXISTS idx_clients_claims_setting ON oauth_clients(allow_claims_without_scope);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 005
-- =============================================================================

-- =============================================================================
-- Source: 006_add_device_codes_table.sql
-- =============================================================================

-- Authrim Phase 7: Device Flow Support
-- Created: 2025-11-21
-- Description: Adds device_codes table for RFC 8628 Device Authorization Grant
-- RFC: https://datatracker.ietf.org/doc/html/rfc8628

-- =============================================================================
-- Device Codes Table (RFC 8628)
-- =============================================================================
-- Stores device authorization codes for Device Flow
-- Used by DeviceCodeStore Durable Object for persistence and recovery
CREATE TABLE device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  user_id TEXT,
  sub TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

-- Index for quick user_code lookup (user enters this code)
CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);

-- Index for expiration cleanup
CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);

-- Index for client_id queries
CREATE INDEX idx_device_codes_client_id ON device_codes(client_id);

-- Index for status queries (pending, approved, etc.)
CREATE INDEX idx_device_codes_status ON device_codes(status);

-- =============================================================================
-- Source: 007_add_ciba_requests_table.sql
-- =============================================================================

-- Authrim Phase 8: CIBA Support
-- Created: 2025-11-21
-- Description: Adds ciba_requests table for OpenID Connect CIBA Flow
-- Spec: https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html

-- =============================================================================
-- CIBA Requests Table (OIDC CIBA Core 1.0)
-- =============================================================================
-- Stores CIBA authentication requests for Client Initiated Backchannel Authentication
-- Used by CIBARequestStore Durable Object for persistence and recovery
CREATE TABLE ciba_requests (
  auth_req_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,

  -- Login hints (at least one required)
  login_hint TEXT,
  login_hint_token TEXT,
  id_token_hint TEXT,

  -- Optional parameters
  binding_message TEXT,
  user_code TEXT,
  acr_values TEXT,
  requested_expiry INTEGER,

  -- Status and delivery mode
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('poll', 'ping', 'push')),

  -- Notification settings (for ping/push modes)
  client_notification_token TEXT,
  client_notification_endpoint TEXT,

  -- Timing and expiration
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  interval INTEGER NOT NULL DEFAULT 5,

  -- User approval
  user_id TEXT,
  sub TEXT,
  nonce TEXT,

  -- Token issuance tracking
  token_issued INTEGER DEFAULT 0, -- Boolean (0/1)
  token_issued_at INTEGER,

  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

-- Index for quick auth_req_id lookup
CREATE INDEX idx_ciba_requests_auth_req_id ON ciba_requests(auth_req_id);

-- Index for expiration cleanup
CREATE INDEX idx_ciba_requests_expires_at ON ciba_requests(expires_at);

-- Index for client_id queries
CREATE INDEX idx_ciba_requests_client_id ON ciba_requests(client_id);

-- Index for status queries (pending, approved, etc.)
CREATE INDEX idx_ciba_requests_status ON ciba_requests(status);

-- Index for user_code lookup (if provided)
CREATE INDEX idx_ciba_requests_user_code ON ciba_requests(user_code) WHERE user_code IS NOT NULL;

-- Index for login_hint lookup
CREATE INDEX idx_ciba_requests_login_hint ON ciba_requests(login_hint) WHERE login_hint IS NOT NULL;

-- Index for user_id queries
CREATE INDEX idx_ciba_requests_user_id ON ciba_requests(user_id) WHERE user_id IS NOT NULL;

-- =============================================================================
-- Update oauth_clients table to support CIBA
-- =============================================================================
-- Add CIBA-specific client configuration

-- Add backchannel_token_delivery_mode column
-- Indicates which CIBA delivery modes the client supports
-- Can be: 'poll', 'ping', 'push', or combination like 'poll,ping'
ALTER TABLE oauth_clients ADD COLUMN backchannel_token_delivery_mode TEXT;

-- Add backchannel_client_notification_endpoint column
-- URL where the OP sends notifications (for ping/push modes)
ALTER TABLE oauth_clients ADD COLUMN backchannel_client_notification_endpoint TEXT;

-- Add backchannel_authentication_request_signing_alg column
-- Algorithm used for signed authentication requests (optional)
ALTER TABLE oauth_clients ADD COLUMN backchannel_authentication_request_signing_alg TEXT;

-- Add backchannel_user_code_parameter column
-- Whether the client supports user_code parameter
ALTER TABLE oauth_clients ADD COLUMN backchannel_user_code_parameter INTEGER DEFAULT 0;

-- =============================================================================
-- Source: 008_add_tenant_id_to_all_tables.sql
-- =============================================================================

-- Migration: 008_add_tenant_id_to_all_tables.sql
-- Description: Add tenant_id column to all tables for future multi-tenant support
-- Author: @authrim
-- Date: 2025-11-28
-- Issue: Multi-tenant readiness

-- =============================================================================
-- Auto-generated by: npx tsx scripts/generate-tenant-migration.ts
-- Generated at: 2025-11-28T04:17:12.834Z
-- Tables detected: 16
-- =============================================================================

-- This migration adds tenant_id to all tables with DEFAULT 'default'.
-- In single-tenant mode, all data uses the 'default' tenant.
-- For future multi-tenant mode, the tenant resolver will set appropriate values.

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- Add tenant_id column to all tables
ALTER TABLE audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE branding_settings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE ciba_requests ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE device_codes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE identity_providers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE migration_metadata ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE oauth_client_consents ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE oauth_clients ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE passkeys ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE password_reset_tokens ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE roles ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE scope_mappings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE user_custom_fields ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE user_roles ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
-- NOTE: users_core already created with tenant_id in initial schema

-- Create indexes for frequently queried tables
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_tenant_id ON oauth_clients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_tenant_id ON passkeys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_roles_tenant_id ON roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions(tenant_id);
-- NOTE: idx_users_core_tenant already created in initial schema

-- NOTE: Email is in users_pii (PII DB), not users_core
-- Email uniqueness is enforced in PII DB via idx_users_pii_email index

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- WARNING: This will fail if any tenant_id values other than 'default' exist.
--
-- -- Restore original unique constraints
-- DROP INDEX IF EXISTS idx_users_tenant_email;
-- CREATE UNIQUE INDEX idx_users_email ON users(email);
--
-- -- Drop tenant_id indexes
-- DROP INDEX IF EXISTS idx_audit_log_tenant_id;
-- DROP INDEX IF EXISTS idx_oauth_clients_tenant_id;
-- DROP INDEX IF EXISTS idx_passkeys_tenant_id;
-- DROP INDEX IF EXISTS idx_roles_tenant_id;
-- DROP INDEX IF EXISTS idx_sessions_tenant_id;
-- DROP INDEX IF EXISTS idx_users_tenant_id;
--
-- -- Drop tenant_id columns
-- ALTER TABLE audit_log DROP COLUMN tenant_id;
-- ALTER TABLE branding_settings DROP COLUMN tenant_id;
-- ALTER TABLE ciba_requests DROP COLUMN tenant_id;
-- ALTER TABLE device_codes DROP COLUMN tenant_id;
-- ALTER TABLE identity_providers DROP COLUMN tenant_id;
-- ALTER TABLE migration_metadata DROP COLUMN tenant_id;
-- ALTER TABLE oauth_client_consents DROP COLUMN tenant_id;
-- ALTER TABLE oauth_clients DROP COLUMN tenant_id;
-- ALTER TABLE passkeys DROP COLUMN tenant_id;
-- ALTER TABLE password_reset_tokens DROP COLUMN tenant_id;
-- ALTER TABLE roles DROP COLUMN tenant_id;
-- ALTER TABLE scope_mappings DROP COLUMN tenant_id;
-- ALTER TABLE sessions DROP COLUMN tenant_id;
-- ALTER TABLE user_custom_fields DROP COLUMN tenant_id;
-- ALTER TABLE user_roles DROP COLUMN tenant_id;
-- ALTER TABLE users DROP COLUMN tenant_id;
--
-- -- Remove migration record
-- DELETE FROM schema_migrations WHERE version = 8;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 008
-- =============================================================================

-- =============================================================================
-- Source: 009_rbac_phase1_organizations.sql
-- =============================================================================

-- Migration: 009_rbac_phase1_organizations.sql
-- Description: Create organizations and subject_org_membership tables for RBAC Phase 1
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Organizations Table
-- =============================================================================
-- Represents companies, departments, or other organizational units.
-- Used for B2B/B2B2C scenarios (distributors, enterprise customers, etc.)

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  org_type TEXT NOT NULL DEFAULT 'enterprise',  -- distributor, enterprise, department
  parent_org_id TEXT REFERENCES organizations(id),
  plan TEXT DEFAULT 'free',  -- free, starter, professional, enterprise
  is_active INTEGER DEFAULT 1,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes for organizations
CREATE INDEX idx_organizations_tenant_id ON organizations(tenant_id);
CREATE INDEX idx_organizations_parent_org_id ON organizations(parent_org_id);
CREATE INDEX idx_organizations_org_type ON organizations(org_type);
CREATE INDEX idx_organizations_is_active ON organizations(is_active);
CREATE UNIQUE INDEX idx_organizations_tenant_name ON organizations(tenant_id, name);

-- =============================================================================
-- 2. Subject-Organization Membership Table
-- =============================================================================
-- Links users (subjects) to organizations with a specific membership type.
-- is_primary = 1 indicates the user's primary organization (source of truth).

CREATE TABLE subject_org_membership (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL REFERENCES users_core(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_type TEXT NOT NULL DEFAULT 'member',  -- member, admin, owner
  is_primary INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes for subject_org_membership
CREATE INDEX idx_subject_org_membership_tenant_id ON subject_org_membership(tenant_id);
CREATE INDEX idx_subject_org_membership_subject_id ON subject_org_membership(subject_id);
CREATE INDEX idx_subject_org_membership_org_id ON subject_org_membership(org_id);
CREATE INDEX idx_subject_org_membership_is_primary ON subject_org_membership(subject_id, is_primary);
CREATE UNIQUE INDEX idx_subject_org_membership_unique ON subject_org_membership(subject_id, org_id);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 009
-- =============================================================================

-- =============================================================================
-- Source: 010_rbac_phase1_role_enhancements.sql
-- =============================================================================

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

-- =============================================================================
-- Source: 011_rbac_phase1_role_assignments.sql
-- =============================================================================

-- Migration: 011_rbac_phase1_role_assignments.sql
-- Description: Create role_assignments table to replace user_roles with scope support
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Create role_assignments Table
-- =============================================================================
-- Replaces user_roles with support for scoped role assignments.
-- scope_type: global (tenant-wide), org (organization), resource (specific resource)
-- scope_target: Empty string for global, or "type:id" format (e.g., "org:org_123")

CREATE TABLE role_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL REFERENCES users_core(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'global',  -- global, org, resource
  scope_target TEXT NOT NULL DEFAULT '',  -- Empty for global, "type:id" format otherwise
  expires_at INTEGER,  -- Optional expiration (UNIX seconds)
  assigned_by TEXT,  -- User ID who made the assignment
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 2. Indexes for role_assignments
-- =============================================================================

CREATE INDEX idx_role_assignments_tenant_id ON role_assignments(tenant_id);
CREATE INDEX idx_role_assignments_subject_id ON role_assignments(subject_id);
CREATE INDEX idx_role_assignments_role_id ON role_assignments(role_id);
CREATE INDEX idx_role_assignments_scope ON role_assignments(scope_type, scope_target);
CREATE INDEX idx_role_assignments_expires_at ON role_assignments(expires_at);

-- Unique constraint: prevent duplicate assignments for same subject/role/scope
CREATE UNIQUE INDEX idx_role_assignments_unique
  ON role_assignments(tenant_id, subject_id, role_id, scope_type, scope_target);

-- =============================================================================
-- 3. Migrate existing user_roles data to role_assignments
-- =============================================================================
-- Existing user_roles entries become global scope assignments

INSERT INTO role_assignments (
  id,
  tenant_id,
  subject_id,
  role_id,
  scope_type,
  scope_target,
  expires_at,
  assigned_by,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))) as id,
  tenant_id,
  user_id as subject_id,
  role_id,
  'global' as scope_type,
  '' as scope_target,
  NULL as expires_at,
  NULL as assigned_by,
  NULL as metadata_json,
  created_at,
  created_at as updated_at
FROM user_roles
WHERE NOT EXISTS (
  SELECT 1 FROM role_assignments ra
  WHERE ra.subject_id = user_roles.user_id
    AND ra.role_id = user_roles.role_id
    AND ra.scope_type = 'global'
);

-- =============================================================================
-- 4. Note: user_roles table is kept for backwards compatibility
-- =============================================================================
-- The user_roles table is NOT dropped to maintain backwards compatibility.
-- New code should use role_assignments; user_roles will be deprecated in Phase 2.
-- A view or trigger could be added later to keep them in sync if needed.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 011
-- =============================================================================

-- =============================================================================
-- Source: 012_rbac_phase1_relationships.sql
-- =============================================================================

-- Migration: 012_rbac_phase1_relationships.sql
-- Description: Create relationships table for parent-child and other subject relationships
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Create relationships Table
-- =============================================================================
-- Replaces users.parent_user_id with a more flexible relationship model.
-- Supports subject-subject relationships now, and org-org relationships in the future.
--
-- relationship_type:
--   - parent_child: Parent managing a child account
--   - guardian: Legal guardian relationship
--   - delegate: Delegated access (e.g., assistant)
--   - manager: Manager-subordinate relationship
--   - reseller_of: Distributor/reseller relationship (for org-org, Phase 2+)
--
-- from_type/to_type:
--   - subject: User ID
--   - org: Organization ID (for future use)
--
-- Phase 1 uses subject-subject only. is_bidirectional is always 0.

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  relationship_type TEXT NOT NULL,  -- parent_child, guardian, delegate, manager, reseller_of
  from_type TEXT NOT NULL DEFAULT 'subject',  -- subject, org (future)
  from_id TEXT NOT NULL,  -- subject_id or org_id
  to_type TEXT NOT NULL DEFAULT 'subject',  -- subject, org (future)
  to_id TEXT NOT NULL,  -- subject_id or org_id
  permission_level TEXT NOT NULL DEFAULT 'full',  -- full, limited, read_only
  expires_at INTEGER,  -- Optional expiration (UNIX seconds)
  is_bidirectional INTEGER DEFAULT 0,  -- Phase 1: always 0
  metadata_json TEXT,  -- Additional constraints, notes, etc.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 2. Indexes for relationships
-- =============================================================================

CREATE INDEX idx_relationships_tenant_id ON relationships(tenant_id);
CREATE INDEX idx_relationships_from ON relationships(from_type, from_id);
CREATE INDEX idx_relationships_to ON relationships(to_type, to_id);
CREATE INDEX idx_relationships_type ON relationships(relationship_type);
CREATE INDEX idx_relationships_expires_at ON relationships(expires_at);

-- Unique constraint: prevent duplicate relationships
CREATE UNIQUE INDEX idx_relationships_unique
  ON relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);

-- =============================================================================
-- 3. Migrate existing parent_user_id data to relationships
-- =============================================================================
-- NOTE: Disabled for PII separation architecture.
-- parent_user_id is no longer in users_core table.
-- For existing environment upgrades, run migration 002_pii_separation.sql
--
-- INSERT INTO relationships (...)
-- SELECT ... FROM users_core u WHERE u.parent_user_id IS NOT NULL ...

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 012
-- =============================================================================

-- =============================================================================
-- Source: 013_rbac_phase1_user_attributes.sql
-- =============================================================================

-- Migration: 013_rbac_phase1_user_attributes.sql
-- Description: Add user_type column to users table
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Add user_type column to users table
-- =============================================================================
-- user_type is a coarse classification for UI/logging purposes.
-- Actual authorization should use role_assignments, NOT user_type.
--
-- Values:
--   - end_user: Regular end user (default)
--   - distributor_admin: Distributor/reseller administrator
--   - enterprise_admin: Enterprise customer administrator
--   - system_admin: System administrator

-- NOTE: users_core already created with user_type column in initial schema
-- ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'end_user';

-- =============================================================================
-- 2. Note on user_type index
-- =============================================================================
-- idx_users_core_user_type already created in initial schema

-- =============================================================================
-- 3. Note: primary_org_id is NOT added in Phase 1
-- =============================================================================
-- Primary organization is determined by subject_org_membership.is_primary = 1.
-- This avoids dual source of truth issues.
-- If performance becomes a concern, primary_org_id can be added as a cache
-- column in a future migration.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 013
-- =============================================================================

-- =============================================================================
-- Source: 014_rbac_phase1_cleanup.sql
-- =============================================================================

-- Migration: 014_rbac_phase1_cleanup.sql
-- Description: Clean up parent_user_id index after migration to relationships table
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Drop parent_user_id index
-- =============================================================================
-- The parent_user_id column is deprecated in favor of the relationships table.
-- We drop the index but keep the column for backwards compatibility.
-- The column can be removed in a future migration after all code is updated.

DROP INDEX IF EXISTS idx_users_parent_user_id;

-- =============================================================================
-- 2. Note: parent_user_id column is NOT dropped
-- =============================================================================
-- SQLite has limitations on ALTER TABLE DROP COLUMN in older versions.
-- More importantly, keeping the column ensures backwards compatibility
-- during the transition period.
--
-- To remove the column in the future:
-- 1. Ensure no code references parent_user_id
-- 2. Create a new users table without the column
-- 3. Copy data from old table to new table
-- 4. Drop old table and rename new table
--
-- For now, the column remains but should not be used for new records.

-- =============================================================================
-- 3. Verification query (commented out, for manual verification)
-- =============================================================================
-- Run this query to verify all parent_user_id values have been migrated:
--
-- SELECT u.id, u.parent_user_id
-- FROM users u
-- WHERE u.parent_user_id IS NOT NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM relationships r
--     WHERE r.from_id = u.parent_user_id
--       AND r.to_id = u.id
--       AND r.relationship_type = 'parent_child'
--   );
--
-- This query should return 0 rows if migration was successful.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 014
-- =============================================================================

-- =============================================================================
-- Source: 015_add_jwks_to_clients.sql
-- =============================================================================

-- Migration 015: Add JWKS and JWKS URI to OAuth Clients
-- Created: 2025-11-30
-- Description: Add jwks and jwks_uri columns to oauth_clients table
--              to support private_key_jwt client authentication (RFC 7523)
-- =============================================================================

-- Add jwks column (embedded JWKS for static key storage)
-- Stores JSON Web Key Set as JSON string
ALTER TABLE oauth_clients ADD COLUMN jwks TEXT;

-- Add jwks_uri column (URI to fetch JWKS dynamically)
-- Allows clients to rotate keys without re-registration
ALTER TABLE oauth_clients ADD COLUMN jwks_uri TEXT;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 015
-- =============================================================================

-- =============================================================================
-- Source: 016_add_userinfo_signed_response_alg.sql
-- =============================================================================

-- Migration 016: Add userinfo_signed_response_alg to OAuth Clients
-- Created: 2025-11-30
-- Description: Add userinfo_signed_response_alg column to oauth_clients table
--              to support signed UserInfo responses (OIDC Core 5.3.3)
-- =============================================================================

-- Add userinfo_signed_response_alg column
-- Stores the algorithm for signing UserInfo responses (e.g., 'RS256', 'none')
ALTER TABLE oauth_clients ADD COLUMN userinfo_signed_response_alg TEXT;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 016
-- =============================================================================

-- =============================================================================
-- Source: 017_rebac_closure_table.sql
-- =============================================================================

-- Migration: 017_rebac_closure_table.sql
-- Description: Create relationship_closure table for ReBAC transitive relationship resolution
-- Author: @authrim
-- Date: 2025-12-01
-- Issue: Phase 3 - ReBAC + RBAC + ABAC Implementation

-- =============================================================================
-- 1. Create relationship_closure Table
-- =============================================================================
-- Stores pre-computed transitive relationships for efficient listObjects/listUsers queries.
-- The check() API uses recursive CTE + KV cache instead of this table.
--
-- Use cases:
--   - listObjects(user, relation, objectType): "Which documents can user X view?"
--   - listUsers(object, relation): "Who can edit document Y?"
--
-- The closure is updated when relationships change, allowing O(1) lookups for listing.
-- For check() operations, we use recursive CTE with KV caching for flexibility.

CREATE TABLE relationship_closure (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Ancestor (source) entity
  ancestor_type TEXT NOT NULL,      -- 'subject', 'org', 'group'
  ancestor_id TEXT NOT NULL,
  -- Descendant (target) entity
  descendant_type TEXT NOT NULL,    -- 'document', 'folder', 'org', 'resource'
  descendant_id TEXT NOT NULL,
  -- Computed relation (derived from relationship chain)
  relation TEXT NOT NULL,           -- 'viewer', 'editor', 'owner'
  -- Path information
  depth INTEGER NOT NULL,           -- Number of hops (0 = direct)
  path_json TEXT,                   -- JSON array of relationship IDs in the path
  -- Computed metadata
  effective_permission TEXT,        -- Most restrictive permission in path
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 2. Indexes for relationship_closure
-- =============================================================================

-- Primary lookup: "What can this user access?"
CREATE INDEX idx_closure_ancestor_lookup
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, relation);

-- Reverse lookup: "Who has access to this resource?"
CREATE INDEX idx_closure_descendant_lookup
  ON relationship_closure(tenant_id, descendant_type, descendant_id, relation);

-- Unique constraint: prevent duplicate closure entries
CREATE UNIQUE INDEX idx_closure_unique
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, descendant_type, descendant_id, relation);

-- Cleanup queries: find entries by depth (for incremental updates)
CREATE INDEX idx_closure_depth
  ON relationship_closure(tenant_id, depth);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 017
-- =============================================================================

-- =============================================================================
-- Source: 018_rebac_relation_definitions.sql
-- =============================================================================

-- Migration: 018_rebac_relation_definitions.sql
-- Description: Create relation_definitions table for Zanzibar-style Relation DSL
-- Author: @authrim
-- Date: 2025-12-01
-- Issue: Phase 3 - ReBAC + RBAC + ABAC Implementation

-- =============================================================================
-- 1. Create relation_definitions Table
-- =============================================================================
-- Stores relation composition rules (similar to Zanzibar's namespace configuration).
-- Allows defining how relations can be computed from other relations.
--
-- Phase 3 MVP supports:
--   - union: OR of multiple relations (viewer = owner OR editor)
--   - tuple_to_userset: Inherit from parent object (document#parent.viewer)
--
-- Phase 4+ will add:
--   - intersection: AND of multiple relations
--   - exclusion: Negation (viewer AND NOT blocked)
--   - computed_userset: Arbitrary computed relations
--
-- Example definition_json for "viewer" relation on "document":
-- {
--   "type": "union",
--   "children": [
--     { "type": "direct", "relation": "viewer" },
--     { "type": "direct", "relation": "editor" },
--     { "type": "direct", "relation": "owner" },
--     {
--       "type": "tuple_to_userset",
--       "tupleset": { "relation": "parent" },
--       "computed_userset": { "relation": "viewer" }
--     }
--   ]
-- }

CREATE TABLE relation_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Object type this definition applies to
  object_type TEXT NOT NULL,        -- 'document', 'folder', 'org', etc.
  -- Relation name being defined
  relation_name TEXT NOT NULL,      -- 'viewer', 'editor', 'owner', etc.
  -- Relation composition rule (JSON)
  definition_json TEXT NOT NULL,
  -- Description for documentation
  description TEXT,
  -- Evaluation priority (higher = evaluated first)
  priority INTEGER DEFAULT 0,
  -- Whether this definition is active
  is_active INTEGER DEFAULT 1,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 2. Indexes for relation_definitions
-- =============================================================================

-- Primary lookup: Get all relation definitions for an object type
CREATE INDEX idx_relation_defs_tenant_object
  ON relation_definitions(tenant_id, object_type);

-- Specific relation lookup
CREATE INDEX idx_relation_defs_lookup
  ON relation_definitions(tenant_id, object_type, relation_name);

-- Unique constraint: one definition per object_type + relation_name per tenant
CREATE UNIQUE INDEX idx_relation_defs_unique
  ON relation_definitions(tenant_id, object_type, relation_name);

-- Active definitions only
CREATE INDEX idx_relation_defs_active
  ON relation_definitions(tenant_id, is_active);

-- =============================================================================
-- 3. Seed default relation definitions
-- =============================================================================
-- Common patterns for document-like resources

INSERT INTO relation_definitions (
  id, tenant_id, object_type, relation_name, definition_json, description, priority, is_active, created_at, updated_at
) VALUES
  -- Document viewer: owner OR editor OR direct viewer OR parent folder's viewer
  (
    'reldef_doc_viewer',
    'default',
    'document',
    'viewer',
    '{"type":"union","children":[{"type":"direct","relation":"owner"},{"type":"direct","relation":"editor"},{"type":"direct","relation":"viewer"},{"type":"tuple_to_userset","tupleset":{"relation":"parent"},"computed_userset":{"relation":"viewer"}}]}',
    'Users who can view a document: owners, editors, direct viewers, or viewers of parent folder',
    100,
    1,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  ),
  -- Document editor: owner OR direct editor
  (
    'reldef_doc_editor',
    'default',
    'document',
    'editor',
    '{"type":"union","children":[{"type":"direct","relation":"owner"},{"type":"direct","relation":"editor"}]}',
    'Users who can edit a document: owners or direct editors',
    100,
    1,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  ),
  -- Document owner: direct owner only
  (
    'reldef_doc_owner',
    'default',
    'document',
    'owner',
    '{"type":"direct","relation":"owner"}',
    'Users who own a document: direct owners only',
    100,
    1,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  ),
  -- Folder viewer: owner OR editor OR viewer OR parent folder's viewer
  (
    'reldef_folder_viewer',
    'default',
    'folder',
    'viewer',
    '{"type":"union","children":[{"type":"direct","relation":"owner"},{"type":"direct","relation":"editor"},{"type":"direct","relation":"viewer"},{"type":"tuple_to_userset","tupleset":{"relation":"parent"},"computed_userset":{"relation":"viewer"}}]}',
    'Users who can view a folder: owners, editors, direct viewers, or viewers of parent folder',
    100,
    1,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  );

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 018
-- =============================================================================

-- =============================================================================
-- Source: 019_vc_did_abstraction.sql
-- =============================================================================

-- Migration: 019_vc_did_abstraction.sql
-- Description: Create abstraction tables for future VC/DID integration
-- Author: @authrim
-- Date: 2025-12-01
-- Issue: Phase 3 - ReBAC + RBAC + ABAC Implementation (VC/DID abstraction layer)

-- =============================================================================
-- Purpose: Prepare for VC/DID Integration (Phase 4+)
-- =============================================================================
-- These tables are created now but mostly empty in Phase 3.
-- When VC/DID is implemented in Phase 4+, these tables will be populated
-- without requiring changes to the Policy Engine or ReBAC service.
--
-- Abstraction approach:
--   1. verified_attributes: Generic attribute store (VC claims write here)
--   2. subject_identifiers: Extensible identity lookup (DID mapping here)
--   3. relationships.evidence_*: VC-sourced relationship provenance
-- =============================================================================

-- =============================================================================
-- 1. Create subject_identifiers Table
-- =============================================================================
-- Maps various identifiers (email, DID, etc.) to user accounts.
-- Phase 3: email / userId only
-- Phase 4+: did:web, did:key, did:ion, did:ethr added here

CREATE TABLE subject_identifiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- User this identifier belongs to
  subject_id TEXT NOT NULL,         -- References users(id)
  -- Identifier details
  identifier_type TEXT NOT NULL,    -- 'email', 'did', 'phone', 'username'
  identifier_value TEXT NOT NULL,   -- 'user@example.com', 'did:key:z6Mk...'
  -- Flags
  is_primary INTEGER DEFAULT 0,     -- Whether this is the primary identifier
  -- Verification
  verified_at INTEGER,              -- When the identifier was verified
  verification_method TEXT,         -- 'email_verification', 'did_auth', 'phone_sms'
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- 2. Indexes for subject_identifiers
-- =============================================================================

-- Lookup by subject
CREATE INDEX idx_subject_identifiers_tenant_subject
  ON subject_identifiers(tenant_id, subject_id);

-- Lookup by identifier (e.g., find user by DID)
CREATE INDEX idx_subject_identifiers_lookup
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

-- Unique constraint: one identifier per type per tenant
CREATE UNIQUE INDEX idx_subject_identifiers_unique
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);

-- Primary identifier lookup
CREATE INDEX idx_subject_identifiers_primary
  ON subject_identifiers(tenant_id, subject_id, is_primary);

-- =============================================================================
-- 3. Create user_verified_attributes Table
-- =============================================================================
-- Stores verified attributes extracted from VCs or other sources.
-- Each user can have one value per attribute (latest wins).
-- Populated by VP verification flow.

CREATE TABLE user_verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'vc',  -- 'vc', 'manual', 'kyc_provider'
  issuer_did TEXT,
  verification_id TEXT,  -- References attribute_verifications(id) - added later
  verified_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,

  UNIQUE(tenant_id, user_id, attribute_name)
);

-- =============================================================================
-- 4. Indexes for user_verified_attributes
-- =============================================================================

-- Lookup by user
CREATE INDEX idx_user_verified_attributes_user
  ON user_verified_attributes(tenant_id, user_id);

-- Attribute name lookup
CREATE INDEX idx_user_verified_attributes_name
  ON user_verified_attributes(tenant_id, attribute_name);

-- Note: UNIQUE constraint already defined in table (tenant_id, user_id, attribute_name)

-- =============================================================================
-- 5. Add evidence columns to relationships table
-- =============================================================================
-- Track the provenance of relationships (manual vs VC-sourced)
-- Phase 3: All values are 'manual'
-- Phase 4+: VC-derived relationships set evidence_type = 'vc'

ALTER TABLE relationships ADD COLUMN evidence_type TEXT DEFAULT 'manual';
-- Values: 'manual', 'vc', 'external_assertion', 'system_derived'

ALTER TABLE relationships ADD COLUMN evidence_ref TEXT;
-- Reference to the evidence (VC credential_id, external system ID, etc.)

-- Index for filtering by evidence type
CREATE INDEX idx_relationships_evidence_type
  ON relationships(tenant_id, evidence_type);

-- =============================================================================
-- 6. Seed existing users' email as subject_identifiers
-- =============================================================================
-- NOTE: Disabled for PII separation architecture.
-- email column is no longer in users_core table (moved to PII DB).
-- For existing environment upgrades, run migration 002_pii_separation.sql
--
-- INSERT INTO subject_identifiers (...)
-- SELECT ... FROM users_core u WHERE u.email IS NOT NULL ...

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 019
-- =============================================================================

-- =============================================================================
-- Source: 020_external_idp_providers.sql
-- =============================================================================

-- Migration: 020_external_idp_providers.sql
-- Description: Create tables for external IdP integration (Phase 7: Identity Hub)
-- Author: Claude
-- Date: 2025-12-03

-- =============================================================================
-- 1. Upstream Providers Table
-- =============================================================================
-- Stores OIDC/OAuth2 provider configurations (Google, GitHub, Microsoft, etc.)

CREATE TABLE IF NOT EXISTS upstream_providers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,                    -- Display name: "Google", "GitHub"
  provider_type TEXT NOT NULL,           -- 'oidc' | 'oauth2'
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,            -- Display order (lower = higher priority)

  -- OIDC/OAuth2 endpoints
  issuer TEXT,                           -- OIDC issuer URL (for discovery)
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL, -- Encrypted with RP_TOKEN_ENCRYPTION_KEY
  authorization_endpoint TEXT,           -- Override for non-standard providers
  token_endpoint TEXT,
  userinfo_endpoint TEXT,
  jwks_uri TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid email profile', -- Space-separated

  -- Configuration
  attribute_mapping TEXT DEFAULT '{}',   -- JSON: {"sub": "sub", "email": "email"}
  auto_link_email INTEGER DEFAULT 1,     -- Enable email-based identity stitching
  jit_provisioning INTEGER DEFAULT 1,    -- Create user on first login
  require_email_verified INTEGER DEFAULT 1, -- Only link if email is verified

  -- Provider-specific settings
  provider_quirks TEXT DEFAULT '{}',     -- JSON for provider-specific handling

  -- UI customization
  icon_url TEXT,                         -- Provider icon for login button
  button_color TEXT,                     -- Brand color for login button (hex)
  button_text TEXT,                      -- Custom button text (optional)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upstream_providers_tenant_id
  ON upstream_providers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_upstream_providers_enabled
  ON upstream_providers(tenant_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_providers_tenant_name
  ON upstream_providers(tenant_id, name);

-- =============================================================================
-- 2. Linked Identities Table
-- =============================================================================
-- Links external provider identities to Authrim users

CREATE TABLE IF NOT EXISTS linked_identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,                 -- References users(id)
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  provider_user_id TEXT NOT NULL,        -- sub claim from provider
  provider_email TEXT,                   -- Email from provider (for stitching)
  email_verified INTEGER DEFAULT 0,      -- Was email verified at provider?

  -- Token storage (encrypted with RP_TOKEN_ENCRYPTION_KEY)
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at INTEGER,

  -- Raw data
  raw_claims TEXT,                       -- JSON of original claims from provider
  profile_data TEXT,                     -- JSON of normalized profile

  -- Timestamps
  linked_at INTEGER NOT NULL,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(provider_id, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_linked_identities_tenant_id
  ON linked_identities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_user_id
  ON linked_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_provider_id
  ON linked_identities(provider_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_provider_email
  ON linked_identities(provider_email);
CREATE INDEX IF NOT EXISTS idx_linked_identities_user_provider
  ON linked_identities(user_id, provider_id);

-- =============================================================================
-- 3. External IdP Auth States Table
-- =============================================================================
-- Tracks OAuth state parameters for CSRF protection and PKCE

CREATE TABLE IF NOT EXISTS external_idp_auth_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  state TEXT UNIQUE NOT NULL,            -- OAuth state parameter
  nonce TEXT,                            -- OIDC nonce for ID token validation
  code_verifier TEXT,                    -- PKCE code verifier
  redirect_uri TEXT NOT NULL,            -- Where to redirect after auth

  -- For linking flow
  user_id TEXT,                          -- Set if linking to existing account
  session_id TEXT,                       -- Authrim session (for linking flow)

  -- For OIDC proxy flow (future)
  original_auth_request TEXT,            -- JSON of original OIDC auth request

  -- OIDC Core 1.0 parameters (for validation in callback)
  max_age INTEGER,                       -- max_age parameter for auth_time validation
  acr_values TEXT,                       -- acr_values parameter for acr validation

  -- Timestamps
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,                   -- When state was consumed (for single-use)

  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_external_idp_auth_states_state
  ON external_idp_auth_states(state);
CREATE INDEX IF NOT EXISTS idx_external_idp_auth_states_expires_at
  ON external_idp_auth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at);

-- =============================================================================
-- 4. Seed Google Provider (commented out - configure via Admin API)
-- =============================================================================
-- Uncomment and customize to seed Google provider:
--
-- INSERT INTO upstream_providers (
--   id, tenant_id, name, provider_type, enabled, priority,
--   issuer, client_id, client_secret_encrypted, scopes,
--   icon_url, button_color,
--   created_at, updated_at
-- ) VALUES (
--   'google',
--   'default',
--   'Google',
--   'oidc',
--   1,
--   0,
--   'https://accounts.google.com',
--   'YOUR_GOOGLE_CLIENT_ID',
--   'YOUR_ENCRYPTED_CLIENT_SECRET',
--   'openid email profile',
--   'https://www.google.com/favicon.ico',
--   '#4285F4',
--   unixepoch(),
--   unixepoch()
-- );

-- =============================================================================
-- Source: 021_refresh_token_sharding.sql
-- =============================================================================

-- Migration: 021_refresh_token_sharding.sql
-- Description: Add tables for RefreshTokenRotator sharding support (Phase 6.5: High RPS Optimization)
-- Author: Claude
-- Date: 2025-12-04

-- =============================================================================
-- 1. User Token Families Table (Slimmed for High RPS)
-- =============================================================================
-- Purpose: Index table for user-wide token revocation
-- Optimized for high RPS: NO D1 access during token rotation
--
-- D1 Access Pattern:
--   INSERT: Token issuance only
--   UPDATE: Token revocation only (is_revoked = 1)
--   SELECT: User-wide revocation (get all families for a user)
--   ROTATION: No D1 access (DO storage only)

CREATE TABLE IF NOT EXISTS user_token_families (
  jti TEXT PRIMARY KEY,               -- JTI as primary key (v{gen}_{shard}_{random})
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,              -- References users(id)
  client_id TEXT NOT NULL,            -- References clients(id)
  generation INTEGER NOT NULL,        -- Shard generation (0 = legacy)
  expires_at INTEGER NOT NULL,        -- Token expiration timestamp (ms)
  is_revoked INTEGER DEFAULT 0,       -- 0 = active, 1 = revoked

  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

-- Note: Removed columns for high RPS optimization:
--   - shard_index: Calculated from JTI (v1_3_... -> shard=3)
--   - created_at: Not needed (audit_log handles this)
--   - last_rotated_at: Not needed (rotation doesn't touch D1)
--   - revoked_at: Not needed (audit_log handles this)
--   - revoke_reason: Not needed (audit_log handles this)

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_utf_tenant_user
  ON user_token_families(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_utf_tenant_client
  ON user_token_families(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_utf_user_client
  ON user_token_families(user_id, client_id);
CREATE INDEX IF NOT EXISTS idx_utf_expires
  ON user_token_families(expires_at);
CREATE INDEX IF NOT EXISTS idx_utf_generation
  ON user_token_families(generation);
CREATE INDEX IF NOT EXISTS idx_utf_active_tokens
  ON user_token_families(user_id, client_id, is_revoked)
  WHERE is_revoked = 0;

-- =============================================================================
-- 2. Refresh Token Shard Configs Table (Audit)
-- =============================================================================
-- Purpose: Track shard configuration history for audit purposes
-- Primary configuration is stored in KV for fast access

CREATE TABLE IF NOT EXISTS refresh_token_shard_configs (
  id TEXT PRIMARY KEY,                -- UUID
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,                     -- NULL = global config
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,      -- When this config was activated (ms)
  deprecated_at INTEGER,              -- When this config was deprecated (ms)
  created_by TEXT,                    -- Admin user who created this config
  notes TEXT,                         -- Human-readable notes

  UNIQUE(tenant_id, client_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_rtsc_tenant_client
  ON refresh_token_shard_configs(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_rtsc_generation
  ON refresh_token_shard_configs(generation);
CREATE INDEX IF NOT EXISTS idx_rtsc_activated_at
  ON refresh_token_shard_configs(activated_at);

-- =============================================================================
-- 3. Seed Default Global Configuration
-- =============================================================================
-- Initial configuration: generation=1, 8 shards (production default)

INSERT INTO refresh_token_shard_configs (
  id,
  tenant_id,
  client_id,
  generation,
  shard_count,
  activated_at,
  created_by,
  notes
) VALUES (
  'seed-default-v1',
  'default',
  NULL,  -- Global config
  1,
  8,
  unixepoch() * 1000,
  'migration',
  'Initial default configuration: 8 shards for production use'
);

-- =============================================================================
-- Migration Notes
-- =============================================================================
--
-- After applying this migration:
--
-- 1. Initialize KV configuration:
--    ```
--    wrangler kv:key put --binding=KV "refresh-token-shards:__global__" \
--      '{"currentGeneration":1,"currentShardCount":8,"previousGenerations":[],"updatedAt":...}'
--    ```
--
-- 2. For load testing with 32 shards:
--    ```
--    PUT /api/admin/refresh-token-sharding/config
--    { "shardCount": 32, "notes": "Load testing configuration" }
--    ```
--
-- 3. Legacy tokens (generation=0) will continue to work with existing DO instances.
--
-- 4. New tokens will use generation=1+ with sharded DO instances.
--

-- =============================================================================
-- Source: 022_add_post_logout_redirect_uris.sql
-- =============================================================================

-- Migration: Add post_logout_redirect_uris column to oauth_clients table
-- Created: 2025-12-07
-- Description: Required for OIDC RP-Initiated Logout 1.0 (OpenID Connect RP-Initiated Logout 1.0)
-- Reference: https://openid.net/specs/openid-connect-rpinitiated-1_0.html

-- =============================================================================
-- Add post_logout_redirect_uris column
-- =============================================================================
-- This column stores a JSON array of URIs that the client can use as
-- post_logout_redirect_uri parameter when initiating logout.
-- Per OIDC RP-Initiated Logout 1.0, the OP MUST validate the post_logout_redirect_uri
-- against the registered URIs.
-- =============================================================================

ALTER TABLE oauth_clients ADD COLUMN post_logout_redirect_uris TEXT;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Column added: post_logout_redirect_uris (TEXT, nullable)
-- The column stores JSON array of strings (e.g., '["https://example.com/logout", "https://example.com/signout"]')
-- Version: 022
-- =============================================================================

-- =============================================================================
-- Source: 018_ai_grants.sql
-- =============================================================================

-- Migration: 018_ai_grants.sql
-- Description: Create ai_grants table for AI Ephemeral Auth grant management
-- Author: @authrim
-- Date: 2025-12-28
-- Issue: Human Auth / AI Ephemeral Auth Two-Layer Model Implementation

-- =============================================================================
-- 1. AI Grants Table
-- =============================================================================
-- Stores grants that authorize AI principals (agents, tools, services) to act
-- on behalf of users or systems. Used for MCP (Model Context Protocol) integration
-- and AI-to-AI delegation scenarios.

CREATE TABLE ai_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  ai_principal TEXT NOT NULL,
  scopes TEXT NOT NULL,
  scope_targets TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  UNIQUE(tenant_id, client_id, ai_principal)
);

-- Indexes for performance
CREATE INDEX idx_ai_grants_client ON ai_grants(client_id);
CREATE INDEX idx_ai_grants_principal ON ai_grants(ai_principal);
CREATE INDEX idx_ai_grants_tenant ON ai_grants(tenant_id);
CREATE INDEX idx_ai_grants_active ON ai_grants(is_active) WHERE is_active = 1;
CREATE INDEX idx_ai_grants_expires ON ai_grants(expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================================
-- Additional Tables (Consolidated from migrations 016-035)
-- =============================================================================

-- =============================================================================
-- session_clients: Session-Client relationship tracking
-- =============================================================================
CREATE TABLE session_clients (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_token_at INTEGER NOT NULL,
  last_token_at INTEGER NOT NULL,
  last_seen_at INTEGER,

  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  UNIQUE (session_id, client_id)
);

CREATE INDEX idx_session_clients_session_id ON session_clients(session_id);
CREATE INDEX idx_session_clients_client_id ON session_clients(client_id);
CREATE INDEX idx_session_clients_last_seen_at ON session_clients(last_seen_at);

-- =============================================================================
-- device_secrets: Native SSO 1.0 device secrets
-- =============================================================================
CREATE TABLE device_secrets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  device_name TEXT,
  device_platform TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,

  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX idx_device_secrets_secret_hash ON device_secrets(secret_hash);
CREATE INDEX idx_device_secrets_tenant_user ON device_secrets(tenant_id, user_id);
CREATE INDEX idx_device_secrets_session_id ON device_secrets(session_id);
CREATE INDEX idx_device_secrets_expires ON device_secrets(expires_at) WHERE is_active = 1;

-- =============================================================================
-- settings_history: Settings version control
-- =============================================================================
CREATE TABLE settings_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  category TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changes TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT,
  change_reason TEXT,
  change_source TEXT,
  created_at INTEGER NOT NULL,

  UNIQUE(tenant_id, category, version)
);

CREATE INDEX idx_settings_history_category ON settings_history(tenant_id, category, version DESC);
CREATE INDEX idx_settings_history_actor ON settings_history(actor_id, created_at DESC);
CREATE INDEX idx_settings_history_cleanup ON settings_history(tenant_id, category, created_at);

-- =============================================================================
-- org_domain_mappings: Organization domain-based auto-join
-- =============================================================================
CREATE TABLE org_domain_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  domain_hash TEXT NOT NULL,
  domain_hash_version INTEGER DEFAULT 1,
  org_id TEXT NOT NULL,
  auto_join_enabled INTEGER DEFAULT 1,
  membership_type TEXT NOT NULL DEFAULT 'member',
  auto_assign_role_id TEXT,
  verified INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verification_token TEXT,
  verification_status TEXT DEFAULT 'unverified',
  verification_expires_at INTEGER,
  verification_method TEXT,

  UNIQUE(tenant_id, domain_hash, domain_hash_version, org_id)
);

CREATE INDEX idx_odm_lookup ON org_domain_mappings(tenant_id, domain_hash, is_active, verified DESC, priority DESC);
CREATE INDEX idx_odm_org ON org_domain_mappings(org_id);
CREATE INDEX idx_odm_version ON org_domain_mappings(domain_hash_version);
CREATE INDEX idx_odm_verification_status ON org_domain_mappings(verification_status, verification_expires_at);

-- =============================================================================
-- status_lists: VC Status List 2021 for credential revocation
-- =============================================================================
CREATE TABLE status_lists (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'revocation',
  encoded_list TEXT NOT NULL,
  current_index INTEGER DEFAULT 0,
  capacity INTEGER DEFAULT 131072,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  state TEXT DEFAULT 'active',
  used_count INTEGER DEFAULT 0,
  sealed_at TEXT
);

CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id);
CREATE INDEX idx_status_lists_tenant_state ON status_lists(tenant_id, state);

-- =============================================================================
-- trusted_issuers: Trusted VC issuer registry
-- =============================================================================
CREATE TABLE trusted_issuers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  issuer_did TEXT NOT NULL,
  display_name TEXT,
  credential_types TEXT,
  trust_level TEXT DEFAULT 'standard',
  jwks_uri TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(tenant_id, issuer_did)
);

CREATE INDEX idx_trusted_issuers_tenant ON trusted_issuers(tenant_id);
CREATE INDEX idx_trusted_issuers_did ON trusted_issuers(issuer_did);

-- =============================================================================
-- issued_credentials: Tracked VCs issued by Authrim
-- =============================================================================
CREATE TABLE issued_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  format TEXT NOT NULL,
  claims TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  status_list_index INTEGER,
  status_list_id TEXT REFERENCES status_lists(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE INDEX idx_issued_credentials_user ON issued_credentials(tenant_id, user_id);
CREATE INDEX idx_issued_credentials_type ON issued_credentials(credential_type);
CREATE INDEX idx_issued_credentials_status ON issued_credentials(status);
CREATE INDEX idx_issued_credentials_status_list ON issued_credentials(status_list_id);

-- =============================================================================
-- did_document_cache: DID Document resolution cache
-- =============================================================================
CREATE TABLE did_document_cache (
  did TEXT PRIMARY KEY,
  document TEXT NOT NULL,
  resolved_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_did_document_cache_expires ON did_document_cache(expires_at);

-- =============================================================================
-- attribute_verifications: VC/VP verification results
-- =============================================================================
CREATE TABLE attribute_verifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vp_request_id TEXT,
  issuer_did TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  format TEXT NOT NULL,
  verification_result TEXT NOT NULL,
  holder_binding_verified INTEGER DEFAULT 0,
  issuer_trusted INTEGER DEFAULT 0,
  status_valid INTEGER DEFAULT 0,
  mapped_attribute_ids TEXT,
  verified_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX idx_attribute_verifications_user ON attribute_verifications(tenant_id, user_id);
CREATE INDEX idx_attribute_verifications_result ON attribute_verifications(verification_result);

-- =============================================================================
-- webhook_configs: Event webhook configuration
-- =============================================================================
CREATE TABLE webhook_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  scope TEXT NOT NULL DEFAULT 'tenant',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_encrypted TEXT,
  headers TEXT,
  retry_policy TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT
);

CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id);
CREATE INDEX idx_webhook_configs_client ON webhook_configs(tenant_id, client_id);
CREATE INDEX idx_webhook_configs_active ON webhook_configs(tenant_id, active) WHERE active = 1;
CREATE INDEX idx_webhook_configs_scope ON webhook_configs(tenant_id, scope);

-- =============================================================================
-- consent_policy_versions: Privacy policy version tracking
-- =============================================================================
CREATE TABLE consent_policy_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL,
  policy_type TEXT NOT NULL,
  policy_uri TEXT,
  policy_hash TEXT,
  effective_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,

  UNIQUE (tenant_id, policy_type, version)
);

CREATE INDEX idx_consent_policy_versions_tenant ON consent_policy_versions(tenant_id, policy_type);
CREATE INDEX idx_consent_policy_versions_effective ON consent_policy_versions(effective_at);

-- =============================================================================
-- event_log: Anonymized audit/event log (non-PII)
-- =============================================================================
CREATE TABLE event_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_category TEXT NOT NULL,
  result TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  anonymized_user_id TEXT,
  client_id TEXT,
  session_id TEXT,
  request_id TEXT,
  duration_ms INTEGER,
  details_r2_key TEXT,
  details_json TEXT,
  retention_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_event_log_tenant_time ON event_log(tenant_id, created_at DESC);
CREATE INDEX idx_event_log_type ON event_log(event_type);
CREATE INDEX idx_event_log_anon_user ON event_log(anonymized_user_id);
CREATE INDEX idx_event_log_request_id ON event_log(request_id);
CREATE INDEX idx_event_log_result ON event_log(result);
CREATE INDEX idx_event_log_severity ON event_log(severity);
CREATE INDEX idx_event_log_retention ON event_log(retention_until);

-- =============================================================================
-- operational_logs: Admin operation audit (encrypted)
-- =============================================================================
CREATE TABLE operational_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  reason_detail_encrypted TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_operational_logs_tenant_created ON operational_logs(tenant_id, created_at DESC);
CREATE INDEX idx_operational_logs_resource ON operational_logs(resource_type, resource_id);
CREATE INDEX idx_operational_logs_expires ON operational_logs(expires_at);
CREATE INDEX idx_operational_logs_admin ON operational_logs(admin_id);

-- =============================================================================
-- suspicious_activities: Security monitoring - suspicious user activities
-- =============================================================================
CREATE TABLE suspicious_activities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  source_ip TEXT,
  user_agent TEXT,
  description TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_suspicious_activities_tenant ON suspicious_activities(tenant_id);
CREATE INDEX idx_suspicious_activities_type ON suspicious_activities(tenant_id, type);
CREATE INDEX idx_suspicious_activities_severity ON suspicious_activities(tenant_id, severity);
CREATE INDEX idx_suspicious_activities_user ON suspicious_activities(tenant_id, user_id);
CREATE INDEX idx_suspicious_activities_created ON suspicious_activities(tenant_id, created_at);

-- =============================================================================
-- security_threats: Security monitoring - detected threats
-- =============================================================================
CREATE TABLE security_threats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  description TEXT,
  source TEXT,
  affected_resources TEXT,
  indicators TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  mitigated_at TEXT
);

CREATE INDEX idx_security_threats_tenant ON security_threats(tenant_id);
CREATE INDEX idx_security_threats_type ON security_threats(tenant_id, type);
CREATE INDEX idx_security_threats_severity ON security_threats(tenant_id, severity);
CREATE INDEX idx_security_threats_status ON security_threats(tenant_id, status);
CREATE INDEX idx_security_threats_detected ON security_threats(tenant_id, detected_at);

-- =============================================================================
-- access_reviews: Compliance - periodic access review campaigns
-- =============================================================================
CREATE TABLE access_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL,
  scope_value TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer_id TEXT,
  total_items INTEGER NOT NULL DEFAULT 0,
  reviewed_items INTEGER NOT NULL DEFAULT 0,
  approved_items INTEGER NOT NULL DEFAULT 0,
  revoked_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  due_date TEXT
);

CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id);
CREATE INDEX idx_access_reviews_status ON access_reviews(tenant_id, status);
CREATE INDEX idx_access_reviews_reviewer ON access_reviews(tenant_id, reviewer_id);
CREATE INDEX idx_access_reviews_created ON access_reviews(tenant_id, created_at);
CREATE INDEX idx_access_reviews_due ON access_reviews(tenant_id, due_date);

-- =============================================================================
-- access_review_items: Individual items within an access review
-- =============================================================================
CREATE TABLE access_review_items (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  permission_type TEXT NOT NULL,
  permission_value TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  decided_at TEXT,
  justification TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_access_review_items_review ON access_review_items(review_id);
CREATE INDEX idx_access_review_items_user ON access_review_items(tenant_id, user_id);
CREATE INDEX idx_access_review_items_decision ON access_review_items(review_id, decision);

-- =============================================================================
-- compliance_reports: Generated compliance reports
-- =============================================================================
CREATE TABLE compliance_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  parameters TEXT,
  result_url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT
);

CREATE INDEX idx_compliance_reports_tenant ON compliance_reports(tenant_id);
CREATE INDEX idx_compliance_reports_type ON compliance_reports(tenant_id, type);
CREATE INDEX idx_compliance_reports_status ON compliance_reports(tenant_id, status);
CREATE INDEX idx_compliance_reports_created ON compliance_reports(tenant_id, created_at);
CREATE INDEX idx_compliance_reports_requested ON compliance_reports(tenant_id, requested_by);

-- =============================================================================
-- Final Migration Complete
-- =============================================================================
-- This consolidated schema includes all tables from migrations 000-039
-- For PII tables, see migrations/pii/001_pii_initial.sql
-- =============================================================================
