-- Migration: 020_identifier_source_values.sql
-- Description: Dedicated identifier sources for the persistent_identifier step: values an
--              administrator imports for accounts (an employee number, a student ID, an old
--              user name) for a step to make its identifier from, instead of the account's own ID.
--              - Not a profile attribute: no user, sign-up, JIT, SCIM or profile path can write
--                it. Only the Admin API's CSV import does.
--              - source_name: the name the step's `source` parameter uses.
--              - account_id: the account's runtime ID (the user ID the Admin API shows as `id`).
--              - value: plain text; no type, no JSON parsing. One source holds one value per
--                account, and no value for two accounts.
--              Rows are erased with the account (full deletion and PII-only erasure).
--              Holds identifying values of accounts: personal data, in the tenant's backups.
--              - retired_identifier_values: a value (a stored identifier of mapped_identifier_values,
--                or a source value) that was replaced or erased with its account stays reserved: no
--                other account may be given it, or it would make the identifier the first one had.
--                account_hmac (an HMAC of the account's ID under the same key) says whose it was:
--                the same account may take its own old value back, nobody else may.
--                Only an HMAC of the value (under a key the tenant's key manager holds) is kept, so
--                erasing an account leaves no personal data here. key_id says which key made
--                the HMAC (the first 16 hex of an HMAC of a fixed text under it): the rows and the key
--                are restored by different parts of a backup, and an import refuses to run when
--                the key it has is not the one the rows were made with. kind is `stored` or `source`;
--                scope is `<store>\n<audience>` or the source's name.
-- Author: @authrim
-- Date: 2026-11-14
-- Issue: Persistent identifier step PR-3 (identifier sources)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS identifier_source_values (
  tenant_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 512),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, source_name, account_id),
  UNIQUE (tenant_id, source_name, value)
);

CREATE INDEX IF NOT EXISTS idx_identifier_source_values_account
  ON identifier_source_values (tenant_id, account_id);

CREATE TABLE IF NOT EXISTS retired_identifier_values (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stored', 'source')),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 2200),
  value_hmac TEXT NOT NULL CHECK (length(value_hmac) = 64),
  account_hmac TEXT NOT NULL CHECK (length(account_hmac) = 64),
  key_id TEXT NOT NULL CHECK (length(key_id) = 16),
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, kind, scope, value_hmac, account_hmac)
);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP TABLE IF EXISTS retired_identifier_values;
-- DROP INDEX IF EXISTS idx_identifier_source_values_account;
-- DROP TABLE IF EXISTS identifier_source_values;
-- DELETE FROM schema_migrations WHERE version = 20;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 020
-- =============================================================================
