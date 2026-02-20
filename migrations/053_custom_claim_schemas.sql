-- =============================================================================
-- 053: Custom Claim Schemas
-- =============================================================================
-- Defines the schema for custom claims (user-defined fields).
-- Manages which custom fields are available, their types, validation rules,
-- and how they map to OIDC tokens/endpoints.
--
-- Data storage is split based on PII classification (set at creation, immutable):
--   - Non-PII (is_pii=0): user_custom_fields (D1_CORE, EAV)
--   - PII (is_pii=1): users_pii.custom_attributes_json (D1_PII, JSON)
--
-- Cross-DB operations (rename, delete) use 2-phase design with operation_status
-- to ensure read consistency during migrations.
-- =============================================================================

CREATE TABLE custom_claim_schemas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Field definition
  field_key TEXT NOT NULL,                    -- snake_case (e.g. 'employee_id')
  display_label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'string',  -- 'string'|'number'|'boolean'|'date'|'enum'
  is_pii INTEGER NOT NULL DEFAULT 0,          -- 0=non-PII(D1_CORE), 1=PII(D1_PII); immutable after creation
  is_required INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,

  -- Validation rules (type-safe JSON + CHECK constraint)
  validation_rules TEXT CHECK(validation_rules IS NULL OR json_valid(validation_rules)),

  -- OIDC token/endpoint inclusion settings
  include_in_id_token INTEGER NOT NULL DEFAULT 0,
  include_in_userinfo INTEGER NOT NULL DEFAULT 0,
  include_in_introspection INTEGER NOT NULL DEFAULT 0,
  -- Required scopes (JSON array: ["profile","employee"], NULL=always include)
  -- scope_mode: 'all'=all scopes required, 'any'=any one suffices
  required_scopes TEXT CHECK(required_scopes IS NULL OR json_valid(required_scopes)),
  scope_mode TEXT NOT NULL DEFAULT 'any' CHECK(scope_mode IN ('all', 'any')),

  -- Extended attribute flags
  is_searchable INTEGER NOT NULL DEFAULT 1,   -- searchable when non-PII
  is_exportable INTEGER NOT NULL DEFAULT 1,   -- SCIM/data export target
  is_vc_claim INTEGER NOT NULL DEFAULT 0,     -- Verifiable Credential target

  -- Enterprise namespace (future use)
  -- e.g. 'https://example.com/claims/' -> claim name becomes 'https://example.com/claims/employee_id'
  -- Trailing '/' normalized on save
  claim_namespace TEXT,

  -- UI/management settings
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,

  -- Versioning (schema change tracking)
  schema_version INTEGER NOT NULL DEFAULT 1,

  -- Cross-DB operation state management (2-phase design)
  -- 'active': normal state
  -- 'renaming': field_key rename in progress (old_key still readable)
  -- 'deleting': cascade delete in progress
  -- 'error': operation failed (admin intervention required)
  operation_status TEXT NOT NULL DEFAULT 'active',
  operation_detail TEXT,                      -- operation metadata (JSON: {old_key, new_key, error, etc.})

  -- Audit
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Partial unique: only enforce uniqueness on active keys
-- Allows soft-deprecate -> new creation coexistence
CREATE UNIQUE INDEX uniq_ccs_active_key ON custom_claim_schemas(tenant_id, field_key) WHERE is_active = 1;

CREATE INDEX idx_ccs_tenant_active ON custom_claim_schemas(tenant_id, is_active, display_order);
CREATE INDEX idx_ccs_tenant_key ON custom_claim_schemas(tenant_id, field_key);
CREATE INDEX idx_ccs_operation ON custom_claim_schemas(operation_status) WHERE operation_status != 'active';
