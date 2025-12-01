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
