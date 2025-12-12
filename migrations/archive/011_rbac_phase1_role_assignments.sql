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
  subject_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
