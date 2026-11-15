-- Migration: 019_mapped_identifier_values_account_binding.sql
-- Description: Identifiers kept from another identity provider are bound to the account they were
--              imported for (not to a hash of a value the person controls, such as an email
--              address, which another person could come to hold and so claim the identifier).
--              - Rebuilt: mapped_identifier_values, keyed (tenant, store, audience, account_id),
--                still UNIQUE (tenant, store, audience, identifier): one identifier per account
--                and audience, and no identifier for two accounts.
--              - account_id: the account's runtime ID (the user ID the Admin API shows as `id`),
--                the same for OIDC and SAML. The importer checks that the account exists.
--              - Rows are erased with the account (full deletion and PII-only erasure).
--              The old rows were keyed by source_hash and cannot be bound to an account: they are
--              not carried over (pre-1.0, no backward compatibility); import them again with an
--              account column.
--              Holds pseudonymous identifiers of accounts: personal data, in the tenant's backups.
-- Author: @authrim
-- Date: 2026-11-14
-- Issue: Persistent identifier step PR-3 (stored identifiers bound to accounts)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

DROP TABLE IF EXISTS mapped_identifier_values;

CREATE TABLE mapped_identifier_values (
  tenant_id TEXT NOT NULL,
  store_name TEXT NOT NULL,
  audience TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  identifier TEXT NOT NULL CHECK (length(identifier) BETWEEN 1 AND 512),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, store_name, audience, account_id),
  UNIQUE (tenant_id, store_name, audience, identifier)
);

CREATE INDEX idx_mapped_identifier_values_account
  ON mapped_identifier_values (tenant_id, account_id);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP INDEX IF EXISTS idx_mapped_identifier_values_account;
-- DROP TABLE IF EXISTS mapped_identifier_values;
-- DELETE FROM schema_migrations WHERE version = 19;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 019
-- =============================================================================
