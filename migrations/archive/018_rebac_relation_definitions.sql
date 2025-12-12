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
