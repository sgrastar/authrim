-- =============================================================================
-- Unified Identity Mapping: destination profile registration
--
-- Destination profiles define outbound release contracts for OIDC claims and CSV
-- export formats. They store schema, validation, warning, and release-impact
-- summaries only; raw identity values are never persisted here.
-- =============================================================================

-- UIM-SCH-092 destination_profiles
CREATE TABLE IF NOT EXISTS destination_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  destination_type TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  base_profile_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, destination_type, profile_key)
);

CREATE INDEX IF NOT EXISTS idx_destination_profiles_type_state
  ON destination_profiles(tenant_id, destination_type, lifecycle_state, updated_at);

CREATE INDEX IF NOT EXISTS idx_destination_profiles_owner
  ON destination_profiles(owner_scope_type, owner_scope_id, destination_type);

CREATE UNIQUE INDEX IF NOT EXISTS ux_destination_profiles_scope_key
  ON destination_profiles(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    destination_type,
    profile_key
  );

-- UIM-SCH-093 destination_profile_versions
CREATE TABLE IF NOT EXISTS destination_profile_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  validation_summary_json TEXT NOT NULL,
  warning_summary_json TEXT NOT NULL,
  release_impact_json TEXT NOT NULL,
  reviewed_at INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_id, version_label),
  FOREIGN KEY (profile_id) REFERENCES destination_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_destination_profile_versions_state
  ON destination_profile_versions(tenant_id, lifecycle_state, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_destination_profile_versions_label
  ON destination_profile_versions(tenant_id, profile_id, version_label);

-- UIM-SCH-094 attribute_group_registry
CREATE TABLE IF NOT EXISTS attribute_group_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  protocol TEXT NOT NULL,
  group_type TEXT NOT NULL,
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  field_keys_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, protocol, group_type, group_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_attribute_group_registry_key
  ON attribute_group_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    protocol,
    group_type,
    group_key
  );

-- UIM-SCH-095 attribute_field_registry
CREATE TABLE IF NOT EXISTS attribute_field_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_scope_type TEXT NOT NULL DEFAULT 'tenant',
  owner_scope_id TEXT,
  protocol TEXT NOT NULL,
  field_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  classification TEXT NOT NULL DEFAULT 'internal',
  surfaces_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_scope_type, owner_scope_id, protocol, field_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_attribute_field_registry_key
  ON attribute_field_registry(
    tenant_id,
    owner_scope_type,
    COALESCE(owner_scope_id, ''),
    protocol,
    field_key
  );
