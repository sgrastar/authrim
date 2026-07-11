-- =============================================================================
-- Authrim Core Migration 014: Identity Fields, Sessions, and Authenticators
-- Consolidated for fresh Authrim installs from migrations/014_field_usage_bindings.sql, migrations/015_session_revocation_epochs.sql, migrations/020_passkeys_aaguid_metadata.sql, migrations/035_totp_credentials.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: migrations/014_field_usage_bindings.sql
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- Source: migrations/015_session_revocation_epochs.sql
-- -----------------------------------------------------------------------------

-- Migration: 015_session_revocation_epochs
-- Persist per-user session revocation epochs so user-wide revocation survives
-- Durable Object cache misses, shard routing failures, and cold persistence fallback.

CREATE TABLE IF NOT EXISTS session_revocation_epochs (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  revoked_after_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_revocation_epochs_user
  ON session_revocation_epochs(tenant_id, user_id);

-- -----------------------------------------------------------------------------
-- Source: migrations/020_passkeys_aaguid_metadata.sql
-- -----------------------------------------------------------------------------

-- Migration: 020_passkeys_aaguid_metadata
-- Description: Store end-user WebAuthn authenticator AAGUID for passkey management display.
-- Note: AAGUID metadata is display-only and must not be used for trust decisions.

ALTER TABLE passkeys ADD COLUMN aaguid TEXT;

-- -----------------------------------------------------------------------------
-- Source: migrations/035_totp_credentials.sql
-- -----------------------------------------------------------------------------

-- Migration: 035_totp_credentials
-- Description: Add TOTP authenticators and single-use backup codes for passwordless login.

CREATE TABLE IF NOT EXISTS totp_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  window INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  last_used_time_step INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_used_at INTEGER,
  CHECK (algorithm IN ('SHA1', 'SHA256')),
  CHECK (digits IN (6, 8)),
  CHECK (period BETWEEN 15 AND 300),
  CHECK (window BETWEEN 0 AND 2),
  CHECK (status IN ('pending', 'active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_totp_credentials_tenant_user
  ON totp_credentials(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_totp_credentials_active_user
  ON totp_credentials(tenant_id, user_id, status);

CREATE TABLE IF NOT EXISTS totp_backup_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  credential_id TEXT,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  UNIQUE (tenant_id, user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_user
  ON totp_backup_codes(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_unused
  ON totp_backup_codes(tenant_id, user_id, used_at);
