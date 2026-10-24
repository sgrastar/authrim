-- Migration: 049_identity_mapping_test_users.sql
-- Description: Test users for explaining the release of claims (the identity-mapping explain
--   API). Each is a made-up set of Authrim attributes kept per tenant: there is no user row, and
--   the explanation reads nothing keyed by its ID, so a real user's data is never touched. The
--   values are fixtures an administrator typed, never copied from an account.
-- Date: 2026-10-24

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE identity_mapping_test_users (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 4 AND 64 AND substr(id, 1, 3) = 'tu_'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  attributes_json TEXT NOT NULL CHECK (
    json_valid(attributes_json)
    AND json_type(attributes_json) = 'object'
    AND length(attributes_json) <= 8192
  ),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX idx_identity_mapping_test_users_tenant_position
  ON identity_mapping_test_users (tenant_id, position);
