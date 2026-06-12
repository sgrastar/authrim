-- =============================================================================
-- Authrim Core Migration 014: Field Usage Bindings
-- =============================================================================
-- Tracks feature-level dependencies on canonical/custom fields so schema deletion
-- can distinguish removable fields from fields currently required by login,
-- discovery, notification, consent, policy, or protocol delivery features.

CREATE TABLE IF NOT EXISTS field_usage_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  binding_type TEXT NOT NULL CHECK (
    binding_type IN (
      'authentication_method',
      'notification',
      'discovery',
      'consent',
      'policy',
      'protocol_output',
      'display',
      'ui',
      'custom'
    )
  ),
  binding_id TEXT NOT NULL,
  protection TEXT NOT NULL DEFAULT 'warn' CHECK (
    protection IN ('none', 'warn', 'delete_blocked')
  ),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'admin' CHECK (
    source IN ('system', 'admin', 'derived', 'migration')
  ),
  metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, field_key, binding_type, binding_id)
);

CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_tenant_field
  ON field_usage_bindings(tenant_id, field_key, is_active);
CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_binding
  ON field_usage_bindings(tenant_id, binding_type, binding_id, is_active);
CREATE INDEX IF NOT EXISTS idx_field_usage_bindings_protection
  ON field_usage_bindings(tenant_id, protection, is_active);

-- Seed the default optional canonical fields for existing tenants. These are
-- built-in starting points, not system-locked fields; administrators may remove
-- them when a tenant does not use the corresponding data.
INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, ui_group_key, ui_group_label, ui_group_order, ui_field_order,
  examples_json, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'builtin:' || tenants.id || ':' || builtin.field_key,
  tenants.id,
  builtin.field_key,
  builtin.field_key,
  builtin.display_label,
  builtin.field_type,
  builtin.is_pii,
  0,
  1,
  0,
  builtin.is_searchable,
  builtin.is_exportable,
  0,
  0,
  1,
  0,
  'any',
  builtin.display_order,
  builtin.ui_group_key,
  builtin.ui_group_label,
  builtin.ui_group_order,
  builtin.ui_field_order,
  builtin.examples_json,
  1,
  'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants
JOIN (
  SELECT
    'name' AS field_key,
    'Full Name' AS display_label,
    'string' AS field_type,
    1 AS is_pii,
    1 AS is_searchable,
    1 AS is_exportable,
    1 AS display_order,
    'profile' AS ui_group_key,
    'Profile' AS ui_group_label,
    10 AS ui_group_order,
    1 AS ui_field_order,
    '{"values":["John Doe","山田 太郎"]}' AS examples_json
  UNION ALL
  SELECT
    'locale',
    'Locale',
    'string',
    0,
    0,
    1,
    12,
    'profile',
    'Profile',
    10,
    12,
    '{"values":["ja-JP","en-US"]}'
  UNION ALL
  SELECT
    'email',
    'Email',
    'string',
    1,
    1,
    1,
    20,
    'contact',
    'Contact',
    20,
    1,
    '{"values":["john@example.com"]}'
  UNION ALL
  SELECT
    'email_verified',
    'Email Verified',
    'boolean',
    0,
    0,
    0,
    21,
    'contact',
    'Contact',
    20,
    2,
    '{"values":[true]}'
) AS builtin
WHERE NOT EXISTS (
  SELECT 1
  FROM custom_claim_schemas existing
  WHERE existing.tenant_id = tenants.id AND existing.field_key = builtin.field_key
);
