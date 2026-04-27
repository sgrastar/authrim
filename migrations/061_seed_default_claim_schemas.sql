-- Migration 061: Seed default OIDC claim schemas for all existing tenants
--
-- Inserts standard OIDC claims as system schemas (is_system=1) for every tenant.
-- Uses WHERE NOT EXISTS to ensure idempotency without relying on partial unique indexes.
-- All claims default to include_in_id_token=0 (OIDC compliant: claims via UserInfo,
-- controlled by scope). System claims cannot be deleted or renamed via the admin API.
--
-- display_order ranges:
--   1-13  : profile scope claims (name, given_name, ...)
--   20-21 : email scope claims
--   30-31 : phone scope claims
--   40-45 : address scope claims (stored as individual fields, not JSON)
--
-- Custom claims created by admins default to display_order=100+.

-- ──────────────────────────────────────────────
-- Profile scope claims
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_name',
  t.id,
  'name',
  'name', 'Full Name', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 1, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_given_name',
  t.id,
  'given_name',
  'given_name', 'First Name', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 2, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'given_name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_family_name',
  t.id,
  'family_name',
  'family_name', 'Last Name', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 3, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'family_name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_middle_name',
  t.id,
  'middle_name',
  'middle_name', 'Middle Name', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 4, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'middle_name'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_nickname',
  t.id,
  'nickname',
  'nickname', 'Nickname', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 5, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'nickname'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_preferred_username',
  t.id,
  'preferred_username',
  'preferred_username', 'Preferred Username', 'string',
  0, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 6, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'preferred_username'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_profile',
  t.id,
  'profile',
  'profile', 'Profile URL', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 7, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'profile'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_picture',
  t.id,
  'picture',
  'picture', 'Picture URL', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 8, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'picture'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_website',
  t.id,
  'website',
  'website', 'Website', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 9, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'website'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_birthdate',
  t.id,
  'birthdate',
  'birthdate', 'Birthdate', 'date',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 10, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'birthdate'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_zoneinfo',
  t.id,
  'zoneinfo',
  'zoneinfo', 'Time Zone', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 11, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'zoneinfo'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_locale',
  t.id,
  'locale',
  'locale', 'Locale', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 12, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'locale'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_updated_at',
  t.id,
  'updated_at',
  'updated_at', 'Last Updated', 'number',
  0, 0, 1, 1,
  0, 0, 0,
  0, 1, 0,
  'any', 13, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'updated_at'
);

-- ──────────────────────────────────────────────
-- Email scope claims
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_email',
  t.id,
  'email',
  'email', 'Email', 'string',
  1, 0, 1, 1,
  1, 1, 0,
  0, 1, 0,
  'any', 20, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'email'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_email_verified',
  t.id,
  'email_verified',
  'email_verified', 'Email Verified', 'boolean',
  0, 0, 1, 1,
  0, 0, 0,
  0, 1, 0,
  'any', 21, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'email_verified'
);

-- ──────────────────────────────────────────────
-- Phone scope claims
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_phone_number',
  t.id,
  'phone_number',
  'phone_number', 'Phone Number', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 30, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'phone_number'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_phone_number_verified',
  t.id,
  'phone_number_verified',
  'phone_number_verified', 'Phone Number Verified', 'boolean',
  0, 0, 1, 1,
  0, 0, 0,
  0, 1, 0,
  'any', 31, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'phone_number_verified'
);

-- ──────────────────────────────────────────────
-- Address scope claims (individual fields, not JSON)
--
-- address_country is non-PII (is_pii=0) to support future country-based
-- regulatory separation and DB partitioning without cross-DB joins.
-- Other address sub-fields are PII (is_pii=1).
-- ──────────────────────────────────────────────

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_formatted',
  t.id,
  'address_formatted',
  'address_formatted', 'Address (Formatted)', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 40, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_formatted'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_street_address',
  t.id,
  'address_street_address',
  'address_street_address', 'Street Address', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 41, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_street_address'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_locality',
  t.id,
  'address_locality',
  'address_locality', 'City / Locality', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 42, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_locality'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_region',
  t.id,
  'address_region',
  'address_region', 'State / Region', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 43, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_region'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_postal_code',
  t.id,
  'address_postal_code',
  'address_postal_code', 'Postal Code', 'string',
  1, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 44, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_postal_code'
);

INSERT INTO custom_claim_schemas (
  id, tenant_id, field_key, active_field_key, display_label, field_type,
  is_pii, is_required, is_active, is_system,
  is_searchable, is_exportable, is_vc_claim,
  include_in_id_token, include_in_userinfo, include_in_introspection,
  scope_mode, display_order, schema_version, operation_status,
  created_at, updated_at
)
SELECT
  'system_claim_' || t.id || '_address_country',
  t.id,
  'address_country',
  'address_country', 'Country', 'string',
  0, 0, 1, 1,
  0, 1, 0,
  0, 1, 0,
  'any', 45, 1, 'active',
  __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM custom_claim_schemas WHERE tenant_id = t.id AND field_key = 'address_country'
);
