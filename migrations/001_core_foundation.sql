-- =============================================================================
-- Authrim Core Baseline: Foundation
-- Consolidated baseline for fresh Authrim core database installs.
-- =============================================================================

-- tenants table must be created first as other tables reference it via FK
CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,           -- slug format: ^[a-z0-9-]+$, max 63chars
  tenant_code TEXT NOT NULL UNIQUE,       -- manual-entry/discovery code (globally unique)
  tenant_key  TEXT NOT NULL UNIQUE,       -- opaque key for logging/storage object paths
  name        TEXT NOT NULL,              -- display name
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1, -- 0=disabled, 1=enabled
  is_default  INTEGER NOT NULL DEFAULT 0, -- default tenant (only one)
  default_tenant_guard TEXT,              -- 'default' when is_default=1, NULL otherwise
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard);

CREATE TABLE trust_groups (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX idx_trust_groups_tenant_id ON trust_groups(tenant_id, id);

-- Seed the existing 'default' tenant
INSERT INTO tenants (
  id, tenant_code, tenant_key, name, is_active, is_default, default_tenant_guard, created_at, updated_at
)
VALUES (
  'default',
  'default',
  't_' || lower(hex(randomblob(18))),
  'Default',
  1,
  1,
  'default',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  __AUTHRIM_NOW_EPOCH_SECONDS__
);

-- Platform-level email domain → tenant routing (system_admin only)
CREATE TABLE tenant_domain_mappings (
  id                      TEXT PRIMARY KEY,
  domain_hash             TEXT NOT NULL,
  hash_version            INTEGER NOT NULL DEFAULT 1,
  tenant_id               TEXT NOT NULL,
  priority                INTEGER NOT NULL DEFAULT 0,
  is_active               INTEGER NOT NULL DEFAULT 1,
  active_domain_hash      TEXT,
  verified                INTEGER NOT NULL DEFAULT 0,
  verification_token      TEXT,
  verification_expires_at INTEGER,
  created_by              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX idx_tdm_domain_hash ON tenant_domain_mappings(active_domain_hash);
CREATE INDEX idx_tdm_domain_lookup ON tenant_domain_mappings(domain_hash, is_active);
CREATE INDEX idx_tdm_tenant ON tenant_domain_mappings(tenant_id);
CREATE INDEX idx_tdm_verified ON tenant_domain_mappings(verified, is_active, priority DESC);

-- Canonical per-tenant custom hostnames (Cloudflare Custom Hostnames)
CREATE TABLE tenant_vanity_domains (
  id                             TEXT PRIMARY KEY,
  tenant_id                      TEXT NOT NULL,
  hostname                       TEXT NOT NULL,
  is_active                      INTEGER NOT NULL DEFAULT 1,
  active_hostname                TEXT,
  is_primary                     INTEGER NOT NULL DEFAULT 0,
  primary_active_tenant_key      TEXT,
  status                         TEXT NOT NULL DEFAULT 'pending',
  cloudflare_zone_id             TEXT,
  cloudflare_custom_hostname_id  TEXT,
  ssl_status                     TEXT,
  ownership_status               TEXT,
  validation_method              TEXT,
  validation_records_json        TEXT,
  last_sync_at                   INTEGER,
  created_by                     TEXT,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX idx_tvd_hostname_active ON tenant_vanity_domains(active_hostname);
CREATE UNIQUE INDEX idx_tvd_primary_active ON tenant_vanity_domains(primary_active_tenant_key);
CREATE INDEX idx_tvd_hostname_lookup ON tenant_vanity_domains(hostname, is_active);
CREATE INDEX idx_tvd_primary_lookup ON tenant_vanity_domains(tenant_id, is_primary, is_active, status);
CREATE INDEX idx_tvd_tenant ON tenant_vanity_domains(tenant_id);
CREATE INDEX idx_tvd_status ON tenant_vanity_domains(status, is_active);
