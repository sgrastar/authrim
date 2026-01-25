-- Migration 029: Add external_id column to users_core for SCIM support
--
-- SCIM 2.0 (RFC 7643) uses externalId to identify users in external systems.
-- This column enables IdPs to track users provisioned via SCIM with their
-- original identifiers from enterprise directories (e.g., AD, Okta, Entra ID).
--
-- Reference: RFC 7643 Section 3.1 (Common Attributes - externalId)

ALTER TABLE users_core ADD COLUMN external_id TEXT DEFAULT NULL;

-- Index for efficient lookups by external_id within a tenant
CREATE INDEX IF NOT EXISTS idx_users_core_tenant_external_id ON users_core(tenant_id, external_id);
