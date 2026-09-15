-- Durable proof that one recorded unpublished restore target was removed after cancellation.
CREATE TABLE tenant_backup_restore_cleanup_receipts (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  item_ordinal INTEGER NOT NULL CHECK(item_ordinal>=0 AND item_ordinal<4096),
  item_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  cleaned_at INTEGER NOT NULL CHECK(cleaned_at>=0),
  PRIMARY KEY(operation_id,item_ordinal),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(operation_id,item_ordinal) REFERENCES tenant_backup_restore_plan_inventory_items(operation_id,ordinal)
);
CREATE TRIGGER tenant_backup_restore_cleanup_receipt_immutable
BEFORE UPDATE ON tenant_backup_restore_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'backup_restore_cleanup_receipt_immutable'); END;
