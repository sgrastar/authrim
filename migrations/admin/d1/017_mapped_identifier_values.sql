-- Migration: 017_mapped_identifier_values.sql
-- Description: Identifiers people already have at another identity provider, kept so a
--              persistent_identifier step can release them unchanged (`stored`: prefer or
--              require). Imported from the other IdP (Shibboleth stored IDs, a cloud IdP's
--              identifiers) where they cannot be made again from a salt.
--              - store_name: the step's `store` setting; one store holds one kind of identifier.
--              - audience: who it was issued to (the OIDC client ID or sector host, the SAML SP
--                entity ID), as the step resolves it.
--              - source_hash: SHA-256 (hex) of the value it was made from (the migrated user
--                name, the account ID); the value itself is not kept.
--              - identifier: the identifier before protocol framing (no scope, no NameQualifiers).
--              One identifier per person and audience, and no identifier for two people.
--              Holds pseudonymous identifiers: personal data, in the tenant's backups.
-- Author: @authrim
-- Date: 2026-11-14
-- Issue: Persistent identifier step PR-2

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS mapped_identifier_values (
  tenant_id TEXT NOT NULL,
  store_name TEXT NOT NULL,
  audience TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  identifier TEXT NOT NULL CHECK (length(identifier) BETWEEN 1 AND 512),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, store_name, audience, source_hash),
  UNIQUE (tenant_id, store_name, audience, identifier)
);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP TABLE IF EXISTS mapped_identifier_values;
-- DELETE FROM schema_migrations WHERE version = 17;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 017
-- =============================================================================
