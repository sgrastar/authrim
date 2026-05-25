-- =============================================================================
-- Authrim Admin Baseline: Policy, ABAC, and ReBAC
-- Consolidated for fresh Authrim installs from admin/005_admin_abac_rebac.sql, admin/006_admin_setup_tokens.sql, admin/007_admin_role_inheritance.sql, admin/008_admin_rebac_definitions.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/005_admin_abac_rebac.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin ABAC & ReBAC (D1_ADMIN)
-- =============================================================================
-- Created: 2025-01-22
-- Description: Creates tables for Admin ABAC (Attribute-Based Access Control)
--              and ReBAC (Relationship-Based Access Control).
--
-- IMPORTANT: This migration is for D1_ADMIN (dedicated Admin database).
--            Separate from EndUser ABAC/ReBAC in D1_CORE.
--
-- Architecture:
-- - admin_attributes: Attribute type definitions
-- - admin_attribute_values: Attribute values assigned to Admin users
-- - admin_relationships: Relationships between Admin users/entities
-- - admin_policies: Policy definitions combining RBAC/ABAC/ReBAC
-- =============================================================================

-- =============================================================================
-- admin_attributes Table
-- =============================================================================
-- Attribute definitions for Admin ABAC.
-- Examples: department, location, clearance_level, project_access
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_attributes (
  -- Attribute ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Attribute identification
  name TEXT NOT NULL,  -- Machine-readable name (e.g., 'department')
  display_name TEXT,   -- Human-readable name (e.g., 'Department')
  description TEXT,

  -- Attribute type (determines value validation)
  -- string: Free-form text
  -- enum: Must be one of allowed_values
  -- number: Numeric value (with optional min/max)
  -- boolean: true/false
  -- date: ISO 8601 date
  -- array: Multiple values allowed
  attribute_type TEXT NOT NULL DEFAULT 'string',

  -- For enum type: JSON array of allowed values
  -- e.g., ["engineering", "sales", "support"]
  allowed_values_json TEXT,

  -- Validation constraints
  min_value INTEGER,  -- For number type
  max_value INTEGER,  -- For number type
  regex_pattern TEXT, -- For string type

  -- Whether this attribute is required for all Admin users
  is_required INTEGER DEFAULT 0,

  -- Whether this attribute can have multiple values
  is_multi_valued INTEGER DEFAULT 0,

  -- System attribute flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for attribute name per tenant
  UNIQUE(tenant_id, name)
);

