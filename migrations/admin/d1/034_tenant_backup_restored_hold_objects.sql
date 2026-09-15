-- Immutable R2 companions for restored workflow rows that remain quarantined from live consumers.
CREATE TABLE tenant_backup_restored_hold_objects (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  source_bucket_binding TEXT NOT NULL CHECK (source_bucket_binding IN (
    'AUDIT_ARCHIVE', 'DIAGNOSTIC_LOGS', 'EXPORT_ARTIFACTS', 'IMPORT_ARTIFACTS',
    'SENSITIVE_DETAILS'
  )),
  source_object_ref TEXT NOT NULL,
  target_bucket_binding TEXT NOT NULL CHECK (target_bucket_binding IN (
    'AUDIT_ARCHIVE', 'DIAGNOSTIC_LOGS', 'EXPORT_ARTIFACTS', 'IMPORT_ARTIFACTS',
    'SENSITIVE_DETAILS'
  )),
  target_object_ref TEXT NOT NULL,
  target_object_version TEXT NOT NULL,
  target_object_etag TEXT NOT NULL,
  target_plaintext_sha256 TEXT NOT NULL CHECK (
    length(target_plaintext_sha256) = 64 AND target_plaintext_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  target_stored_sha256 TEXT NOT NULL CHECK (
    length(target_stored_sha256) = 64 AND target_stored_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  target_stored_byte_count INTEGER NOT NULL CHECK (target_stored_byte_count > 0),
  target_key_version INTEGER NOT NULL CHECK (target_key_version > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, dataset_id, record_id, source_field),
  UNIQUE (operation_id, target_bucket_binding, target_object_ref),
  FOREIGN KEY (operation_id) REFERENCES tenant_backup_operations(id) ON DELETE CASCADE
);

CREATE INDEX idx_tenant_backup_restored_hold_objects_tenant_operation
  ON tenant_backup_restored_hold_objects(tenant_id, operation_id, dataset_id);

CREATE TRIGGER trg_tenant_backup_restored_hold_objects_immutable
BEFORE UPDATE ON tenant_backup_restored_hold_objects
BEGIN
  SELECT RAISE(ABORT, 'tenant_backup_restored_hold_object_immutable');
END;
