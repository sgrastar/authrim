-- =============================================================================
-- Migration: Admin ReBAC Definitions (D1_ADMIN)
-- =============================================================================
-- Created: 2026-02-06
-- Description: Adds admin_rebac_definitions table for managing relationship
--              type definitions. This complements the existing admin_relationships
--              table which stores relationship instances (tuples).
--
-- Architecture:
-- - admin_rebac_definitions: Relationship type definitions (metadata)
-- - admin_relationships: Relationship instances (tuples)
-- =============================================================================

-- =============================================================================
-- admin_rebac_definitions Table
-- =============================================================================
-- Defines relationship types that can be used in ReBAC.
-- Examples: admin_supervises, admin_team_member, admin_escalation_chain
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_rebac_definitions (
  -- Definition ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Relationship name (e.g., 'admin_supervises', 'admin_team_member')
  relation_name TEXT NOT NULL,

  -- Human-readable display name
  display_name TEXT,

  -- Description of what this relationship means
  description TEXT,

  -- Priority for evaluation (higher = evaluated first)
  priority INTEGER DEFAULT 0,

  -- Whether this is a system-defined relationship (cannot be deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for relation name per tenant
  UNIQUE(tenant_id, relation_name)
);

-- =============================================================================
-- Indexes for admin_rebac_definitions
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_admin_rebac_def_tenant ON admin_rebac_definitions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_rebac_def_name ON admin_rebac_definitions(tenant_id, relation_name);

-- =============================================================================
-- Default ReBAC Definitions
-- =============================================================================

-- Supervises relationship
INSERT OR IGNORE INTO admin_rebac_definitions (
  id, tenant_id, relation_name, display_name, description,
  priority, is_system, created_at, updated_at
) VALUES (
  'rebac_def_supervises',
  'default',
  'admin_supervises',
  'Supervises',
  'Admin user supervises another admin user',
  100,
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- Team member relationship
INSERT OR IGNORE INTO admin_rebac_definitions (
  id, tenant_id, relation_name, display_name, description,
  priority, is_system, created_at, updated_at
) VALUES (
  'rebac_def_team_member',
  'default',
  'admin_team_member',
  'Team Member',
  'Admin user is a member of a team',
  50,
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- Escalation chain relationship
INSERT OR IGNORE INTO admin_rebac_definitions (
  id, tenant_id, relation_name, display_name, description,
  priority, is_system, created_at, updated_at
) VALUES (
  'rebac_def_escalation',
  'default',
  'admin_escalation_chain',
  'Escalation Chain',
  'Admin user is in escalation chain for another admin user',
  75,
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- =============================================================================
-- Migration Complete
-- =============================================================================
--
-- admin_rebac_definitions table is now available for managing relationship types.
-- Use admin_relationships table to create relationship instances (tuples).
--
-- =============================================================================
