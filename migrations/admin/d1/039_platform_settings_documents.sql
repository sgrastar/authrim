-- Migration: 039_platform_settings_documents.sql
-- Description: Strongly consistent source for platform-scope SettingsManager documents, as
--   tenant_settings_documents is for tenant and client documents. Saves compare and set on the
--   version here; Workers KV (`settings:platform:<category>`) remains the runtime projection.
-- Date: 2026-10-01

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE platform_settings_documents (
  category TEXT NOT NULL PRIMARY KEY CHECK(length(category) BETWEEN 1 AND 128),
  document_json TEXT NOT NULL CHECK(
    json_valid(document_json) AND
    json_type(document_json)='object' AND
    length(CAST(document_json AS BLOB))<=1048576
  ),
  version TEXT NOT NULL CHECK(
    length(version)=23 AND
    version LIKE 'sha256:%' AND
    substr(version,8) NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK(revision>0),
  projection_state TEXT NOT NULL CHECK(projection_state IN ('pending','applied')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  projected_at INTEGER CHECK(projected_at IS NULL OR projected_at>=updated_at),
  reconciled_at INTEGER NOT NULL DEFAULT 0 CHECK(reconciled_at>=0),
  CHECK((projection_state='pending' AND projected_at IS NULL) OR
    (projection_state='applied' AND projected_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_platform_settings_documents_projection
  ON platform_settings_documents(projection_state,updated_at,category);

CREATE INDEX idx_platform_settings_documents_reconciled
  ON platform_settings_documents(reconciled_at,category);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP INDEX IF EXISTS idx_platform_settings_documents_reconciled;
-- DROP INDEX IF EXISTS idx_platform_settings_documents_projection;
-- DROP TABLE IF EXISTS platform_settings_documents;
