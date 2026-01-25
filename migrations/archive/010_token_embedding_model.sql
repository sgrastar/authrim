-- =============================================================================
-- Migration: Token Embedding Model
-- =============================================================================
-- Created: 2025-12-18
-- Description: Creates tables for custom claims rules and ID-level resource
--              permissions. Enables embedding roles, permissions, and custom
--              claims into JWT tokens.
--
-- Features:
-- - token_claim_rules: Conditional claim embedding rules
-- - resource_permissions: ID-level resource permission grants
--
-- Architecture:
-- - All tables are in D1_CORE (Non-PII)
-- - No PII data stored - only roles, permissions, and metadata
-- - Tokens contain Authorization Result Cache, NOT Source of Truth
-- - Real-time permission changes require Phase 8.3 Check API
-- =============================================================================

-- =============================================================================
-- token_claim_rules Table
-- =============================================================================
-- Defines rules for embedding custom claims into access/ID tokens based on:
-- - User roles and permissions
-- - Organization membership
-- - IdP claims (evaluated from linked_identities.raw_attributes)
-- - Email domain hash
-- - Scope contents
--
-- Evaluation Order:
-- 1. Filter by tenant_id, token_type, is_active=1, validity period
-- 2. Sort by priority DESC, created_at ASC
-- 3. Evaluate conditions for each rule
-- 4. Apply actions for matching rules (later rules override earlier for same claim)
-- 5. Stop if stop_processing=1 on matching rule
--
-- Claim Collision Policy:
-- - Last-Write-Wins: Same claim name is overwritten by later rule
-- - Collision is logged: [CLAIM_OVERRIDE] claim=X, old=Y, new=Z, rule=R
-- - Recommendation: Use namespace prefixes (e.g., myapp_tier)
-- =============================================================================

CREATE TABLE IF NOT EXISTS token_claim_rules (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target token type
  token_type TEXT NOT NULL DEFAULT 'access',  -- 'access' | 'id' | 'both'

  -- Conditions (JSON format, same structure as role_assignment_rules)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "has_role", "operator": "contains", "value": "premium_user"},
  --   {"field": "org_type", "operator": "eq", "value": "enterprise"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "add_claim", "claim_name": "tier", "claim_value": "premium"},
  --   {"type": "add_claim_template", "claim_name": "greeting", "template": "Hello {{user_type}}"},
  --   {"type": "copy_from_context", "claim_name": "org", "context_field": "org_id"}
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
-- ORDER BY priority DESC, created_at ASC for deterministic evaluation
CREATE INDEX IF NOT EXISTS idx_tcr_evaluation ON token_claim_rules(
  tenant_id,
  token_type,
  is_active,
  priority DESC,
  created_at ASC
);

-- =============================================================================
-- resource_permissions Table
-- =============================================================================
-- Stores ID-level resource permissions for fine-grained access control.
-- Enables permissions like "documents:doc_123:read" in addition to
-- type-level permissions like "documents:read".
--
-- Subject Types:
-- - user: Direct user permission
-- - role: Permission inherited from role
-- - org: Permission inherited from organization membership
--
-- Evaluation:
-- - expires_at is evaluated at token generation time only
-- - WHERE expires_at IS NULL OR expires_at > NOW()
-- - Changes after token issuance reflect on next token generation
--
-- Token Format:
-- - authrim_permissions: Type-level (2-part) permissions
-- - authrim_resource_permissions: ID-level (3-part) permissions
--
-- Note: ID-level scope format (resource:id:action) is a non-standard
-- OAuth 2.0 extension. Standard-compliant clients should read from
-- the authrim_resource_permissions claim instead of parsing scopes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS resource_permissions (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Subject (who has the permission)
  subject_type TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'role' | 'org'
  subject_id TEXT NOT NULL,                   -- user_id, role_id, or org_id

  -- Resource (what is being accessed)
  resource_type TEXT NOT NULL,                -- e.g., 'documents', 'projects'
  resource_id TEXT NOT NULL,                  -- e.g., 'doc_123', 'proj_456'

  -- Actions allowed (JSON array)
  -- Example: ["read", "write", "delete"]
  actions_json TEXT NOT NULL,

  -- Optional condition for permission (JSON)
  -- Example: {"time_restricted": true, "hours": [9, 17]}
  condition_json TEXT,

  -- Expiration (UNIX seconds)
  -- NULL = no expiration
  -- Evaluated at token generation time only
  expires_at INTEGER,

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Audit fields
  granted_by TEXT,                            -- Admin or system that granted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  -- Same subject can have only one permission entry per resource
  UNIQUE(tenant_id, subject_type, subject_id, resource_type, resource_id)
);

-- Index for permission lookup by subject (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_rp_lookup ON resource_permissions(
  tenant_id,
  subject_type,
  subject_id,
  resource_type,
  is_active
);

-- Index for finding permissions by resource
CREATE INDEX IF NOT EXISTS idx_rp_resource ON resource_permissions(
  tenant_id,
  resource_type,
  resource_id,
  is_active
);

-- Index for expiration cleanup
CREATE INDEX IF NOT EXISTS idx_rp_expires ON resource_permissions(expires_at)
WHERE expires_at IS NOT NULL;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Deploy this migration to D1_CORE database
-- 2. Enable feature flags in KV when ready:
--    - ENABLE_POLICY_EMBEDDING (type-level permissions)
--    - ENABLE_CUSTOM_CLAIMS (custom claim rules)
--    - ENABLE_ID_LEVEL_PERMISSIONS (ID-level permissions)
-- 3. Configure token embedding limits in KV:
--    - config:max_embedded_permissions (default: 50)
--    - config:max_resource_permissions (default: 100)
--    - config:max_custom_claims (default: 20)
-- 4. Create token_claim_rules via Admin API
-- 5. Create resource_permissions via Admin API
-- 6. Test with /api/admin/token-claim-rules/:id/test endpoint
-- =============================================================================
