-- Restored asynchronous work is retained outside live queues so the target environment cannot
-- replay source side effects. The encrypted payload preserves the original row for a future,
-- separately authorized replay workflow; this release exposes inspection only.
CREATE TABLE tenant_backup_restored_holds (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL CHECK(
    length(dataset_id) BETWEEN 1 AND 256 AND dataset_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
  ),
  record_id TEXT NOT NULL CHECK(json_valid(record_id) AND length(record_id) BETWEEN 1 AND 4096),
  reason TEXT NOT NULL CHECK(
    length(reason) BETWEEN 1 AND 128 AND reason NOT GLOB '*[^a-z0-9_.:-]*'
  ),
  source_row_sha256 TEXT NOT NULL CHECK(
    length(source_row_sha256)=64 AND source_row_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_encrypted TEXT NOT NULL CHECK(
    payload_encrypted GLOB 'enc:v[1-9]*:gcm:*' AND length(payload_encrypted)<=2097152
  ),
  payload_key_version INTEGER NOT NULL CHECK(payload_key_version>=1),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(operation_id,dataset_id,record_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);

CREATE INDEX tenant_backup_restored_holds_tenant_operation
  ON tenant_backup_restored_holds(tenant_id,operation_id,dataset_id);

CREATE TRIGGER tenant_backup_restored_holds_immutable_update
BEFORE UPDATE ON tenant_backup_restored_holds
BEGIN SELECT RAISE(ABORT,'backup_restored_hold_immutable'); END;

CREATE TRIGGER tenant_backup_restored_holds_immutable_delete
BEFORE DELETE ON tenant_backup_restored_holds
BEGIN SELECT RAISE(ABORT,'backup_restored_hold_immutable'); END;
