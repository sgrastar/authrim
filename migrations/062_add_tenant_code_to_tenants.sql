-- Add globally unique tenant_code for discovery and manual tenant entry
ALTER TABLE tenants ADD COLUMN tenant_code TEXT;

UPDATE tenants
SET tenant_code = id
WHERE tenant_code IS NULL OR tenant_code = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_tenant_code ON tenants(tenant_code);
