-- =============================================================================
-- Migration: DCR Scope Restriction & Software ID Support
-- Version: 045
-- Description: Add columns for DCR scope restriction and software_id tracking
-- =============================================================================

-- Add software_id column for RFC 7591 Dynamic Client Registration
-- software_id identifies the software application (e.g., "my-app-123")
ALTER TABLE oauth_clients ADD COLUMN software_id TEXT;

-- Add software_version column for DCR
ALTER TABLE oauth_clients ADD COLUMN software_version TEXT;

-- Add requestable_scopes column for scope restriction
-- JSON array of scopes that this client is allowed to request
-- When set, client can only request scopes from this list during authorization
ALTER TABLE oauth_clients ADD COLUMN requestable_scopes TEXT;

-- Index for software_id duplicate checking (fast lookup by software_id + tenant_id)
-- Used when dcr.allow_duplicate_software_id is false
CREATE INDEX idx_clients_software_id_tenant ON oauth_clients(software_id, tenant_id);
