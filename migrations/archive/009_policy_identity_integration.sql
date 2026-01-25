-- =============================================================================
-- Migration: Policy ↔ Identity Integration
-- =============================================================================
-- Created: 2025-12-18
-- Description: Creates tables for dynamic role assignment rules, organization
--              domain mappings, and key rotation support for JIT Provisioning.
--
-- Features:
-- - role_assignment_rules: Auto role assignment based on IdP claims
-- - org_domain_mappings: Domain-based organization auto-join
-- - Key rotation support: email_domain_hash_version column
--
-- Architecture:
-- - All tables are in D1_CORE (Non-PII)
-- - No PII data stored - only hashes and references
-- - Integrates with existing users_core, organizations, roles tables
-- =============================================================================

-- =============================================================================
-- role_assignment_rules Table
-- =============================================================================
-- Defines rules for automatic role assignment based on:
-- - email_domain_hash (blind index)
-- - IdP claims (evaluated from linked_identities.raw_attributes in memory)
-- - email_verified status
-- - provider_id
--
-- Evaluation Order:
-- 1. Filter by tenant_id, is_active=1, validity period
-- 2. Sort by priority DESC (higher priority first)
-- 3. Evaluate conditions for each rule
-- 4. Apply actions for matching rules
-- 5. Stop if stop_processing=1 on matching rule
-- =============================================================================

CREATE TABLE IF NOT EXISTS role_assignment_rules (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target role (reference only, no FK for flexibility)
  role_id TEXT NOT NULL,

  -- Scope for assigned role
  scope_type TEXT NOT NULL DEFAULT 'global',  -- global, org, resource
  scope_target TEXT NOT NULL DEFAULT '',      -- e.g., 'org:org_123' or '' for global

  -- Conditions (JSON format)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "email_domain_hash", "operator": "eq", "value": "abc123..."},
  --   {"field": "idp_claim", "claim_path": "groups", "operator": "contains", "value": "admin"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "assign_role", "role_id": "role_org_admin", "scope_type": "org", "scope_target": "auto"},
  --   {"type": "join_org", "org_id": "auto"}
  -- ]
  actions_json TEXT NOT NULL,

  -- Priority and control
  priority INTEGER NOT NULL DEFAULT 0,    -- Higher = evaluated first (DESC order)
  stop_processing INTEGER DEFAULT 0,      -- 1 = stop evaluating further rules after match
  is_active INTEGER DEFAULT 1,            -- 0 = disabled

  -- Validity period (optional, UNIX seconds)
  valid_from INTEGER,                     -- NULL = no start restriction
  valid_until INTEGER,                    -- NULL = no end restriction

  -- Audit fields
  created_by TEXT,                        -- Admin user ID who created
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, name)
);

-- Index for rule evaluation (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_rar_evaluation ON role_assignment_rules(
  tenant_id,
  is_active,
  priority DESC
);

-- Index for finding rules by role
CREATE INDEX IF NOT EXISTS idx_rar_role ON role_assignment_rules(role_id);

-- =============================================================================
-- org_domain_mappings Table
-- =============================================================================
-- Maps email domains (hashed) to organizations for JIT auto-join.
-- Used during JIT Provisioning to automatically add users to organizations
-- based on their email domain.
--
-- Security:
-- - domain_hash is HMAC-SHA256 of lowercase domain
-- - Actual domain is never stored
-- - verified flag indicates if domain ownership is confirmed
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_domain_mappings (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Domain identification (hashed for privacy)
  -- Algorithm: HMAC-SHA256(lowercase(domain), secret_key)
  domain_hash TEXT NOT NULL,

  -- Key rotation support
  domain_hash_version INTEGER DEFAULT 1,

  -- Target organization
  org_id TEXT NOT NULL,                   -- Reference to organizations.id

  -- Auto-join settings
  auto_join_enabled INTEGER DEFAULT 1,    -- 0 = mapping exists but auto-join disabled
  membership_type TEXT NOT NULL DEFAULT 'member',  -- member, admin, owner
  auto_assign_role_id TEXT,               -- Optional: auto-assign this role on join

  -- Verification status
  verified INTEGER DEFAULT 0,             -- 1 = domain ownership verified (DNS TXT, etc.)

  -- Priority for multiple mappings
  priority INTEGER DEFAULT 0,             -- Higher = preferred when multiple match

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  -- Allow same domain to map to multiple orgs with different versions
  UNIQUE(tenant_id, domain_hash, domain_hash_version, org_id)
);

-- Index for domain lookup (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_odm_lookup ON org_domain_mappings(
  tenant_id,
  domain_hash,
  is_active,
  verified DESC,
  priority DESC
);

-- Index for finding mappings by organization
CREATE INDEX IF NOT EXISTS idx_odm_org ON org_domain_mappings(org_id);

-- Index for key rotation status queries
CREATE INDEX IF NOT EXISTS idx_odm_version ON org_domain_mappings(domain_hash_version);

-- =============================================================================
-- users_core Alterations
-- =============================================================================
-- Add key rotation support column to existing users_core table.
-- This allows tracking which version of the secret key was used to generate
-- each user's email_domain_hash.
-- =============================================================================

-- Add version column for key rotation support
-- Default to 1 for all existing users
ALTER TABLE users_core ADD COLUMN email_domain_hash_version INTEGER DEFAULT 1;

-- Index for key rotation migration queries
CREATE INDEX IF NOT EXISTS idx_users_core_hash_version ON users_core(email_domain_hash_version);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Deploy this migration to D1_CORE database
-- 2. Set EMAIL_DOMAIN_HASH_SECRET in environment or KV
-- 3. Configure JIT Provisioning settings in KV (jit_provisioning_config)
-- 4. Create role_assignment_rules via Admin API
-- 5. Create org_domain_mappings via Admin API
-- =============================================================================
