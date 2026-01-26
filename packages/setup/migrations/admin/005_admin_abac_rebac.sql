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
INSERT OR IGNORE INTO admin_attributes (
  id, tenant_id, name, display_name, description,
  attribute_type, allowed_values_json, is_required, is_system,
  created_at, updated_at
) VALUES (
  'attr_department',
  'default',
  'department',
  'Department',
  'The department this admin belongs to',
  'enum',
  '["engineering", "security", "operations", "support", "management"]',
  0,
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- Clearance Level attribute
INSERT OR IGNORE INTO admin_attributes (
  id, tenant_id, name, display_name, description,
  attribute_type, min_value, max_value, is_required, is_system,
  created_at, updated_at
) VALUES (
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
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- Location attribute
INSERT OR IGNORE INTO admin_attributes (
  id, tenant_id, name, display_name, description,
  attribute_type, is_required, is_system,
  created_at, updated_at
) VALUES (
  'attr_location',
  'default',
  'location',
  'Location',
  'Physical or regional location of the admin',
  'string',
  0,
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
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
