-- =============================================================================
-- Migration 088: Add opaque tenant keys for logging/storage object paths
-- =============================================================================

ALTER TABLE tenants ADD COLUMN tenant_key TEXT;

UPDATE tenants
SET tenant_key = 't_' || lower(hex(randomblob(18)))
WHERE tenant_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_tenant_key ON tenants(tenant_key);
