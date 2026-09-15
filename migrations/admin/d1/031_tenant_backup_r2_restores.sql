-- Durable object-write state for portable R2 bodies restored into unpublished tenant targets.
CREATE TABLE tenant_backup_r2_restore_objects (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL CHECK(dataset_id IN ('artifacts.object_catalog_bodies','logs.archive_object_bodies')),
  object_id TEXT NOT NULL CHECK(length(object_id) BETWEEN 1 AND 256),
  source_object_key TEXT NOT NULL CHECK(length(source_object_key) BETWEEN 1 AND 1024),
  source_encoding TEXT NOT NULL CHECK(source_encoding IN ('plaintext','object_artifact_v1','log_chunk_v1')),
  write_mode TEXT NOT NULL CHECK(write_mode IN ('multipart','staged')),
  target_bucket_binding TEXT NOT NULL CHECK(target_bucket_binding IN ('AUDIT_ARCHIVE','DIAGNOSTIC_LOGS','EXPORT_ARTIFACTS','IMPORT_ARTIFACTS','SENSITIVE_DETAILS')),
  target_object_key TEXT NOT NULL CHECK(length(target_object_key) BETWEEN 1 AND 1024),
  object_sha256 TEXT NOT NULL CHECK(length(object_sha256)=64 AND object_sha256 NOT GLOB '*[^0-9a-f]*'),
  total_bytes INTEGER NOT NULL CHECK(total_bytes>=0 AND total_bytes<=21474836480),
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 4096),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(context_json)<=8192),
  http_metadata_json TEXT CHECK(http_metadata_json IS NULL OR (json_valid(http_metadata_json) AND length(http_metadata_json)<=8192)),
  custom_metadata_json TEXT CHECK(custom_metadata_json IS NULL OR (json_valid(custom_metadata_json) AND length(custom_metadata_json)<=8192)),
  multipart_id TEXT,
  state TEXT NOT NULL DEFAULT 'allocating' CHECK(state IN ('allocating','uploading','completing','completed','cancelling','deleted')),
  object_version TEXT,
  object_etag TEXT,
  stored_sha256 TEXT CHECK(stored_sha256 IS NULL OR (length(stored_sha256)=64 AND stored_sha256 NOT GLOB '*[^0-9a-f]*')),
  completed_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  PRIMARY KEY(operation_id,dataset_id,object_id),
  UNIQUE(target_bucket_binding,target_object_key),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  CHECK(source_object_key<>target_object_key),
  CHECK((write_mode='multipart' AND (state='allocating' OR multipart_id IS NOT NULL))
    OR (write_mode='staged' AND multipart_id IS NULL)),
  CHECK(state!='completed' OR (object_version IS NOT NULL AND object_etag IS NOT NULL
    AND stored_sha256 IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE tenant_backup_r2_restore_parts (
  operation_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 4095),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 5242880),
  chunk_sha256 TEXT NOT NULL CHECK(length(chunk_sha256)=64 AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_part_etag TEXT,
  staging_object_key TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  PRIMARY KEY(operation_id,dataset_id,object_id,chunk_index),
  FOREIGN KEY(operation_id,dataset_id,object_id)
    REFERENCES tenant_backup_r2_restore_objects(operation_id,dataset_id,object_id) ON DELETE CASCADE,
  CHECK(NOT (target_part_etag IS NOT NULL AND staging_object_key IS NOT NULL))
);

CREATE INDEX tenant_backup_r2_restore_state
  ON tenant_backup_r2_restore_objects(state,updated_at,operation_id,dataset_id,object_id);

CREATE TRIGGER tenant_backup_r2_restore_identity_immutable
BEFORE UPDATE ON tenant_backup_r2_restore_objects
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.dataset_id IS NOT OLD.dataset_id
  OR NEW.object_id IS NOT OLD.object_id
  OR NEW.source_object_key IS NOT OLD.source_object_key
  OR NEW.source_encoding IS NOT OLD.source_encoding
  OR NEW.write_mode IS NOT OLD.write_mode
  OR NEW.target_bucket_binding IS NOT OLD.target_bucket_binding
  OR NEW.target_object_key IS NOT OLD.target_object_key
  OR NEW.object_sha256 IS NOT OLD.object_sha256
  OR NEW.total_bytes IS NOT OLD.total_bytes
  OR NEW.chunk_count IS NOT OLD.chunk_count
  OR NEW.context_json IS NOT OLD.context_json
  OR NEW.http_metadata_json IS NOT OLD.http_metadata_json
  OR NEW.custom_metadata_json IS NOT OLD.custom_metadata_json
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.multipart_id IS NOT NULL AND NEW.multipart_id IS NOT OLD.multipart_id)
  OR (OLD.object_version IS NOT NULL AND NEW.object_version IS NOT OLD.object_version)
  OR (OLD.object_etag IS NOT NULL AND NEW.object_etag IS NOT OLD.object_etag)
  OR (OLD.stored_sha256 IS NOT NULL AND NEW.stored_sha256 IS NOT OLD.stored_sha256)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_identity'); END;

CREATE TRIGGER tenant_backup_r2_restore_state_transition
BEFORE UPDATE OF state ON tenant_backup_r2_restore_objects
WHEN NOT (
  NEW.state=OLD.state
  OR (OLD.state='allocating' AND NEW.state IN ('uploading','cancelling'))
  OR (OLD.state='uploading' AND NEW.state IN ('completing','cancelling'))
  OR (OLD.state='completing' AND NEW.state IN ('completed','cancelling'))
  OR (OLD.state='completed' AND NEW.state='cancelling')
  OR (OLD.state='cancelling' AND NEW.state='deleted')
)
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_state_transition'); END;

CREATE TRIGGER tenant_backup_r2_restore_part_immutable
BEFORE UPDATE ON tenant_backup_r2_restore_parts
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.dataset_id IS NOT OLD.dataset_id
  OR NEW.object_id IS NOT OLD.object_id
  OR NEW.chunk_index IS NOT OLD.chunk_index
  OR NEW.byte_count IS NOT OLD.byte_count
  OR NEW.chunk_sha256 IS NOT OLD.chunk_sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.target_part_etag IS NOT NULL AND NEW.target_part_etag IS NOT OLD.target_part_etag)
  OR (OLD.staging_object_key IS NOT NULL AND NEW.staging_object_key IS NOT OLD.staging_object_key)
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_part_identity'); END;
