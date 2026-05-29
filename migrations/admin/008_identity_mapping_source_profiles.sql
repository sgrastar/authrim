-- =============================================================================
-- Unified Identity Mapping: source profile registration
--
-- CSV source profiles store only schema summaries, parser options, warnings, and
-- lifecycle state. Raw imported rows and raw sample values are intentionally not
-- persisted.
-- =============================================================================

-- UIM-SCH-089 source_profiles
CREATE TABLE IF NOT EXISTS source_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);

CREATE INDEX IF NOT EXISTS idx_source_profiles_type_state
  ON source_profiles(tenant_id, source_type, lifecycle_state, updated_at);

-- UIM-SCH-090 source_profile_versions
CREATE TABLE IF NOT EXISTS source_profile_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  parser_options_json TEXT,
  warning_summary_json TEXT,
  source_metadata_json TEXT,
  reviewed_at INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_id, version_label),
  FOREIGN KEY (profile_id) REFERENCES source_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_profile_versions_state
  ON source_profile_versions(tenant_id, lifecycle_state, updated_at);

-- UIM-SCH-091 source_profile_parse_drafts
CREATE TABLE IF NOT EXISTS source_profile_parse_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  parser_options_json TEXT,
  warning_summary_json TEXT,
  source_metadata_json TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_profile_parse_drafts_expiry
  ON source_profile_parse_drafts(tenant_id, expires_at);
