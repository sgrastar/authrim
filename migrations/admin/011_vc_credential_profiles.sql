-- Credential Profiles bind VC protocol configuration to immutable published
-- Flow and field-mapping snapshots. This is a new migration so already-applied
-- control-plane databases receive the schema.

CREATE TABLE IF NOT EXISTS credential_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_state IN ('draft', 'published', 'disabled')),
  current_published_version_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);

CREATE TABLE IF NOT EXISTS credential_profile_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  credential_profile_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  lifecycle_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_state IN ('draft', 'published', 'retired')),
  credential_configuration_id TEXT NOT NULL,
  issuance_flow_id TEXT NOT NULL,
  issuance_flow_version_id TEXT,
  verification_flow_id TEXT,
  verification_flow_version_id TEXT,
  issuance_mapping_set_id TEXT NOT NULL,
  issuance_mapping_version_id TEXT,
  issuance_mapping_snapshot_hash TEXT,
  verification_mapping_set_id TEXT,
  verification_mapping_version_id TEXT,
  verification_mapping_snapshot_hash TEXT,
  claim_allowlist_json TEXT NOT NULL,
  offer_ttl_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (offer_ttl_seconds BETWEEN 60 AND 900),
  maximum_attribute_age_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (maximum_attribute_age_seconds BETWEEN 60 AND 2592000),
  transaction_code_required INTEGER NOT NULL DEFAULT 0
    CHECK (transaction_code_required IN (0, 1)),
  snapshot_hash TEXT,
  published_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, credential_profile_id, version_number),
  FOREIGN KEY (credential_profile_id) REFERENCES credential_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (issuance_mapping_set_id) REFERENCES field_mapping_sets(id),
  FOREIGN KEY (issuance_mapping_version_id) REFERENCES field_mapping_versions(id),
  FOREIGN KEY (verification_mapping_set_id) REFERENCES field_mapping_sets(id),
  FOREIGN KEY (verification_mapping_version_id) REFERENCES field_mapping_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_credential_profiles_state
  ON credential_profiles(tenant_id, lifecycle_state, updated_at);

CREATE INDEX IF NOT EXISTS idx_credential_profile_versions_state
  ON credential_profile_versions(tenant_id, credential_profile_id, lifecycle_state, version_number);
