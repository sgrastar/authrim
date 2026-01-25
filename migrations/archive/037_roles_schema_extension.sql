-- =============================================================================
-- Migration 037: Extend Roles Table Schema
-- =============================================================================
-- Adds columns required for Admin UI role management:
-- - display_name: Human-readable name for UI
-- - is_system: Flag to prevent modification of system roles
-- - updated_at: Track when role was last modified
--
-- Note: Some environments may already have tenant_id, role_type, parent_role_id
-- This migration only adds missing columns for UI support.
-- =============================================================================

-- Add display_name column for human-readable role names
ALTER TABLE roles ADD COLUMN display_name TEXT;

-- Add is_system flag to identify protected system roles
ALTER TABLE roles ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

-- Add updated_at for tracking modifications
ALTER TABLE roles ADD COLUMN updated_at INTEGER;

-- Update existing seed roles to be marked as system roles
UPDATE roles SET
  is_system = 1,
  role_type = 'system',
  updated_at = created_at,
  display_name = CASE name
    WHEN 'super_admin' THEN 'Super Administrator'
    WHEN 'admin' THEN 'Administrator'
    WHEN 'viewer' THEN 'Viewer'
    WHEN 'support' THEN 'Support'
    ELSE name
  END
WHERE id IN ('role_super_admin', 'role_admin', 'role_viewer', 'role_support');

-- Update any other existing roles (custom roles) with updated_at
UPDATE roles SET updated_at = created_at WHERE updated_at IS NULL;
