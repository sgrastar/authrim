-- Input staging references immutable encrypted upload ranges; never persist plaintext or DEKs.
CREATE TABLE tenant_backup_input_receipts (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL CHECK(length(bundle_id)=32 AND bundle_id NOT GLOB '*[^0-9a-f]*'),
  sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<=1000001),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB))<=16384),
  event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(operation_id,bundle_id,sequence),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TRIGGER tenant_backup_input_receipt_immutable
BEFORE UPDATE ON tenant_backup_input_receipts
BEGIN SELECT RAISE(ABORT,'backup_input_receipt_immutable'); END;
