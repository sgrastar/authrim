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
