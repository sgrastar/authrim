-- Immutable R2 identities authorized for one import operation.
CREATE TABLE tenant_backup_operation_inputs (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
  upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 174 AND 83886080000),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  bound_at INTEGER NOT NULL CHECK(bound_at>=0),
  PRIMARY KEY(operation_id,ordinal),
  UNIQUE(operation_id,upload_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(upload_id) REFERENCES tenant_backup_uploads(id)
);
CREATE INDEX tenant_backup_operation_inputs_upload ON tenant_backup_operation_inputs(upload_id);
CREATE TRIGGER tenant_backup_operation_input_authorized
BEFORE INSERT ON tenant_backup_operation_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_uploads u
  JOIN tenant_backup_operations o ON o.id=NEW.operation_id AND o.tenant_id=NEW.tenant_id
  WHERE u.id=NEW.upload_id AND u.tenant_id=NEW.tenant_id AND u.created_by=o.created_by
    AND o.kind='import' AND o.created_at=NEW.bound_at
    AND u.state='uploaded' AND u.object_key=NEW.object_key
    AND u.object_version=NEW.object_version AND u.object_etag=NEW.object_etag
    AND u.expected_bytes=NEW.size_bytes AND u.verified_sha256=NEW.digest_sha256
    AND u.completed_at IS NOT NULL AND u.completed_at<=NEW.bound_at
    AND u.created_at<=NEW.bound_at AND u.expires_at>NEW.bound_at
)
BEGIN SELECT RAISE(ABORT,'backup_operation_input_unauthorized'); END;
CREATE TRIGGER tenant_backup_operation_input_immutable
BEFORE UPDATE ON tenant_backup_operation_inputs
BEGIN SELECT RAISE(ABORT,'backup_operation_input_immutable'); END;

ALTER TABLE tenant_backup_operations ADD COLUMN active_input_key_challenges_json TEXT
  CHECK(active_input_key_challenges_json IS NULL OR
    (json_valid(active_input_key_challenges_json) AND json_type(active_input_key_challenges_json)='array'
      AND json_array_length(active_input_key_challenges_json) BETWEEN 1 AND 32
      AND length(CAST(active_input_key_challenges_json AS BLOB))<=16384));
CREATE TRIGGER tenant_backup_active_input_keys_immutable
BEFORE UPDATE OF active_input_key_challenges_json ON tenant_backup_operations
WHEN OLD.active_input_key_challenges_json IS NOT NULL
  OR NEW.active_input_key_challenges_json IS NULL
BEGIN SELECT RAISE(ABORT,'backup_active_input_keys_immutable'); END;

CREATE TRIGGER tenant_backup_key_handoff_input_authorized
BEFORE INSERT ON tenant_backup_key_handoffs
WHEN NOT (
  (NEW.input_upload_id IS NULL AND EXISTS (
    SELECT 1 FROM tenant_backup_operations o
    WHERE o.id=NEW.operation_id AND o.tenant_id=NEW.tenant_id AND o.kind='export'
  )) OR
  (NEW.input_upload_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tenant_backup_operation_inputs i
    JOIN tenant_backup_operations o ON o.id=i.operation_id AND o.tenant_id=i.tenant_id
    WHERE i.operation_id=NEW.operation_id AND i.tenant_id=NEW.tenant_id
      AND i.upload_id=NEW.input_upload_id AND o.kind='import'
  ))
)
BEGIN SELECT RAISE(ABORT,'backup_key_handoff_input_unauthorized'); END;
