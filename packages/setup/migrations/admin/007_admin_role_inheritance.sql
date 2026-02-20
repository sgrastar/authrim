-- =============================================================================
-- Migration: Admin Role Inheritance (D1_ADMIN)
-- =============================================================================
-- Created: 2026-02-06
-- Description: Adds role inheritance support to admin_roles table.
--              Allows roles to inherit permissions from parent roles.
--
-- Changes:
-- - Add inherits_from column to admin_roles table
-- - Add index for inheritance lookup
-- =============================================================================

-- =============================================================================
-- Add inherits_from column to admin_roles
-- =============================================================================

-- Add inherits_from column (nullable, references another role)
ALTER TABLE admin_roles ADD COLUMN inherits_from TEXT DEFAULT NULL;

-- Create index for inheritance lookup
CREATE INDEX IF NOT EXISTS idx_admin_roles_inherits ON admin_roles(inherits_from);

-- =============================================================================
-- Migration Complete
-- =============================================================================
--
-- admin_roles table now supports role inheritance:
-- - inherits_from: ID of parent role (NULL if no inheritance)
-- - Permissions are merged: child role permissions + parent role permissions
-- - Inheritance chain can be resolved recursively
--
-- =============================================================================
