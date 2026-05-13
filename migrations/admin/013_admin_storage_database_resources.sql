-- =============================================================================
-- Migration: Admin Storage And Database Resources
-- =============================================================================
-- Created: 2026-05-13
-- Description:
--   Adds RBAC-managed storage destination and database connection metadata.
--   Credentials are stored as encrypted write-only blobs and must not be
--   returned by Admin APIs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_storage_destinations (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'platform')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('r2', 'aws_s3', 'sftp', 'custom')),
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_encrypted TEXT,
  credential_key_version INTEGER,
  credential_updated_at INTEGER,
  credential_updated_by TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (scope_type, scope_id, name)
);

CREATE INDEX IF NOT EXISTS idx_admin_storage_destinations_scope
  ON admin_storage_destinations(scope_type, scope_id, is_active, name);

CREATE INDEX IF NOT EXISTS idx_admin_storage_destinations_provider
  ON admin_storage_destinations(provider, status);

CREATE TABLE IF NOT EXISTS admin_storage_destination_usages (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (destination_id, feature, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_storage_destination_usages_destination
  ON admin_storage_destination_usages(destination_id, is_active);

CREATE INDEX IF NOT EXISTS idx_admin_storage_destination_usages_feature
  ON admin_storage_destination_usages(tenant_id, feature, is_active);

CREATE TABLE IF NOT EXISTS admin_database_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('d1', 'hyperdrive', 'postgres', 'mysql', 'custom')),
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_encrypted TEXT,
  credential_key_version INTEGER,
  credential_updated_at INTEGER,
  credential_updated_by TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_admin_database_connections_provider
  ON admin_database_connections(provider, status, is_active);

CREATE TABLE IF NOT EXISTS admin_database_connection_usages (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tenant_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (connection_id, purpose, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_database_connection_usages_connection
  ON admin_database_connection_usages(connection_id, is_active);
