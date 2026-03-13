-- Migration 058: Add tenant domain mappings table
-- Platform-level email domain → tenant routing (system_admin only)
-- Allows users with @company.com emails to be auto-routed to the 'acme' tenant

CREATE TABLE IF NOT EXISTS tenant_domain_mappings (
  id                      TEXT PRIMARY KEY,
  domain_hash             TEXT NOT NULL,
  hash_version            INTEGER NOT NULL DEFAULT 1,
  tenant_id               TEXT NOT NULL,
  priority                INTEGER NOT NULL DEFAULT 0,
  is_active               INTEGER NOT NULL DEFAULT 1,
  verified                INTEGER NOT NULL DEFAULT 0,
  verification_token      TEXT,
  verification_expires_at INTEGER,
  created_by              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Unique index on active domain hashes to prevent duplicate routing
CREATE UNIQUE INDEX IF NOT EXISTS idx_tdm_domain_hash
  ON tenant_domain_mappings(domain_hash)
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_tdm_tenant ON tenant_domain_mappings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tdm_verified ON tenant_domain_mappings(verified, is_active, priority DESC);
