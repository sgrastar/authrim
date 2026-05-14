-- SAML custom attribute release presets
-- Stores tenant-scoped reusable SAML AttributeReleasePolicy templates.

CREATE TABLE IF NOT EXISTS saml_attribute_presets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  applies_to TEXT NOT NULL DEFAULT 'sp_attribute_release',
  profile TEXT NOT NULL DEFAULT 'custom',
  stability TEXT NOT NULL DEFAULT 'custom',
  application_mode TEXT NOT NULL DEFAULT 'clone_edit',
  attribute_release_policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, label)
);

CREATE INDEX IF NOT EXISTS idx_saml_attribute_presets_tenant
  ON saml_attribute_presets(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_saml_attribute_presets_applies_to
  ON saml_attribute_presets(tenant_id, applies_to);
