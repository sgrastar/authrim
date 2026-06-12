-- =============================================================================
-- Persistent Identifier Profiles
--
-- Shared control-plane configuration for pairwise/persistent identifiers used by
-- SAML, OIDC, and future protocol adapters.
-- =============================================================================

CREATE TABLE IF NOT EXISTS persistent_identifier_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  mode TEXT NOT NULL DEFAULT 'computed',
  algorithm TEXT NOT NULL DEFAULT 'authrim_sha256_base64url',
  protocol_scope TEXT NOT NULL DEFAULT 'any',
  usage_json TEXT NOT NULL DEFAULT '[]',
  source_ref_json TEXT,
  secret_ref TEXT,
  issuer_entity_id TEXT,
  audience_mode TEXT NOT NULL DEFAULT 'runtime',
  format_json TEXT NOT NULL DEFAULT '{}',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);

CREATE INDEX IF NOT EXISTS idx_persistent_identifier_profiles_tenant_state
  ON persistent_identifier_profiles(tenant_id, lifecycle_state, updated_at);

CREATE TABLE IF NOT EXISTS persistent_identifier_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  audience_key TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  value_source TEXT NOT NULL DEFAULT 'imported',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_id, subject_key, audience_key),
  FOREIGN KEY (profile_id) REFERENCES persistent_identifier_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_persistent_identifier_values_lookup
  ON persistent_identifier_values(tenant_id, profile_id, subject_key, audience_key);
