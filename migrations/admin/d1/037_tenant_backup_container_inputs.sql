-- One authenticated receipt per v2 input. Dataset stats include empty datasets without row events.
CREATE TABLE tenant_backup_container_inputs (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL CHECK (length(bundle_id)=32 AND bundle_id NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  object_size INTEGER NOT NULL CHECK (object_size>0),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  dataset_stats_json TEXT NOT NULL CHECK (json_valid(dataset_stats_json)),
  verified_at INTEGER NOT NULL CHECK (verified_at>=0),
  PRIMARY KEY (operation_id,bundle_id),
  FOREIGN KEY (operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);

CREATE TRIGGER tenant_backup_container_inputs_immutable
BEFORE UPDATE ON tenant_backup_container_inputs
BEGIN SELECT RAISE(ABORT,'tenant_backup_container_input_immutable'); END;
