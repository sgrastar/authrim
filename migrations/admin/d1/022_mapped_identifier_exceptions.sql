-- Migration: 022_mapped_identifier_exceptions.sql
-- Description: Exceptions to a persistent_identifier step (Shibboleth's exceptionMap): per account
--              and recipient, another imported salt for the identifier, or no identifier at all.
--              - list_name: the name the step's `exceptions` parameter uses.
--              - account_id: the account's runtime ID (the user ID the Admin API shows as `id`),
--                or `*` for every account without an entry of its own.
--              - audience: the recipient (the OIDC sector, or the SAML SP's entity ID), or `*`.
--              - action: `salt` (salt_name names an imported salt) or `block` (no identifier is
--                made). The salt's value is never kept here, only its name.
--              A list is replaced whole by its import. Rows of an account are erased with the
--              account (full deletion and PII-only erasure); the `*` rows are not about one.
-- Author: @authrim
-- Date: 2026-11-15
-- Issue: Persistent identifier step PR-3 (exception map)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS mapped_identifier_exceptions (
  tenant_id TEXT NOT NULL,
  list_name TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK (account_id = '*' OR length(account_id) BETWEEN 1 AND 128),
  audience TEXT NOT NULL CHECK (length(audience) BETWEEN 1 AND 1024),
  action TEXT NOT NULL CHECK (action IN ('salt', 'block')),
  salt_name TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((action = 'salt' AND salt_name IS NOT NULL) OR (action = 'block' AND salt_name IS NULL)),
  PRIMARY KEY (tenant_id, list_name, account_id, audience)
);

CREATE INDEX IF NOT EXISTS idx_mapped_identifier_exceptions_account
  ON mapped_identifier_exceptions (tenant_id, account_id);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP INDEX IF EXISTS idx_mapped_identifier_exceptions_account;
-- DROP TABLE IF EXISTS mapped_identifier_exceptions;
-- DELETE FROM schema_migrations WHERE version = 22;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 022
-- =============================================================================
