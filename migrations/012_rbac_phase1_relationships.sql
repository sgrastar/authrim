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
-- Convert users.parent_user_id to parent_child relationships

INSERT INTO relationships (
  id,
  tenant_id,
  relationship_type,
  from_type,
  from_id,
  to_type,
  to_id,
  permission_level,
  expires_at,
  is_bidirectional,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))) as id,
  u.tenant_id,
  'parent_child' as relationship_type,
  'subject' as from_type,
  u.parent_user_id as from_id,
  'subject' as to_type,
  u.id as to_id,
  'full' as permission_level,
  NULL as expires_at,
  0 as is_bidirectional,
  '{"migrated_from": "parent_user_id"}' as metadata_json,
  u.created_at,
  strftime('%s', 'now') as updated_at
FROM users u
WHERE u.parent_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM relationships r
    WHERE r.from_id = u.parent_user_id
      AND r.to_id = u.id
      AND r.relationship_type = 'parent_child'
  );

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 012
-- =============================================================================
