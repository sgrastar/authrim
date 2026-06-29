-- Add directory authentication artifact classes to the core object catalog.

ALTER TABLE object_catalog RENAME TO object_catalog_old;

CREATE TABLE object_catalog (
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
      'admin_job_result',
      'directory_auth_evidence_export',
      'directory_auth_support_bundle',
      'dr_bundle',
      'approval_transport_detail'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

INSERT INTO object_catalog (
  id,
  public_artifact_id,
  tenant_id,
  object_class,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  id,
  public_artifact_id,
  tenant_id,
  object_class,
  created_at,
  updated_at,
  deleted_at
FROM object_catalog_old;

ALTER TABLE object_catalog_objects RENAME TO object_catalog_objects_old;

CREATE TABLE object_catalog_objects (
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

INSERT INTO object_catalog_objects (
  id,
  catalog_id,
  representation,
  object_kind,
  object_index,
  bucket_binding,
  object_key,
  key_version,
  checksum_sha256,
  total_bytes,
  created_at,
  deleted_at
)
SELECT
  id,
  catalog_id,
  representation,
  object_kind,
  object_index,
  bucket_binding,
  object_key,
  key_version,
  checksum_sha256,
  total_bytes,
  created_at,
  deleted_at
FROM object_catalog_objects_old;

DROP TABLE object_catalog_objects_old;

ALTER TABLE sensitive_detail_chunk_index RENAME TO sensitive_detail_chunk_index_old;

CREATE TABLE sensitive_detail_chunk_index (
  catalog_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  object_class TEXT NOT NULL,
  bucket_binding TEXT NOT NULL CHECK (bucket_binding IN ('SENSITIVE_DETAILS')),
  object_key TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT 'gzip' CHECK (content_encoding IN ('gzip', 'none')),
  line_number INTEGER NOT NULL,
  byte_offset INTEGER,
  byte_length INTEGER,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE
);

INSERT INTO sensitive_detail_chunk_index (
  catalog_id,
  tenant_id,
  object_class,
  bucket_binding,
  object_key,
  content_encoding,
  line_number,
  byte_offset,
  byte_length,
  key_version,
  checksum_sha256,
  created_at,
  deleted_at
)
SELECT
  catalog_id,
  tenant_id,
  object_class,
  bucket_binding,
  object_key,
  content_encoding,
  line_number,
  byte_offset,
  byte_length,
  key_version,
  checksum_sha256,
  created_at,
  deleted_at
FROM sensitive_detail_chunk_index_old;

DROP TABLE sensitive_detail_chunk_index_old;
DROP TABLE object_catalog_old;