-- =============================================================================
-- Indexes for admin_attributes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_admin_attributes_tenant ON admin_attributes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_attributes_name ON admin_attributes(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_admin_attributes_type ON admin_attributes(attribute_type);

-- =============================================================================
-- admin_attribute_values Table
-- =============================================================================
-- Attribute values assigned to Admin users.
-- Links admin_users to admin_attributes with specific values.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_attribute_values (
  -- Value assignment ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- References
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  admin_attribute_id TEXT NOT NULL REFERENCES admin_attributes(id) ON DELETE CASCADE,

  -- The actual value (stored as text, parsed according to attribute_type)
  value TEXT NOT NULL,

  -- For multi-valued attributes, this is the index (0, 1, 2, ...)
  value_index INTEGER DEFAULT 0,

  -- Source of this value (manual, idp_sync, api, etc.)
  source TEXT DEFAULT 'manual',

  -- Expiration (for temporary attribute assignments)
  expires_at INTEGER,

  -- Audit fields
  assigned_by TEXT,  -- Admin user ID who assigned this value
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for single-valued attributes
  -- For multi-valued, use UNIQUE(admin_user_id, admin_attribute_id, value_index)
  UNIQUE(admin_user_id, admin_attribute_id, value_index)
);

-- =============================================================================
-- Indexes for admin_attribute_values
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_admin_attr_values_user ON admin_attribute_values(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_attr_values_attr ON admin_attribute_values(admin_attribute_id);
CREATE INDEX IF NOT EXISTS idx_admin_attr_values_tenant ON admin_attribute_values(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_attr_values_expires ON admin_attribute_values(expires_at);

-- Combined index for policy evaluation
CREATE INDEX IF NOT EXISTS idx_admin_attr_values_lookup
  ON admin_attribute_values(admin_user_id, admin_attribute_id, value);

-- =============================================================================
-- admin_relationships Table
-- =============================================================================
-- Relationships between Admin users/entities for ReBAC.
-- Examples: manager_of, delegate_of, team_member
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_relationships (
  -- Relationship ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Relationship type (e.g., 'manager_of', 'delegate_of', 'team_member')
  relationship_type TEXT NOT NULL,

  -- Source entity (from)
  from_type TEXT NOT NULL DEFAULT 'admin_user',  -- admin_user, admin_role, team
  from_id TEXT NOT NULL,

  -- Target entity (to)
  to_type TEXT NOT NULL DEFAULT 'admin_user',  -- admin_user, admin_role, team
  to_id TEXT NOT NULL,

  -- Permission level granted by this relationship
  -- full: All permissions of target
  -- limited: Subset of permissions
  -- read_only: Read-only access
  permission_level TEXT NOT NULL DEFAULT 'full',

  -- For hierarchical relationships (e.g., transitive manager relationship)
  is_transitive INTEGER DEFAULT 0,

  -- Expiration (for temporary relationships)
  expires_at INTEGER,

  -- Bidirectional flag (if true, relationship works both ways)
  is_bidirectional INTEGER DEFAULT 0,

  -- Additional metadata (JSON)
  metadata_json TEXT,

  -- Audit fields
  created_by TEXT,  -- Admin user ID who created this relationship
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- =============================================================================
-- Indexes for admin_relationships
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_admin_rel_tenant ON admin_relationships(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_rel_from ON admin_relationships(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_admin_rel_to ON admin_relationships(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_admin_rel_type ON admin_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_admin_rel_expires ON admin_relationships(expires_at);

-- Unique constraint: prevent duplicate relationships
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_rel_unique
  ON admin_relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);

-- =============================================================================
-- admin_policies Table
-- =============================================================================
-- Policy definitions combining RBAC/ABAC/ReBAC conditions.
-- Policies define access rules using role, attribute, and relationship conditions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_policies (
  -- Policy ID (UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Policy identification
  name TEXT NOT NULL,  -- Machine-readable name
  display_name TEXT,   -- Human-readable name
  description TEXT,

  -- Policy effect: allow or deny
  effect TEXT NOT NULL DEFAULT 'allow',  -- allow, deny

  -- Priority (higher = evaluated first, useful for deny policies)
  priority INTEGER DEFAULT 0,

  -- Resource this policy applies to (supports wildcards)
  -- e.g., "admin:users:*", "admin:settings:security", "admin:*"
  resource_pattern TEXT NOT NULL,

  -- Actions this policy applies to (supports wildcards)
  -- e.g., ["read", "write"], ["*"]
  actions_json TEXT NOT NULL DEFAULT '["*"]',

  -- Conditions (JSON object with RBAC/ABAC/ReBAC conditions)
  -- Format:
  -- {
  --   "roles": ["admin", "security_admin"],  // RBAC: Any of these roles
  --   "attributes": {                         // ABAC: Attribute conditions
  --     "department": {"equals": "engineering"},
  --     "clearance_level": {"gte": 3}
  --   },
  --   "relationships": {                      // ReBAC: Relationship conditions
  --     "manager_of": {"target_type": "admin_user"}
  --   },
  --   "condition_type": "all"  // "all" (AND) or "any" (OR)
  -- }
  conditions_json TEXT NOT NULL DEFAULT '{}',

  -- Whether this policy is active
  is_active INTEGER DEFAULT 1,

  -- System policy flag (cannot be modified or deleted)
  is_system INTEGER DEFAULT 0,

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Unique constraint for policy name per tenant
  UNIQUE(tenant_id, name)
);

-- =============================================================================
-- Indexes for admin_policies
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_admin_policies_tenant ON admin_policies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_policies_name ON admin_policies(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_admin_policies_resource ON admin_policies(resource_pattern);
CREATE INDEX IF NOT EXISTS idx_admin_policies_active ON admin_policies(is_active);
CREATE INDEX IF NOT EXISTS idx_admin_policies_priority ON admin_policies(priority DESC);

-- =============================================================================
-- Default Attributes
-- =============================================================================

-- Department attribute
INSERT INTO admin_attributes (
  id, tenant_id, name, display_name, description,
  attribute_type, allowed_values_json, is_required, is_system,
  created_at, updated_at
) SELECT
  'attr_department',
  'default',
  'department',
  'Department',
  'The department this admin belongs to',
  'enum',
  '["engineering", "security", "operations", "support", "management"]',
  0,
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_attributes
  WHERE id = 'attr_department'
);

-- Clearance Level attribute
INSERT INTO admin_attributes (
  id, tenant_id, name, display_name, description,
  attribute_type, min_value, max_value, is_required, is_system,
  created_at, updated_at
) SELECT
  'attr_clearance_level',
  'default',
  'clearance_level',
  'Clearance Level',
  'Security clearance level (1-5, higher = more access)',
  'number',
  1,
  5,
  0,
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_attributes
  WHERE id = 'attr_clearance_level'
);

-- Location attribute
INSERT INTO admin_attributes (
  id, tenant_id, name, display_name, description,
  attribute_type, is_required, is_system,
  created_at, updated_at
) SELECT
  'attr_location',
  'default',
  'location',
  'Location',
  'Physical or regional location of the admin',
  'string',
  0,
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_attributes
  WHERE id = 'attr_location'
);

-- =============================================================================
-- Migration Complete
-- =============================================================================
--
-- This migration adds ABAC and ReBAC support for Admin users:
--
-- ABAC (Attribute-Based):
-- - admin_attributes: Define attribute types (department, clearance_level, etc.)
-- - admin_attribute_values: Assign values to Admin users
--
-- ReBAC (Relationship-Based):
-- - admin_relationships: Define relationships (manager_of, delegate_of, etc.)
--
-- Combined Policies:
-- - admin_policies: Define access rules using RBAC + ABAC + ReBAC conditions
--
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/006_admin_setup_tokens.sql
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Migration: Admin Setup Tokens (D1_ADMIN)
-- =============================================================================
-- Created: 2025-01-25
-- Description: Creates admin_setup_tokens table for secure Admin UI passkey
--              registration during initial setup.
--
-- IMPORTANT: This migration is for D1_ADMIN (dedicated Admin database).
--
-- Use Case:
-- - After initial setup on Router, redirect to Admin UI with a setup token
-- - Admin UI verifies the token and allows passkey registration
-- - Token is single-use and time-limited for security
-- =============================================================================

-- =============================================================================
-- admin_setup_tokens Table
-- =============================================================================
-- Stores one-time setup tokens for Admin UI passkey registration.
-- These tokens allow secure passkey registration after initial setup.
--
-- Lifecycle:
-- 1. Created during initial setup (or via CLI for recovery)
-- 2. Used when admin visits Admin UI /setup/complete?token=xxx
-- 3. Invalidated after successful passkey registration
-- 4. Auto-expires after 24 hours
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_setup_tokens (
  -- Token ID (the actual token value, UUID v4)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Reference to admin user
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,

  -- Token status
  -- pending: Created, waiting for use
  -- used: Successfully used for passkey registration
  -- expired: Expired without use
  -- revoked: Manually revoked
  status TEXT NOT NULL DEFAULT 'pending',

  -- Expiration (UNIX timestamp in milliseconds)
  expires_at INTEGER NOT NULL,

  -- Usage tracking
  used_at INTEGER,  -- When the token was used
  used_ip TEXT,     -- IP address that used the token

  -- Audit fields
  created_at INTEGER NOT NULL,
  created_by TEXT  -- 'initial_setup' | 'cli' | admin_user_id
);

-- =============================================================================
-- Indexes for admin_setup_tokens
-- =============================================================================

-- User's tokens lookup (for checking existing tokens)
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_user ON admin_setup_tokens(admin_user_id);

-- Tenant-scoped lookup
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_tenant ON admin_setup_tokens(tenant_id);

-- Status filter (for cleanup jobs)
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_status ON admin_setup_tokens(status);

-- Expiration lookup (for cleanup jobs)
CREATE INDEX IF NOT EXISTS idx_admin_setup_tokens_expires ON admin_setup_tokens(expires_at);

-- =============================================================================
-- admin_users: Add passkey_setup_completed column
-- =============================================================================
-- Track whether the admin user has completed passkey setup on Admin UI.
-- This is separate from having passkeys - it tracks the initial setup flow.
-- =============================================================================

ALTER TABLE admin_users ADD COLUMN passkey_setup_completed INTEGER DEFAULT 0;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Usage:
-- 1. Router creates token during initial setup
-- 2. Admin visits Admin UI with token
-- 3. Admin UI verifies token and registers passkey
-- 4. Token is marked as 'used' and passkey_setup_completed is set to 1
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: admin/007_admin_role_inheritance.sql
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- Source: admin/008_admin_rebac_definitions.sql
-- -----------------------------------------------------------------------------

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
INSERT INTO admin_rebac_definitions (
  id, tenant_id, relation_name, display_name, description,
  priority, is_system, created_at, updated_at
) SELECT
  'rebac_def_supervises',
  'default',
  'admin_supervises',
  'Supervises',
  'Admin user supervises another admin user',
  100,
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_rebac_definitions
  WHERE id = 'rebac_def_supervises'
);

-- Team member relationship
INSERT INTO admin_rebac_definitions (
  id, tenant_id, relation_name, display_name, description,
  priority, is_system, created_at, updated_at
) SELECT
  'rebac_def_team_member',
  'default',
  'admin_team_member',
  'Team Member',
  'Admin user is a member of a team',
  50,
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_rebac_definitions
  WHERE id = 'rebac_def_team_member'
);

-- Escalation chain relationship
INSERT INTO admin_rebac_definitions (
  id, tenant_id, relation_name, display_name, description,
  priority, is_system, created_at, updated_at
) SELECT
  'rebac_def_escalation',
  'default',
  'admin_escalation_chain',
  'Escalation Chain',
  'Admin user is in escalation chain for another admin user',
  75,
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
WHERE NOT EXISTS (
  SELECT 1
  FROM admin_rebac_definitions
  WHERE id = 'rebac_def_escalation'
);

-- =============================================================================
-- Migration Complete
-- =============================================================================
--
-- admin_rebac_definitions table is now available for managing relationship types.
-- Use admin_relationships table to create relationship instances (tuples).
--
-- =============================================================================
