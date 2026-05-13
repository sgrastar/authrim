-- =============================================================================
-- Migration: Object Catalog Foundation
-- =============================================================================
-- Created: 2026-05-01
-- Description:
--   Adds the shared object catalog foundation for export artifacts and other
--   object-backed payloads stored outside the primary database.
-- =============================================================================

CREATE TABLE IF NOT EXISTS object_catalog (
  id TEXT PRIMARY KEY,
  public_artifact_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  object_class TEXT NOT NULL CHECK (
    object_class IN (
      'admin_audit_detail',
      'webhook_delivery_payload',
      'operational_log_detail',
      'user_export',
      'user_import_input',
      'user_import_result',
      'approval_transport_detail'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_object_catalog_deleted_at
  ON object_catalog(deleted_at);

CREATE TABLE IF NOT EXISTS object_catalog_objects (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  representation TEXT NOT NULL CHECK (
    representation IN (
      'canonical_json',
      'csv_projection',
      'ndjson_projection',
      'zip_bundle'
    )
  ),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('single', 'manifest', 'chunk')),
  object_index INTEGER NOT NULL DEFAULT 0,
  bucket_binding TEXT NOT NULL CHECK (
    bucket_binding IN ('IMPORT_ARTIFACTS', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS')
  ),
  object_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  total_bytes INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE,
  UNIQUE(catalog_id, representation, object_index)
);

CREATE INDEX IF NOT EXISTS idx_object_catalog_objects_catalog_repr
  ON object_catalog_objects(catalog_id, representation, object_index);

CREATE INDEX IF NOT EXISTS idx_object_catalog_objects_bucket_key
  ON object_catalog_objects(bucket_binding, object_key);

CREATE INDEX IF NOT EXISTS idx_object_catalog_objects_deleted_at
  ON object_catalog_objects(deleted_at);

ALTER TABLE data_export_requests ADD COLUMN object_catalog_id TEXT;

CREATE INDEX IF NOT EXISTS idx_data_export_requests_object_catalog
  ON data_export_requests(object_catalog_id);
