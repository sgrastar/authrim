-- Migration: 034_plugin_account_metadata.sql
-- Description: Add plugin-scoped account metadata with idempotent mutation and immutable audit.
-- Author: Authrim
-- Date: 2026-07-29

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS plugin_account_metadata (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  value_json TEXT NOT NULL
    CHECK (json_valid(value_json) AND length(value_json) BETWEEN 1 AND 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id, plugin_id, metadata_key),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (metadata_key NOT GLOB '*[^a-z0-9._-]*' AND length(metadata_key) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_plugin_account_metadata_installation
  ON plugin_account_metadata(tenant_id, plugin_installation_id, account_id);

CREATE TABLE IF NOT EXISTS plugin_account_metadata_mutations (
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB '*[^a-z0-9._-]*' AND
      length(fingerprint_key_id) BETWEEN 1 AND 64),
  result_version INTEGER NOT NULL CHECK (result_version >= 1),
  request_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  data_role TEXT NOT NULL CHECK (data_role = 'tenant_core/users'),
  residency_partition TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, plugin_installation_id, operation_id),
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK (length(request_id) BETWEEN 1 AND 256),
  CHECK (length(capability) BETWEEN 1 AND 128),
  CHECK (length(residency_partition) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_plugin_account_metadata_mutations_account
  ON plugin_account_metadata_mutations(tenant_id, account_id, applied_at);

CREATE TRIGGER IF NOT EXISTS trg_plugin_account_metadata_mutation_immutable_update
BEFORE UPDATE ON plugin_account_metadata_mutations
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_mutation_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_plugin_account_metadata_mutation_immutable_delete
BEFORE DELETE ON plugin_account_metadata_mutations
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_mutation_immutable');
END;

CREATE TABLE IF NOT EXISTS plugin_account_metadata_audit (
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK (result_version >= 1),
  actor_type TEXT NOT NULL CHECK (actor_type = 'plugin'),
  request_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = 'account.metadata.write'),
  data_role TEXT NOT NULL CHECK (data_role = 'tenant_core/users'),
  residency_partition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, plugin_installation_id, operation_id),
  FOREIGN KEY (tenant_id, plugin_installation_id, operation_id)
    REFERENCES plugin_account_metadata_mutations(
      tenant_id, plugin_installation_id, operation_id
    ) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_plugin_account_metadata_audit_account
  ON plugin_account_metadata_audit(tenant_id, account_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_plugin_account_metadata_audit_immutable_update
BEFORE UPDATE ON plugin_account_metadata_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_audit_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_plugin_account_metadata_audit_immutable_delete
BEFORE DELETE ON plugin_account_metadata_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_audit_immutable');
END;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP TRIGGER IF EXISTS trg_plugin_account_metadata_audit_immutable_delete;
-- DROP TRIGGER IF EXISTS trg_plugin_account_metadata_audit_immutable_update;
-- DROP TABLE IF EXISTS plugin_account_metadata_audit;
-- DROP TRIGGER IF EXISTS trg_plugin_account_metadata_mutation_immutable_delete;
-- DROP TRIGGER IF EXISTS trg_plugin_account_metadata_mutation_immutable_update;
-- DROP TABLE IF EXISTS plugin_account_metadata_mutations;
-- DROP TABLE IF EXISTS plugin_account_metadata;
-- DELETE FROM schema_migrations WHERE version = 34;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 034
-- =============================================================================
