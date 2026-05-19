-- Tenant-level SAML federation metadata trust profiles.
-- Stored in the control-plane/admin database so trust anchors can be configured before
-- tenant-owned provider storage is provisioned.

CREATE TABLE IF NOT EXISTS saml_federation_trust_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  metadata_url_patterns_json TEXT NOT NULL,
  certificates_json TEXT NOT NULL,
  policy TEXT CHECK (policy IN ('strict', 'warn', 'disabled')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saml_federation_trust_profiles_tenant
  ON saml_federation_trust_profiles(tenant_id, enabled, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saml_federation_trust_profiles_tenant_name
  ON saml_federation_trust_profiles(tenant_id, name);
