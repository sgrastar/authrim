-- Migration: 002_unique_saml_provider_entity_id.sql
-- Description: Enforce one explicit SAML provider per tenant, role, and entityID.
-- Author: Authrim
-- Date: 2026-09-01

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE UNIQUE INDEX idx_identity_providers_saml_entity_id
  ON identity_providers(
    tenant_id,
    provider_type,
    json_extract(config_json, '$.entityId')
  )
  WHERE provider_type IN ('saml_idp', 'saml_sp')
    AND json_valid(config_json)
    AND json_type(config_json, '$.entityId') = 'text';

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP INDEX IF EXISTS idx_identity_providers_saml_entity_id;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 002
-- =============================================================================
