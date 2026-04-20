-- Migration 064: Add tenant vanity domains
-- Canonical per-tenant custom hostnames backed by Cloudflare Custom Hostnames.

CREATE TABLE IF NOT EXISTS tenant_vanity_domains (
  id                             TEXT PRIMARY KEY,
  tenant_id                      TEXT NOT NULL,
  hostname                       TEXT NOT NULL,
  is_active                      INTEGER NOT NULL DEFAULT 1,
  is_primary                     INTEGER NOT NULL DEFAULT 0,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_tvd_hostname_active
  ON tenant_vanity_domains(hostname)
  WHERE is_active = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tvd_primary_active
  ON tenant_vanity_domains(tenant_id)
  WHERE is_primary = 1 AND is_active = 1;

CREATE INDEX IF NOT EXISTS idx_tvd_tenant
  ON tenant_vanity_domains(tenant_id);

CREATE INDEX IF NOT EXISTS idx_tvd_status
  ON tenant_vanity_domains(status, is_active);
