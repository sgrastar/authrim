-- Private incoming ciphertext handles. These are never themselves portable datasets.
CREATE TABLE tenant_backup_uploads (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 174 AND 83886080000),
  expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL UNIQUE,
  multipart_id TEXT,
  object_version TEXT,
  object_etag TEXT,
  verified_sha256 TEXT CHECK(verified_sha256 IS NULL OR (length(verified_sha256)=64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*')),
  completed_at INTEGER,
  completion_lease_owner TEXT,
  completion_lease_until INTEGER,
  state TEXT NOT NULL DEFAULT 'allocating' CHECK(state IN ('allocating','uploading','completing','uploaded','cancelling','deleted')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  UNIQUE(tenant_id,idempotency_key),
  CHECK(state NOT IN ('uploading','completing','uploaded') OR multipart_id IS NOT NULL),
  CHECK((completion_lease_owner IS NULL)=(completion_lease_until IS NULL)),
  CHECK(state!='uploaded' OR (object_version IS NOT NULL AND object_etag IS NOT NULL
    AND verified_sha256=expected_sha256 AND completed_at IS NOT NULL))
);
CREATE INDEX tenant_backup_upload_expiry ON tenant_backup_uploads(state,expires_at);
CREATE INDEX tenant_backup_upload_completion ON tenant_backup_uploads(state,completion_lease_until,created_at,id);
CREATE TABLE tenant_backup_upload_parts (
  upload_id TEXT NOT NULL REFERENCES tenant_backup_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  etag TEXT,
  PRIMARY KEY(upload_id,part_number)
);
CREATE TRIGGER tenant_backup_upload_identity_immutable BEFORE UPDATE ON tenant_backup_uploads
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.created_by IS NOT OLD.created_by
 OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.expected_bytes IS NOT OLD.expected_bytes
 OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR NEW.object_key IS NOT OLD.object_key
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.multipart_id IS NOT NULL AND NEW.multipart_id IS NOT OLD.multipart_id)
 OR (OLD.object_version IS NOT NULL AND NEW.object_version IS NOT OLD.object_version)
 OR (OLD.object_etag IS NOT NULL AND NEW.object_etag IS NOT OLD.object_etag)
 OR (OLD.verified_sha256 IS NOT NULL AND NEW.verified_sha256 IS NOT OLD.verified_sha256)
 OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'backup_upload_immutable'); END;
CREATE TRIGGER tenant_backup_upload_state_transition BEFORE UPDATE OF state ON tenant_backup_uploads
WHEN NOT (
  NEW.state=OLD.state OR
  (OLD.state='allocating' AND NEW.state IN ('uploading','cancelling')) OR
  (OLD.state='uploading' AND NEW.state IN ('completing','cancelling')) OR
  (OLD.state='completing' AND NEW.state IN ('uploaded','cancelling')) OR
  (OLD.state='uploaded' AND NEW.state='cancelling') OR
  (OLD.state='cancelling' AND NEW.state='deleted')
)
BEGIN SELECT RAISE(ABORT,'backup_upload_state_transition'); END;
CREATE TRIGGER tenant_backup_upload_part_immutable BEFORE UPDATE ON tenant_backup_upload_parts
WHEN NEW.upload_id IS NOT OLD.upload_id OR NEW.part_number IS NOT OLD.part_number
 OR NEW.byte_count IS NOT OLD.byte_count OR NEW.sha256 IS NOT OLD.sha256
 OR (OLD.etag IS NOT NULL AND NEW.etag IS NOT OLD.etag)
BEGIN SELECT RAISE(ABORT,'backup_upload_part_immutable'); END;
